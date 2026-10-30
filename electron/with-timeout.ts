import { logger } from './safe-logger.js';

/**
 * Startup timeout helper — wraps a promise with a max-wait, returning null on timeout.
 * The timer is cleared however the promise settles; it used to stay armed on rejection
 * and log a misleading "timed out" warning 15-20 s after the real failure.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => { logger.warn(`[Startup] ${label} timed out after ${ms}ms`); resolve(null); }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
