/**
 * Cursor-stream every row of an IndexedDB object store in batches of `size`,
 * handing each batch to the async `onBatch`. Shared by the Steam and Epic
 * catalog stores for their one-shot IDB → LevelDB migration.
 *
 * The cursor never awaits `onBatch` (awaiting IPC inside `onsuccess` lets the
 * transaction auto-commit and the next `continue()` throws); writes are
 * chained on `pending` instead and the end-of-cursor branch awaits them.
 *
 * Settles exactly once: the first `onBatch` rejection rejects the stream
 * right away and stops the cursor. The previous per-store copies rethrew
 * inside the chain and only stopped reading, so a failed write while the
 * cursor was still running left the promise pending forever (every catalog
 * API waiting on the migration hung) and the rejection went unhandled.
 */
export function idbStreamStoreBatches<T>(
  db: IDBDatabase,
  storeName: string,
  onBatch: (rows: T[]) => Promise<void>,
  size: number,
  label: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).openCursor();
    let count = 0;
    let batch: T[] = [];
    let pending: Promise<void> = Promise.resolve();
    let failed: unknown = null;
    const fail = (err: unknown) => {
      if (failed) return;
      failed = err ?? new Error(`${label} IDB migration stream failed`);
      reject(failed);
    };

    req.onsuccess = async () => {
      if (failed) return; // a batch write already failed — stop reading
      const cursor = req.result;
      if (!cursor) {
        await pending;
        if (failed) return;
        try {
          if (batch.length > 0) await onBatch(batch);
          resolve(count);
        } catch (err) {
          fail(err);
        }
        return;
      }
      batch.push(cursor.value as T);
      count++;
      if (batch.length >= size) {
        const drain = batch;
        batch = [];
        // No rethrow: `pending` always resolves, the failure is reported once via `fail`.
        pending = pending.then(() => (failed ? undefined : onBatch(drain))).catch(fail);
      }
      cursor.continue();
    };
    req.onerror = () => fail(req.error ?? new Error(`${label} IDB cursor error during migration stream`));
  });
}
