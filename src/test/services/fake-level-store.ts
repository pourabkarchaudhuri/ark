import { vi } from 'vitest';

/**
 * Minimal in-memory stand-in for the preload `window.store` LevelDB bridge,
 * shared by the store persistence tests. `rows` seeds namespaces;
 * `batch` is a vi.fn so tests can swap in failures.
 */
export function makeFakeLevelStore(rows: Record<string, Array<{ key: string; value: unknown }>> = {}) {
  const data = new Map<string, Map<string, unknown>>();
  for (const [ns, list] of Object.entries(rows)) {
    data.set(ns, new Map(list.map((r) => [r.key, r.value])));
  }
  const nsMap = (ns: string) => {
    let m = data.get(ns);
    if (!m) {
      m = new Map();
      data.set(ns, m);
    }
    return m;
  };
  const applyBatch = (ops: Array<{ type: 'put' | 'del'; namespace: string; key: string; value?: unknown }>) => {
    for (const op of ops) {
      if (op.type === 'put') nsMap(op.namespace).set(op.key, JSON.parse(JSON.stringify(op.value)));
      else nsMap(op.namespace).delete(op.key);
    }
    return { ok: true };
  };
  const api: any = {
    data,
    applyBatch,
    getAll: vi.fn(async (ns: string) => ({
      rows: [...nsMap(ns).entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => ({ key, value })),
    })),
    get: vi.fn(async (ns: string, key: string) => ({ value: nsMap(ns).get(key) ?? null })),
    put: vi.fn(async (ns: string, key: string, value: unknown) => {
      nsMap(ns).set(key, JSON.parse(JSON.stringify(value)));
      return { ok: true };
    }),
    del: vi.fn(async (ns: string, key: string) => {
      nsMap(ns).delete(key);
      return { ok: true };
    }),
    batch: vi.fn(async (ops: any[]) => applyBatch(ops)),
    has: vi.fn(async (ns: string, key: string) => ({ value: nsMap(ns).has(key) })),
    clearNamespace: vi.fn(async (ns: string) => {
      data.delete(ns);
      return { ok: true };
    }),
  };
  return api;
}

export function installFakeLevelStore(api: unknown): void {
  Object.defineProperty(window, 'store', { value: api, configurable: true, writable: true });
}

/** batch calls that touched `namespace`. */
export function batchesFor(api: any, namespace: string): any[][] {
  return api.batch.mock.calls
    .map((c: any[]) => c[0] as any[])
    .filter((ops: any[]) => ops.some((op) => op.namespace === namespace));
}
