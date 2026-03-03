/**
 * DevLog IPC — reads docs/dev-journal.json from the project root.
 * Dev-mode only; the journal is maintained by the session-journal Cursor skill.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ipcMain, app } = require('electron');
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../safe-logger.js';

export function register(): void {
  ipcMain.handle('devlog:getJournal', async () => {
    try {
      const root = app.isPackaged
        ? path.dirname(process.execPath)
        : app.getAppPath();
      const journalPath = path.join(root, 'docs', 'dev-journal.json');

      if (!fs.existsSync(journalPath)) return null;

      const raw = fs.readFileSync(journalPath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      logger.error('[DevLog] Failed to read journal:', err);
      return null;
    }
  });
}
