/**
 * Store IPC Handlers (v1.0.61)
 *
 * Wires the main-process `LevelStore` to a `store:*` IPC channel surface
 * consumed by the renderer via `window.store` (see `electron/preload.cjs`).
 *
 * Includes a light per-channel, per-sender token-bucket rate limiter as a
 * safety net against renderer-side runaway loops (Gap #25 fold-in).
 * Renderer stores under normal usage never approach the limit — this is
 * defence-in-depth, not throttling.
 *
 * NOTE: The streaming variant (`store:stream`) is intentionally deferred to
 * a later release (when we migrate the ~155k-row catalog store). For v1.0.61
 * only single-response `getAll` is exposed.  TODO: chunked streaming.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { logger } from '../safe-logger.js';
import { getLevelStore } from '../storage/level-store.js';

// ---------------------------------------------------------------------------
// Rate limiting (Gap #25) — per-channel, per-sender token bucket
// ---------------------------------------------------------------------------

/**
 * Max sustained calls/sec/channel per sender WebContents. Renderer stores
 * batch their writes, so 500 calls/sec is well above normal traffic and
 * acts purely as a runaway-loop safety net.
 */
const RATE_LIMIT_TOKENS = 500;
const RATE_LIMIT_REFILL_PER_SEC = 500; // tokens replenished per second
const RATE_LIMIT_BURST = 500; // == bucket capacity

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}
// Keyed by `${channel}:${senderId}`.
const buckets = new Map<string, Bucket>();

function checkRateLimit(channel: string, senderId: number): boolean {
  const now = Date.now();
  const key = `${channel}:${senderId}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_BURST, lastRefillMs: now };
    buckets.set(key, bucket);
  }
  const elapsedSec = (now - bucket.lastRefillMs) / 1000;
  if (elapsedSec > 0) {
    bucket.tokens = Math.min(RATE_LIMIT_BURST, bucket.tokens + elapsedSec * RATE_LIMIT_REFILL_PER_SEC);
    bucket.lastRefillMs = now;
  }
  if (bucket.tokens < 1) {
    return false;
  }
  bucket.tokens -= 1;
  return true;
}

function rateLimited(channel: string, senderId: number): { error: string } {
  logger.warn(`[Store IPC] Rate limit hit on ${channel} sender=${senderId} (limit=${RATE_LIMIT_TOKENS}/s)`);
  return { error: 'rate_limited' };
}

function senderIdOf(event: any): number {
  try {
    return typeof event?.sender?.id === 'number' ? event.sender.id : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Handler helpers
// ---------------------------------------------------------------------------

/** Standard error envelope so the renderer never sees a raw thrown Error. */
function toError(err: unknown): { error: string } {
  const msg = err instanceof Error ? err.message : String(err);
  return { error: msg };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(): void {
  const store = getLevelStore();

  ipcMain.handle('store:get', async (event: any, namespace: string, key: string) => {
    if (!checkRateLimit('store:get', senderIdOf(event))) return rateLimited('store:get', senderIdOf(event));
    try {
      return { value: await store.get(namespace, key) };
    } catch (err) {
      logger.error('[Store IPC] store:get failed:', err);
      return toError(err);
    }
  });

  ipcMain.handle('store:getAll', async (event: any, namespace: string) => {
    if (!checkRateLimit('store:getAll', senderIdOf(event))) return rateLimited('store:getAll', senderIdOf(event));
    try {
      // NOTE: fine for small/medium namespaces. For the large catalog
      // namespaces (~40k epic, ~155k steam) callers MUST use `store:getChunk`
      // instead — a single-response getAll would marshal a ~75MB payload.
      return { rows: await store.getAll(namespace) };
    } catch (err) {
      logger.error('[Store IPC] store:getAll failed:', err);
      return toError(err);
    }
  });

  ipcMain.handle('store:getChunk', async (
    event: any,
    namespace: string,
    opts: { startAfter?: string; limit: number },
  ) => {
    if (!checkRateLimit('store:getChunk', senderIdOf(event))) {
      return rateLimited('store:getChunk', senderIdOf(event));
    }
    try {
      if (!opts || typeof opts.limit !== 'number' || opts.limit <= 0) {
        return { error: 'limit must be a positive number' };
      }
      const res = await store.getChunk(namespace, opts);
      return res;
    } catch (err) {
      logger.error('[Store IPC] store:getChunk failed:', err);
      return toError(err);
    }
  });

  ipcMain.handle('store:put', async (event: any, namespace: string, key: string, value: unknown) => {
    if (!checkRateLimit('store:put', senderIdOf(event))) return rateLimited('store:put', senderIdOf(event));
    try {
      await store.put(namespace, key, value);
      return { ok: true };
    } catch (err) {
      logger.error('[Store IPC] store:put failed:', err);
      return toError(err);
    }
  });

  ipcMain.handle('store:del', async (event: any, namespace: string, key: string) => {
    if (!checkRateLimit('store:del', senderIdOf(event))) return rateLimited('store:del', senderIdOf(event));
    try {
      await store.del(namespace, key);
      return { ok: true };
    } catch (err) {
      logger.error('[Store IPC] store:del failed:', err);
      return toError(err);
    }
  });

  ipcMain.handle('store:batch', async (event: any, ops: unknown) => {
    if (!checkRateLimit('store:batch', senderIdOf(event))) return rateLimited('store:batch', senderIdOf(event));
    try {
      if (!Array.isArray(ops)) {
        return { error: 'ops must be an array' };
      }
      await store.batch(ops as any);
      return { ok: true };
    } catch (err) {
      logger.error('[Store IPC] store:batch failed:', err);
      return toError(err);
    }
  });

  ipcMain.handle('store:has', async (event: any, namespace: string) => {
    if (!checkRateLimit('store:has', senderIdOf(event))) return rateLimited('store:has', senderIdOf(event));
    try {
      return { value: await store.has(namespace) };
    } catch (err) {
      logger.error('[Store IPC] store:has failed:', err);
      return toError(err);
    }
  });

  ipcMain.handle('store:clearNamespace', async (event: any, namespace: string) => {
    if (!checkRateLimit('store:clearNamespace', senderIdOf(event))) {
      return rateLimited('store:clearNamespace', senderIdOf(event));
    }
    try {
      await store.clearNamespace(namespace);
      return { ok: true };
    } catch (err) {
      logger.error('[Store IPC] store:clearNamespace failed:', err);
      return toError(err);
    }
  });
}
