/**
 * Atomic file write utilities.
 *
 * Writes to a unique `.tmp` sibling first, then renames into place.  If the
 * process crashes mid-write, the original file is untouched.
 */

import * as fs from 'fs';

let _tmpSeq = 0;

/**
 * Unique temp path per write. The async debounced save and the synchronous
 * shutdown flush used to share `<file>.tmp`, so a flushSync landing while an
 * async write was mid-flight could rename a half-written tmp into place (or
 * have its own tmp renamed away underneath it).
 */
function uniqueTmpPath(filePath: string): string {
  _tmpSeq = (_tmpSeq + 1) % 1_000_000;
  return `${filePath}.${process.pid}.${Date.now().toString(36)}.${_tmpSeq}.tmp`;
}

// ---------------------------------------------------------------------------
// Synchronous (for shutdown / flushSync paths)
// ---------------------------------------------------------------------------

export function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = uniqueTmpPath(filePath);
  fs.writeFileSync(tmp, data, 'utf-8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Clean up orphan .tmp file before re-throwing
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Asynchronous (for debounced background saves)
// ---------------------------------------------------------------------------

export function atomicWriteFile(
  filePath: string,
  data: string,
  callback: (err: NodeJS.ErrnoException | null) => void,
): void {
  const tmp = uniqueTmpPath(filePath);
  fs.writeFile(tmp, data, 'utf-8', (writeErr) => {
    if (writeErr) {
      callback(writeErr);
      return;
    }
    fs.rename(tmp, filePath, (renameErr) => {
      if (renameErr) {
        // Clean up orphan .tmp file before reporting error
        fs.unlink(tmp, () => { /* ignore cleanup failure */ });
      }
      callback(renameErr);
    });
  });
}
