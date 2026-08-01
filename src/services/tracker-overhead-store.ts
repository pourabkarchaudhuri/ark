/**
 * tracker-overhead-store.ts
 *
 * Renderer-side, memory-only ring buffer for tracker overhead samples
 * (CPU %, RSS MB, hook latency ms) streamed from the main process via
 * the `telemetryAPI.onSample` IPC bridge exposed by preload.
 *
 * Nothing is persisted to disk. The buffer is bounded so long-running
 * sessions cannot grow memory without bound.
 *
 * UI listeners are notified on a ~3s throttle so charts stay live-ish
 * without re-rendering on every main-process poll tick. The buffer itself
 * always accepts samples immediately.
 */

export interface OverheadSample {
  timestamp: number;
  gameId: string | null;
  cpuPercent: number;
  rssMb: number;
  hookLatencyMs: number;
}

const RING_CAPACITY = 4096;
/** Coalesce UI notifications into the safe 2–5s window. */
export const OVERHEAD_UI_THROTTLE_MS = 3000;

type Listener = () => void;

interface TelemetryAPI {
  onSample?: (cb: (sample: OverheadSample) => void) => (() => void) | void;
}

declare global {
  interface Window {
    telemetryAPI?: TelemetryAPI;
  }
}

/** Accept number or ISO string timestamps from the main-process bridge. */
export function normalizeOverheadSample(raw: unknown): OverheadSample | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  let timestamp: number;
  if (typeof r.timestamp === 'number' && Number.isFinite(r.timestamp)) {
    timestamp = r.timestamp;
  } else if (typeof r.timestamp === 'string') {
    const parsed = Date.parse(r.timestamp);
    if (!Number.isFinite(parsed)) return null;
    timestamp = parsed;
  } else {
    return null;
  }

  const cpuPercent = Number(r.cpuPercent);
  const rssMb = Number(r.rssMb);
  const hookLatencyMs = Number(r.hookLatencyMs);
  if (![cpuPercent, rssMb, hookLatencyMs].every(Number.isFinite)) return null;

  const gameId =
    r.gameId == null
      ? null
      : typeof r.gameId === 'string'
        ? r.gameId
        : typeof r.gameId === 'number'
          ? `steam-${r.gameId}`
          : String(r.gameId);

  return { timestamp, gameId, cpuPercent, rssMb, hookLatencyMs };
}

class TrackerOverheadStore {
  private readonly capacity = RING_CAPACITY;
  private buffer: (OverheadSample | undefined)[] = new Array(RING_CAPACITY);
  private writeIndex = 0;
  private size = 0;
  private listeners = new Set<Listener>();
  /** Cached snapshot so useSyncExternalStore getSnapshot stays referentially stable. */
  private cachedAll: readonly OverheadSample[] | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private emitPending = false;

  ingest(raw: OverheadSample | unknown): void {
    const sample = normalizeOverheadSample(raw);
    if (!sample) return;

    this.buffer[this.writeIndex] = sample;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size += 1;
    }
    this.cachedAll = null;
    this.scheduleEmit();
  }

  getAll(): readonly OverheadSample[] {
    if (this.cachedAll) return this.cachedAll;
    if (this.size === 0) {
      this.cachedAll = EMPTY;
      return EMPTY;
    }
    const out: OverheadSample[] = new Array(this.size);
    // Oldest sample is at writeIndex when buffer is full; otherwise at 0.
    const start = this.size < this.capacity ? 0 : this.writeIndex;
    for (let i = 0; i < this.size; i += 1) {
      const idx = (start + i) % this.capacity;
      out[i] = this.buffer[idx] as OverheadSample;
    }
    this.cachedAll = out;
    return out;
  }

  getForGame(gameId: string, sinceMs?: number): OverheadSample[] {
    const all = this.getAll();
    const cutoff = typeof sinceMs === 'number' ? sinceMs : -Infinity;
    const out: OverheadSample[] = [];
    for (let i = 0; i < all.length; i += 1) {
      const s = all[i];
      if (s.gameId === gameId && s.timestamp >= cutoff) {
        out.push(s);
      }
    }
    return out;
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.writeIndex = 0;
    this.size = 0;
    this.cachedAll = null;
    this.scheduleEmit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Flush any pending throttled notification (tests / teardown). */
  flush(): void {
    if (this.emitTimer != null) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    if (this.emitPending) {
      this.emitPending = false;
      this.emitNow();
    }
  }

  private scheduleEmit(): void {
    this.emitPending = true;
    if (this.emitTimer != null) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (!this.emitPending) return;
      this.emitPending = false;
      this.emitNow();
    }, OVERHEAD_UI_THROTTLE_MS);
  }

  private emitNow(): void {
    this.listeners.forEach((l) => {
      try {
        l();
      } catch {
        // Swallow — a broken listener must not corrupt the store.
      }
    });
  }
}

const EMPTY: readonly OverheadSample[] = Object.freeze([]);

export const trackerOverheadStore = new TrackerOverheadStore();

// SSR / test-safe subscription: only wire up if the preload bridge is
// present in this environment.
if (typeof window !== 'undefined' && window.telemetryAPI?.onSample) {
  try {
    window.telemetryAPI.onSample((sample: OverheadSample) => {
      trackerOverheadStore.ingest(sample);
    });
  } catch {
    // Ignore — bridge failure must not break the renderer.
  }
}
