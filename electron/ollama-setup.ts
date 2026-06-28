/**
 * Ollama Auto-Setup
 *
 * Detects if Ollama is installed and running, and ensures required models
 * are pulled for the recommendation engine. Runs during the splash screen
 * boot sequence so the app is ready to generate embeddings on first use.
 *
 * Required models:
 *   - snowflake-arctic-embed2  (for semantic embeddings — 1024-dim, ~1.2 GB)
 *
 * Graceful degradation: if Ollama is not found, all functions return
 * cleanly with status 'unavailable'. The rest of the app continues normally
 * and the recommendation engine runs without embeddings.
 */

import { logger } from './safe-logger.js';
import { settingsStore } from './settings-store.js';
import http from 'http';

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
  error: string | null;
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
export async function runOllamaSetup(
  onProgress?: (status: string, pct: number) => void,
): Promise<OllamaSetupStatus> {
  const result: OllamaSetupStatus = {
    ollamaDetected: false,
    ollamaVersion: null,
    embeddingModelReady: false,
    error: null,
  };

  try {
    // Step 1: Health check
    onProgress?.('Checking for Ollama...', 0);
    const health = await isOllamaRunning();

    if (!health.running) {
      logger.log('[Ollama Setup] Ollama not detected — recommendation engine will run without embeddings');
      result.error = 'Ollama not detected';
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
      onProgress?.('Embedding model ready', 100);
    } else {
      result.error = `Failed to pull ${tagToPull}`;
      onProgress?.('Model pull failed — continuing without embeddings', 100);
    }
  } catch (err) {
    logger.error('[Ollama Setup] Unexpected error:', err);
    result.error = err instanceof Error ? err.message : String(err);
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
