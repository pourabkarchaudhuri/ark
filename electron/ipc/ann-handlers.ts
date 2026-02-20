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
} from '../ann-index.js';

export function register(): void {
  ipcMain.handle('ann:load', async () => {
    try {
      return loadIndex();
    } catch (err) {
      logger.error('[ANN IPC] load error:', err);
      return false;
    }
  });

  ipcMain.handle('ann:save', async () => {
    try {
      return saveIndex();
    } catch (err) {
      logger.error('[ANN IPC] save error:', err);
      return false;
    }
  });

  ipcMain.handle('ann:addVectors', async (_event: any, entries: Array<{ id: string; vector: number[] }>) => {
    try {
      return addVectors(entries);
    } catch (err) {
      logger.error('[ANN IPC] addVectors error:', err);
      return 0;
    }
  });

  ipcMain.handle('ann:query', async (_event: any, centroid: number[], k: number) => {
    try {
      return query(centroid, k);
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
      return { ready: false, vectorCount: 0, dims: 768 };
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
