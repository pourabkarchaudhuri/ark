/**
 * Preload `window.store` (1.0.97): main caps store:batch at 5000 ops, so the
 * preload splits larger writes (a full library or session-history rewrite can
 * pass that) into sequential slices and stops at the first error. Every
 * store's write is an idempotent put/del diff that is replayed whole after an
 * error, so a slice that already landed is harmless. Also exposes store:count.
 *
 * The preload is evaluated with a fake `electron` (it is plain CJS that only
 * touches contextBridge / ipcRenderer at load time).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PRELOAD = path.resolve(__dirname, '../../../electron/preload.cjs');

function loadPreload(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>) {
  const apis: Record<string, any> = {};
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { apis[name] = api; } },
    ipcRenderer: new Proxy({ invoke } as Record<string, unknown>, {
      get: (target, prop) => (prop in target ? target[prop as string] : () => undefined),
    }),
  };
  const fakeRequire = (id: string) => {
    if (id === 'electron') return electron;
    throw new Error(`unexpected require(${id})`);
  };
  const fakeConsole = { ...console, log: () => {} };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('require', 'process', 'console', fs.readFileSync(PRELOAD, 'utf-8'))(
    fakeRequire, { env: { NODE_ENV: 'production' }, platform: 'win32' }, fakeConsole,
  );
  return apis.store;
}

const put = (i: number) => ({ type: 'put', namespace: 'library', key: `k${i}`, value: i });

describe('preload store.batch', () => {
  it('sends a batch of up to 5000 ops as one IPC call', async () => {
    const calls: unknown[][] = [];
    const store = loadPreload(async (ch, ...args) => { calls.push([ch, ...args]); return { ok: true }; });
    expect(await store.batch(Array.from({ length: 5000 }, (_, i) => put(i)))).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect((calls[0][1] as unknown[]).length).toBe(5000);
  });

  it('splits 12001 ops into 5000-op slices, in order', async () => {
    const sizes: number[] = [];
    const seen: string[] = [];
    const store = loadPreload(async (_ch, ops) => {
      sizes.push((ops as unknown[]).length);
      for (const op of ops as Array<{ key: string }>) seen.push(op.key);
      return { ok: true };
    });
    const ops = Array.from({ length: 12001 }, (_, i) => put(i));
    expect(await store.batch(ops)).toEqual({ ok: true });
    expect(sizes).toEqual([5000, 5000, 2001]);
    expect(seen).toEqual(ops.map((o) => o.key));
  });

  it('stops at the first failing slice and returns its error', async () => {
    let n = 0;
    const store = loadPreload(async () => (++n === 2 ? { error: 'disk full' } : { ok: true }));
    expect(await store.batch(Array.from({ length: 15000 }, (_, i) => put(i)))).toEqual({ error: 'disk full' });
    expect(n).toBe(2);
  });

  it('passes non-array input through for main to reject', async () => {
    const calls: unknown[][] = [];
    const store = loadPreload(async (ch, ...args) => { calls.push([ch, ...args]); return { error: 'ops must be an array' }; });
    expect(await store.batch('nope')).toEqual({ error: 'ops must be an array' });
    expect(calls).toEqual([['store:batch', 'nope']]);
  });

  it('exposes store:count', async () => {
    const calls: unknown[][] = [];
    const store = loadPreload(async (ch, ...args) => { calls.push([ch, ...args]); return { value: 3 }; });
    expect(await store.count('embed-catalog', { keys: true })).toEqual({ value: 3 });
    expect(calls).toEqual([['store:count', 'embed-catalog', { keys: true }]]);
  });
});
