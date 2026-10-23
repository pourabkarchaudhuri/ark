/**
 * Oracle Event Log — append-only record of what Oracle showed and what the
 * user did about it (v1.0.75).
 *
 * Why: the engine's weights are hand-tuned and nothing records outcomes, so
 * there is no way to tell whether a change helped. This log is the raw
 * material for later evaluation / learning-to-rank: which games were shown
 * where (with their scores), and which were clicked, dismissed, thumbed,
 * added, played or rated.
 *
 * Storage: LevelDB namespace `oracle-events`, one row per event, keys sort
 * chronologically (`<13-digit ms>-<seq>`). A `_meta` row tracks the row
 * count so the cap can be enforced without scanning. Writes are buffered and
 * flushed in one `batch` (debounced). Diagnostic only — every failure is
 * swallowed so logging can never affect recommendations or the UI. When
 * `window.store` is unavailable (tests, early boot) recording is a no-op.
 */

type Store = NonNullable<Window['store']>;
type BatchOp = Parameters<Store['batch']>[0][number];

const LEVEL_NAMESPACE = 'oracle-events';
const META_KEY = '_meta';
/** Soft cap on stored events; the oldest are trimmed once this + slack is exceeded. */
export const ORACLE_EVENT_MAX_ROWS = 20_000;
const TRIM_SLACK = 2_000;
const FLUSH_DEBOUNCE_MS = 1_000;
const MAX_BUFFER = 50;

export type OracleEventType =
  | 'shown-run'
  | 'click'
  | 'dismiss'
  | 'thumbs'
  | 'library-add'
  | 'play'
  | 'rating'
  | 'explain-open'
  | 'shelf-order';

export interface OracleEvent {
  type: OracleEventType;
  gameId?: string;
  shelfType?: string;
  data?: Record<string, unknown>;
}

export interface StoredOracleEvent extends OracleEvent {
  /** Epoch ms when the event was recorded. */
  t: number;
}

interface PendingRow {
  key: string;
  value: StoredOracleEvent;
}

class OracleEventLog {
  private buffer: PendingRow[] = [];
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private count: number | null = null;
  private beforeUnloadBound = false;

  private get store(): Store | null {
    return typeof window !== 'undefined' && window.store ? window.store : null;
  }

  /** Queue an event. Never throws. */
  record(event: OracleEvent): void {
    try {
      if (!this.store) return;
      const t = Date.now();
      const key = `${String(t).padStart(13, '0')}-${String(this.seq++ % 10_000).padStart(4, '0')}`;
      this.buffer.push({ key, value: { ...event, t } });
      this.bindUnload();
      if (this.buffer.length >= MAX_BUFFER) {
        void this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.flush();
        }, FLUSH_DEBOUNCE_MS);
      }
    } catch {
      /* diagnostic only */
    }
  }

  private bindUnload(): void {
    if (this.beforeUnloadBound || typeof window === 'undefined') return;
    this.beforeUnloadBound = true;
    window.addEventListener('beforeunload', () => { void this.flush(); });
  }

  /** Write buffered events now. Safe to call concurrently. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.flushing) {
      await this.flushing;
      if (this.buffer.length === 0) return;
    }
    this.flushing = this.doFlush().finally(() => { this.flushing = null; });
    await this.flushing;
  }

  private async doFlush(): Promise<void> {
    const store = this.store;
    if (!store || this.buffer.length === 0) return;
    const rows = this.buffer.splice(0, this.buffer.length);
    try {
      if (this.count === null) {
        const meta = await store.get<{ count?: number }>(LEVEL_NAMESPACE, META_KEY);
        this.count = typeof meta.value?.count === 'number' ? meta.value.count : 0;
      }
      this.count += rows.length;
      const ops: BatchOp[] = rows.map(r => ({
        type: 'put' as const,
        namespace: LEVEL_NAMESPACE,
        key: r.key,
        value: r.value,
      }));

      if (this.count > ORACLE_EVENT_MAX_ROWS + TRIM_SLACK) {
        const excess = Math.min(this.count - ORACLE_EVENT_MAX_ROWS, 5_000);
        const oldest = await store.getChunk<StoredOracleEvent>(LEVEL_NAMESPACE, { limit: excess });
        const toDelete = (oldest.rows ?? []).filter(r => r.key !== META_KEY);
        for (const r of toDelete) {
          ops.push({ type: 'del', namespace: LEVEL_NAMESPACE, key: r.key });
        }
        this.count = Math.max(0, this.count - toDelete.length);
      }

      ops.push({ type: 'put', namespace: LEVEL_NAMESPACE, key: META_KEY, value: { count: this.count } });
      const res = await store.batch(ops);
      if (res.error) console.warn('[OracleEventLog] batch failed:', res.error);
    } catch (err) {
      console.warn('[OracleEventLog] flush failed:', err);
    }
  }

  /** Read every stored event, oldest first (debug / export / tests). */
  async readAll(): Promise<StoredOracleEvent[]> {
    await this.flush();
    const store = this.store;
    if (!store) return [];
    const res = await store.getAll<StoredOracleEvent>(LEVEL_NAMESPACE);
    return (res.rows ?? [])
      .filter(r => r.key !== META_KEY)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(r => r.value);
  }

  /** Test helper — forget in-memory state. */
  __resetForTests(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.buffer = [];
    this.seq = 0;
    this.count = null;
    this.flushing = null;
  }
}

export const oracleEventLog = new OracleEventLog();
