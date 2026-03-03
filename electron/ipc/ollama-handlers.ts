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
  getEmbeddingModelInfo,
  getEmbeddingModelSize,
  EMBEDDING_MODEL_NAME,
} from '../ollama-setup.js';

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

  // Generate embeddings for multiple texts (batched with concurrency)
  ipcMain.handle('ollama:generateEmbeddings', async (_event: any, items: Array<{ id: string; text: string }>) => {
    try {
      if (!Array.isArray(items)) return {};

      const validItems = items.filter(item => item.id && item.text);
      if (validItems.length === 0) return {};

      const results: Record<string, number[]> = {};
      let completed = 0;

      const CONCURRENCY = 20;

      for (let i = 0; i < validItems.length; i += CONCURRENCY) {
        const batch = validItems.slice(i, i + CONCURRENCY);
        const promises = batch.map(async (item) => {
          const embedding = await generateEmbedding(item.text);
          if (embedding) {
            results[item.id] = embedding;
          }
        });

        await Promise.all(promises);
        completed += batch.length;

        if (completed % 50 === 0 || completed === validItems.length) {
          logger.log(`[Ollama] Embeddings: ${completed}/${validItems.length}`);
        }
      }

      logger.log(`[Ollama] Generated ${Object.keys(results).length} embeddings out of ${validItems.length} requested`);
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
}
