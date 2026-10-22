/**
 * Ollama IPC Handlers
 *
 * Exposes Ollama setup and embedding generation to the renderer.
 * All functions gracefully degrade when Ollama is unavailable.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { logger } from '../safe-logger.js';
import {
  isOllamaRunning,
  runOllamaSetup,
  generateEmbedding,
  generateEmbeddingsBatch,
  generateEmbeddingsBatchDetailed,
  getSessionEmbedOptions,
  getSessionNumBatch,
  stepDownSessionNumBatch,
  isOllamaOomError,
  EMBED_NUM_THREAD_CPU,
  detectGpuMode,
  getEmbeddingModelInfo,
  getEmbeddingModelSize,
  ensureRerankModelPull,
  getRerankQwenModelTag,
  EMBEDDING_MODEL_NAME,
} from '../ollama-setup.js';
import { settingsStore, DEFAULT_OLLAMA_RERANK_MODEL } from '../settings-store.js';
import { normalizeOllamaRerankRows, type RerankResultRow } from '../ollama-rerank-normalize.js';
import {
  detectRerankTier,
  resetRerankTierCache,
  rerankTierLabel,
  scoreWithQwen3,
  type RerankTier,
  type RerankTierProbe,
} from '../rerank-engine.js';

/**
 * Structured IPC result for ollama:rerank.
 *
 * `via` is the tier that actually produced the ordering, so the renderer can be
 * honest about a weaker path instead of showing everything as "reranked".
 */
export type OllamaRerankIpcResult =
  | { results: RerankResultRow[]; via: RerankTier }
  | { error: { code: string; httpStatus?: number; message: string } };

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Rank documents by cosine(query, doc) using the existing arctic-embed2 path.
 * Used when /api/rerank is 404 or the cross-encoder model is missing.
 */
async function embedCosineRerank(
  query: string,
  documents: string[],
  topN: number,
): Promise<RerankResultRow[] | null> {
  const qEmb = await generateEmbedding(query);
  if (!qEmb?.length) return null;
  const docEmbs = await generateEmbeddingsBatch(documents);
  const scored: RerankResultRow[] = [];
  for (let i = 0; i < documents.length; i++) {
    const emb = docEmbs[i];
    if (!emb?.length) continue;
    scored.push({ index: i, relevance_score: cosineSimilarity(qEmb, emb) });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.relevance_score - a.relevance_score);
  return scored.slice(0, topN);
}

type NativeRerankOutcome = {
  results: RerankResultRow[] | null;
  /** 'ok' | 'empty_results' | 'model_missing' | 'endpoint_missing' | 'http_error' | 'network_error' */
  code: string;
  message: string;
  httpStatus?: number;
};

/** POST /api/rerank against a cross-encoder. Only reached when the native tier won detection. */
async function rerankViaNativeEndpoint(
  query: string,
  documents: string[],
  topN: number,
  model: string,
): Promise<NativeRerankOutcome> {
  const ollama = settingsStore.getOllamaSettings();
  const baseUrl = (ollama.url || 'http://localhost:11434').replace(/\/$/, '');

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), RERANK_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // v1.0.60 fix: pin bge-reranker in memory forever. Without keep_alive,
      // Ollama unloads the ~1.2 GB model after its default 5 min idle. Every
      // subsequent call pays a 30–80 s reload — and if arctic-embed2 (which
      // IS pinned) is called between two rerank calls on a single-GPU box
      // with OLLAMA_NUM_PARALLEL=1, the two models thrash-swap. Wave 3's
      // ES neighbor rerank made this the top perf bug (24 h reco cycles).
      body: JSON.stringify({ model, query, documents, top_n: topN, keep_alive: -1 }),
      signal: ac.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { results: null, code: 'network_error', message };
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      bodyText = '';
    }
    logger.warn(`[Ollama] rerank HTTP ${res.status} for model ${model}: ${bodyText.slice(0, 200)}`);
    if (looksLikeModelMissing(res.status, bodyText)) {
      void ensureRerankModelPull(model);
      return { results: null, code: 'model_missing', message: `Model ${model} is not installed`, httpStatus: res.status };
    }
    if (res.status === 404) {
      return { results: null, code: 'endpoint_missing', message: '/api/rerank is not available', httpStatus: res.status };
    }
    return { results: null, code: 'http_error', message: `Rerank HTTP ${res.status}`, httpStatus: res.status };
  }

  const data = (await res.json()) as {
    results?: Array<{ index?: number; relevance_score?: number; score?: number }>;
  };
  const results = normalizeOllamaRerankRows(data.results, documents.length);
  if (!results) {
    return { results: null, code: 'empty_results', message: 'Rerank returned no usable rows', httpStatus: res.status };
  }
  return { results, code: 'ok', message: 'ok', httpStatus: res.status };
}

function looksLikeModelMissing(httpStatus: number, bodyText: string): boolean {
  const lower = bodyText.toLowerCase();
  if (lower.includes('not found') && (lower.includes('model') || lower.includes('pull'))) {
    return true;
  }
  // Ollama often returns 404 for a missing model name on /api/rerank.
  if (httpStatus === 404 && (lower.includes('model') || lower.includes('pull it'))) {
    return true;
  }
  return false;
}

// Items per Ollama array request — Ollama processes them sequentially internally,
// so larger batches reduce HTTP roundtrips without bumping CPU.
// CPU mode: 100 — bigger requests start to bottleneck on JSON encode/decode.
// GPU mode: 256 — GPU eats them fast, HTTP overhead is the bottleneck instead.
const EMBED_SUB_BATCH_CPU = 100;
const EMBED_SUB_BATCH_GPU = 256;
const EMBED_SUB_BATCH_BG = 64; // polite mode — smaller bursts even on GPU
// Concurrent in-flight requests on GPU. Two overlaps HTTP/JSON-shuffle wall-clock
// of one batch with GPU compute of another. Requires OLLAMA_NUM_PARALLEL≥2 on the
// server side to actually parallelize inference — without it, Ollama queues
// them and behavior degrades gracefully to serial (same speed, no harm).
const EMBED_GPU_INFLIGHT = 2;
// Per-batch sleep when in background mode — gives the foreground app (likely a
// game) uninterrupted GPU/CPU windows between embedding bursts.
const EMBED_BG_COOLDOWN_MS = 100;
// Extra requests one IPC call may spend bisecting sub-batches that Ollama
// rejected with an error body, to isolate the offending text(s) instead of
// failing every innocent text that shared its sub-batch.
const EMBED_BISECT_BUDGET = 24;

// Runner options (num_thread / num_batch / num_gpu) are NOT chosen here any
// more — they are fixed per session by `getSessionEmbedOptions()` so Ollama
// never reloads the model on alt-tab. Background mode only changes pacing.

// ─── Session-scoped state ─────────────────────────────────────────────────
const embedState = {
  /** True when main window has been blurred for >2s — assume user is in another app (likely gaming). */
  background: false,
};

/**
 * Toggle polite background mode. Called by main.ts when the main window
 * blur/focus state changes. Affects only app-side pacing (sub-batch size,
 * in-flight count, cooldown) — never the Ollama runner options.
 */
export function setEmbeddingBackgroundMode(on: boolean): void {
  if (embedState.background === on) return;
  embedState.background = on;
  logger.log(`[Ollama] Embedding background mode: ${on ? 'ON (polite — foreground app gets GPU)' : 'OFF (full throughput)'}`);
}

const RERANK_MAX_DOCS = 100;
const RERANK_MAX_CHARS = 8000;
const RERANK_TIMEOUT_MS = 120_000;

export function register(): void {
  // Check if Ollama is running
  ipcMain.handle('ollama:healthCheck', async () => {
    try {
      return await isOllamaRunning();
    } catch (error) {
      logger.error('[Ollama] Health check error:', error);
      return { running: false, version: null };
    }
  });

  // Run the full setup sequence (check + pull missing models).
  // Progress is sent to the renderer via ollama:setup-progress for splash UI.
  ipcMain.handle('ollama:setup', async (event) => {
    const sender = event.sender;
    try {
      return await runOllamaSetup(
        (status, pct) => {
          logger.log(`[Ollama Setup] ${status} (${pct}%)`);
          try {
            sender.send('ollama:setup-progress', { status, pct });
          } catch {
            // Window may have closed
          }
        },
        // Separate channel: the rerank pull outlives runOllamaSetup, and its
        // progress must not be mistaken for the embedding bar's.
        (progress) => {
          logger.log(`[Ollama Rerank Setup] ${progress.status} (${progress.pct}%)`);
          try {
            sender.send('ollama:rerank-progress', progress);
          } catch {
            // Window may have closed
          }
        },
      );
    } catch (error) {
      logger.error('[Ollama] Setup error:', error);
      return {
        ollamaDetected: false,
        ollamaVersion: null,
        embeddingModelReady: false,
        rerankModelReady: false,
        rerankTier: null,
        rerankTierLabel: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Generate embedding for a single text
  ipcMain.handle('ollama:generateEmbedding', async (_event: any, text: string) => {
    try {
      if (!text || typeof text !== 'string') return null;
      return await generateEmbedding(text);
    } catch (error) {
      logger.error('[Ollama] Embedding generation error:', error);
      return null;
    }
  });

  // Generate embeddings for multiple texts.
  // Sends sub-batches as array requests to Ollama (/api/embed accepts string[])
  // so Ollama handles them sequentially internally — no parallel-requests CPU spike.
  // `opts.reportTransient` (v1.0.73): return `{ results, transientIds }` instead of the bare map.
  // transientIds = items that got no vector for a reason that says nothing about the text
  // (timeout / server gone / never sent) — the caller must not count those as the game's fault.
  ipcMain.handle('ollama:generateEmbeddings', async (_event: any, items: Array<{ id: string; text: string }>, opts?: { reportTransient?: boolean }) => {
    const transientIds: string[] = [];
    const reply = (results: Record<string, number[]>) => (opts?.reportTransient ? { results, transientIds } : results);
    try {
      if (!Array.isArray(items)) return reply({});

      const validItems = items.filter(item => item.id && item.text);
      if (validItems.length === 0) return reply({});

      // Length-sort: group texts of similar length into the same sub-batch.
      // Ollama processes the array sequentially so cross-text padding doesn't
      // apply, but length-grouping still helps in two ways:
      //   1. Per-sub-batch timeout calibration is tighter (no one giant text
      //      pushing the whole sub-batch close to the timeout)
      //   2. If OLLAMA_NUM_PARALLEL≥2, the 2nd in-flight sub-batch carries
      //      similar-length texts → finishes around the same time as the
      //      first, keeping worker queue utilized instead of one stragglering.
      // Sort by text length ascending. Results map is keyed by id so original
      // input order is irrelevant.
      validItems.sort((a, b) => a.text.length - b.text.length);

      // Probe whether the model is GPU-loaded — decides app-side pacing only
      // (sub-batch size / in-flight count). Conclusive answers are cached;
      // an early "model not loaded yet" probe is retried later.
      const onGpu = await detectGpuMode();

      const results: Record<string, number[]> = {};
      let completed = 0;
      // Set once Ollama times out / refuses the connection: the rest of this
      // call's sub-batches fail fast instead of each waiting out its own timeout.
      let serverDown = false;
      let bisectBudget = EMBED_BISECT_BUDGET;

      // Pacing is recomputed PER sub-batch so window blur/focus takes effect
      // immediately. Runner options are session-fixed (see getSessionEmbedOptions).
      const pickProfile = () => {
        const background = embedState.background;
        const numBatch = getSessionNumBatch();
        if (!onGpu) {
          return {
            subBatch: background ? EMBED_SUB_BATCH_BG : EMBED_SUB_BATCH_CPU,
            inFlight: 1,
            cooldownMs: background ? EMBED_BG_COOLDOWN_MS : 0,
            mode: `${background ? 'CPU-bg' : 'CPU'} (threads=${EMBED_NUM_THREAD_CPU}, num_batch=${numBatch ?? 'default'})`,
          };
        }
        if (background) {
          return {
            subBatch: EMBED_SUB_BATCH_BG,
            inFlight: 1, // single in-flight so foreground app gets GPU windows
            cooldownMs: EMBED_BG_COOLDOWN_MS,
            mode: `GPU-bg (subBatch=${EMBED_SUB_BATCH_BG}, num_batch=${numBatch ?? 'default'}, inFlight=1)`,
          };
        }
        return {
          subBatch: EMBED_SUB_BATCH_GPU,
          inFlight: EMBED_GPU_INFLIGHT,
          cooldownMs: 0,
          mode: `GPU (subBatch=${EMBED_SUB_BATCH_GPU}, num_batch=${numBatch ?? 'default'}, inFlight=${EMBED_GPU_INFLIGHT})`,
        };
      };

      // Carve into sub-batches up front, then drain through workers.
      // CPU mode / background: inFlight=1 → serial. GPU foreground: inFlight=2.
      const initialProfile = pickProfile();
      const subBatches: Array<{ id: string; text: string }[]> = [];
      for (let i = 0; i < validItems.length; i += initialProfile.subBatch) {
        subBatches.push(validItems.slice(i, i + initialProfile.subBatch));
      }

      // Embed one slice of texts. Failure handling is driven by what Ollama
      // actually reported, never by an all-null guess:
      //   - OOM error body  → step num_batch down (session-sticky), retry once.
      //   - other error body → bisect, so one poison text only fails itself
      //     rather than its whole sub-batch (bounded by EMBED_BISECT_BUDGET).
      //   - timeout / network → server hung or gone: stop this call.
      const embedTexts = async (texts: string[], oomRetried = false): Promise<(number[] | null)[]> => {
        if (serverDown) return texts.map(() => null);
        const { embeddings, error } = await generateEmbeddingsBatchDetailed(texts);
        if (!error) return embeddings;

        if (error.kind === 'timeout' || error.kind === 'network') {
          serverDown = true;
          logger.warn(`[Ollama] Embedding request failed (${error.kind}: ${error.message}) — skipping the rest of this batch`);
          return texts.map(() => null);
        }
        if (error.kind === 'http' && isOllamaOomError(error.message) && !oomRetried && stepDownSessionNumBatch()) {
          return embedTexts(texts, true);
        }
        if (error.kind === 'http' && texts.length > 1 && bisectBudget >= 2) {
          bisectBudget -= 2;
          const mid = Math.ceil(texts.length / 2);
          const left = await embedTexts(texts.slice(0, mid), oomRetried);
          const right = await embedTexts(texts.slice(mid), oomRetried);
          return [...left, ...right];
        }
        logger.warn(`[Ollama] Embedding request failed for ${texts.length} text(s): ${error.kind} ${error.status ?? ''} ${error.message.slice(0, 200)}`);
        return texts.map(() => null);
      };

      let cursor = 0;
      const runWorker = async (): Promise<void> => {
        while (cursor < subBatches.length && !serverDown) {
          const myIdx = cursor++;
          const subBatch = subBatches[myIdx];
          const texts = subBatch.map(item => item.text);
          const embeddings = await embedTexts(texts);
          for (let k = 0; k < subBatch.length; k++) {
            const vec = embeddings[k];
            if (vec) results[subBatch[k].id] = vec;
            // Once the server is down, every null in this slice is suspect — conservative on purpose
            else if (serverDown) transientIds.push(subBatch[k].id);
          }
          completed += subBatch.length;
          if (completed % 100 === 0 || completed === validItems.length) {
            logger.log(`[Ollama] Embeddings: ${completed}/${validItems.length}`);
          }
          // Polite cooldown in background mode — yields the GPU/CPU briefly
          // to the foreground app between bursts.
          const live = pickProfile();
          if (live.cooldownMs > 0 && cursor < subBatches.length) {
            await new Promise(r => setTimeout(r, live.cooldownMs));
          }
        }
      };

      const workers = Array.from(
        { length: Math.min(initialProfile.inFlight, subBatches.length) },
        runWorker,
      );
      await Promise.all(workers);
      // Sub-batches never sent because the server went down mid-call
      for (let i = cursor; i < subBatches.length; i++) for (const item of subBatches[i]) transientIds.push(item.id);

      logger.log(`[Ollama] Generated ${Object.keys(results).length}/${validItems.length} embeddings (mode=${pickProfile().mode})`);
      return reply(results);
    } catch (error) {
      logger.error('[Ollama] Batch embedding error:', error);
      for (const item of Array.isArray(items) ? items : []) if (item?.id) transientIds.push(item.id);
      return reply({});
    }
  });

  /**
   * Embed performance diagnostic — answers "is GPU actually engaged + how
   * fast are we really embedding?" Returns concrete numbers so we can stop
   * guessing about throughput.
   *
   * Probes:
   *  1. /api/ps  → is model loaded? on GPU? how much VRAM?
   *  2. /api/version  → server version (FA / NUM_PARALLEL behavior varies)
   *  3. Runs a real 100-item embed pass with current foreground profile
   *     and times it. Returns embeds/sec + per-text avg ms.
   */
  ipcMain.handle('ollama:embedDiagnostic', async () => {
    const result: {
      ollamaUp: boolean;
      ollamaVersion: string | null;
      modelLoaded: boolean;
      onGpu: boolean;
      sizeVramBytes: number;
      sizeBytes: number;
      probe: {
        items: number;
        avgTextChars: number;
        totalMs: number;
        embedsPerSec: number;
        msPerEmbed: number;
        successful: number;
        numBatchUsed: number | 'default';
        subBatchUsed: number;
        inFlight: number;
        backgroundMode: boolean;
      } | null;
      error: string | null;
    } = {
      ollamaUp: false,
      ollamaVersion: null,
      modelLoaded: false,
      onGpu: false,
      sizeVramBytes: 0,
      sizeBytes: 0,
      probe: null,
      error: null,
    };

    try {
      const health = await isOllamaRunning();
      result.ollamaUp = health.running;
      result.ollamaVersion = health.version;
      if (!health.running) {
        result.error = 'Ollama not running';
        return result;
      }

      // /api/ps probe
      const ollama = settingsStore.getOllamaSettings();
      const baseUrl = (ollama.url || 'http://localhost:11434').replace(/\/$/, '');
      try {
        const psRes = await fetch(`${baseUrl}/api/ps`);
        if (psRes.ok) {
          const ps = (await psRes.json()) as {
            models?: Array<{ name?: string; size?: number; size_vram?: number }>;
          };
          const m = ps.models?.find(x => (x.name || '').toLowerCase().startsWith(EMBEDDING_MODEL_NAME));
          if (m) {
            result.modelLoaded = true;
            result.sizeBytes = m.size ?? 0;
            result.sizeVramBytes = m.size_vram ?? 0;
            result.onGpu = (m.size_vram ?? 0) > 0;
          }
        }
      } catch (e) {
        logger.warn('[Ollama] Diagnostic /api/ps failed:', e);
      }

      // Real embed probe — short repetitive text so we measure throughput,
      // not tokenizer chunking. 100 items ≈ matches our real sub-batch on GPU.
      const probeTexts = Array.from(
        { length: 100 },
        (_, i) => `diagnostic probe item ${i}: a short representative game description for benchmark purposes`,
      );
      const avgChars = probeTexts.reduce((a, t) => a + t.length, 0) / probeTexts.length;

      // Same session-fixed runner options as production — so the number
      // reflects real throughput and the probe never triggers a model reload.
      const onGpu = result.onGpu;
      const background = embedState.background;
      const opts = getSessionEmbedOptions();

      const t0 = Date.now();
      const embeddings = await generateEmbeddingsBatch(probeTexts, opts);
      const totalMs = Date.now() - t0;
      const successful = embeddings.filter(e => e !== null).length;

      result.probe = {
        items: probeTexts.length,
        avgTextChars: Math.round(avgChars),
        totalMs,
        embedsPerSec: successful > 0 ? Math.round((successful / totalMs) * 1000 * 100) / 100 : 0,
        msPerEmbed: successful > 0 ? Math.round((totalMs / successful) * 100) / 100 : 0,
        successful,
        numBatchUsed: opts.numBatch ?? 'default',
        subBatchUsed: probeTexts.length,
        inFlight: 1, // diagnostic uses single in-flight for clean measurement
        backgroundMode: background,
      };

      logger.log(`[Ollama] Diagnostic: ${result.probe.embedsPerSec} emb/sec, ${result.probe.msPerEmbed}ms/emb on ${onGpu ? `GPU (VRAM=${Math.round(result.sizeVramBytes / 1024 / 1024)}MB)` : 'CPU'}, ollama=${health.version}`);
      return result;
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
      logger.error('[Ollama] Embed diagnostic failed:', e);
      return result;
    }
  });

  ipcMain.handle('ollama:modelInfo', async () => {
    try {
      const info = await getEmbeddingModelInfo();
      if (info) return info;
      const size = await getEmbeddingModelSize();
      return {
        name: EMBEDDING_MODEL_NAME,
        installed: size > 0,
        sizeBytes: size,
        parameterSize: '568M',
        quantization: 'F16',
      };
    } catch (error) {
      logger.error('[Ollama] Model info error:', error);
      return {
        name: EMBEDDING_MODEL_NAME,
        installed: false,
        sizeBytes: 0,
        parameterSize: '568M',
        quantization: 'F16',
      };
    }
  });

  /**
   * Tiered rerank for Embedding Space / Oracle ordering.
   *
   * The tier is chosen once per session by `detectRerankTier()` and the result
   * reports which one actually ran:
   *   native        → POST /api/rerank cross-encoder
   *   qwen_graded   → Qwen3-Reranker, softmax over the yes/no logprobs
   *   qwen_binary   → same model on an Ollama build without logprobs support
   *   embed_fallback→ arctic-embed2 cosine
   *
   * Returns { results, via } on success or { error: { code, httpStatus?, message } }.
   */
  ipcMain.handle('ollama:rerank', async (_event: any, payload: unknown): Promise<OllamaRerankIpcResult> => {
    const fail = (
      code: string,
      message: string,
      httpStatus?: number,
    ): OllamaRerankIpcResult => ({ error: { code, message, ...(httpStatus !== undefined ? { httpStatus } : {}) } });

    try {
      if (!payload || typeof payload !== 'object') {
        return fail('invalid_payload', 'Rerank payload must be an object');
      }
      const p = payload as { query?: unknown; documents?: unknown; topN?: unknown };
      const query = typeof p.query === 'string' ? p.query.trim() : '';
      const documents = Array.isArray(p.documents) ? p.documents : [];
      if (!query || documents.length === 0) {
        return fail('invalid_payload', 'Rerank requires a non-empty query and documents');
      }

      const slice = documents.slice(0, RERANK_MAX_DOCS).map((d) => {
        const s = typeof d === 'string' ? d : String(d ?? '');
        return s.length > RERANK_MAX_CHARS ? s.slice(0, RERANK_MAX_CHARS) : s;
      });
      const q = query.length > RERANK_MAX_CHARS ? query.slice(0, RERANK_MAX_CHARS) : query;

      const topNRaw = p.topN;
      const topN =
        typeof topNRaw === 'number' && Number.isFinite(topNRaw)
          ? Math.min(Math.max(1, Math.floor(topNRaw)), slice.length)
          : slice.length;

      const tryEmbedFallback = async (reason: string): Promise<OllamaRerankIpcResult> => {
        logger.log(`[Ollama] rerank falling back to arctic-embed cosine (${reason})`);
        const results = await embedCosineRerank(q, slice, topN);
        if (!results?.length) {
          return fail('embed_fallback_failed', `Reranker unavailable (${reason}); embed cosine fallback also failed`);
        }
        return { results, via: 'embed_fallback' };
      };

      let detection = await detectRerankTier();

      // ── Tier 1: native cross-encoder ──
      if (detection.tier === 'native') {
        const native = await rerankViaNativeEndpoint(q, slice, topN, detection.model);
        if (native.results) return { results: native.results, via: 'native' };
        if (native.code === 'empty_results') {
          return fail('empty_results', 'Rerank returned no usable rows');
        }
        if (native.code === 'http_error') {
          return fail('http_error', native.message, native.httpStatus);
        }
        // The endpoint or model stopped answering mid-session (Ollama restarted,
        // model deleted). Re-probe so later calls pick the next-best tier.
        logger.warn(`[Ollama] native rerank stopped working (${native.code}) — re-probing tiers`);
        resetRerankTierCache();
        detection = await detectRerankTier({ force: true });
      }

      // ── Tier 2: Qwen3 through /api/generate ──
      if (detection.tier === 'qwen_graded' || detection.tier === 'qwen_binary') {
        const scored = await scoreWithQwen3(q, slice, {
          model: detection.model,
          graded: detection.tier === 'qwen_graded',
          // Same politeness contract as embeddings: when the window has been
          // blurred we assume a game has the GPU and pause between documents.
          isBackground: () => embedState.background,
        });
        if (scored) {
          return { results: scored.rows.slice(0, topN), via: scored.tier };
        }
        return tryEmbedFallback('qwen_abandoned');
      }

      // ── Tier 3: cosine ──
      if (detection.ollamaUp) {
        // Nothing better is installed — start the Qwen3 download so the next
        // session gets graded scores. Deduped, retry-capable, non-blocking.
        void ensureRerankModelPull(getRerankQwenModelTag());
      }
      return tryEmbedFallback(detection.reason);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('[Ollama] rerank failed:', error);
      // Abort / network — not a 404; do not silent-fallback (keeps failures honest).
      const code = message.toLowerCase().includes('abort') ? 'timeout' : 'network_error';
      return fail(code, message);
    }
  });

  /**
   * Diagnostic probe — surfaces WHICH tier is serving reranks and why the
   * stronger ones were rejected, instead of only testing /api/rerank.
   *
   * `ollamaUp` / `modelName` / `modelInstalled` / `rerankWorking` / `latencyMs`
   * are kept for the Settings screen's existing "Test reranker" button.
   */
  ipcMain.handle('ollama:rerankDiagnostic', async () => {
    const ollama = settingsStore.getOllamaSettings();
    const baseUrl = ollama.url.replace(/\/$/, '');
    const modelName = ollama.rerankModel?.trim() || DEFAULT_OLLAMA_RERANK_MODEL;

    const status: {
      ollamaUp: boolean;
      ollamaVersion: string | null;
      modelName: string;
      modelInstalled: boolean;
      rerankWorking: boolean;
      tier: RerankTier | null;
      tierLabel: string | null;
      tierModel: string;
      tierReason: string;
      tiers: RerankTierProbe[];
      latencyMs?: number;
      error?: string;
    } = {
      ollamaUp: false,
      ollamaVersion: null,
      modelName,
      modelInstalled: false,
      rerankWorking: false,
      tier: null,
      tierLabel: null,
      tierModel: '',
      tierReason: '',
      tiers: [],
    };

    try {
      const t0 = Date.now();
      // Force a fresh probe — the point of the button is to test the current
      // machine state, not to report a cached decision.
      const detection = await detectRerankTier({ force: true });
      status.latencyMs = Date.now() - t0;
      status.ollamaUp = detection.ollamaUp;
      status.ollamaVersion = detection.ollamaVersion;
      status.tier = detection.tier;
      status.tierLabel = rerankTierLabel(detection.tier);
      status.tierModel = detection.model;
      status.tierReason = detection.reason;
      status.tiers = detection.probes;

      if (!detection.ollamaUp) {
        status.error = 'Ollama is not reachable at ' + baseUrl;
        return status;
      }

      const nativeProbe = detection.probes.find((probe) => probe.tier === 'native');
      status.modelInstalled = nativeProbe?.available ?? false;
      // Any tier above cosine is a working reranker as far as the UI cares.
      status.rerankWorking = detection.tier !== 'embed_fallback';
      if (!status.rerankWorking) {
        status.error = `${rerankTierLabel(detection.tier)} — ${detection.reason}`;
      }
      return status;
    } catch (e) {
      status.error = 'Rerank probe failed: ' + (e instanceof Error ? e.message : 'unknown');
      return status;
    }
  });
}
