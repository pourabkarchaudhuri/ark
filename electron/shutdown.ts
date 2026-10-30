/**
 * Shutdown finalisation shared by every quit path.
 *
 * On Windows, before-quit / will-quit are NOT emitted for OS shutdown, restart or
 * log-off — only the window's `session-end` is. Without a handler there the active
 * play session was never finalized, debounced chat / cache writes were lost and the
 * clean-exit marker was not written (so a shutdown counted as an abnormal boot).
 * Windows gives the process ~5 s, so everything here is synchronous and short.
 */

import { logger } from './safe-logger.js';

export interface ShutdownStep {
  label: string;
  run: () => void;
}

/**
 * Returns a run-once function executing each step in order. A throwing step is
 * logged and the rest still run.
 */
export function createShutdownFinalizer(steps: ShutdownStep[]): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const step of steps) {
      try {
        step.run();
      } catch (e) {
        logger.error(`[Shutdown] ${step.label} failed:`, e);
      }
    }
  };
}

export interface SessionEndDeps {
  /** Let the hide-to-tray close interceptor through. */
  setQuitting: () => void;
  /** The synchronous finalizer (session finalisation first). */
  finalize: () => void;
  /** Started, never awaited — the OS may kill us before it settles. */
  closeDb: () => Promise<void>;
  quit: () => void;
}

/** Handler for `session-end` (Windows) / powerMonitor `shutdown` (macOS, Linux). Runs once. */
export function createSessionEndHandler(deps: SessionEndDeps): () => void {
  let fired = false;
  return () => {
    if (fired) return;
    fired = true;
    logger.log('[Shutdown] OS session ending — finalizing');
    deps.setQuitting();
    deps.finalize();
    try {
      void deps.closeDb().catch((err) => logger.error('[Shutdown] LevelDB close failed:', err));
    } catch (err) {
      logger.error('[Shutdown] LevelDB close failed:', err);
    }
    deps.quit();
  };
}
