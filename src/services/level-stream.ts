/**
 * Chunked LevelDB namespace walks over the `window.store` IPC surface.
 *
 * Every full-namespace scan in the renderer (catalog stores, embedding
 * service) used to stop at the first failed `getChunk` hop with only a
 * console error and report the partial walk as if it were the whole
 * namespace. Embedding passes then stamped their watermark with games still
 * unembedded, and graph / skip-index builds ran on a partial set.
 *
 * Here a failed hop is retried once; if it still fails the walk stops and
 * reports `complete: false`, so each caller can decide whether partial
 * results are usable (UI reads) or must not be committed (watermarks,
 * persisted graphs, skip indexes).
 */

export interface LevelScanResult {
  /** Rows handed to the callback. */
  count: number;
  /** False when a hop failed twice and the walk stopped early. */
  complete: boolean;
}

/** Thrown by callers that must not act on a partial walk. */
export class IncompleteScanError extends Error {
  constructor(what: string) {
    super(`${what}: storage scan stopped early (read error) — partial results not used`);
    this.name = 'IncompleteScanError';
  }
}

/** Pause before the single retry of a failed hop (rate limiter / transient IPC error). */
const RETRY_DELAY_MS = 150;

type ChunkPage<T> = { rows: Array<{ key: string; value: T }>; nextKey?: string; done: boolean };

/**
 * One `getChunk` hop, retried once on an error envelope or a thrown call.
 * Returns null when both attempts failed.
 */
export async function getChunkWithRetry<T>(
  namespace: string,
  query: { startAfter?: string; limit: number },
  label: string,
): Promise<ChunkPage<T> | null> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise<void>((r) => setTimeout(r, RETRY_DELAY_MS));
    try {
      const res = await window.store!.getChunk<T>(namespace, query);
      if (!res.error) return { rows: res.rows ?? [], nextKey: res.nextKey, done: !!res.done };
      lastError = res.error;
    } catch (err) {
      lastError = err;
    }
  }
  console.error(`${label} getChunk(${namespace}) failed twice — scan incomplete:`, lastError);
  return null;
}

/**
 * Walk a whole namespace in `pageSize` hops, awaiting `onRow` per row.
 * `onRow` may return `false` to stop early; that still counts as complete
 * (the caller chose to stop, nothing was lost).
 */
export async function levelStreamNamespace<T>(
  namespace: string,
  onRow: (row: { key: string; value: T }) => void | boolean | Promise<void | boolean>,
  opts: { pageSize: number; label: string; startAfter?: string },
): Promise<LevelScanResult> {
  let startAfter = opts.startAfter;
  let count = 0;
  while (true) {
    const page = await getChunkWithRetry<T>(namespace, { startAfter, limit: opts.pageSize }, opts.label);
    if (!page) return { count, complete: false };
    for (const row of page.rows) {
      if ((await onRow(row)) === false) return { count, complete: true };
      count++;
    }
    if (page.done || !page.nextKey) return { count, complete: true };
    startAfter = page.nextKey;
  }
}
