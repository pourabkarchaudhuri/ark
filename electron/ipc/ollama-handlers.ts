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
// so larger batches reduce HTTP roundtrips without bumping CPU. 100 is the
// sweet spot — bigger requests start to bottleneck on JSON encode/decode.
const EMBED_SUB_BATCH = 100;
// CPU-mode thread cap. Combined with serial requests keeps CPU ≤10% on
// CPU-only machines. Ignored when GPU mode is detected (GPU does the work,
// CPU threads aren't the bottleneck).
const EMBED_NUM_THREAD_CPU = 1;

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

      // Probe whether the model is GPU-loaded. When it is, we skip the
      // CPU thread cap entirely — Ollama uses the GPU and num_thread becomes
      // a meaningless throttle. Probe is cached after first call.
      const onGpu = await detectGpuMode();
      const numThread = onGpu ? undefined : EMBED_NUM_THREAD_CPU;

      const results: Record<string, number[]> = {};
      let completed = 0;

      // Serial — one sub-batch at a time. No inter-batch cooldown: the previous
      // 100ms sleep was a CPU safety, but with num_thread=1 (CPU mode) or the
      // GPU doing the work, the cooldown only added wall-clock without any
      // resource benefit.
      for (let i = 0; i < validItems.length; i += EMBED_SUB_BATCH) {
        const subBatch = validItems.slice(i, i + EMBED_SUB_BATCH);
        const texts = subBatch.map(item => item.text);
        const embeddings = await generateEmbeddingsBatch(texts, numThread);
        for (let k = 0; k < subBatch.length; k++) {
          const vec = embeddings[k];
          if (vec) results[subBatch[k].id] = vec;
        }

        completed += subBatch.length;
        if (completed % 100 === 0 || completed === validItems.length) {
          logger.log(`[Ollama] Embeddings: ${completed}/${validItems.length}`);
        }
      }

      logger.log(`[Ollama] Generated ${Object.keys(results).length}/${validItems.length} embeddings (mode=${onGpu ? 'GPU' : `CPU threads=${EMBED_NUM_THREAD_CPU}`})`);
      return results;
    } catch (error) {
      logger.error('[Ollama] Batch embedding error:', error);
      return {};
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
