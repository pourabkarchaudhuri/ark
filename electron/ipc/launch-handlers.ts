/**
 * Game Launch IPC Handlers (Phase 4a — Launch games from Ark)
 *
 * Launches a library/custom game's tracked executable via shell.openPath.
 * Reuses the same absolute-path + .exe validation as session-handlers.ts /
 * exe-info-handlers.ts so a path that's already rejected by session tracking
 * can't be launched from here either.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain, shell } = electron;
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../safe-logger.js';

export interface LaunchResult {
  success: boolean;
  error?: string;
}

// Test-only injectable seam: `require('electron')` via createRequire isn't
// visible to vi.mock('electron', ...) (it bypasses Vitest's module graph),
// so real/fake implementations are swapped through these module-level refs
// instead — same seam pattern as native-bridge.ts's __resetNativeBridgeForTests.
let _statFile: (p: string) => Promise<unknown> = (p) => fs.promises.stat(p);
let _openPath: (p: string) => Promise<string> = (p) => shell.openPath(p);

export function __setLaunchDepsForTests(deps?: {
  stat?: (p: string) => Promise<unknown>;
  openPath?: (p: string) => Promise<string>;
}): void {
  _statFile = deps?.stat ?? ((p) => fs.promises.stat(p));
  _openPath = deps?.openPath ?? ((p) => shell.openPath(p));
}

export async function launchExecutable(exePath: unknown): Promise<LaunchResult> {
  if (typeof exePath !== 'string' || !exePath) {
    return { success: false, error: 'No executable path provided' };
  }
  if (!path.isAbsolute(exePath)) {
    return { success: false, error: 'Executable path must be absolute' };
  }
  if (!exePath.toLowerCase().endsWith('.exe')) {
    return { success: false, error: 'Executable path must end with .exe' };
  }

  try {
    await _statFile(exePath);
  } catch {
    return { success: false, error: 'Executable not found — check the path in Edit Entry' };
  }

  try {
    // shell.openPath resolves to an empty string on success, or an error
    // message string on failure — it does not throw or reject on failure.
    const openError = await _openPath(exePath);
    if (openError) {
      logger.warn(`[Launch] shell.openPath failed for ${exePath}: ${openError}`);
      return { success: false, error: openError };
    }
    logger.log(`[Launch] Launched ${exePath}`);
    return { success: true };
  } catch (error) {
    logger.error('[Launch] Error launching executable:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function register(): void {
  ipcMain.handle('game:launch', async (_event: any, exePath: unknown) => {
    return launchExecutable(exePath);
  });
}
