/**
 * Game Launch IPC (Phase 4a) — launchExecutable validation + shell.openPath
 * success/failure contract tests.
 *
 * Note: `require('electron')` via createRequire isn't visible to
 * vi.mock('electron', ...) — it bypasses Vitest's module graph entirely and
 * loads the real (non-Electron-runtime) 'electron' npm package, which is
 * just a path string, not {shell, ipcMain}. __setLaunchDepsForTests is the
 * real seam; see launch-handlers.ts for the same pattern used in native-bridge.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { launchExecutable, __setLaunchDepsForTests } from '../../../electron/ipc/launch-handlers';

const WIN_EXE = 'C:\\Games\\MyGame\\game.exe';

function mockDeps(overrides?: { stat?: () => Promise<unknown>; openPath?: () => Promise<string> }) {
  const stat = vi.fn(overrides?.stat ?? (async () => ({ isFile: () => true })));
  const openPath = vi.fn(overrides?.openPath ?? (async () => ''));
  __setLaunchDepsForTests({ stat, openPath });
  return { stat, openPath };
}

beforeEach(() => {
  __setLaunchDepsForTests(); // reset to real (unused in tests, but keeps state clean between cases)
});

describe('launchExecutable — input validation', () => {
  it('rejects missing/empty/non-string paths without touching stat or openPath', async () => {
    const { stat, openPath } = mockDeps();
    expect(await launchExecutable(undefined)).toEqual({ success: false, error: 'No executable path provided' });
    expect(await launchExecutable('')).toEqual({ success: false, error: 'No executable path provided' });
    expect(await launchExecutable(42)).toEqual({ success: false, error: 'No executable path provided' });
    expect(stat).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });

  it('rejects a relative path', async () => {
    mockDeps();
    const result = await launchExecutable('game.exe');
    expect(result).toEqual({ success: false, error: 'Executable path must be absolute' });
  });

  it('rejects a non-.exe path even if absolute', async () => {
    mockDeps();
    const result = await launchExecutable('C:\\Games\\MyGame\\readme.txt');
    expect(result).toEqual({ success: false, error: 'Executable path must end with .exe' });
  });

  it('accepts .EXE case-insensitively', async () => {
    mockDeps();
    const result = await launchExecutable('C:\\Games\\MyGame\\GAME.EXE');
    expect(result.success).toBe(true);
  });
});

describe('launchExecutable — existence check', () => {
  it('reports a friendly error when the file does not exist, without calling openPath', async () => {
    const { openPath } = mockDeps({ stat: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } });
    const result = await launchExecutable(WIN_EXE);
    expect(result).toEqual({ success: false, error: 'Executable not found — check the path in Edit Entry' });
    expect(openPath).not.toHaveBeenCalled();
  });
});

describe('launchExecutable — shell.openPath contract', () => {
  it('succeeds when openPath resolves to an empty string', async () => {
    mockDeps({ openPath: async () => '' });
    const result = await launchExecutable(WIN_EXE);
    expect(result).toEqual({ success: true });
  });

  it('treats a non-empty resolved string as a failure (shell.openPath does not reject on failure)', async () => {
    mockDeps({ openPath: async () => 'No application is associated with this file' });
    const result = await launchExecutable(WIN_EXE);
    expect(result).toEqual({ success: false, error: 'No application is associated with this file' });
  });

  it('catches a thrown/rejected openPath call and returns a structured failure instead of propagating', async () => {
    mockDeps({ openPath: async () => { throw new Error('native openPath failure'); } });
    const result = await launchExecutable(WIN_EXE);
    expect(result.success).toBe(false);
    expect(result.error).toContain('native openPath failure');
  });

  it('passes the exact validated path through to openPath', async () => {
    const { openPath } = mockDeps();
    await launchExecutable(WIN_EXE);
    expect(openPath).toHaveBeenCalledWith(WIN_EXE);
  });
});
