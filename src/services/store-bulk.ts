/**
 * Bulk LevelDB reads over the `window.store` IPC surface.
 *
 * Fanning out hundreds of `store.get` calls per tick is what used to exhaust
 * the store IPC rate limiter and silently drop rows. `storeGetMany` uses the
 * single-round-trip `store:getMany` channel (v1.0.73) and only falls back to
 * small, sequential `get` slices when it is unavailable (older preload, tests).
 */

const GET_MANY_CHUNK = 2000;
const FALLBACK_SLICE = 100;
/** Keys per `store:countExisting` call (the handler caps a call at 10k keys). */
const COUNT_EXISTING_CHUNK = 10_000;

/**
 * Values for `keys` in order (`null` = missing or unreadable). Throws only if
 * the bulk channel reports an error; per-key fallback failures read as `null`.
 */
export async function storeGetMany<T>(namespace: string, keys: string[]): Promise<Array<T | null>> {
  const store = window.store;
  if (!store || keys.length === 0) return keys.map(() => null);
  const out: Array<T | null> = new Array(keys.length).fill(null);
  if (typeof store.getMany === 'function') {
    for (let i = 0; i < keys.length; i += GET_MANY_CHUNK) {
      const slice = keys.slice(i, i + GET_MANY_CHUNK);
      const res = await store.getMany<T>(namespace, slice);
      if (res.error || !res.values) throw new Error(`[store-bulk] getMany(${namespace}) failed: ${res.error ?? 'no values'}`);
      for (let j = 0; j < slice.length; j++) out[i + j] = res.values[j] ?? null;
    }
    return out;
  }
  for (let i = 0; i < keys.length; i += FALLBACK_SLICE) {
    const slice = keys.slice(i, i + FALLBACK_SLICE);
    const settled = await Promise.all(slice.map((k) => store.get<T>(namespace, k)));
    for (let j = 0; j < slice.length; j++) out[i + j] = (settled[j]?.value ?? null) as T | null;
  }
  return out;
}

/**
 * How many of `keys` exist in `namespace`, without shipping the rows back.
 * Uses the main-process `store:countExisting` channel (no row decode, no
 * structured clone of values); older preloads fall back to `getMany` slices,
 * summed and dropped one slice at a time. Throws when the store reports an
 * error, so callers can fall back instead of reading a failure as "0 stored".
 */
export async function storeCountExisting(namespace: string, keys: string[]): Promise<number> {
  const store = window.store;
  if (!store || keys.length === 0) return 0;
  let total = 0;
  if (typeof store.countExisting === 'function') {
    for (let i = 0; i < keys.length; i += COUNT_EXISTING_CHUNK) {
      const res = await store.countExisting(namespace, keys.slice(i, i + COUNT_EXISTING_CHUNK));
      if (res.error || typeof res.count !== 'number') {
        throw new Error(`[store-bulk] countExisting(${namespace}) failed: ${res.error ?? 'no count'}`);
      }
      total += res.count;
    }
    return total;
  }
  for (let i = 0; i < keys.length; i += GET_MANY_CHUNK) {
    const slice = await storeGetMany<unknown>(namespace, keys.slice(i, i + GET_MANY_CHUNK));
    total += slice.filter((v) => v != null).length;
  }
  return total;
}
