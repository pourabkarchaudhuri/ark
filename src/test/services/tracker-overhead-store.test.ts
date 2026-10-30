/**
 * tracker-overhead-store — getAll() snapshot stability (1.0.97 B23).
 * useSyncExternalStore compares snapshots by reference, so getAll() must
 * return the same array until the buffer actually changes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { trackerOverheadStore, type OverheadSample } from '@/services/tracker-overhead-store';

function sample(i: number, gameId: string | null = 'steam-1'): OverheadSample {
  return { timestamp: 1_000 + i, gameId, cpuPercent: 1, rssMb: 100, hookLatencyMs: 2 };
}

describe('trackerOverheadStore.getAll snapshot', () => {
  beforeEach(() => {
    trackerOverheadStore.clear();
  });

  it('returns the same empty reference when nothing was ingested', () => {
    expect(trackerOverheadStore.getAll()).toBe(trackerOverheadStore.getAll());
    expect(trackerOverheadStore.getAll()).toHaveLength(0);
  });

  it('returns the same reference across calls with no ingest', () => {
    trackerOverheadStore.ingest(sample(1));
    const a = trackerOverheadStore.getAll();
    const b = trackerOverheadStore.getAll();
    expect(a).toBe(b);
    expect(a).toHaveLength(1);
  });

  it('returns a new reference after ingest and after clear', () => {
    trackerOverheadStore.ingest(sample(1));
    const a = trackerOverheadStore.getAll();
    trackerOverheadStore.ingest(sample(2));
    const b = trackerOverheadStore.getAll();
    expect(b).not.toBe(a);
    expect(b.map((s) => s.timestamp)).toEqual([1_001, 1_002]);
    trackerOverheadStore.clear();
    const c = trackerOverheadStore.getAll();
    expect(c).not.toBe(b);
    expect(c).toHaveLength(0);
  });

  it('returns a frozen array', () => {
    trackerOverheadStore.ingest(sample(1));
    expect(Object.isFrozen(trackerOverheadStore.getAll())).toBe(true);
  });

  it('getForGame still filters from the cached snapshot', () => {
    trackerOverheadStore.ingest(sample(1, 'a'));
    trackerOverheadStore.ingest(sample(2, 'b'));
    trackerOverheadStore.ingest(sample(3, 'a'));
    expect(trackerOverheadStore.getForGame('a').map((s) => s.timestamp)).toEqual([1_001, 1_003]);
    expect(trackerOverheadStore.getForGame('a', 1_002).map((s) => s.timestamp)).toEqual([1_003]);
  });
});
