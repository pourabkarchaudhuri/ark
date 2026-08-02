/**
 * LevelDB Storage Foundation (v1.0.61)
 *
 * A single-owner LevelDB instance in the Electron main process.
 * Exposed to the renderer via the `store:*` IPC surface (see
 * `electron/ipc/store-handlers.ts`).
 *
 * Design notes:
 *  - Single LevelDB opened lazily at `<userData>/leveldb`.
 *  - LevelDB has no true "tables"; namespaces are implemented as
 *    a key prefix `{namespace}::` on every stored key.
 *  - Values are JSON-encoded on `put`, JSON-decoded on `get`. Non-JSON-
 *    serialisable values are rejected (logged + thrown).
 *  - Errors are logged through the existing `safe-logger`.
 *  - Callers should invoke `close()` on shutdown; `electron/main.ts`
 *    wires this into `app.on('will-quit')`.
 *
 * This is FOUNDATION only — no renderer-store yet touches it. Individual
 * store migrations happen in the parallel Migrate phase (Phase 1).
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { app } = electron;
import path from 'path';
import fs from 'fs';
import { logger } from '../safe-logger.js';

// Load classic-level via createRequire (ESM interop for CJS native module).
// The prebuilt Windows x64 binary ships with the package — no rebuild required.
// Typed as `any` at the boundary; internal helpers wrap the raw handle.
const { ClassicLevel } = require('classic-level') as { ClassicLevel: any };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LevelStore {
  get<T>(namespace: string, key: string): Promise<T | null>;
  getAll<T>(namespace: string): Promise<Array<{ key: string; value: T }>>;
  put<T>(namespace: string, key: string, value: T): Promise<void>;
  del(namespace: string, key: string): Promise<void>;
  batch(
    ops: Array<
      | { type: 'put'; namespace: string; key: string; value: unknown }
      | { type: 'del'; namespace: string; key: string }
    >,
  ): Promise<void>;
  stream<T>(
    namespace: string,
    opts?: { start?: string; end?: string; limit?: number },
  ): AsyncGenerator<{ key: string; value: T }>;
  /**
   * Paginated chunk read (v1.0.65+). Returns up to `limit` rows starting
   * strictly AFTER `startAfter` (exclusive). The `nextKey` is the last
   * key in `rows` — pass it back as `startAfter` for the next chunk.
   * `done` is true when the returned slice was shorter than `limit`,
   * meaning the caller can stop iterating.
   *
   * This is the IPC-friendly counterpart to `stream()` for large namespaces
   * (e.g. the ~155k-row Steam catalog) where marshalling everything in one
   * `getAll` payload would be prohibitive.
   */
  getChunk<T>(
    namespace: string,
    opts: { startAfter?: string; limit: number },
  ): Promise<{ rows: Array<{ key: string; value: T }>; nextKey?: string; done: boolean }>;
  /** Fast "does this namespace have any keys?" check — returns on first hit. */
  has(namespace: string): Promise<boolean>;
  clearNamespace(namespace: string): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Key encoding
// ---------------------------------------------------------------------------

// Namespaces are prefixed with `${namespace}::` — chosen because `:` never
// occurs in JSON-safe identifier keys and the doubled colon is unambiguous.
// The high-sentinel `￿` gives us a clean upper bound for range scans.
const NS_SEP = '::';
const NS_HIGH = '￿';

function validateNamespace(namespace: string): void {
  if (typeof namespace !== 'string' || !namespace) {
    throw new Error(`[LevelStore] Invalid namespace: ${String(namespace)}`);
  }
  if (namespace.includes(NS_SEP)) {
    throw new Error(`[LevelStore] Namespace must not contain '${NS_SEP}': ${namespace}`);
  }
}

function validateKey(key: string): void {
  if (typeof key !== 'string' || !key) {
    throw new Error(`[LevelStore] Invalid key: ${String(key)}`);
  }
}

function encodeKey(namespace: string, key: string): string {
  return `${namespace}${NS_SEP}${key}`;
}

function decodeKey(namespace: string, fullKey: string): string {
  const prefix = `${namespace}${NS_SEP}`;
  return fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey;
}

function encodeValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (err) {
    logger.error('[LevelStore] Non-serialisable value:', err);
    throw new Error(
      `[LevelStore] Value is not JSON-serialisable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function decodeValue<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.error('[LevelStore] Value is not valid JSON:', err);
    throw new Error(
      `[LevelStore] Stored value is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton implementation
// ---------------------------------------------------------------------------

let dbHandle: any = null;
let openPromise: Promise<any> | null = null;
let storeSingleton: LevelStore | null = null;

async function openDb(): Promise<any> {
  if (dbHandle) return dbHandle;
  if (openPromise) return openPromise;

  const dbPath = path.join(app.getPath('userData'), 'leveldb');
  openPromise = (async () => {
    try {
      // Ensure the parent directory exists — classic-level creates the DB
      // subdirectory itself but does not `mkdir -p` above it.
      try {
        fs.mkdirSync(dbPath, { recursive: true });
      } catch (mkErr) {
        // Non-fatal if the directory already exists.
        if ((mkErr as NodeJS.ErrnoException).code !== 'EEXIST') {
          logger.warn('[LevelStore] mkdir warning:', mkErr);
        }
      }
      const db = new ClassicLevel(dbPath, { valueEncoding: 'utf8', keyEncoding: 'utf8' });
      await db.open();
      dbHandle = db;
      logger.log('[LevelStore] Opened LevelDB at', dbPath);
      return db;
    } catch (err) {
      logger.error('[LevelStore] Failed to open LevelDB:', err);
      openPromise = null;
      throw err;
    }
  })();
  return openPromise;
}

async function getImpl<T>(namespace: string, key: string): Promise<T | null> {
  validateNamespace(namespace);
  validateKey(key);
  const db = await openDb();
  try {
    const raw = await db.get(encodeKey(namespace, key));
    if (raw === undefined || raw === null) return null;
    return decodeValue<T>(raw);
  } catch (err) {
    // classic-level throws LEVEL_NOT_FOUND for missing keys.
    if ((err as any)?.code === 'LEVEL_NOT_FOUND') return null;
    logger.error(`[LevelStore] get(${namespace}, ${key}) failed:`, err);
    throw err;
  }
}

async function getAllImpl<T>(namespace: string): Promise<Array<{ key: string; value: T }>> {
  validateNamespace(namespace);
  const db = await openDb();
  const gte = `${namespace}${NS_SEP}`;
  const lt = `${namespace}${NS_SEP}${NS_HIGH}`;
  const results: Array<{ key: string; value: T }> = [];
  try {
    const iter = db.iterator({ gte, lt });
    try {
      for await (const [fullKey, raw] of iter) {
        results.push({ key: decodeKey(namespace, fullKey), value: decodeValue<T>(raw) });
      }
    } finally {
      try {
        await iter.close();
      } catch {
        /* ignore close errors */
      }
    }
    return results;
  } catch (err) {
    logger.error(`[LevelStore] getAll(${namespace}) failed:`, err);
    throw err;
  }
}

async function putImpl<T>(namespace: string, key: string, value: T): Promise<void> {
  validateNamespace(namespace);
  validateKey(key);
  const db = await openDb();
  const encoded = encodeValue(value);
  try {
    await db.put(encodeKey(namespace, key), encoded);
  } catch (err) {
    logger.error(`[LevelStore] put(${namespace}, ${key}) failed:`, err);
    throw err;
  }
}

async function delImpl(namespace: string, key: string): Promise<void> {
  validateNamespace(namespace);
  validateKey(key);
  const db = await openDb();
  try {
    await db.del(encodeKey(namespace, key));
  } catch (err) {
    logger.error(`[LevelStore] del(${namespace}, ${key}) failed:`, err);
    throw err;
  }
}

async function batchImpl(
  ops: Array<
    | { type: 'put'; namespace: string; key: string; value: unknown }
    | { type: 'del'; namespace: string; key: string }
  >,
): Promise<void> {
  if (!Array.isArray(ops) || ops.length === 0) return;
  const db = await openDb();
  const encoded = ops.map((op) => {
    validateNamespace(op.namespace);
    validateKey(op.key);
    if (op.type === 'put') {
      return { type: 'put', key: encodeKey(op.namespace, op.key), value: encodeValue(op.value) };
    }
    return { type: 'del', key: encodeKey(op.namespace, op.key) };
  });
  try {
    await db.batch(encoded);
  } catch (err) {
    logger.error(`[LevelStore] batch(${ops.length} ops) failed:`, err);
    throw err;
  }
}

async function* streamImpl<T>(
  namespace: string,
  opts?: { start?: string; end?: string; limit?: number },
): AsyncGenerator<{ key: string; value: T }> {
  validateNamespace(namespace);
  const db = await openDb();
  const prefix = `${namespace}${NS_SEP}`;
  const gte = opts?.start ? `${prefix}${opts.start}` : prefix;
  const lt = opts?.end ? `${prefix}${opts.end}` : `${prefix}${NS_HIGH}`;
  const iterOpts: Record<string, unknown> = { gte, lt };
  if (typeof opts?.limit === 'number' && opts.limit > 0) iterOpts.limit = opts.limit;
  const iter = db.iterator(iterOpts);
  try {
    for await (const [fullKey, raw] of iter) {
      yield { key: decodeKey(namespace, fullKey), value: decodeValue<T>(raw) };
    }
  } finally {
    try {
      await iter.close();
    } catch {
      /* ignore close errors */
    }
  }
}

async function getChunkImpl<T>(
  namespace: string,
  opts: { startAfter?: string; limit: number },
): Promise<{ rows: Array<{ key: string; value: T }>; nextKey?: string; done: boolean }> {
  validateNamespace(namespace);
  const limit = Math.max(1, Math.min(10_000, Math.floor(opts.limit)));
  const db = await openDb();
  const prefix = `${namespace}${NS_SEP}`;
  const lt = `${namespace}${NS_SEP}${NS_HIGH}`;
  // Exclusive start when a cursor is supplied — the caller already saw `startAfter`.
  const iterOpts: Record<string, unknown> = opts.startAfter
    ? { gt: encodeKey(namespace, opts.startAfter), lt, limit }
    : { gte: prefix, lt, limit };
  const rows: Array<{ key: string; value: T }> = [];
  const iter = db.iterator(iterOpts);
  try {
    for await (const [fullKey, raw] of iter) {
      rows.push({ key: decodeKey(namespace, fullKey), value: decodeValue<T>(raw) });
    }
  } catch (err) {
    logger.error(`[LevelStore] getChunk(${namespace}) failed:`, err);
    throw err;
  } finally {
    try {
      await iter.close();
    } catch {
      /* ignore */
    }
  }
  const nextKey = rows.length > 0 ? rows[rows.length - 1].key : undefined;
  const done = rows.length < limit;
  return { rows, nextKey, done };
}

async function hasImpl(namespace: string): Promise<boolean> {
  validateNamespace(namespace);
  const db = await openDb();
  const gte = `${namespace}${NS_SEP}`;
  const lt = `${namespace}${NS_SEP}${NS_HIGH}`;
  // Use a limit:1 iterator to short-circuit as soon as we see a matching key.
  const iter = db.iterator({ gte, lt, limit: 1, values: false });
  try {
    for await (const _entry of iter) {
      return true;
    }
    return false;
  } catch (err) {
    logger.error(`[LevelStore] has(${namespace}) failed:`, err);
    throw err;
  } finally {
    try {
      await iter.close();
    } catch {
      /* ignore close errors */
    }
  }
}

async function clearNamespaceImpl(namespace: string): Promise<void> {
  validateNamespace(namespace);
  const db = await openDb();
  const gte = `${namespace}${NS_SEP}`;
  const lt = `${namespace}${NS_SEP}${NS_HIGH}`;
  try {
    // `clear` is O(n) but batched at the C++ layer — far cheaper than
    // iterating + `del`ing in JS. Range identical to iterator range above.
    await db.clear({ gte, lt });
  } catch (err) {
    logger.error(`[LevelStore] clearNamespace(${namespace}) failed:`, err);
    throw err;
  }
}

async function closeImpl(): Promise<void> {
  if (!dbHandle) return;
  const db = dbHandle;
  dbHandle = null;
  openPromise = null;
  try {
    await db.close();
    logger.log('[LevelStore] Closed LevelDB');
  } catch (err) {
    logger.error('[LevelStore] Failed to close LevelDB cleanly:', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Lazy singleton accessor
// ---------------------------------------------------------------------------

export function getLevelStore(): LevelStore {
  if (storeSingleton) return storeSingleton;
  storeSingleton = {
    get: getImpl,
    getAll: getAllImpl,
    put: putImpl,
    del: delImpl,
    batch: batchImpl,
    stream: streamImpl,
    getChunk: getChunkImpl,
    has: hasImpl,
    clearNamespace: clearNamespaceImpl,
    close: closeImpl,
  };
  return storeSingleton;
}
