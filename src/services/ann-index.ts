/**
 * ANN Index Service (Renderer Side)
 *
 * Communicates with the main-process usearch HNSW index via IPC.
 * Observable singleton — UI components can subscribe for status updates.
 *
 * Graceful degradation: if the main process ANN module is unavailable
 * (e.g., native addon failed to load), all methods return cleanly
 * and the recommendation pipeline falls back to metadata-only retrieval.
 *
 * ── Job coordination ──
 * A clear + backfill (Rebuild ANN, or the automatic backfill of an empty /
 * partial index) holds an exclusive LEASE. While a lease is held, every other
 * writer — catalog passes, library generateMissing, the re-chunk job — waits:
 * `addVectors` / `save` / `clear` without the lease queue until it is
 * released, so their vectors are applied after the rebuild instead of being
 * dropped by the clear or interleaved into a half-built index. Acquiring a
 * lease first drains writes already in flight.
 *
 * Build progress has a single OWNER: only the job that holds it may update or
 * finish it, so a catalog pass can no longer flip the loader back and forth
 * over a running rebuild.
 */

export interface AnnAddResult {
  added: number;
  replaced?: number;
  failed?: number;
  aborted: boolean;
}

declare global {
  interface Window {
    ann?: {
      load: () => Promise<boolean>;
      save: (opts?: { force?: boolean; complete?: boolean }) => Promise<boolean>;
      /** Main returns AnnAddResult; older builds returned the bare added count. */
      addVectors: (entries: Array<{ id: string; vector: number[] | Float32Array }>) => Promise<AnnAddResult | number>;
      query: (centroid: number[], k: number, excludeId?: string) => Promise<Array<{ id: string; distance: number }>>;
      queryBatch: (entries: Array<{ id: string; vector: number[] | Float32Array }>, k: number) => Promise<Record<string, Array<{ id: string; distance: number }>>>;
      status: () => Promise<{ ready: boolean; vectorCount: number; dims: number; partial?: boolean }>;
      clear: () => Promise<boolean>;
    };
  }
}

/** Exclusive write lease for a clear/backfill job. */
export interface AnnLease {
  readonly owner: string;
  /** Resolves when the lease is released. */
  readonly done: Promise<void>;
  release(): void;
}

type VectorEntry = { id: string; vector: number[] | Float32Array };

class AnnIndexService {
  private _listeners = new Set<() => void>();
  private _ready = false;
  private _partial = true;
  private _vectorCount = 0;
  private _buildProgress = { done: 0, total: 0 };
  private _building = false;
  /** Job that currently owns the build-progress reading (null = free). */
  private _progressOwner: string | null = null;
  private _lease: AnnLease | null = null;
  /** Non-lease writes currently in flight — drained before a lease is granted. */
  private _inflight = new Set<Promise<unknown>>();
  /** Last status round-trip after addVectors — throttled to one per STATUS_SYNC_MS. */
  private _lastStatusSyncAt = 0;
  private _statusSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly STATUS_SYNC_MS = 1000;

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private _notify() { this._listeners.forEach(fn => fn()); }

  get isReady(): boolean { return this._ready; }
  get vectorCount(): number { return this._vectorCount; }
  get isBuilding(): boolean { return this._building; }
  get buildProgress(): Readonly<{ done: number; total: number }> { return this._buildProgress; }
  /** Main reports the in-memory index as not coherent (cleared / half-built / never loaded). */
  get isPartial(): boolean { return this._partial; }
  /** True when a backfill from cache should run (empty, or partial after a clear / crash mid-rebuild). */
  get needsBackfill(): boolean { return !this._ready || this._partial; }
  /** True while a clear/backfill job holds the exclusive write lease. */
  get isLeased(): boolean { return this._lease !== null; }
  get leaseOwner(): string | null { return this._lease?.owner ?? null; }
  get progressOwner(): string | null { return this._progressOwner; }

  // ── Lease ────────────────────────────────────────────────────────────────

  /**
   * Take the exclusive write lease. Waits for any current holder, then for
   * every non-lease write already in flight, so nothing lands mid-clear.
   * Also takes over the build-progress reading.
   */
  async acquireLease(owner: string): Promise<AnnLease> {
    while (this._lease) await this._lease.done;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    let released = false;
    const lease: AnnLease = {
      owner,
      done,
      release: () => {
        if (released) return;
        released = true;
        if (this._lease === lease) this._lease = null;
        resolveDone();
        this._notify();
      },
    };
    this._lease = lease;
    this._progressOwner = owner;
    this._notify();
    if (this._inflight.size > 0) await Promise.allSettled([...this._inflight]);
    return lease;
  }

  /**
   * Resolves once no lease (other than `lease`) is held. With `signal`, also
   * resolves early on abort — callers re-check their signal afterwards.
   */
  async waitForLease(signal?: AbortSignal, lease?: AnnLease): Promise<void> {
    while (this._lease && this._lease !== lease) {
      if (signal?.aborted) return;
      const current = this._lease.done;
      if (!signal) { await current; continue; }
      await new Promise<void>((resolve) => {
        const onAbort = () => resolve();
        signal.addEventListener('abort', onAbort, { once: true });
        void current.then(() => { signal.removeEventListener('abort', onAbort); resolve(); });
      });
    }
  }

  private _isOwner(lease?: AnnLease): boolean {
    return !!lease && this._lease === lease;
  }

  private _track<T>(p: Promise<T>): Promise<T> {
    this._inflight.add(p);
    const done = () => { this._inflight.delete(p); };
    p.then(done, done);
    return p;
  }

  // ── Status ───────────────────────────────────────────────────────────────

  private async _syncStatusFromMain(): Promise<void> {
    if (!window.ann) return;
    try {
      const s = await window.ann.status();
      this._ready = s.ready;
      this._vectorCount = s.vectorCount;
      // Older main builds have no `partial` — trust `ready` alone there.
      this._partial = typeof s.partial === 'boolean' ? s.partial : !s.ready;
      this._notify();
    } catch { /* ignore */ }
  }

  /**
   * Status sync after a write. The embedding passes call addVectors once per
   * group of games, so an unthrottled sync doubled their ANN IPC traffic and
   * re-rendered every subscriber per call. Sync immediately until the index
   * reports ready (so `isReady` flips promptly), then at most once per second
   * with a trailing sync so the final count is never stale.
   */
  private async _syncStatusAfterWrite(): Promise<void> {
    const now = Date.now();
    if (!this._ready || now - this._lastStatusSyncAt >= AnnIndexService.STATUS_SYNC_MS) {
      this._lastStatusSyncAt = now;
      await this._syncStatusFromMain();
      return;
    }
    if (!this._statusSyncTimer) {
      this._statusSyncTimer = setTimeout(() => {
        this._statusSyncTimer = null;
        this._lastStatusSyncAt = Date.now();
        void this._syncStatusFromMain();
      }, AnnIndexService.STATUS_SYNC_MS);
    }
  }

  /** Main makes this a no-op when an index is already in memory (renderer reloads). */
  async load(): Promise<boolean> {
    if (!window.ann) return false;
    try {
      const loaded = await window.ann.load();
      await this._syncStatusFromMain();
      return loaded;
    } catch (err) {
      console.warn('[AnnIndex] load failed:', err);
      return false;
    }
  }

  /**
   * `force` writes now instead of within the main process's 60s save window
   * (use before a watermark). `complete` (lease holder, end of a full backfill)
   * marks the index coherent so main may persist it — main refuses to persist a
   * cleared / partial index otherwise. Non-holders wait out a running lease.
   */
  async save(opts?: { force?: boolean; complete?: boolean; lease?: AnnLease }): Promise<boolean> {
    if (!window.ann) return false;
    const lease = opts?.lease;
    while (this._lease && !this._isOwner(lease)) await this._lease.done;
    try {
      const ipcOpts: { force?: boolean; complete?: boolean } = {};
      if (opts?.force) ipcOpts.force = true;
      if (opts?.complete && this._isOwner(lease)) ipcOpts.complete = true;
      const p = window.ann.save(Object.keys(ipcOpts).length > 0 ? ipcOpts : undefined);
      const ok = await (this._isOwner(lease) ? p : this._track(p));
      if (ipcOpts.complete) await this._syncStatusFromMain();
      return ok;
    } catch (err) {
      console.warn('[AnnIndex] save failed:', err);
      return false;
    }
  }

  private static _normalizeAdd(raw: AnnAddResult | number | null | undefined): AnnAddResult {
    if (typeof raw === 'number') return { added: raw, aborted: false };
    if (raw && typeof raw === 'object') {
      return {
        added: Number(raw.added) || 0,
        replaced: Number(raw.replaced) || 0,
        failed: Number(raw.failed) || 0,
        aborted: raw.aborted === true,
      };
    }
    return { added: 0, aborted: false };
  }

  private async _sendAdd(entries: VectorEntry[]): Promise<AnnAddResult> {
    const first = AnnIndexService._normalizeAdd(await window.ann!.addVectors(entries));
    if (!first.aborted) return first;
    // The index was replaced mid-call (dims change) — upserts are idempotent, so resend once.
    const retry = AnnIndexService._normalizeAdd(await window.ann!.addVectors(entries));
    if (retry.aborted) console.warn(`[AnnIndex] addVectors aborted twice — ${entries.length} vectors not applied`);
    return { ...retry, added: first.added + retry.added };
  }

  /**
   * Add/replace vectors. Returns the number of NEW ids (same contract as
   * before). Without the lease, waits for a running clear/backfill to finish
   * first — the vectors are applied after it, never dropped.
   */
  async addVectors(entries: VectorEntry[], opts?: { lease?: AnnLease }): Promise<number> {
    return (await this.addVectorsDetailed(entries, opts)).added;
  }

  async addVectorsDetailed(entries: VectorEntry[], opts?: { lease?: AnnLease }): Promise<AnnAddResult> {
    if (!window.ann || entries.length === 0) return { added: 0, aborted: false };
    const lease = opts?.lease;
    // NB: the lease check and the in-flight registration below run in the same
    // synchronous step, so acquireLease's drain can never miss this write.
    while (this._lease && !this._isOwner(lease)) await this._lease.done;
    try {
      const p = this._sendAdd(entries);
      const result = await (this._isOwner(lease) ? p : this._track(p));
      await this._syncStatusAfterWrite();
      return result;
    } catch (err) {
      console.warn('[AnnIndex] addVectors failed:', err);
      return { added: 0, aborted: false, failed: entries.length };
    }
  }

  /** Clear the index. Only a lease holder may clear while a lease is held. */
  async clear(opts?: { lease?: AnnLease }): Promise<boolean> {
    if (!window.ann) return false;
    const lease = opts?.lease;
    while (this._lease && !this._isOwner(lease)) await this._lease.done;
    try {
      const ok = await window.ann.clear();
      await this._syncStatusFromMain();
      return ok;
    } catch (err) {
      console.warn('[AnnIndex] clear failed:', err);
      return false;
    }
  }

  async query(centroid: number[] | Float32Array, k: number, excludeId?: string): Promise<string[]> {
    if (!window.ann || !this._ready) return [];
    try {
      const centroidArray = centroid instanceof Float32Array ? Array.from(centroid) : centroid;
      const results = await window.ann.query(centroidArray, k, excludeId);
      return results.map(r => r.id);
    } catch (err) {
      console.warn('[AnnIndex] query failed:', err);
      return [];
    }
  }

  async queryWithDistances(centroid: number[] | Float32Array, k: number, excludeId?: string): Promise<Array<{ id: string; distance: number }>> {
    if (!window.ann || !this._ready) return [];
    try {
      const centroidArray = centroid instanceof Float32Array ? Array.from(centroid) : centroid;
      return await window.ann.query(centroidArray, k, excludeId);
    } catch (err) {
      console.warn('[AnnIndex] queryWithDistances failed:', err);
      return [];
    }
  }

  async queryBatch(entries: VectorEntry[], k: number): Promise<Record<string, Array<{ id: string; distance: number }>>> {
    if (!window.ann || !this._ready) return {};
    try {
      return await window.ann.queryBatch(entries, k);
    } catch (err) {
      console.warn('[AnnIndex] queryBatch failed:', err);
      return {};
    }
  }

  async refreshStatus(): Promise<void> {
    await this._syncStatusFromMain();
  }

  // ── Build progress (single owner) ────────────────────────────────────────

  /**
   * Update the build-progress reading. Ignored unless `owner` holds it or it
   * is free (then `owner` takes it). Ownership ends at finishBuild(owner) or
   * when the owner reports done >= total. Returns whether it was applied.
   */
  setBuildProgress(done: number, total: number, owner = 'default'): boolean {
    if (this._progressOwner !== null && this._progressOwner !== owner) return false;
    this._building = done < total;
    this._buildProgress = { done, total };
    this._progressOwner = this._building ? owner : null;
    this._notify();
    return true;
  }

  /** End the build reading — only by the job that owns it (or anyone when unowned). */
  finishBuild(owner = 'default'): boolean {
    if (this._progressOwner !== null && this._progressOwner !== owner) return false;
    this._progressOwner = null;
    this._building = false;
    this._notify();
    return true;
  }
}

export const annIndex = new AnnIndexService();
