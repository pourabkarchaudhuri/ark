import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeFakeLevelStore, installFakeLevelStore, batchesFor } from './fake-level-store';

const NS = 'transmissions-history';
const MAX_IDS = 2000;

async function loadFresh() {
  vi.resetModules();
  const mod = await import('@/services/transmissions-history-store');
  return mod.transmissionsHistoryStore;
}

let api: any;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ark-transmissions-decoded-migrated-v1', 'yes');
});

afterEach(() => {
  installFakeLevelStore(undefined);
});

describe('transmissions decode history — eviction by age after restart', () => {
  it('evicts the oldest decode (lowest value), not the alphabetically first id', async () => {
    // Key order and age order disagree: "a-*" ids are the NEWEST decodes,
    // "z-old" is the oldest, and legacy rows (value 1) sort oldest of all.
    const rows: Array<{ key: string; value: unknown }> = [];
    for (let i = 0; i < MAX_IDS - 2; i++) {
      rows.push({ key: `a-${String(i).padStart(5, '0')}`, value: 1_000_000 + i });
    }
    rows.push({ key: 'z-old', value: 10 });
    rows.push({ key: 'm-legacy', value: 1 });
    api = makeFakeLevelStore({ [NS]: rows });
    installFakeLevelStore(api);

    const store = await loadFresh();
    await store.ready();
    expect(store.getDecodedIds().size).toBe(MAX_IDS);

    store.markDecoded('new-1');
    await Promise.resolve();
    expect(store.hasDecoded('m-legacy')).toBe(false); // value 1 = oldest
    expect(store.hasDecoded('z-old')).toBe(true);
    expect(store.hasDecoded('a-00000')).toBe(true);

    store.markDecoded('new-2');
    expect(store.hasDecoded('z-old')).toBe(false);
    expect(store.hasDecoded('a-00000')).toBe(true);
  });

  it('writes the decode time as the row value', async () => {
    api = makeFakeLevelStore();
    installFakeLevelStore(api);
    const store = await loadFresh();
    await store.ready();
    const before = Date.now();
    store.markDecoded('t-1');
    await new Promise((r) => setTimeout(r, 0));
    const [ops] = batchesFor(api, NS);
    expect(ops[0].key).toBe('t-1');
    expect(ops[0].value).toBeGreaterThanOrEqual(before);
  });

  it('migration stamps increasing values in legacy order', async () => {
    localStorage.removeItem('ark-transmissions-decoded-migrated-v1');
    localStorage.setItem('ark-transmissions-decoded', JSON.stringify(['zz', 'aa', 'mm']));
    api = makeFakeLevelStore();
    installFakeLevelStore(api);
    const store = await loadFresh();
    await store.ready();
    const stored = api.data.get(NS);
    expect(stored.get('zz')).toBeLessThan(stored.get('aa'));
    expect(stored.get('aa')).toBeLessThan(stored.get('mm'));
  });

  it('ids decoded before the hydrate finished survive it', async () => {
    api = makeFakeLevelStore({ [NS]: [{ key: 'stored-1', value: 5 }] });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realGetAll = api.getAll.getMockImplementation();
    api.getAll.mockImplementation(async (ns: string) => {
      await gate;
      return realGetAll(ns);
    });
    installFakeLevelStore(api);
    const store = await loadFresh();
    store.markDecoded('early-1');
    release();
    await store.ready();
    expect(store.hasDecoded('early-1')).toBe(true);
    expect(store.hasDecoded('stored-1')).toBe(true);
    // early-1 is the newest: it is listed after the stored row.
    expect([...store.getDecodedIds()]).toEqual(['stored-1', 'early-1']);
  });
});
