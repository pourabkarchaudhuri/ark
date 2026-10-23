/**
 * Oracle event log — buffered append-only writes, ordering, cap/trim, and
 * the "never throws, no-op without a store" guarantees.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { oracleEventLog, ORACLE_EVENT_MAX_ROWS } from '@/services/oracle-event-log';

type Row = { key: string; value: any };

function installFakeStore(opts: { failBatch?: boolean } = {}) {
  const db = new Map<string, unknown>();
  const calls = { batch: 0 };
  const ns = (k: string) => k.split('::');
  const fake = {
    get: async (namespace: string, key: string) => ({ value: db.get(`${namespace}::${key}`) ?? null }),
    getAll: async (namespace: string) => {
      const rows: Row[] = [];
      for (const [k, v] of db) {
        const [n, ...rest] = ns(k);
        if (n === namespace) rows.push({ key: rest.join('::'), value: v });
      }
      return { rows };
    },
    getChunk: async (namespace: string, { limit }: { limit: number }) => {
      const keys: string[] = [];
      for (const k of db.keys()) {
        const [n, ...rest] = ns(k);
        if (n === namespace) keys.push(rest.join('::'));
      }
      keys.sort();
      const rows = keys.slice(0, limit).map(key => ({ key, value: db.get(`${namespace}::${key}`) }));
      return { rows, done: rows.length < limit };
    },
    batch: async (ops: any[]) => {
      calls.batch++;
      if (opts.failBatch) return { error: 'boom' };
      for (const op of ops) {
        if (op.type === 'put') db.set(`${op.namespace}::${op.key}`, op.value);
        else db.delete(`${op.namespace}::${op.key}`);
      }
      return { ok: true };
    },
    put: async () => ({ ok: true }),
    del: async () => ({ ok: true }),
    has: async () => ({ value: false }),
    clearNamespace: async () => ({ ok: true }),
  };
  Object.defineProperty(window, 'store', { value: fake, writable: true, configurable: true });
  return { db, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
  oracleEventLog.__resetForTests();
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
});

describe('oracleEventLog', () => {
  it('is a silent no-op without window.store', async () => {
    expect(() => oracleEventLog.record({ type: 'click', gameId: 'steam-1' })).not.toThrow();
    await expect(oracleEventLog.readAll()).resolves.toEqual([]);
  });

  it('buffers events and writes them in a single batch, oldest first', async () => {
    const { calls } = installFakeStore();
    oracleEventLog.record({ type: 'click', gameId: 'steam-1', shelfType: 'hero' });
    oracleEventLog.record({ type: 'dismiss', gameId: 'steam-2' });
    oracleEventLog.record({ type: 'thumbs', gameId: 'steam-3', data: { value: -1 } });
    expect(calls.batch).toBe(0);

    await vi.advanceTimersByTimeAsync(1_100);
    expect(calls.batch).toBe(1);

    const all = await oracleEventLog.readAll();
    expect(all.map(e => e.type)).toEqual(['click', 'dismiss', 'thumbs']);
    expect(all[2].data).toEqual({ value: -1 });
    expect(all.every(e => typeof e.t === 'number')).toBe(true);
  });

  it('keeps same-millisecond events distinct and ordered via the sequence suffix', async () => {
    installFakeStore();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    for (let i = 0; i < 5; i++) oracleEventLog.record({ type: 'click', gameId: `g${i}` });
    const all = await oracleEventLog.readAll();
    expect(all.map(e => e.gameId)).toEqual(['g0', 'g1', 'g2', 'g3', 'g4']);
  });

  it('flushes immediately once the buffer is full', async () => {
    const { calls } = installFakeStore();
    for (let i = 0; i < 50; i++) oracleEventLog.record({ type: 'click', gameId: `g${i}` });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.batch).toBeGreaterThanOrEqual(1);
  });

  it('trims the oldest rows once the cap plus slack is exceeded', async () => {
    const { db } = installFakeStore();
    // Pre-seed the namespace right at the limit with a meta row.
    for (let i = 0; i < ORACLE_EVENT_MAX_ROWS + 1_990; i++) {
      db.set(`oracle-events::${String(i).padStart(13, '0')}-0000`, { type: 'click', t: i });
    }
    db.set('oracle-events::_meta', { count: ORACLE_EVENT_MAX_ROWS + 1_990 });

    for (let i = 0; i < 20; i++) oracleEventLog.record({ type: 'click', gameId: `new${i}` });
    await oracleEventLog.flush();

    const meta = db.get('oracle-events::_meta') as { count: number };
    expect(meta.count).toBeLessThanOrEqual(ORACLE_EVENT_MAX_ROWS);
    // Oldest seeded row gone, newest events still present.
    expect(db.has(`oracle-events::${String(0).padStart(13, '0')}-0000`)).toBe(false);
    const all = await oracleEventLog.readAll();
    expect(all.some(e => e.gameId === 'new19')).toBe(true);
  });

  it('swallows storage errors instead of throwing', async () => {
    installFakeStore({ failBatch: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    oracleEventLog.record({ type: 'click', gameId: 'steam-1' });
    await expect(oracleEventLog.flush()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
