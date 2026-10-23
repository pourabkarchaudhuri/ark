/**
 * ANN Index IPC Handlers
 *
 * Exposes HNSW nearest-neighbor operations to the renderer process.
 * The usearch native addon runs exclusively in the main process.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { logger } from '../safe-logger.js';
import {
  loadIndex,
  saveIndex,
  addVectors,
  query,
  queryBatch,
  getStatus,
  clearIndex,
  setAnnModelTag,
} from '../ann-index.js';
import { getEmbeddingModelTag } from '../ollama-setup.js';

export function register(): void {
  // Resolve the embedding model tag once, before any index load: a persisted index built with another model is discarded.
  try { setAnnModelTag(getEmbeddingModelTag()); } catch { /* tag stays unknown → no model-mismatch guard */ }

  ipcMain.handle('ann:load', async () => {
    try {
      return loadIndex();
    } catch (err) {
      logger.error('[ANN IPC] load error:', err);
      return false;
    }
  });

  ipcMain.handle('ann:save', async (_event: any, opts?: { force?: boolean; complete?: boolean }) => {
    try {
      return saveIndex({ force: opts?.force === true, complete: opts?.complete === true });
    } catch (err) {
      logger.error('[ANN IPC] save error:', err);
      return false;
    }
  });

  // Returns AddVectorsResult ({ added, replaced, failed, aborted }). The renderer
  // wrapper (src/services/ann-index.ts) also accepts a bare number from older builds.
  ipcMain.handle('ann:addVectors', async (_event: any, entries: Array<{ id: string; vector: number[] }>) => {
    try {
      return await addVectors(entries);
    } catch (err) {
      logger.error('[ANN IPC] addVectors error:', err);
      return { added: 0, replaced: 0, failed: Array.isArray(entries) ? entries.length : 0, aborted: false };
    }
  });

  ipcMain.handle('ann:query', async (_event: any, centroid: number[], k: number, excludeId?: string) => {
    try {
      return query(centroid, k, excludeId);
    } catch (err) {
      logger.error('[ANN IPC] query error:', err);
      return [];
    }
  });

  ipcMain.handle('ann:status', async () => {
    try {
      return getStatus();
    } catch (err) {
      logger.error('[ANN IPC] status error:', err);
      return { ready: false, vectorCount: 0, dims: 1024, partial: true, layoutGeneration: 1, modelTag: '' };
    }
  });

  ipcMain.handle('ann:clear', async () => {
    try {
      clearIndex();
      return true;
    } catch (err) {
      logger.error('[ANN IPC] clear error:', err);
      return false;
    }
  });

  ipcMain.handle('ann:queryBatch', async (_event: any, entries: Array<{ id: string; vector: number[] }>, k: number) => {
    try {
      return queryBatch(entries, k);
    } catch (err) {
      logger.error('[ANN IPC] queryBatch error:', err);
      return {};
    }
  });
}
