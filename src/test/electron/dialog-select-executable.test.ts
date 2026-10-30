/**
 * dialog:selectExecutable — only .exe paths are handed back, because session
 * tracking and launch reject anything else. A .lnk is resolved to its target.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  selectExecutable,
  NOT_AN_EXE_ERROR,
  __setDialogDepsForTests,
} from '../../../electron/ipc/dialog-handlers';

function picker(filePaths: string[], canceled = false) {
  return vi.fn(async () => ({ canceled, filePaths }));
}

beforeEach(() => {
  __setDialogDepsForTests({ readShortcutTarget: () => null });
});

describe('selectExecutable', () => {
  it('offers only .exe (plus All Files) in the filter', async () => {
    const show = picker(['C:\\Games\\g.exe']);
    await selectExecutable(show);
    const opts = (show.mock.calls[0] as unknown as [{ filters: Array<{ extensions: string[] }> }])[0];
    expect(opts.filters).toEqual([
      { name: 'Executables', extensions: ['exe'] },
      { name: 'All Files', extensions: ['*'] },
    ]);
  });

  it('returns the path for an .exe', async () => {
    expect(await selectExecutable(picker(['C:\\Games\\g.exe']))).toEqual({
      success: true,
      filePath: 'C:\\Games\\g.exe',
    });
  });

  it.each(['C:\\Games\\run.bat', 'C:\\Games\\run.cmd', 'C:\\Games\\readme.txt'])(
    'rejects %s with an error',
    async (p) => {
      expect(await selectExecutable(picker([p]))).toEqual({ success: false, error: NOT_AN_EXE_ERROR });
    },
  );

  it('resolves a .lnk whose target is an .exe', async () => {
    __setDialogDepsForTests({ readShortcutTarget: () => 'C:\\Games\\real\\game.exe' });
    expect(await selectExecutable(picker(['C:\\Users\\me\\Desktop\\Game.lnk']))).toEqual({
      success: true,
      filePath: 'C:\\Games\\real\\game.exe',
    });
  });

  it('rejects a .lnk that cannot be resolved or points at a non-exe', async () => {
    expect((await selectExecutable(picker(['C:\\Desktop\\Game.lnk']))).success).toBe(false);
    __setDialogDepsForTests({ readShortcutTarget: () => 'C:\\Games\\start.bat' });
    expect(await selectExecutable(picker(['C:\\Desktop\\Game.lnk']))).toEqual({
      success: false,
      error: NOT_AN_EXE_ERROR,
    });
  });

  it('reports cancel', async () => {
    expect(await selectExecutable(picker([], true))).toEqual({ success: false, canceled: true });
  });
});
