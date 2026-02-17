/**
 * Atomic file write utilities.
 *
 * Writes to a `.tmp` sibling first, then renames into place.  If the
 * process crashes mid-write, the original file is untouched.
 */

import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Synchronous (for shutdown / flushSync paths)
// ---------------------------------------------------------------------------

export function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
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
  const tmp = filePath + '.tmp';
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
