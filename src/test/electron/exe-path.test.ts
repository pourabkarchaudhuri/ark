/**
 * Shared exe-path rule used by the picker, session tracking, launch and
 * exe analysis — one rule so a picked path is always a trackable path.
 */
import { describe, it, expect } from 'vitest';
import { exePathError, isValidExePath } from '../../../electron/ipc/exe-path';

describe('exe-path', () => {
  it('accepts an absolute .exe case-insensitively', () => {
    expect(isValidExePath('C:\\Games\\g.exe')).toBe(true);
    expect(isValidExePath('C:\\Games\\G.EXE')).toBe(true);
  });

  it.each<[unknown, string]>([
    [undefined, 'No executable path provided'],
    ['', 'No executable path provided'],
    [42, 'No executable path provided'],
    ['g.exe', 'Executable path must be absolute'],
    ['C:\\Games\\g.lnk', 'Executable path must end with .exe'],
    ['C:\\Games\\g.bat', 'Executable path must end with .exe'],
    ['C:\\Games\\g.cmd', 'Executable path must end with .exe'],
  ])('%j -> %s', (p, msg) => {
    expect(exePathError(p)).toBe(msg);
    expect(isValidExePath(p)).toBe(false);
  });
});
