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

const EMBEDDING_MODEL = 'snowflake-arctic-embed2';
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
 * List currently installed models.
 */
async function listModels(): Promise<string[]> {
  const settings = settingsStore.getOllamaSettings();
  const url = settings.url || 'http://localhost:11434';

  return new Promise<string[]>((resolve) => {
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
            const names = (parsed.models || []).map((m) => m.name.split(':')[0]);
            resolve(names);
          } catch {
            resolve([]);
          }
        });
      },
    );

    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
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
  const settings = settingsStore.getOllamaSettings();
  const url = settings.url || 'http://localhost:11434';
  const urlObj = new URL(url);
  const hostname = urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname;
  const port = parseInt(urlObj.port) || 11434;

  return new Promise<number[] | null>((resolve) => {
    const body = JSON.stringify({ model: EMBEDDING_MODEL, input: text });

    const req = http.request(
      {
        hostname,
        port,
        path: '/api/embed',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: EMBED_TIMEOUT_MS,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { embeddings?: number[][] };
            if (parsed.embeddings && parsed.embeddings.length > 0) {
              resolve(parsed.embeddings[0]);
            } else {
              resolve(null);
            }
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
    const installedModels = await listModels();
    logger.log(`[Ollama Setup] Installed models: ${installedModels.join(', ') || 'none'}`);

    const hasEmbeddingModel = installedModels.some((m) =>
      m.startsWith('snowflake-arctic-embed2') || m === EMBEDDING_MODEL,
    );

    if (hasEmbeddingModel) {
      logger.log('[Ollama Setup] Embedding model already installed');
      result.embeddingModelReady = true;
      onProgress?.('Embedding model ready', 100);
      return result;
    }

    // Step 3: Pull embedding model
    logger.log(`[Ollama Setup] Pulling ${EMBEDDING_MODEL}...`);
    onProgress?.(`Pulling ${EMBEDDING_MODEL}...`, 30);

    const pulled = await pullModel(EMBEDDING_MODEL, (status, pct) => {
      onProgress?.(`Pulling ${EMBEDDING_MODEL}: ${status}`, 30 + Math.round(pct * 0.7));
    });

    result.embeddingModelReady = pulled;

    if (pulled) {
      // Warm up the model in the background — the first /api/embed call
      // after install forces Ollama to load the 1.1 GB model into RAM
      // (~80s on slow machines). Fire-and-forget so splash isn't blocked.
      onProgress?.('Warming up embedding model...', 95);
      warmUpEmbeddingModel().then(ok => {
        logger.log(`[Ollama Setup] Model warm-up: ${ok ? 'ready' : 'deferred'}`);
      });
      onProgress?.('Embedding model ready', 100);
    } else {
      result.error = `Failed to pull ${EMBEDDING_MODEL}`;
      onProgress?.('Model pull failed — continuing without embeddings', 100);
    }
  } catch (err) {
    logger.error('[Ollama Setup] Unexpected error:', err);
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
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
    const body = JSON.stringify({ name: EMBEDDING_MODEL });

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
              name: EMBEDDING_MODEL,
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
