/**
 * tracker-overhead-store — normalize samples, stable snapshots, throttled notify.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trackerOverheadStore } from '@/services/tracker-overhead-store';

describe('trackerOverheadStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    trackerOverheadStore.clear();
    // clear() schedules a throttled emit — flush so tests start quiet
    trackerOverheadStore.flush();
  });

  afterEach(() => {
    trackerOverheadStore.clear();
    trackerOverheadStore.flush();
    vi.useRealTimers();
  });

  it('normalizes ISO string timestamps to epoch ms on ingest', () => {
    const iso = '2026-08-01T10:15:00.000Z';
    trackerOverheadStore.ingest({
      timestamp: iso as unknown as number,
      gameId: 'steam-730',
      cpuPercent: 1.5,
      rssMb: 220,
      hookLatencyMs: 12,
    });
    vi.advanceTimersByTime(5000);

    const all = trackerOverheadStore.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].timestamp).toBe(Date.parse(iso));
    expect(typeof all[0].timestamp).toBe('number');
  });

  it('returns a stable getAll() reference until the next ingest', () => {
    trackerOverheadStore.ingest({
      timestamp: 1_700_000_000_000,
      gameId: 'steam-730',
      cpuPercent: 1,
      rssMb: 100,
      hookLatencyMs: 5,
    });
    vi.advanceTimersByTime(5000);

    const a = trackerOverheadStore.getAll();
    const b = trackerOverheadStore.getAll();
    expect(a).toBe(b);
  });

  it('throttles listener notifications to ~5s while still buffering samples', () => {
    const listener = vi.fn();
    const unsub = trackerOverheadStore.subscribe(listener);

    trackerOverheadStore.ingest({
      timestamp: 1,
      gameId: 'g',
      cpuPercent: 1,
      rssMb: 1,
      hookLatencyMs: 1,
    });
    trackerOverheadStore.ingest({
      timestamp: 2,
      gameId: 'g',
      cpuPercent: 2,
      rssMb: 2,
      hookLatencyMs: 2,
    });

    // Buffer accepts both immediately
    expect(trackerOverheadStore.getAll()).toHaveLength(2);
    // But listeners are coalesced
    expect(listener).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4999);
    expect(listener).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
  });
});
