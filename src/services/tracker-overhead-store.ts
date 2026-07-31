/**
 * tracker-overhead-store.ts
 *
 * Renderer-side, memory-only ring buffer for tracker overhead samples
 * (CPU %, RSS MB, hook latency ms) streamed from the main process via
 * the `telemetryAPI.onSample` IPC bridge exposed by preload.
 *
 * Nothing is persisted to disk. The buffer is bounded so long-running
 * sessions cannot grow memory without bound.
 */

export interface OverheadSample {
  timestamp: number;
  gameId: string | null;
  cpuPercent: number;
  rssMb: number;
  hookLatencyMs: number;
}

const RING_CAPACITY = 4096;

type Listener = () => void;

interface TelemetryAPI {
  onSample?: (cb: (sample: OverheadSample) => void) => (() => void) | void;
}

declare global {
  interface Window {
    telemetryAPI?: TelemetryAPI;
  }
}

class TrackerOverheadStore {
  private readonly capacity = RING_CAPACITY;
  private buffer: (OverheadSample | undefined)[] = new Array(RING_CAPACITY);
  private writeIndex = 0;
  private size = 0;
  private listeners = new Set<Listener>();

  ingest(sample: OverheadSample): void {
    this.buffer[this.writeIndex] = sample;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size += 1;
    }
    this.emit();
  }

  getAll(): readonly OverheadSample[] {
    if (this.size === 0) {
      return EMPTY;
    }
    const out: OverheadSample[] = new Array(this.size);
    // Oldest sample is at writeIndex when buffer is full; otherwise at 0.
    const start = this.size < this.capacity ? 0 : this.writeIndex;
    for (let i = 0; i < this.size; i += 1) {
      const idx = (start + i) % this.capacity;
      out[i] = this.buffer[idx] as OverheadSample;
    }
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
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
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
