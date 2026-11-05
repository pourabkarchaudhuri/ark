/**
 * Ollama Auto-Setup
 *
 * Detects if Ollama is installed and running, and ensures required models
 * are pulled for the recommendation engine. Runs during the splash screen
 * boot sequence so the app is ready to generate embeddings on first use.
 *
 * Required models:
 *   - snowflake-arctic-embed2  (for semantic embeddings — 1024-dim, ~1.2 GB)
 *   - dengcao/bge-reranker-v2-m3 (cross-encoder /api/rerank — silent background pull)
 *
 * Graceful degradation: if Ollama is not found, all functions return
 * cleanly with status 'unavailable'. The rest of the app continues normally
 * and the recommendation engine runs without embeddings. Missing rerank model
 * falls back to arctic-embed cosine scoring via IPC.
 */

import { logger } from './safe-logger.js';
import {
  settingsStore,
  DEFAULT_OLLAMA_RERANK_MODEL,
  DEFAULT_OLLAMA_RERANK_QWEN_MODEL,
} from './settings-store.js';
import http from 'http';
import https from 'https';
import os from 'os';
import { useBuiltinBackend, getBuiltinBackend } from './local-ai/backend.js';
import { getAiRouter, routeFor } from './ai-router/service.js';
import { getLocalAiService } from './local-ai/service.js';
import { getAutoModels } from './local-ai/manifest.js';
import { StringDecoder } from 'string_decoder';
// Type-only — the runtime import of rerank-engine.ts is dynamic (see
// settleRerankModelStatus) because that module imports this one.
import type { RerankTier } from './rerank-engine.js';

// Base model name (no tag). Used for matching loaded/installed models in
// /api/tags and /api/ps listings — we accept any quantization variant of
// arctic-embed2 since they all produce 1024-dim vectors in the same space.
const EMBEDDING_MODEL = 'snowflake-arctic-embed2';

/**
 * Resolve the active embedding-model TAG (name + optional quantization suffix).
 *
 * Priority:
 *   1. `ARK_EMBEDDING_MODEL_TAG` env var — power-user override for quantized variants
 *      (e.g. `snowflake-arctic-embed2:568m-q8_0`). Pre-pull the tag with
 *      `ollama pull <tag>` before setting the env var.
 *   2. Default `snowflake-arctic-embed2` (Ollama resolves to :latest, F16).
 *
 * VALIDATION: tag must start with `snowflake-arctic-embed2` so users can't
 * accidentally swap to a different model — embedding-space compatibility
 * (1024 dims, same training distribution) must hold across cached vectors.
 * If you swap models intentionally, also bump EMBEDDING_MODEL_VERSION in
 * src/services/embedding-service.ts to invalidate cached vectors.
 */
let _resolvedTag: string | null = null;
export function getEmbeddingModelTag(): string {
  if (_resolvedTag) return _resolvedTag;
  const envTag = process.env.ARK_EMBEDDING_MODEL_TAG?.trim();
  if (envTag && envTag.length > 0) {
    if (envTag === EMBEDDING_MODEL || envTag.startsWith(`${EMBEDDING_MODEL}:`)) {
      _resolvedTag = envTag;
      logger.log(`[Ollama Setup] Using embedding model tag from env: ${envTag}`);
      return envTag;
    }
    logger.warn(`[Ollama Setup] ARK_EMBEDDING_MODEL_TAG="${envTag}" rejected — must start with "${EMBEDDING_MODEL}" to preserve embedding-space compatibility. Falling back to default.`);
  }
  _resolvedTag = EMBEDDING_MODEL;
  return _resolvedTag;
}

const PULL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max for model pull (1.2 GB)
const HEALTH_TIMEOUT_MS = 15_000; // 15s — Ollama can be slow to respond on loaded machines
const LIST_TIMEOUT_MS = 15_000; // 15s for listing models
const EMBED_TIMEOUT_MS = 120_000; // 120s — first call needs to load the 1.1 GB model into memory

/**
 * keep_alive sent with every Ark embed / rerank request. It used to be -1
 * (never unload), which kept ~2-3 GB of models in VRAM/RAM through games and
 * after Ark quit. A finite window still covers a whole embedding or rerank
 * pass (no reload between calls — the v1.0.60 thrash fix), and
 * `unloadArkModels` frees them early when a game starts, on quit, and after
 * background work drains.
 */
export const OLLAMA_KEEP_ALIVE = '30m';
/** Upper bound for `unloadArkModels` — it runs on quit and must never hold it up. */
const UNLOAD_TIMEOUT_MS = 1_000;

export interface OllamaSetupStatus {
  ollamaDetected: boolean;
  ollamaVersion: string | null;
  embeddingModelReady: boolean;
  /** True when a reranker tier stronger than arctic-embed cosine is available. */
  rerankModelReady: boolean;
  /** Tier resolved during setup — 'embed_fallback' when nothing better exists. */
  rerankTier: string | null;
  /** Display name for `rerankTier` ("Qwen3 graded", "Cosine fallback", ...). */
  rerankTierLabel: string | null;
  error: string | null;
}

/** Progress event for the dedicated `ollama:rerank-progress` channel. */
export interface RerankSetupProgress {
  status: string;
  pct: number;
  /** Present on the terminal event. */
  done?: boolean;
  tier?: string | null;
  tierLabel?: string | null;
  error?: string | null;
  /**
   * Whether Ollama answered during tier detection. The renderer needs this to
   * distinguish "no reranker because Ollama is off" (not an error — nothing was
   * expected to work) from "Ollama is up and every tier above cosine failed".
   */
  ollamaUp?: boolean;
}

export type RerankProgressCallback = (progress: RerankSetupProgress) => void;

/**
 * Build the terminal progress event for a FAILED background Qwen3 pull.
 *
 * `lastPullStatus` is the last real text delivered through the pull progress
 * callback — `pullModel` forwards `Error: <ollama message>`, `HTTP error <code>`,
 * `Network error: <msg>` or `Download timed out`. Surfacing it (instead of a
 * generic "could not download") tells the user WHY the reranker fell back to
 * cosine. Tier stays `embed_fallback`.
 */
export function buildRerankPullFailureEvent(
  qwenTag: string,
  lastPullStatus: string | null,
  tierLabel: string | null,
): RerankSetupProgress {
  const detail = lastPullStatus && lastPullStatus.trim() ? ` — ${lastPullStatus.trim()}` : '';
  return {
    status: `Cosine fallback — could not download ${qwenTag}${detail}`,
    pct: 100,
    done: true,
    tier: 'embed_fallback',
    tierLabel,
    error: `Failed to pull ${qwenTag}${detail}`,
    ollamaUp: true,
  };
}

/** Resolve configured rerank model tag (Settings → default dengcao/bge-reranker-v2-m3). */
export function getRerankModelTag(): string {
  const settings = settingsStore.getOllamaSettings();
  return settings.rerankModel?.trim() || DEFAULT_OLLAMA_RERANK_MODEL;
}

/** Resolve the Qwen3 tier tag (Settings → default dengcao/Qwen3-Reranker-0.6B:Q8_0, Apache 2.0). */
export function getRerankQwenModelTag(): string {
  const settings = settingsStore.getOllamaSettings();
  return settings.rerankQwenModel?.trim() || DEFAULT_OLLAMA_RERANK_QWEN_MODEL;
}

/** Match installed tags for a rerank model (bare name or tagged variant). */
export function isRerankModelInstalled(
  _baseNames: string[],
  fullTags: string[],
  modelName: string,
): boolean {
  const target = modelName.toLowerCase();
  const targetBase = target.split(':')[0];
  return fullTags.some((t) => {
    const n = t.toLowerCase();
    return n === target || n.startsWith(`${target}:`) || n.split(':')[0] === targetBase;
  });
}

/**
 * A user-configured https Ollama address (reverse proxy, remote box) is spoken to over TLS and its own
 * default port; it used to be contacted with plain http on 11434, which can never work and leaks the
 * request in the clear when something answers.
 */
export function ollamaTransport(urlObj: { protocol: string }): typeof http {
  return (urlObj.protocol === 'https:' ? https : http) as typeof http;
}

export function ollamaPort(urlObj: { protocol: string; port: string }): number {
  return parseInt(urlObj.port) || (urlObj.protocol === 'https:' ? 443 : 11434);
}

/**
 * Check if Ollama is running at the configured URL.
 */
export async function isOllamaRunning(): Promise<{ running: boolean; version: string | null }> {
  // Built-in runtime (default): "running" means the packaged llama-server is there to start on demand.
  if (useBuiltinBackend()) return getBuiltinBackend().health();
  const settings = settingsStore.getOllamaSettings();
  const url = settings.url || 'http://localhost:11434';

  return new Promise<{ running: boolean; version: string | null }>((resolve) => {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname;
    const port = ollamaPort(urlObj);

    const req = ollamaTransport(urlObj).get(
      { hostname, port, path: '/api/version', timeout: HEALTH_TIMEOUT_MS },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ running: true, version: parsed.version || 'unknown' });
          } catch {
            resolve({ running: true, version: 'unknown' });
          }
        });
      },
    );

    req.on('error', () => resolve({ running: false, version: null }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ running: false, version: null });
    });
  });
}

/**
 * List currently installed models. Returns both bare base names AND full tagged
 * forms so callers can match either pattern.
 */
async function listModels(): Promise<{ baseNames: string[]; fullTags: string[] }> {
  const settings = settingsStore.getOllamaSettings();
  const url = settings.url || 'http://localhost:11434';

  return new Promise<{ baseNames: string[]; fullTags: string[] }>((resolve) => {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname;
    const port = ollamaPort(urlObj);

    const req = ollamaTransport(urlObj).get(
      { hostname, port, path: '/api/tags', timeout: LIST_TIMEOUT_MS },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { models?: Array<{ name: string }> };
            const fullTags = (parsed.models || []).map((m) => m.name);
            const baseNames = fullTags.map((n) => n.split(':')[0]);
            resolve({ baseNames, fullTags });
          } catch {
            resolve({ baseNames: [], fullTags: [] });
          }
        });
      },
    );

    req.on('error', () => resolve({ baseNames: [], fullTags: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ baseNames: [], fullTags: [] }); });
  });
}

/**
 * Splits a streamed NDJSON body into complete lines. Bytes go through a UTF-8 StringDecoder, so a
 * multi-byte character split across two socket chunks is kept intact (status text, error messages).
 */
export function createNdjsonLineSplitter(): (chunk: Buffer) => string[] {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  return (chunk) => {
    buffer += decoder.write(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    return lines;
  };
}

/**
 * True when `/api/tags` lists `tag` itself. A bare name means `:latest`, so a
 * different quantization of the same model does not count as this tag.
 */
export function isExactTagInstalled(fullTags: string[], tag: string): boolean {
  const target = tag.trim().toLowerCase();
  if (!target) return false;
  const withTag = target.includes(':') ? target : `${target}:latest`;
  return fullTags.some((t) => {
    const n = t.toLowerCase();
    return n === target || n === withTag;
  });
}

/**
 * Pull a model (streaming progress). Returns true on success.
 *
 * Settles exactly once. A stream that ends without Ollama's final `success`
 * line (truncated download, server restart) only counts as success when
 * `/api/tags` confirms the tag is installed; a response error, abort or early
 * close resolves false instead of raising an uncaught exception or leaving
 * the caller waiting forever.
 */
export async function pullModel(
  modelName: string,
  onProgress?: (status: string, pct: number) => void,
): Promise<boolean> {
  const settings = settingsStore.getOllamaSettings();
  const url = settings.url || 'http://localhost:11434';
  const urlObj = new URL(url);
  const hostname = urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname;
  const port = ollamaPort(urlObj);

  return new Promise<boolean>((resolve) => {
    const body = JSON.stringify({ name: modelName, stream: true });
    let sawSuccess = false;
    let sawError: string | null = null;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const req = ollamaTransport(urlObj).request(
      {
        hostname,
        port,
        path: '/api/pull',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: PULL_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          logger.error(`[Ollama Setup] Pull returned HTTP ${res.statusCode}`);
          onProgress?.(`HTTP error ${res.statusCode}`, 0);
          res.on('error', () => finish(false));
          res.resume();
          finish(false);
          return;
        }

        const splitLines = createNdjsonLineSplitter();
        let ended = false;
        res.on('data', (chunk: Buffer) => {
          for (const line of splitLines(chunk)) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line) as {
                status?: string;
                error?: string;
                completed?: number;
                total?: number;
              };

              if (obj.error) {
                sawError = obj.error;
                logger.error(`[Ollama Setup] Pull error: ${obj.error}`);
                onProgress?.(`Error: ${obj.error}`, 0);
                continue;
              }

              const status = obj.status || 'pulling';
              if (status === 'success') sawSuccess = true;
              const pct = obj.total && obj.completed
                ? Math.round((obj.completed / obj.total) * 100)
                : 0;
              onProgress?.(status, pct);
            } catch {
              // Skip malformed JSON
            }
          }
        });

        res.on('end', () => {
          ended = true;
          if (sawError) {
            logger.error(`[Ollama Setup] Model pull failed: ${sawError}`);
            finish(false);
            return;
          }
          if (sawSuccess) {
            logger.log(`[Ollama Setup] Model pull completed: ${modelName}`);
            finish(true);
            return;
          }
          // No final "success" line: the stream was cut short, or this build
          // does not send one. Only the installed-models list can tell.
          listModels().then(({ fullTags }) => {
            const installed = isExactTagInstalled(fullTags, modelName);
            logger.warn(
              `[Ollama Setup] Pull stream for ${modelName} ended without "success" — tag ${installed ? 'is' : 'is NOT'} installed`,
            );
            if (!installed) onProgress?.('Download ended early', 0);
            finish(installed);
          }, () => finish(false));
        });
        res.on('error', (err: Error) => {
          logger.error(`[Ollama Setup] Model pull stream error: ${err.message}`);
          onProgress?.(`Network error: ${err.message}`, 0);
          finish(false);
        });
        res.on('aborted', () => {
          logger.warn(`[Ollama Setup] Model pull stream aborted: ${modelName}`);
          finish(false);
        });
        res.on('close', () => {
          if (!ended && !res.complete) finish(false);
        });
      },
    );

    req.on('error', (err) => {
      logger.error(`[Ollama Setup] Model pull failed: ${err.message}`);
      onProgress?.(`Network error: ${err.message}`, 0);
      finish(false);
    });

    req.on('timeout', () => {
      logger.warn(`[Ollama Setup] Model pull timed out: ${modelName}`);
      onProgress?.('Download timed out', 0);
      req.destroy();
      finish(false);
    });

    req.write(body);
    req.end();
  });
}

// Rerank pull: in-flight dedupe plus a retry cooldown. A one-shot Set used to
// block retries for the whole session, so a transient network failure during
// boot meant no reranker until the app restarted.
// In-flight pulls are keyed by tag: with one shared slot, the first of two
// overlapping pulls cleared it on finish while the second was still running,
// and later callers for the second tag started a duplicate download.
const _rerankPullsInFlight = new Map<string, Promise<boolean>>();
/** Model tag → timestamp of the last failed pull. */
const _rerankPullFailedAt = new Map<string, number>();
const RERANK_PULL_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

/** Clear the pull-failure cooldown so the next call retries immediately. */
export function resetRerankPullAttempts(): void {
  _rerankPullFailedAt.clear();
}

/**
 * Pull the reranker model, optionally reporting streaming download progress.
 *
 * Concurrent callers for the same tag share one pull. A tag that failed is
 * retried after `RERANK_PULL_RETRY_COOLDOWN_MS`, or immediately after
 * `resetRerankPullAttempts()` (called when Ollama settings change).
 *
 * Defaults to the Qwen3 tier tag, since that is the model auto-download exists
 * for — the native cross-encoder is only useful on builds that serve /api/rerank.
 */
export function ensureRerankModelPull(
  modelName?: string,
  onProgress?: (status: string, pct: number) => void,
): Promise<boolean> {
  if (useBuiltinBackend()) return ensureBuiltinRerankModels(onProgress);
  const model = modelName?.trim() || getRerankQwenModelTag();
  const inFlight = _rerankPullsInFlight.get(model);
  if (inFlight) return inFlight;

  const failedAt = _rerankPullFailedAt.get(model);
  if (failedAt !== undefined) {
    const sinceMs = Date.now() - failedAt;
    if (sinceMs < RERANK_PULL_RETRY_COOLDOWN_MS) {
      const waitS = Math.ceil((RERANK_PULL_RETRY_COOLDOWN_MS - sinceMs) / 1000);
      logger.log(`[Ollama Setup] Rerank pull for ${model} failed recently — retry in ${waitS}s`);
      return Promise.resolve(false);
    }
  }

  logger.log(`[Ollama Setup] Pulling rerank model: ${model}`);
  const pull = pullModel(model, onProgress)
    .then(async (ok) => {
      if (ok) _rerankPullFailedAt.delete(model);
      else _rerankPullFailedAt.set(model, Date.now());
      logger.log(`[Ollama Setup] Rerank pull ${ok ? 'succeeded' : 'failed'}: ${model}`);
      if (ok) {
        // Every successful pull invalidates the tier decision — including the
        // pull the ollama:rerank handler starts on its own, which used to leave
        // the session on a cached cosine tier until restart. Dynamic import for
        // the same cycle reason as settleRerankModelStatus. Awaited so callers
        // that re-detect right after the pull see the reset already applied.
        try {
          const { resetRerankTierCache } = await import('./rerank-engine.js');
          resetRerankTierCache();
        } catch (err) {
          logger.warn('[Ollama Setup] Could not reset rerank tier cache after pull:', err);
        }
      }
      return ok;
    })
    .catch((err) => {
      _rerankPullFailedAt.set(model, Date.now());
      logger.error(`[Ollama Setup] Rerank pull threw for ${model}:`, err);
      return false;
    })
    .finally(() => {
      if (_rerankPullsInFlight.get(model) === pull) _rerankPullsInFlight.delete(model);
    });
  _rerankPullsInFlight.set(model, pull);
  return pull;
}

/** Where an embed request is going: `queryOnly` marks query-time text (never a bulk library / catalog write). */
export interface EmbedRouteOptions {
  queryOnly?: boolean;
}

/**
 * Generate an embedding for a single text string.
 * Returns null if Ollama is unavailable.
 */
export async function generateEmbedding(text: string, route?: EmbedRouteOptions): Promise<number[] | null> {
  const results = await generateEmbeddingsBatch([text], undefined, route);
  return results[0];
}

// ─── Session-fixed embedding runner options ─────────────────────────────────
// Ollama reloads the model whenever a request's runner options (num_thread,
// num_batch, num_gpu, ...) differ from the loaded runner's. Varying them per
// request — foreground vs background on alt-tab, none at all for the warm-up,
// rerank fallback and query embeddings — made Ollama reload arctic-embed2
// (up to ~80 s each) over and over. Every embed request now sends ONE option
// set per session; background politeness is app-side pacing only (sub-batch
// size, in-flight count, cooldown — see ollama-handlers.ts).
//
// The set changes at most when GPU detection finds a partially-offloaded model
// (adds num_gpu=999 once) or when Ollama reports a real out-of-memory error
// (num_batch steps down the ladder).

/** CPU thread count — half the logical cores, never below 2. */
export const EMBED_NUM_THREAD_CPU = Math.max(2, Math.floor((os.cpus()?.length || 2) / 2));
// Internal Ollama batch — tokens per inference pass. Descended only on an
// explicit OOM error body. `undefined` lets Ollama pick (final fallback).
const EMBED_NUM_BATCH_LADDER: Array<number | undefined> = [2048, 1024, 512, undefined];
// Force ALL layers to GPU — only applied when /api/ps shows the model split
// between VRAM and RAM (hybrid laptops), where Ollama's auto-detect caps throughput.
const EMBED_NUM_GPU_OFFLOAD = 999;
let _numBatchIdx = 0;

/** The single option set every embed request uses this session. */
export function getSessionEmbedOptions(): EmbedBatchOptions {
  const opts: EmbedBatchOptions = {
    numThread: EMBED_NUM_THREAD_CPU,
    numBatch: EMBED_NUM_BATCH_LADDER[_numBatchIdx],
  };
  if (_gpuModeChecked && _gpuModeAvailable && _gpuPartialOffload) opts.numGpu = EMBED_NUM_GPU_OFFLOAD;
  return opts;
}

/** Current num_batch (for diagnostics). */
export function getSessionNumBatch(): number | undefined {
  return EMBED_NUM_BATCH_LADDER[_numBatchIdx];
}

/** How many times this session Ollama ran out of memory and num_batch was stepped down. */
export function getEmbedOomStepDowns(): number {
  return _numBatchIdx;
}

/** Last /api/ps reading for the embedding model, refreshed by readEmbedModelVram. */
export async function readEmbedModelVram(): Promise<{ loaded: boolean; sizeBytes: number; vramBytes: number }> {
  if (useBuiltinBackend()) return getBuiltinBackend().gpuReading();
  const settings = settingsStore.getOllamaSettings();
  const urlObj = new URL(settings.url || 'http://localhost:11434');
  const hostname = urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname;
  const port = ollamaPort(urlObj);
  return new Promise((resolve) => {
    const none = { loaded: false, sizeBytes: 0, vramBytes: 0 };
    const req = ollamaTransport(urlObj).get({ hostname, port, path: '/api/ps', timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data) as { models?: Array<{ name?: string; size?: number; size_vram?: number }> };
          const model = parsed.models?.find((m) => {
            const n = (m.name || '').toLowerCase();
            return n.startsWith(EMBEDDING_MODEL) || n.split(':')[0] === EMBEDDING_MODEL;
          });
          resolve(model ? { loaded: true, sizeBytes: model.size ?? 0, vramBytes: model.size_vram ?? 0 } : none);
        } catch { resolve(none); }
      });
    });
    req.on('error', () => resolve(none));
    req.on('timeout', () => { req.destroy(); resolve(none); });
  });
}

/**
 * Step num_batch down after Ollama reported out-of-memory. Sticks for the
 * session. Returns false when already at the bottom of the ladder.
 */
export function stepDownSessionNumBatch(): boolean {
  if (_numBatchIdx >= EMBED_NUM_BATCH_LADDER.length - 1) return false;
  _numBatchIdx += 1;
  logger.warn(`[Ollama Setup] Embedding OOM — num_batch → ${EMBED_NUM_BATCH_LADDER[_numBatchIdx] ?? 'Ollama default'}`);
  return true;
}

/** True only when an Ollama error body explicitly reports memory exhaustion. */
export function isOllamaOomError(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return m.includes('out of memory')
    || m.includes('cudamalloc')
    || m.includes('insufficient memory')
    || m.includes('failed to allocate')
    || /\boom\b/.test(m);
}

export interface EmbedBatchError {
  /** timeout / network = server unreachable or hung; http = Ollama answered with an error. */
  kind: 'timeout' | 'network' | 'http' | 'parse' | 'empty';
  status?: number;
  message: string;
}

export interface EmbedBatchOptions {
  /** CPU thread cap. Ignored when GPU does the work. */
  numThread?: number;
  /** Internal Ollama batch size — tokens processed per inference pass.
   *  Higher = more GPU throughput, costs VRAM. ~2048 is a sweet spot on
   *  consumer GPUs for arctic-embed2; default Ollama uses 512. */
  numBatch?: number;
  /** Layer offload count. Pass 999 to force ALL layers to GPU when GPU mode
   *  is detected — Ollama's auto-detection sometimes leaves layers on CPU
   *  on hybrid/Optimus laptops, capping throughput. */
  numGpu?: number;
}

/**
 * Generate embeddings for multiple texts in a single Ollama request.
 * Ollama processes the array sequentially internally — one inference at a time —
 * so this avoids the CPU spike caused by many parallel single-text requests.
 *
 * @param texts    Texts to embed (order preserved in output).
 * @param opts     Runner options. Omit to use the session-fixed set
 *                 (`getSessionEmbedOptions`) — callers should, since any
 *                 difference makes Ollama reload the model.
 */
export async function generateEmbeddingsBatch(
  texts: string[],
  opts?: EmbedBatchOptions,
  route?: EmbedRouteOptions,
): Promise<(number[] | null)[]> {
  return (await generateEmbeddingsBatchDetailed(texts, opts, route)).embeddings;
}

/**
 * Same as `generateEmbeddingsBatch`, but also reports WHY a request failed so
 * callers can tell a hung/unreachable server (stop sending) from an Ollama
 * error body (bisect / OOM step-down) instead of guessing from all-null output.
 */
export async function generateEmbeddingsBatchDetailed(
  texts: string[],
  opts?: EmbedBatchOptions,
  route: EmbedRouteOptions = {},
): Promise<{ embeddings: (number[] | null)[]; error: EmbedBatchError | null }> {
  if (texts.length === 0) return { embeddings: [], error: null };
  // AI router (1.0.97 B35): an embeddings route on a connector other than Built-in goes through LiteLLM.
  // The router falls back to this local path itself when its policy says so and the vectors allow it.
  if (routeFor('embeddings').via === 'router') {
    // `queryOnly` (search / Oracle query text) lets the router fall back to the built-in model while a model-change
    // rebuild is pending, because the cache being searched is still in that space. Bulk writes never set it.
    return getAiRouter().embed(texts, () => generateEmbeddingsLocalDetailed(texts, opts), { queryOnly: route.queryOnly === true });
  }
  return generateEmbeddingsLocalDetailed(texts, opts);
}

/** The local embedding path: the built-in llama.cpp server, or the user's own Ollama. */
async function generateEmbeddingsLocalDetailed(
  texts: string[],
  opts?: EmbedBatchOptions,
): Promise<{ embeddings: (number[] | null)[]; error: EmbedBatchError | null }> {
  const effectiveOpts = opts ?? getSessionEmbedOptions();

  // Built-in runtime: llama-server's /v1/embeddings. numBatch becomes -b/-ub (a change restarts the server).
  if (useBuiltinBackend()) {
    return getBuiltinBackend().embed(texts, { numThread: effectiveOpts.numThread, numBatch: effectiveOpts.numBatch });
  }

  const settings = settingsStore.getOllamaSettings();
  const url = settings.url || 'http://localhost:11434';
  const urlObj = new URL(url);
  const hostname = urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname;
  const port = ollamaPort(urlObj);

  // Scale timeout: base + per-item allowance so large batches don't time out.
  const timeout = EMBED_TIMEOUT_MS + texts.length * 4_000;

  const ollamaOpts: Record<string, unknown> = {};
  if (effectiveOpts.numThread) ollamaOpts.num_thread = effectiveOpts.numThread;
  if (effectiveOpts.numBatch) ollamaOpts.num_batch = effectiveOpts.numBatch;
  if (effectiveOpts.numGpu) ollamaOpts.num_gpu = effectiveOpts.numGpu;

  const bodyObj: Record<string, unknown> = {
    model: getEmbeddingModelTag(),
    input: texts,
    // Ollama's default 5 min idle unload made the next embed call pay an ~80s
    // reload mid-pass. The shared finite window covers a pass without pinning
    // the model forever (see OLLAMA_KEEP_ALIVE).
    keep_alive: OLLAMA_KEEP_ALIVE,
  };
  if (Object.keys(ollamaOpts).length > 0) bodyObj.options = ollamaOpts;
  const bodyStr = JSON.stringify(bodyObj);

  const nulls = () => texts.map(() => null);

  return new Promise<{ embeddings: (number[] | null)[]; error: EmbedBatchError | null }>((resolve) => {
    let settled = false;
    const done = (embeddings: (number[] | null)[], error: EmbedBatchError | null) => {
      if (settled) return;
      settled = true;
      resolve({ embeddings, error });
    };
    const req = ollamaTransport(urlObj).request(
      {
        hostname,
        port,
        path: '/api/embed',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        timeout,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          let parsed: { embeddings?: number[][]; error?: string } | null = null;
          try {
            parsed = JSON.parse(data) as { embeddings?: number[][]; error?: string };
          } catch {
            parsed = null;
          }
          if (status >= 400 || parsed?.error) {
            done(nulls(), {
              kind: 'http',
              status,
              message: parsed?.error || data.slice(0, 300) || `HTTP ${status}`,
            });
            return;
          }
          if (!parsed) {
            done(nulls(), { kind: 'parse', status, message: 'Unparseable /api/embed response' });
            return;
          }
          if (parsed.embeddings?.length) {
            const out: (number[] | null)[] = parsed.embeddings.map(e => e ?? null);
            while (out.length < texts.length) out.push(null);
            done(out, null);
          } else {
            done(nulls(), { kind: 'empty', status, message: 'No embeddings in /api/embed response' });
          }
        });
        res.on('error', (err: Error) => done(nulls(), { kind: 'network', message: err.message }));
      },
    );

    req.on('error', (err: Error) => done(nulls(), { kind: 'network', message: err.message }));
    req.on('timeout', () => {
      req.destroy();
      done(nulls(), { kind: 'timeout', message: `No response within ${Math.round(timeout / 1000)}s` });
    });
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Fire a throwaway embedding to force Ollama to load the model into memory.
 * Returns true if the warm-up succeeded, false if it timed out or failed.
 * Non-blocking — callers should fire-and-forget.
 */
async function warmUpEmbeddingModel(): Promise<boolean> {
  try {
    const result = await generateEmbedding('warm-up');
    return result !== null && result.length > 0;
  } catch {
    return false;
  }
}

// ─── GPU mode detection ─────────────────────────────────────────────────────
// Probes Ollama's /api/ps to see whether the embedding model is loaded into
// VRAM. When it is, the CPU `num_thread` cap is meaningless — GPU does the
// work and we can drop the throttle for a 10-50x speedup at near-zero CPU.

let _gpuModeChecked = false;
let _gpuModeAvailable = false;
/** Model loaded partly in VRAM, partly in RAM — the only case num_gpu=999 helps. */
let _gpuPartialOffload = false;
let _gpuDetectInFlight: Promise<boolean> | null = null;
/** Last inconclusive probe (model not loaded / Ollama down) — throttles re-probes. */
let _gpuLastInconclusiveAt = 0;
const GPU_REPROBE_INTERVAL_MS = 30_000;

/**
 * Detect whether the embedding model is running on GPU.
 *
 * Only a CONCLUSIVE answer (the model is listed in /api/ps) is cached for the
 * session. Probing before the model has loaded used to cache "CPU" for the
 * whole session, pinning GPU machines to the slow CPU profile; an
 * inconclusive probe now returns false and is retried after
 * `GPU_REPROBE_INTERVAL_MS`.
 */
export async function detectGpuMode(): Promise<boolean> {
  if (_gpuModeChecked && useBuiltinBackend()) {
    // The built-in embed server can relaunch on the CPU after a GPU crash (or be unloaded): the cached
    // answer follows the live server's own reading instead of pinning GPU pacing onto a CPU server.
    const reading = getBuiltinBackend().gpuReading();
    if (reading.loaded) {
      _gpuModeAvailable = reading.vramBytes > 0;
      return _gpuModeAvailable;
    }
    resetGpuModeCache();
  }
  if (_gpuModeChecked) return _gpuModeAvailable;
  if (_gpuDetectInFlight) return _gpuDetectInFlight;
  // The built-in reading is a local in-memory read, so it is never throttled (a server started since the last
  // inconclusive probe must be seen at once); only the Ollama HTTP probe is.
  if (!useBuiltinBackend() && Date.now() - _gpuLastInconclusiveAt < GPU_REPROBE_INTERVAL_MS) return false;

  _gpuDetectInFlight = (async () => {
    if (useBuiltinBackend()) {
      // The embed server reports where its weights landed in its own log (-ngl forces all layers on
      // the GPU, so there is no partial-offload case to repair).
      const reading = getBuiltinBackend().gpuReading();
      if (!reading.loaded) {
        _gpuLastInconclusiveAt = Date.now();
        return false;
      }
      _gpuModeChecked = true;
      _gpuModeAvailable = reading.vramBytes > 0;
      _gpuPartialOffload = false;
      logger.log(`[Local AI] Embedding model GPU mode: ${_gpuModeAvailable ? 'yes' : 'no (CPU)'}`);
      return _gpuModeAvailable;
    }
    const settings = settingsStore.getOllamaSettings();
    const url = settings.url || 'http://localhost:11434';
    const urlObj = new URL(url);
    const hostname = urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname;
    const port = ollamaPort(urlObj);

    return new Promise<boolean>((resolve) => {
      const req = ollamaTransport(urlObj).get(
        { hostname, port, path: '/api/ps', timeout: 5000 },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data) as {
                models?: Array<{ name?: string; size?: number; size_vram?: number }>;
              };
              const model = parsed.models?.find(m => {
                const n = (m.name || '').toLowerCase();
                return n.startsWith(EMBEDDING_MODEL) || n.split(':')[0] === EMBEDDING_MODEL;
              });
              if (!model) {
                // Not loaded yet — inconclusive, re-check later.
                _gpuLastInconclusiveAt = Date.now();
                resolve(false);
                return;
              }
              const vram = model.size_vram ?? 0;
              const size = model.size ?? 0;
              const onGpu = vram > 0;
              _gpuModeChecked = true;
              _gpuModeAvailable = onGpu;
              _gpuPartialOffload = onGpu && size > 0 && vram < size * 0.95;
              logger.log(
                `[Ollama Setup] Embedding model GPU mode: ${onGpu ? (_gpuPartialOffload ? 'yes (partial offload)' : 'yes') : 'no (CPU)'}`,
              );
              resolve(onGpu);
            } catch {
              _gpuLastInconclusiveAt = Date.now();
              resolve(false);
            }
          });
        },
      );
      req.on('error', () => { _gpuLastInconclusiveAt = Date.now(); resolve(false); });
      req.on('timeout', () => { req.destroy(); _gpuLastInconclusiveAt = Date.now(); resolve(false); });
    });
  })().finally(() => { _gpuDetectInFlight = null; });

  return _gpuDetectInFlight;
}

/** Reset cached GPU detection — call when Ollama settings change. */
export function resetGpuModeCache(): void {
  _gpuModeChecked = false;
  _gpuModeAvailable = false;
  _gpuPartialOffload = false;
  _gpuLastInconclusiveAt = 0;
}

/** True when an /api/ps model name is one of the models Ark loads. */
function isArkModelName(name: string): 'embed' | 'rerank' | null {
  const n = name.toLowerCase();
  if (n.startsWith(EMBEDDING_MODEL) || n.split(':')[0] === EMBEDDING_MODEL) return 'embed';
  for (const tag of [getRerankModelTag(), getRerankQwenModelTag()]) {
    if (isRerankModelInstalled([], [name], tag)) return 'rerank';
  }
  return null;
}

/**
 * Ask Ollama to unload every Ark model it currently holds (keep_alive: 0).
 *
 * Reads /api/ps, then sends one unload request per loaded Ark model — the
 * embedder via /api/embed with no input, rerankers via /api/generate with an
 * empty prompt. Models Ark did not load are left alone. Bounded by
 * `timeoutMs` end to end and never throws, so callers can fire and forget it
 * (game start, quit, background work drained). Resolves with the names it
 * asked Ollama to unload.
 */
export async function unloadArkModels(opts?: { timeoutMs?: number }): Promise<string[]> {
  const timeoutMs = opts?.timeoutMs ?? UNLOAD_TIMEOUT_MS;
  if (useBuiltinBackend()) {
    // Stopping the servers frees their VRAM/RAM at once; they start again on the next request.
    const stopped = await getBuiltinBackend().unloadAll().catch(() => [] as string[]);
    if (stopped.length > 0) logger.log(`[Local AI] Stopped built-in servers: ${stopped.join(', ')}`);
    return stopped;
  }
  const settings = settingsStore.getOllamaSettings();
  const baseUrl = (settings.url || 'http://localhost:11434').replace(/\/$/, '');
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => { ac.abort(); resolve([]); }, timeoutMs);
  });

  const work = (async (): Promise<string[]> => {
    const psRes = await fetch(`${baseUrl}/api/ps`, { signal: ac.signal });
    if (!psRes.ok) return [];
    const ps = (await psRes.json()) as { models?: Array<{ name?: string; model?: string }> };
    const loaded = (ps.models ?? [])
      .map((m) => m.name || m.model || '')
      .filter((name) => name && isArkModelName(name));
    await Promise.all(loaded.map(async (name) => {
      const kind = isArkModelName(name);
      const [path, body] = kind === 'embed'
        ? ['/api/embed', { model: name, input: [], keep_alive: 0 }]
        : ['/api/generate', { model: name, prompt: '', keep_alive: 0 }];
      try {
        await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch {
        // Best effort — keep_alive expires the model anyway.
      }
    }));
    if (loaded.length > 0) logger.log(`[Ollama Setup] Asked Ollama to unload: ${loaded.join(', ')}`);
    return loaded;
  })().catch(() => [] as string[]);

  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the full setup sequence during splash screen boot.
 *
 * 1. Check if Ollama is running
 * 2. If yes, check for required models
 * 3. If models missing, pull them (with progress)
 * 4. Warm up the model (fire-and-forget)
 * 5. Return status
 *
 * This function NEVER throws — it always returns a status object.
 */
/**
 * Resolve which reranker tier this machine can serve, and start the Qwen3
 * download when the answer is "cosine only".
 *
 * Tier detection is awaited — it is a handful of short probes, and the caller
 * needs an accurate `rerankModelReady` in its return value. The download is
 * NOT awaited: it is ~600 MB, and the splash must not block on it. Progress
 * streams on the dedicated rerank channel instead of the shared setup channel,
 * so the embedding bar hitting 100% is never mistaken for the reranker's.
 */
async function settleRerankModelStatus(
  result: OllamaSetupStatus,
  onRerankProgress?: RerankProgressCallback,
): Promise<void> {
  // Dynamic import: rerank-engine.ts imports this module for the health probe
  // and the model-tag matcher, so a static import here would be a cycle.
  const { detectRerankTier, rerankTierLabel, resetRerankTierCache } = await import('./rerank-engine.js');

  const emit = (progress: RerankSetupProgress) => {
    try {
      onRerankProgress?.(progress);
    } catch {
      // Window may have closed
    }
  };

  let ollamaUp = false;

  const settle = (tier: RerankTier, ready: boolean, status: string, error?: string) => {
    result.rerankModelReady = ready;
    result.rerankTier = tier;
    result.rerankTierLabel = rerankTierLabel(tier);
    emit({
      status,
      pct: 100,
      done: true,
      tier,
      tierLabel: result.rerankTierLabel,
      error: error ?? null,
      ollamaUp,
    });
  };

  emit({ status: 'Probing reranker tiers...', pct: 5 });
  const detection = await detectRerankTier();
  ollamaUp = detection.ollamaUp;

  if (useBuiltinBackend()) {
    // The rerank models come from the same background download as the embedder; the setup
    // flow (runBuiltinSetup) starts it and re-detects when it finishes.
    if (detection.tier !== 'embed_fallback') {
      settle(detection.tier, true, rerankTierLabel(detection.tier));
    } else if (!detection.ollamaUp) {
      settle('embed_fallback', false, 'Built-in AI runtime not found', detection.reason);
    } else {
      result.rerankModelReady = false;
      result.rerankTier = 'embed_fallback';
      result.rerankTierLabel = rerankTierLabel('embed_fallback');
      emit({ status: 'Reranker models downloading', pct: 0, ollamaUp: true });
      void (async () => {
        await ensureBuiltinRerankModels((status, pct) => emit({ status, pct, ollamaUp: true }));
        resetRerankTierCache();
        const after = await detectRerankTier({ force: true });
        emit({
          status: rerankTierLabel(after.tier),
          pct: 100,
          done: true,
          tier: after.tier,
          tierLabel: rerankTierLabel(after.tier),
          error: after.tier === 'embed_fallback' ? after.reason : null,
          ollamaUp: after.ollamaUp,
        });
      })().catch((err) => logger.warn('[Local AI] Reranker setup failed:', err));
    }
    return;
  }

  if (detection.tier !== 'embed_fallback') {
    settle(detection.tier, true, rerankTierLabel(detection.tier));
    logger.log(`[Ollama Setup] Reranker ready: ${detection.reason}`);
    return;
  }

  if (!detection.ollamaUp) {
    settle('embed_fallback', false, 'Ollama not detected', detection.reason);
    return;
  }

  // Ollama is up but neither /api/rerank nor the Qwen3 model is available.
  // Report cosine now, then download in the background and re-detect.
  const qwenTag = getRerankQwenModelTag();
  result.rerankModelReady = false;
  result.rerankTier = 'embed_fallback';
  result.rerankTierLabel = rerankTierLabel('embed_fallback');
  logger.log(`[Ollama Setup] Reranker on cosine — starting background pull: ${qwenTag}`);

  void (async () => {
    emit({ status: `Downloading ${qwenTag}`, pct: 0, ollamaUp: true });
    // Remember the last real status/error the pull reported so a failure can
    // surface the concrete reason instead of a generic "could not download".
    let lastPullStatus: string | null = null;
    const pulled = await ensureRerankModelPull(qwenTag, (status, pct) => {
      lastPullStatus = status;
      emit({ status: `${qwenTag}: ${status}`, pct, ollamaUp: true });
    });
    if (!pulled) {
      emit(buildRerankPullFailureEvent(qwenTag, lastPullStatus, rerankTierLabel('embed_fallback')));
      return;
    }
    resetRerankTierCache();
    const after = await detectRerankTier({ force: true });
    emit({
      status: rerankTierLabel(after.tier),
      pct: 100,
      done: true,
      tier: after.tier,
      tierLabel: rerankTierLabel(after.tier),
      error: after.tier === 'embed_fallback' ? after.reason : null,
      ollamaUp: after.ollamaUp,
    });
  })();
}

export interface OllamaSetupOptions {
  /**
   * Skip the boot warm-up (Ark started hidden in the tray). Loading ~1.2 GB
   * into VRAM with no work queued only took memory from whatever the user
   * runs next; real work loads the model itself, and `warmUpIfSkipped` runs
   * the warm-up once the window is shown.
   */
  skipWarmUp?: boolean;
}

export async function runOllamaSetup(
  onProgress?: (status: string, pct: number) => void,
  onRerankProgress?: RerankProgressCallback,
  options?: OllamaSetupOptions,
): Promise<OllamaSetupStatus> {
  const warmUp = () => {
    if (options?.skipWarmUp) {
      _warmUpSkipped = true;
      logger.log('[Ollama Setup] Started hidden — embedding warm-up deferred until the window is shown');
      return;
    }
    warmUpAndDetectGpu();
  };
  const result: OllamaSetupStatus = {
    ollamaDetected: false,
    ollamaVersion: null,
    embeddingModelReady: false,
    rerankModelReady: false,
    rerankTier: null,
    rerankTierLabel: null,
    error: null,
  };

  if (useBuiltinBackend()) {
    return runBuiltinSetup(result, onProgress, onRerankProgress, warmUp);
  }

  try {
    // Step 1: Health check
    onProgress?.('Checking for Ollama...', 0);
    const health = await isOllamaRunning();

    if (!health.running) {
      logger.log('[Ollama Setup] Ollama not detected — recommendation engine will run without embeddings');
      result.error = 'Ollama not detected';
      await settleRerankModelStatus(result, onRerankProgress);
      return result;
    }

    result.ollamaDetected = true;
    result.ollamaVersion = health.version;
    logger.log(`[Ollama Setup] Ollama detected: v${health.version}`);

    // Step 2: Check installed models
    onProgress?.('Checking models...', 20);
    const { baseNames, fullTags } = await listModels();
    logger.log(`[Ollama Setup] Installed models: ${baseNames.join(', ') || 'none'}`);

    // If a custom tag is requested via ARK_EMBEDDING_MODEL_TAG, require an EXACT
    // tag match (e.g. snowflake-arctic-embed2:568m-q8_0) so we'll pull it if the
    // user only has the default F16 installed. For the default tag, any
    // arctic-embed2 variant satisfies (back-compat with existing installs).
    const activeTag = getEmbeddingModelTag();
    const wantsCustomTag = activeTag !== EMBEDDING_MODEL;
    const hasEmbeddingModel = wantsCustomTag
      ? fullTags.includes(activeTag)
      : baseNames.some((m) => m.startsWith('snowflake-arctic-embed2') || m === EMBEDDING_MODEL);

    if (hasEmbeddingModel) {
      logger.log('[Ollama Setup] Embedding model already installed');
      result.embeddingModelReady = true;
      // Warm up + detect GPU mode even in the "already installed" path so the
      // first real embedding batch hits a loaded-and-mode-known model.
      // Fire-and-forget — never blocks the splash.
      warmUp();
      // Previously returned here and never considered the rerank model.
      await settleRerankModelStatus(result, onRerankProgress);
      onProgress?.('Embedding model ready', 100);
      return result;
    }

    // Step 3: Pull embedding model
    const tagToPull = getEmbeddingModelTag();
    logger.log(`[Ollama Setup] Pulling ${tagToPull}...`);
    onProgress?.(`Pulling ${tagToPull}...`, 30);

    const pulled = await pullModel(tagToPull, (status, pct) => {
      onProgress?.(`Pulling ${tagToPull}: ${status}`, 30 + Math.round(pct * 0.7));
    });

    result.embeddingModelReady = pulled;

    if (pulled) {
      // Warm up the model + detect GPU mode in the background. First embed call
      // after install would otherwise force a ~80s model load AND a CPU-mode
      // round-trip on slow machines. Fire-and-forget so splash isn't blocked.
      onProgress?.('Warming up embedding model...', 95);
      warmUp();
      await settleRerankModelStatus(result, onRerankProgress);
      onProgress?.('Embedding model ready', 100);
    } else {
      result.error = `Failed to pull ${tagToPull}`;
      onProgress?.('Model pull failed — continuing without embeddings', 100);
      // A failed embedding pull used to silently cancel the reranker too —
      // the two are independent, so settle the reranker either way.
      await settleRerankModelStatus(result, onRerankProgress);
    }
  } catch (err) {
    logger.error('[Ollama Setup] Unexpected error:', err);
    result.error = err instanceof Error ? err.message : String(err);
    try {
      await settleRerankModelStatus(result, onRerankProgress);
    } catch (rerankErr) {
      logger.warn('[Ollama Setup] Rerank settle failed after setup error:', rerankErr);
    }
  }

  return result;
}

/**
 * Background chain: warm up the embedding model, then probe whether it landed
 * on GPU or CPU. Both steps fire-and-forget — splash never waits on them.
 * Idempotent across calls (warmUp is cheap once loaded; detectGpuMode caches).
 */
function warmUpAndDetectGpu(): void {
  const before = JSON.stringify(getSessionEmbedOptions());
  warmUpEmbeddingModel().then(async ok => {
    logger.log(`[Ollama Setup] Model warm-up: ${ok ? 'ready' : 'deferred'}`);
    if (ok) {
      // Only meaningful once the model is loaded — /api/ps reports VRAM
      // only for currently-loaded models.
      try { await detectGpuMode(); } catch { /* non-fatal */ }
      // Detection can add num_gpu (partial offload) — pay the one reload it
      // causes here, during boot, instead of on the first real batch.
      if (JSON.stringify(getSessionEmbedOptions()) !== before) {
        void warmUpEmbeddingModel();
      }
    }
  });
}

/** Set when runOllamaSetup skipped the boot warm-up (hidden start). */
let _warmUpSkipped = false;

/**
 * Run the warm-up that a hidden start skipped — called once the window is
 * shown, so the first search does not pay the cold load. No-op otherwise.
 * Returns true when it started a warm-up.
 */
export function warmUpIfSkipped(): boolean {
  if (!_warmUpSkipped) return false;
  _warmUpSkipped = false;
  warmUpAndDetectGpu();
  return true;
}

/** Exported model name for IPC consumers. */
export const EMBEDDING_MODEL_NAME = EMBEDDING_MODEL;

export interface OllamaModelInfo {
  name: string;
  installed: boolean;
  sizeBytes: number;
  parameterSize: string;
  quantization: string;
}

/**
 * Query Ollama for detailed info about the embedding model.
 * Returns null if Ollama is unavailable or the model isn't installed.
 */
export async function getEmbeddingModelInfo(): Promise<OllamaModelInfo | null> {
  if (useBuiltinBackend()) {
    const info = getBuiltinBackend().embeddingModelInfo();
    return info.installed ? info : null;
  }
  const settings = settingsStore.getOllamaSettings();
  const url = settings.url || 'http://localhost:11434';
  const urlObj = new URL(url);
  const hostname = urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname;
  const port = ollamaPort(urlObj);

  return new Promise<OllamaModelInfo | null>((resolve) => {
    const activeTag = getEmbeddingModelTag();
    const body = JSON.stringify({ name: activeTag });

    const req = ollamaTransport(urlObj).request(
      {
        hostname,
        port,
        path: '/api/show',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: LIST_TIMEOUT_MS,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as {
              details?: {
                parameter_size?: string;
                quantization_level?: string;
              };
              model_info?: Record<string, unknown>;
              modelfile?: string;
              size?: number;
            };

            // Sum blob sizes from the model listing API for accurate on-disk size
            resolve({
              name: activeTag,
              installed: true,
              sizeBytes: parsed.size ?? 0,
              parameterSize: parsed.details?.parameter_size ?? '568M',
              quantization: parsed.details?.quantization_level ?? 'F16',
            });
          } catch {
            resolve(null);
          }
        });
      },
    );

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * Get on-disk size of the embedding model from the model list.
 */
export async function getEmbeddingModelSize(): Promise<number> {
  if (useBuiltinBackend()) return getBuiltinBackend().embeddingModelInfo().sizeBytes;
  const settings = settingsStore.getOllamaSettings();
  const url = settings.url || 'http://localhost:11434';
  const urlObj = new URL(url);
  const hostname = urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname;
  const port = ollamaPort(urlObj);

  return new Promise<number>((resolve) => {
    const req = ollamaTransport(urlObj).get(
      { hostname, port, path: '/api/tags', timeout: LIST_TIMEOUT_MS },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as {
              models?: Array<{ name: string; size: number }>;
            };
            const model = parsed.models?.find(m =>
              m.name.startsWith(EMBEDDING_MODEL),
            );
            resolve(model?.size ?? 0);
          } catch {
            resolve(0);
          }
        });
      },
    );

    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}


// ─── Built-in local AI (1.0.97 B36) ─────────────────────────────────────────

/**
 * Set when the user chose "Continue without local AI": no automatic downloads until Retry / Re-check /
 * Download. Persisted in the settings store so the choice survives a restart; this in-memory value
 * (null = not touched this session) wins while the app runs, so a failed write cannot undo a click.
 */
let _autoDownloadDeclinedOverride: boolean | null = null;

function persistedAutoDownloadDeclined(): boolean {
  try { return settingsStore.isLocalAiAutoDownloadDeclined?.() === true; } catch { return false; }
}

function persistAutoDownloadDeclined(declined: boolean): void {
  try { settingsStore.setLocalAiAutoDownloadDeclined?.(declined); } catch (err) {
    logger.warn('[Local AI] Could not save the "continue without local AI" choice:', err);
  }
}

export function declineBuiltinAutoDownload(): void {
  _autoDownloadDeclinedOverride = true;
  persistAutoDownloadDeclined(true);
  getLocalAiService().store.cancelAll();
}

export function allowBuiltinAutoDownload(): void {
  _autoDownloadDeclinedOverride = false;
  persistAutoDownloadDeclined(false);
}

/** Test seam: forget this session's choice, as a new launch does (only the stored value remains). */
export function __resetAutoDownloadSessionForTests(): void {
  _autoDownloadDeclinedOverride = null;
}

export function isBuiltinAutoDownloadDeclined(): boolean {
  return _autoDownloadDeclinedOverride ?? persistedAutoDownloadDeclined();
}

/** Callbacks run once after a background model download queue drains (any outcome). */
const _modelsSettledHooks = new Set<(embeddingReady: boolean) => void>();

export function onBuiltinModelsSettled(fn: (embeddingReady: boolean) => void): () => void {
  _modelsSettledHooks.add(fn);
  return () => _modelsSettledHooks.delete(fn);
}

/** Run the settled hooks (the renderer re-checks embedding availability). Also used after Retry / Re-check. */
export function notifyBuiltinModelsSettled(embeddingReady: boolean): void {
  for (const hook of _modelsSettledHooks) {
    try { hook(embeddingReady); } catch { /* a hook must not break the queue */ }
  }
}

/** Download the Oracle models in the background; never throws. Resolves when the queue drains. */
export function startBuiltinModelDownloads(): Promise<void> {
  const { store } = getLocalAiService();
  const ids = getAutoModels().map((m) => m.id);
  return store.ensure(ids).catch((err) => {
    logger.warn('[Local AI] Model download queue failed:', err);
  });
}

/** Same, then tell the renderer the queue settled (Retry and Re-check use this, so embeddings recover without a restart). */
export function startBuiltinModelDownloadsAndNotify(): Promise<void> {
  const { store } = getLocalAiService();
  return startBuiltinModelDownloads().then(() => notifyBuiltinModelsSettled(store.isReady('embed')));
}

/**
 * Download the reranker models (the cross-encoder and the Qwen3 fallback) and report progress as
 * (status, pct). Resolves true when at least one reranker is usable afterwards.
 */
export async function ensureBuiltinRerankModels(
  onProgress?: (status: string, pct: number) => void,
): Promise<boolean> {
  const { store } = getLocalAiService();
  const rerankIds = getAutoModels().filter((m) => m.role === 'rerank' || m.role === 'rerank-qwen').map((m) => m.id);
  if (!isBuiltinAutoDownloadDeclined()) {
    const off = store.onChange((all) => {
      const cur = all.find((m) => rerankIds.includes(m.id) && m.state === 'downloading');
      if (cur) onProgress?.(`Downloading ${cur.label}`, cur.pct);
    });
    try {
      // Ahead of anything waiting, and not behind the 7 GB chat model: wait for these two only.
      void store.ensure(rerankIds, { priority: true }).catch((err) => logger.warn('[Local AI] Rerank download queue failed:', err));
      await store.whenSettled(rerankIds);
    } finally {
      off();
    }
  }
  return store.isReady('rerank') || store.isReady('rerank-qwen');
}

async function runBuiltinSetup(
  result: OllamaSetupStatus,
  onProgress: ((status: string, pct: number) => void) | undefined,
  onRerankProgress: RerankProgressCallback | undefined,
  warmUp: () => void,
): Promise<OllamaSetupStatus> {
  try {
    onProgress?.('Checking the built-in AI runtime...', 0);
    const backend = getBuiltinBackend();
    const health = backend.health();
    if (!health.running) {
      logger.warn('[Local AI] llama-server not found — recommendation engine will run without embeddings');
      result.error = 'Built-in AI runtime not found';
      await settleRerankModelStatus(result, onRerankProgress);
      return result;
    }
    result.ollamaDetected = true;
    result.ollamaVersion = health.version;

    onProgress?.('Checking models...', 20);
    const { store } = getLocalAiService();
    await store.refresh();
    const missing = store.statuses().filter((m) => m.auto && m.state !== 'ready');

    if (missing.length === 0) {
      result.embeddingModelReady = true;
      warmUp();
      await settleRerankModelStatus(result, onRerankProgress);
      onProgress?.('Embedding model ready', 100);
      return result;
    }

    // Models missing: Ark keeps running without embeddings (the usual degraded path) while they
    // download in the background. The renderer re-checks after its retry window and on the
    // models-ready push, and then finds them ready.
    result.embeddingModelReady = store.isReady('embed');
    if (isBuiltinAutoDownloadDeclined()) {
      result.error = 'Built-in AI models are not downloaded (local AI was declined)';
    } else {
      onProgress?.('Downloading AI models in the background...', 30);
      void startBuiltinModelDownloads().then(() => {
        const embedReady = store.isReady('embed');
        if (embedReady) warmUp();
        notifyBuiltinModelsSettled(embedReady);
      });
      result.error = result.embeddingModelReady ? null : 'Built-in AI models are downloading';
    }
    await settleRerankModelStatus(result, onRerankProgress);
    if (result.embeddingModelReady) onProgress?.('Embedding model ready', 100);
  } catch (err) {
    logger.error('[Local AI] Unexpected setup error:', err);
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}
