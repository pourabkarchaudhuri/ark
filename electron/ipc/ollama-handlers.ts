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
  detectGpuMode,
  getEmbeddingModelInfo,
  getEmbeddingModelSize,
  EMBEDDING_MODEL_NAME,
} from '../ollama-setup.js';
import { settingsStore, DEFAULT_OLLAMA_RERANK_MODEL } from '../settings-store.js';
import { normalizeOllamaRerankRows } from '../ollama-rerank-normalize.js';

// Items per Ollama array request — Ollama processes them sequentially internally,
// so larger batches reduce HTTP roundtrips without bumping CPU.
// CPU mode: 100 — bigger requests start to bottleneck on JSON encode/decode.
// GPU mode: 256 — GPU eats them fast, HTTP overhead is the bottleneck instead.
const EMBED_SUB_BATCH_CPU = 100;
const EMBED_SUB_BATCH_GPU = 256;
const EMBED_SUB_BATCH_BG = 100; // polite mode — same as CPU even on GPU
// CPU-mode thread cap. Combined with serial requests keeps CPU ≤10% on
// CPU-only machines. Ignored when GPU mode is detected (GPU does the work,
// CPU threads aren't the bottleneck).
const EMBED_NUM_THREAD_CPU = 1;
// GPU-mode Ollama internal batch — tokens processed per inference pass.
// Ladder is descended on VRAM OOM (all-null result). 2048 is sweet spot on a
// 6+ GB GPU; 512 ≈ Ollama default (works on most). `undefined` lets Ollama
// pick (final fallback — should always succeed if model loaded).
const EMBED_NUM_BATCH_LADDER: Array<number | undefined> = [2048, 1024, 512, undefined];
// Polite (background) mode keeps GPU pressure low so a foreground game runs smoothly.
const EMBED_NUM_BATCH_BG = 256;
// Force ALL layers to GPU — Ollama's auto-detect can leave layers on CPU
// on hybrid laptops (Intel iGPU + dGPU), capping throughput.
const EMBED_NUM_GPU_OFFLOAD = 999;
// Concurrent in-flight requests on GPU. Two overlaps HTTP/JSON-shuffle wall-clock
// of one batch with GPU compute of another. Requires OLLAMA_NUM_PARALLEL≥2 on the
// server side to actually parallelize inference — without it, Ollama queues
// them and behavior degrades gracefully to serial (same speed, no harm).
const EMBED_GPU_INFLIGHT = 2;
// Per-batch sleep when in background mode — gives the foreground app (likely a
// game) uninterrupted GPU/CPU windows between embedding bursts.
const EMBED_BG_COOLDOWN_MS = 100;

// ─── Session-scoped state ─────────────────────────────────────────────────
// Mutates over the session as we discover VRAM limits and window-focus state.
const embedState = {
  /** Index into EMBED_NUM_BATCH_LADDER. Starts at 0 (largest). Steps down on OOM, never back up. */
  numBatchIdx: 0,
  /** True when main window has been blurred for >2s — assume user is in another app (likely gaming). */
  background: false,
};

/**
 * Toggle polite background mode. Called by main.ts when the main window
 * blur/focus state changes. Affects only the GPU-mode embedding profile —
 * CPU mode is already polite by default (1 thread, serial).
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
      return await runOllamaSetup((status, pct) => {
        logger.log(`[Ollama Setup] ${status} (${pct}%)`);
        try {
          sender.send('ollama:setup-progress', { status, pct });
        } catch {
          // Window may have closed
        }
      });
    } catch (error) {
      logger.error('[Ollama] Setup error:', error);
      return {
        ollamaDetected: false,
        ollamaVersion: null,
        embeddingModelReady: false,
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
  ipcMain.handle('ollama:generateEmbeddings', async (_event: any, items: Array<{ id: string; text: string }>) => {
    try {
      if (!Array.isArray(items)) return {};

      const validItems = items.filter(item => item.id && item.text);
      if (validItems.length === 0) return {};

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

      // Probe whether the model is GPU-loaded. When it is, we skip the
      // CPU thread cap entirely and push GPU-specific knobs (full layer
      // offload + larger internal batch). Probe is cached after first call.
      const onGpu = await detectGpuMode();

      const results: Record<string, number[]> = {};
      let completed = 0;

      // Profile is recomputed PER sub-batch so window blur/focus or a VRAM
      // step-down mid-pass takes effect immediately on the next sub-batch.
      const pickProfile = () => {
        const background = embedState.background;
        if (!onGpu) {
          return {
            subBatch: EMBED_SUB_BATCH_CPU,
            opts: { numThread: EMBED_NUM_THREAD_CPU } as const,
            inFlight: 1,
            cooldownMs: background ? EMBED_BG_COOLDOWN_MS : 0,
            mode: background ? `CPU-bg (threads=${EMBED_NUM_THREAD_CPU})` : `CPU (threads=${EMBED_NUM_THREAD_CPU})`,
          };
        }
        if (background) {
          return {
            subBatch: EMBED_SUB_BATCH_BG,
            opts: { numGpu: EMBED_NUM_GPU_OFFLOAD, numBatch: EMBED_NUM_BATCH_BG },
            inFlight: 1, // single in-flight so foreground app gets GPU windows
            cooldownMs: EMBED_BG_COOLDOWN_MS,
            mode: `GPU-bg (subBatch=${EMBED_SUB_BATCH_BG}, num_batch=${EMBED_NUM_BATCH_BG}, inFlight=1)`,
          };
        }
        const numBatch = EMBED_NUM_BATCH_LADDER[embedState.numBatchIdx];
        return {
          subBatch: EMBED_SUB_BATCH_GPU,
          opts: { numGpu: EMBED_NUM_GPU_OFFLOAD, numBatch },
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

      // Per-sub-batch embed with VRAM OOM fallback. If the result is all-null
      // (likely Ollama error like "out of memory") AND we sent valid texts
      // AND we're on GPU with a num_batch set, step the ladder down once and
      // retry. The stepped-down value sticks for the rest of the session via
      // `embedState.numBatchIdx`.
      const embedSubBatchWithFallback = async (
        texts: string[],
      ): Promise<(number[] | null)[]> => {
        const profile = pickProfile();
        let embeddings = await generateEmbeddingsBatch(texts, profile.opts);

        const allNull = embeddings.length > 0 && embeddings.every(e => e === null);
        const looksLikeOom = allNull
          && onGpu
          && !embedState.background
          && profile.opts.numBatch !== undefined
          && embedState.numBatchIdx < EMBED_NUM_BATCH_LADDER.length - 1;

        if (looksLikeOom) {
          embedState.numBatchIdx += 1;
          const nextBatch = EMBED_NUM_BATCH_LADDER[embedState.numBatchIdx];
          logger.warn(`[Ollama] Embedding batch returned all-null on GPU — assuming VRAM tight, stepping num_batch → ${nextBatch ?? 'Ollama default'}`);
          embeddings = await generateEmbeddingsBatch(texts, {
            numGpu: EMBED_NUM_GPU_OFFLOAD,
            numBatch: nextBatch,
          });
        }
        return embeddings;
      };

      let cursor = 0;
      const runWorker = async (): Promise<void> => {
        while (cursor < subBatches.length) {
          const myIdx = cursor++;
          const subBatch = subBatches[myIdx];
          const texts = subBatch.map(item => item.text);
          const embeddings = await embedSubBatchWithFallback(texts);
          for (let k = 0; k < subBatch.length; k++) {
            const vec = embeddings[k];
            if (vec) results[subBatch[k].id] = vec;
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

      logger.log(`[Ollama] Generated ${Object.keys(results).length}/${validItems.length} embeddings (mode=${pickProfile().mode})`);
      return results;
    } catch (error) {
      logger.error('[Ollama] Batch embedding error:', error);
      return {};
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

      // Use the same profile picker our handler uses — so the number reflects
      // actual production throughput, not best-case theoretical.
      const onGpu = result.onGpu;
      const background = embedState.background;
      const opts = !onGpu
        ? { numThread: EMBED_NUM_THREAD_CPU }
        : background
          ? { numGpu: EMBED_NUM_GPU_OFFLOAD, numBatch: EMBED_NUM_BATCH_BG }
          : { numGpu: EMBED_NUM_GPU_OFFLOAD, numBatch: EMBED_NUM_BATCH_LADDER[embedState.numBatchIdx] };

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
   * POST /api/rerank — cross-encoder relevance for Embedding Space neighbor ordering.
   * Returns { results: [{ index, relevance_score }] } or null on failure.
   */
  ipcMain.handle('ollama:rerank', async (_event: any, payload: unknown) => {
    try {
      if (!payload || typeof payload !== 'object') return null;
      const p = payload as { query?: unknown; documents?: unknown; topN?: unknown };
      const query = typeof p.query === 'string' ? p.query.trim() : '';
      const documents = Array.isArray(p.documents) ? p.documents : [];
      if (!query || documents.length === 0) return null;

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

      const ollama = settingsStore.getOllamaSettings();
      const baseUrl = ollama.url.replace(/\/$/, '');
      const model = ollama.rerankModel?.trim() || DEFAULT_OLLAMA_RERANK_MODEL;

      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), RERANK_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/rerank`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            query: q,
            documents: slice,
            top_n: topN,
          }),
          signal: ac.signal,
        });
      } finally {
        clearTimeout(t);
      }

      if (!res.ok) {
        logger.warn(`[Ollama] rerank HTTP ${res.status} for model ${model}`);
        return null;
      }

      const data = (await res.json()) as {
        results?: Array<{ index?: number; relevance_score?: number; score?: number }>;
      };
      const raw = data.results;
      const results = normalizeOllamaRerankRows(raw, slice.length);
      if (!results) return null;
      return { results };
    } catch (error) {
      logger.warn('[Ollama] rerank failed:', error);
      return null;
    }
  });

  /**
   * Diagnostic probe — surfaces WHY rerank is failing instead of returning a silent null.
   * Returns: { ollamaUp, modelName, modelInstalled, rerankWorking, latencyMs?, error? }
   */
  ipcMain.handle('ollama:rerankDiagnostic', async () => {
    const ollama = settingsStore.getOllamaSettings();
    const baseUrl = ollama.url.replace(/\/$/, '');
    const modelName = ollama.rerankModel?.trim() || DEFAULT_OLLAMA_RERANK_MODEL;

    const status: {
      ollamaUp: boolean;
      modelName: string;
      modelInstalled: boolean;
      rerankWorking: boolean;
      latencyMs?: number;
      error?: string;
    } = {
      ollamaUp: false,
      modelName,
      modelInstalled: false,
      rerankWorking: false,
    };

    // Step 1: Ollama running?
    try {
      const health = await isOllamaRunning();
      status.ollamaUp = !!(health && health.running);
      if (!status.ollamaUp) {
        status.error = 'Ollama is not reachable at ' + baseUrl;
        return status;
      }
    } catch (e) {
      status.error = 'Ollama health check failed: ' + (e instanceof Error ? e.message : 'unknown');
      return status;
    }

    // Step 2: Rerank model installed?
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 5000);
      let tagsRes: Response;
      try {
        tagsRes = await fetch(`${baseUrl}/api/tags`, { signal: ac.signal });
      } finally {
        clearTimeout(t);
      }
      if (tagsRes.ok) {
        const tags = (await tagsRes.json()) as { models?: Array<{ name?: string }> };
        const installed = (tags.models || []).some((m) => {
          const n = (m.name || '').toLowerCase();
          const target = modelName.toLowerCase();
          return n === target || n.startsWith(target + ':') || n.split(':')[0] === target.split(':')[0];
        });
        status.modelInstalled = installed;
        if (!installed) {
          status.error = `Model "${modelName}" not pulled. Run: ollama pull ${modelName}`;
          return status;
        }
      }
    } catch (e) {
      logger.warn('[Ollama] tags lookup failed in diagnostic:', e);
    }

    // Step 3: End-to-end rerank probe
    try {
      const t0 = Date.now();
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 30_000);
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/rerank`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelName,
            query: 'cozy roguelike with great pixel art',
            documents: ['Hades — fast action roguelike with greek mythology', 'Stardew Valley — cozy farming sim', 'Doom Eternal — fast shooter'],
            top_n: 3,
          }),
          signal: ac.signal,
        });
      } finally {
        clearTimeout(t);
      }
      if (!res.ok) {
        status.error = `Rerank HTTP ${res.status}`;
        return status;
      }
      const data = (await res.json()) as { results?: Array<{ index?: number; relevance_score?: number; score?: number }> };
      const normalized = normalizeOllamaRerankRows(data.results, 3);
      if (!normalized || normalized.length === 0) {
        status.error = 'Rerank returned empty results';
        return status;
      }
      status.rerankWorking = true;
      status.latencyMs = Date.now() - t0;
      return status;
    } catch (e) {
      status.error = 'Rerank probe failed: ' + (e instanceof Error ? e.message : 'unknown');
      return status;
    }
  });
}
