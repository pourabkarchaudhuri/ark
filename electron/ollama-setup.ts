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
 * Check if Ollama is running at the configured URL.
 */
export async function isOllamaRunning(): Promise<{ running: boolean; version: string | null }> {
  const settings = settingsStore.getOllamaSettings();
  const url = settings.url || 'http://localhost:11434';

  return new Promise<{ running: boolean; version: string | null }>((resolve) => {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname;
    const port = parseInt(urlObj.port) || 11434;

    const req = http.get(
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
    const port = parseInt(urlObj.port) || 11434;

    const req = http.get(
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
 * Pull a model (streaming progress). Returns true on success.
 */
async function pullModel(
  modelName: string,
  onProgress?: (status: string, pct: number) => void,
): Promise<boolean> {
  const settings = settingsStore.getOllamaSettings();
  const url = settings.url || 'http://localhost:11434';
  const urlObj = new URL(url);
  const hostname = urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname;
  const port = parseInt(urlObj.port) || 11434;

  return new Promise<boolean>((resolve) => {
    const body = JSON.stringify({ name: modelName, stream: true });
    let sawSuccess = false;
    let sawError: string | null = null;

    const req = http.request(
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
          res.resume();
          resolve(false);
          return;
        }

        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
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
          if (sawError) {
            logger.error(`[Ollama Setup] Model pull failed: ${sawError}`);
            resolve(false);
          } else {
            logger.log(`[Ollama Setup] Model pull completed: ${modelName} (success=${sawSuccess})`);
            resolve(true);
          }
        });
      },
    );

    req.on('error', (err) => {
      logger.error(`[Ollama Setup] Model pull failed: ${err.message}`);
      onProgress?.(`Network error: ${err.message}`, 0);
      resolve(false);
    });

    req.on('timeout', () => {
      logger.warn(`[Ollama Setup] Model pull timed out: ${modelName}`);
      onProgress?.('Download timed out', 0);
      req.destroy();
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}

// Rerank pull: in-flight dedupe plus a retry cooldown. A one-shot Set used to
// block retries for the whole session, so a transient network failure during
// boot meant no reranker until the app restarted.
let _rerankPullInFlight: Promise<boolean> | null = null;
let _rerankPullTarget: string | null = null;
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
  const model = modelName?.trim() || getRerankQwenModelTag();
  if (_rerankPullInFlight && _rerankPullTarget === model) {
    return _rerankPullInFlight;
  }

  const failedAt = _rerankPullFailedAt.get(model);
  if (failedAt !== undefined) {
    const sinceMs = Date.now() - failedAt;
    if (sinceMs < RERANK_PULL_RETRY_COOLDOWN_MS) {
      const waitS = Math.ceil((RERANK_PULL_RETRY_COOLDOWN_MS - sinceMs) / 1000);
      logger.log(`[Ollama Setup] Rerank pull for ${model} failed recently — retry in ${waitS}s`);
      return Promise.resolve(false);
    }
  }

  _rerankPullTarget = model;
  logger.log(`[Ollama Setup] Pulling rerank model: ${model}`);
  const pull = pullModel(model, onProgress)
    .then((ok) => {
      if (ok) _rerankPullFailedAt.delete(model);
      else _rerankPullFailedAt.set(model, Date.now());
      logger.log(`[Ollama Setup] Rerank pull ${ok ? 'succeeded' : 'failed'}: ${model}`);
      return ok;
    })
    .catch((err) => {
      _rerankPullFailedAt.set(model, Date.now());
      logger.error(`[Ollama Setup] Rerank pull threw for ${model}:`, err);
      return false;
    })
    .finally(() => {
      _rerankPullInFlight = null;
      _rerankPullTarget = null;
    });
  _rerankPullInFlight = pull;
  return pull;
}

/**
 * Generate an embedding for a single text string.
 * Returns null if Ollama is unavailable.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const results = await generateEmbeddingsBatch([text]);
  return results[0];
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
 * @param opts     Tuning knobs — see EmbedBatchOptions. Pass {} on CPU mode
 *                 with a numThread cap; pass {numGpu:999, numBatch:2048} on GPU.
 */
export async function generateEmbeddingsBatch(
  texts: string[],
  opts: EmbedBatchOptions = {},
): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];

  const settings = settingsStore.getOllamaSettings();
  const url = settings.url || 'http://localhost:11434';
  const urlObj = new URL(url);
  const hostname = urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname;
  const port = parseInt(urlObj.port) || 11434;

  // Scale timeout: base + per-item allowance so large batches don't time out.
  const timeout = EMBED_TIMEOUT_MS + texts.length * 4_000;

  const ollamaOpts: Record<string, unknown> = {};
  if (opts.numThread) ollamaOpts.num_thread = opts.numThread;
  if (opts.numBatch) ollamaOpts.num_batch = opts.numBatch;
  if (opts.numGpu) ollamaOpts.num_gpu = opts.numGpu;

  const bodyObj: Record<string, unknown> = {
    model: getEmbeddingModelTag(),
    input: texts,
    // Pin model in memory forever — without this, Ollama unloads after 5min idle
    // and the next embed call pays an ~80s model reload cost. Pinned is free
    // (it's already loaded for embedding work anyway).
    keep_alive: -1,
  };
  if (Object.keys(ollamaOpts).length > 0) bodyObj.options = ollamaOpts;
  const bodyStr = JSON.stringify(bodyObj);

  return new Promise<(number[] | null)[]>((resolve) => {
    const req = http.request(
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
          try {
            const parsed = JSON.parse(data) as { embeddings?: number[][] };
            if (parsed.embeddings?.length) {
              resolve(parsed.embeddings.map(e => e ?? null));
            } else {
              resolve(texts.map(() => null));
            }
          } catch {
            resolve(texts.map(() => null));
          }
        });
      },
    );

    req.on('error', () => resolve(texts.map(() => null)));
    req.on('timeout', () => { req.destroy(); resolve(texts.map(() => null)); });
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
let _gpuDetectInFlight: Promise<boolean> | null = null;

/**
 * Detect whether the embedding model is running on GPU.
 * Result is cached for the session — call after the model has been loaded
 * at least once (warm-up or first embed call). Returns false if Ollama is
 * down, the model isn't loaded yet, or the response can't be parsed.
 */
export async function detectGpuMode(): Promise<boolean> {
  if (_gpuModeChecked) return _gpuModeAvailable;
  if (_gpuDetectInFlight) return _gpuDetectInFlight;

  _gpuDetectInFlight = (async () => {
    const settings = settingsStore.getOllamaSettings();
    const url = settings.url || 'http://localhost:11434';
    const urlObj = new URL(url);
    const hostname = urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname;
    const port = parseInt(urlObj.port) || 11434;

    return new Promise<boolean>((resolve) => {
      const req = http.get(
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
              const onGpu = !!(model && model.size_vram && model.size_vram > 0);
              _gpuModeChecked = true;
              _gpuModeAvailable = onGpu;
              logger.log(`[Ollama Setup] Embedding model GPU mode: ${onGpu ? 'yes' : 'no (CPU)'}`);
              resolve(onGpu);
            } catch {
              resolve(false);
            }
          });
        },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  })().finally(() => { _gpuDetectInFlight = null; });

  return _gpuDetectInFlight;
}

/** Reset cached GPU detection — call when Ollama settings change. */
export function resetGpuModeCache(): void {
  _gpuModeChecked = false;
  _gpuModeAvailable = false;
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

export async function runOllamaSetup(
  onProgress?: (status: string, pct: number) => void,
  onRerankProgress?: RerankProgressCallback,
): Promise<OllamaSetupStatus> {
  const result: OllamaSetupStatus = {
    ollamaDetected: false,
    ollamaVersion: null,
    embeddingModelReady: false,
    rerankModelReady: false,
    rerankTier: null,
    rerankTierLabel: null,
    error: null,
  };

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
      warmUpAndDetectGpu();
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
      warmUpAndDetectGpu();
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
  warmUpEmbeddingModel().then(async ok => {
    logger.log(`[Ollama Setup] Model warm-up: ${ok ? 'ready' : 'deferred'}`);
    if (ok) {
      // Only meaningful once the model is loaded — /api/ps reports VRAM
      // only for currently-loaded models.
      try { await detectGpuMode(); } catch { /* non-fatal */ }
    }
  });
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
  const settings = settingsStore.getOllamaSettings();
  const url = settings.url || 'http://localhost:11434';
  const urlObj = new URL(url);
  const hostname = urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname;
  const port = parseInt(urlObj.port) || 11434;

  return new Promise<OllamaModelInfo | null>((resolve) => {
    const activeTag = getEmbeddingModelTag();
    const body = JSON.stringify({ name: activeTag });

    const req = http.request(
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
  const settings = settingsStore.getOllamaSettings();
  const url = settings.url || 'http://localhost:11434';
  const urlObj = new URL(url);
  const hostname = urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname;
  const port = parseInt(urlObj.port) || 11434;

  return new Promise<number>((resolve) => {
    const req = http.get(
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
