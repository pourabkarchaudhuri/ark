/**
 * Shared executable-path validation for every IPC surface that accepts a
 * game's exe (picker, session tracking, launch, exe analysis). Keeping one
 * rule means a path the picker hands back is exactly a path tracking and
 * launching will accept — no "Executable path stored" for a .lnk that is
 * then silently never tracked.
 */
import * as path from 'path';

/**
 * Why `p` is not a usable game executable, or null when it is. Messages are
 * user-facing (launch surfaces them as-is).
 */
export function exePathError(p: unknown): string | null {
  if (typeof p !== 'string' || !p) return 'No executable path provided';
  if (!path.isAbsolute(p)) return 'Executable path must be absolute';
  if (!p.toLowerCase().endsWith('.exe')) return 'Executable path must end with .exe';
  return null;
}

/** True for an absolute path ending in .exe (case-insensitive). */
export function isValidExePath(p: unknown): p is string {
  return exePathError(p) === null;
}
