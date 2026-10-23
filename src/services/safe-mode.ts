/**
 * Crash-loop safe mode (renderer side).
 *
 * The main process counts renderer crashes / abnormal exits across launches
 * (see `electron/main.ts` boot-health). When several happen in a short window
 * it starts the next launch (or the next renderer reload) in SAFE MODE. The
 * splash screen then skips its heavy background work (catalog sync +
 * embedding pipeline, galaxy precompute, ANN load, idle re-chunk, BM25
 * rebuild) and only loads the user's data; App shows a dismissible notice.
 */

export interface SafeModeState {
  safeMode: boolean;
  reason?: string;
  recentCrashes?: number;
}

const NORMAL: SafeModeState = { safeMode: false };
const QUERY_TIMEOUT_MS = 1500;

let _promise: Promise<SafeModeState> | null = null;

/** Query main once per page load (cached). Never rejects; defaults to normal mode. */
export function loadSafeMode(): Promise<SafeModeState> {
  if (_promise) return _promise;
  _promise = (async () => {
    try {
      const bridge = typeof window !== 'undefined' ? window.electron : undefined;
      if (!bridge || typeof bridge.getSafeMode !== 'function') return NORMAL;
      const res = await Promise.race([
        bridge.getSafeMode(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), QUERY_TIMEOUT_MS)),
      ]);
      if (res && typeof res === 'object' && res.safeMode === true) {
        console.warn(`[SafeMode] Starting in safe mode: ${res.reason ?? 'repeated crashes'}`);
        return { safeMode: true, reason: res.reason, recentCrashes: res.recentCrashes };
      }
      return NORMAL;
    } catch {
      return NORMAL;
    }
  })();
  return _promise;
}

/** Test-only reset of the cached query. */
export function __resetSafeModeForTests(): void {
  _promise = null;
}
