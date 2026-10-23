/**
 * Storage health + shared persistence helpers for the LevelDB-backed renderer
 * stores (library, session, journey, status-history, custom-game).
 *
 * Reliability audit (item 3/4/5/10):
 *   - A failed LevelDB read must NEVER silently fall back to the legacy
 *     localStorage snapshot (frozen at the v1.0.61 migration) and then
 *     overwrite LevelDB with it. Stores retry the read; if it still fails they
 *     enter READ-ONLY mode (no writes at all) and report here so the UI can
 *     show a banner.
 *   - Every LevelDB write a store issues goes through a `SerialWriteQueue`, so
 *     `clearNamespace` → `batch` (import) and overlapping debounced saves can
 *     never land out of order.
 */

export interface StorageFailure {
  /** Store label, e.g. "library". */
  store: string;
  /** Last error message seen while reading. */
  error: string;
  /** ms since epoch. */
  at: number;
}

export interface StorageHealth {
  /** True when at least one store is running in read-only mode. */
  readOnly: boolean;
  failures: StorageFailure[];
}

let _failures: StorageFailure[] = [];
let _snapshot: StorageHealth = { readOnly: false, failures: [] };
const _listeners = new Set<() => void>();

function publish(): void {
  _snapshot = { readOnly: _failures.length > 0, failures: [..._failures] };
  _listeners.forEach((fn) => {
    try { fn(); } catch { /* listener errors never break persistence */ }
  });
}

/** Mark `store` as read-only for this session (its data could not be read). */
export function reportStorageReadOnly(store: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  _failures = [..._failures.filter((f) => f.store !== store), { store, error: message, at: Date.now() }];
  console.error(
    `[StorageHealth] ${store}: LevelDB read failed after retries — READ-ONLY for this session (no writes). ${message}`,
  );
  publish();
}

/** Stable snapshot (safe for useSyncExternalStore). */
export function getStorageHealth(): StorageHealth {
  return _snapshot;
}

export function subscribeStorageHealth(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** Test-only reset. */
export function __resetStorageHealthForTests(): void {
  _failures = [];
  publish();
}

// ---------------------------------------------------------------------------
// Read retry
// ---------------------------------------------------------------------------

// ~9 s of retries: read-only lasts the whole session, so a slow LevelDB open or a brief
// IPC hiccup at boot must not be enough to trigger it.
let _retryDelaysMs: number[] = [300, 1000, 2500, 5000];

/** Test hook — e.g. `[0, 0]` to keep failure-path tests fast. */
export function __setStorageRetryDelaysForTests(delays: number[]): void {
  _retryDelaysMs = [...delays];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type ReadOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Run `read` (which resolves `{ error }` on IPC failure or throws), retrying
 * `1 + retryDelays.length` times. Never throws.
 */
export async function readWithRetry<R extends { error?: string }>(
  label: string,
  read: () => Promise<R>,
): Promise<ReadOutcome<R>> {
  let lastError = 'unknown error';
  const attempts = 1 + _retryDelaysMs.length;
  for (let i = 0; i < attempts; i++) {
    const delay = i > 0 ? (_retryDelaysMs[i - 1] ?? 0) : 0;
    if (delay > 0) await sleep(delay);
    try {
      const res = await read();
      if (res && !res.error) return { ok: true, value: res };
      lastError = res?.error ?? 'empty response';
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    console.warn(`[${label}] LevelDB read failed (attempt ${i + 1}/${attempts}): ${lastError}`);
  }
  return { ok: false, error: lastError };
}

// ---------------------------------------------------------------------------
// Serialized writes
// ---------------------------------------------------------------------------

/**
 * Runs async persistence tasks strictly one after another. When the queue is
 * idle the task starts synchronously (so a `clear()` immediately issues its
 * `clearNamespace` call); otherwise it chains behind the in-flight task.
 * Task errors are logged and never break the chain.
 */
export class SerialWriteQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private readonly label: string) {}

  run(task: () => Promise<void> | void): Promise<void> {
    const exec = async () => {
      try {
        await task();
      } catch (err) {
        console.error(`[${this.label}] persistence task failed:`, err);
      }
    };
    const started = this.pending === 0 ? exec() : this.tail.then(exec);
    this.pending++;
    const tracked = started.then(() => { this.pending--; });
    this.tail = tracked;
    return tracked;
  }

  /** Resolves when every task queued so far has settled. */
  idle(): Promise<void> {
    return this.tail;
  }
}
