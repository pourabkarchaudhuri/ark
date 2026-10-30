import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeFakeLevelStore, installFakeLevelStore } from './fake-level-store';

/**
 * reco-history and shelf-bandit used to load the frozen v1.0.61 localStorage
 * snapshot first; a failed boot read then let the next dismiss/impression
 * save that stale data over the real LevelDB rows.
 */

const RECO_MARKERS = ['ark-reco-dismissed-v1-migrated-v1', 'ark-reco-history-v1-migrated-v1'];
const BANDIT_MARKER = 'ark-shelf-bandit-v1-migrated-v1';

async function loadReco() {
  vi.resetModules();
  const health = await import('@/services/storage-health');
  health.__setStorageRetryDelaysForTests([0, 0]);
  const mod = await import('@/services/reco-history-store');
  await mod.recoHistoryStore.ready;
  return mod.recoHistoryStore;
}

async function loadBandit() {
  vi.resetModules();
  const health = await import('@/services/storage-health');
  health.__setStorageRetryDelaysForTests([0, 0]);
  const mod = await import('@/services/shelf-bandit-store');
  await mod.shelfBanditStore.ready;
  return mod.shelfBanditStore;
}

let api: any;

beforeEach(() => {
  localStorage.clear();
  api = makeFakeLevelStore();
  installFakeLevelStore(api);
});

afterEach(() => {
  vi.useRealTimers();
  installFakeLevelStore(undefined);
});

describe('RecoHistoryStore — boot read failure', () => {
  it('goes read-only and never batches after a failed getAll (markers set)', async () => {
    for (const k of RECO_MARKERS) localStorage.setItem(k, 'yes');
    localStorage.setItem('ark-reco-dismissed-v1', JSON.stringify([{ gameId: 'steam-stale', at: 1 }]));
    api.getAll.mockImplementation(async () => ({ error: 'IO error' }));
    const store = await loadReco();
    expect(api.getAll).toHaveBeenCalledTimes(3);
    expect(store.isReadOnly()).toBe(true);
    // The frozen snapshot is not loaded once migrated.
    expect(store.isDismissed('steam-stale')).toBe(false);

    vi.useFakeTimers();
    store.dismiss('steam-1', { title: 'One' });
    store.recordClick('steam-2', 'Two', 'hero');
    await vi.advanceTimersByTimeAsync(1000);
    window.dispatchEvent(new Event('beforeunload'));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.batch).not.toHaveBeenCalled();
    // In-memory updates still work.
    expect(store.isDismissed('steam-1')).toBe(true);
  });

  it('a throwing getAll also goes read-only', async () => {
    for (const k of RECO_MARKERS) localStorage.setItem(k, 'yes');
    api.getAll.mockImplementation(async () => { throw new Error('bridge gone'); });
    const store = await loadReco();
    expect(store.isReadOnly()).toBe(true);
  });

  it('markers set + empty namespace: dismissals are empty after init', async () => {
    for (const k of RECO_MARKERS) localStorage.setItem(k, 'yes');
    localStorage.setItem('ark-reco-dismissed-v1', JSON.stringify([{ gameId: 'steam-stale', at: 1 }]));
    const store = await loadReco();
    expect(store.isReadOnly()).toBe(false);
    expect(store.getDismissedIds()).toEqual([]);
  });

  it('pre-migration still copies the legacy snapshot into LevelDB', async () => {
    localStorage.setItem('ark-reco-dismissed-v1', JSON.stringify([{ gameId: 'steam-legacy', at: 5 }]));
    const store = await loadReco();
    expect(store.isDismissed('steam-legacy')).toBe(true);
    expect(api.data.get('reco-history')?.has('d:steam-legacy')).toBe(true);
  });
});

describe('ShelfBanditStore — boot read failure', () => {
  it('goes read-only and never batches after a failed getAll (marker set)', async () => {
    localStorage.setItem(BANDIT_MARKER, 'yes');
    localStorage.setItem('ark-shelf-bandit-v1', JSON.stringify({ 'hidden-gems': { alpha: 9, beta: 1, impressions: 50, clicks: 8 } }));
    api.getAll.mockImplementation(async () => ({ error: 'IO error' }));
    const store = await loadBandit();
    expect(store.isReadOnly()).toBe(true);
    expect(store.getStats()['hidden-gems']).toBeUndefined();

    vi.useFakeTimers();
    store.recordImpression('hero', 'i-1', 0);
    store.recordClick('hero', 'i-1');
    await vi.advanceTimersByTimeAsync(1000);
    window.dispatchEvent(new Event('beforeunload'));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.batch).not.toHaveBeenCalled();
    expect(store.getStats().hero?.impressions).toBeGreaterThan(0);
  });

  it('marker set + empty namespace: arms are empty after init', async () => {
    localStorage.setItem(BANDIT_MARKER, 'yes');
    localStorage.setItem('ark-shelf-bandit-v1', JSON.stringify({ 'hidden-gems': { alpha: 9, beta: 1, impressions: 50, clicks: 8 } }));
    const store = await loadBandit();
    expect(store.isReadOnly()).toBe(false);
    expect(Object.keys(store.getStats())).toEqual([]);
  });
});
