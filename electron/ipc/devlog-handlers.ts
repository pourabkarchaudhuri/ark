/**
 * DevLog IPC — reads docs/dev-journal.json.
 *
 * In dev the file lives at <projectRoot>/docs/dev-journal.json. When packaged
 * it is shipped via electron-builder `extraResources` and lands under
 * `process.resourcesPath`/docs/dev-journal.json (the cross-platform-correct
 * location — `dirname(execPath)/resources` is wrong on macOS). If the file is
 * genuinely missing we still return a valid empty journal so the page renders.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ipcMain, app } = require('electron');
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../safe-logger.js';

const DEFAULT_JOURNAL = { project: 'ark', days: [] };

export function register(): void {
  ipcMain.handle('devlog:getJournal', async () => {
    try {
      // Candidate paths in priority order so a stale build layout still resolves.
      const candidates = app.isPackaged
        ? [
            path.join(process.resourcesPath, 'docs', 'dev-journal.json'),
            path.join(path.dirname(process.execPath), 'resources', 'docs', 'dev-journal.json'),
          ]
        : [path.join(app.getAppPath(), 'docs', 'dev-journal.json')];

      const journalPath = candidates.find((p: string) => fs.existsSync(p));
      if (!journalPath) {
        logger.warn('[DevLog] Journal file not found. Looked in:', candidates);
        return DEFAULT_JOURNAL;
      }

      const raw = fs.readFileSync(journalPath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      logger.error('[DevLog] Failed to read journal:', err);
      return DEFAULT_JOURNAL;
    }
  });
}
