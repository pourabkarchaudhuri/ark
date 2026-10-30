/**
 * Boot-time ANN load ordering (1.0.97).
 *
 * `ann:load` reads a multi-GB HNSW index with a synchronous native call on the
 * main process. Issued during the splash it stalled every other startup IPC
 * (library hydrate, tray, overlay) for seconds. It now waits for the library
 * hydrate and the next painted frame, so the user's data is on screen first;
 * Oracle availability moves back by roughly the hydrate time.
 */

/** Fallback when no frame is painted (window hidden to tray at boot never runs rAF callbacks). */
const PAINT_FALLBACK_MS = 1000;

/** Resolves after the next painted frame, or after PAINT_FALLBACK_MS when frames are not running. */
export function afterNextPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    setTimeout(finish, PAINT_FALLBACK_MS);
    if (typeof requestAnimationFrame === 'function') {
      // rAF runs before the paint; the timeout after it lands once the frame is out.
      requestAnimationFrame(() => setTimeout(finish, 0));
    } else {
      setTimeout(finish, 0);
    }
  });
}

export interface AnnBootLoadDeps {
  /** Library hydrate (libraryStore.ready). A failed hydrate still lets the index load. */
  hydrated: Promise<unknown>;
  /** The load itself (annIndex.load). */
  load: () => Promise<boolean>;
  /** Test seam; defaults to afterNextPaint. */
  afterPaint?: () => Promise<void>;
}

/** Load the ANN index once the library has hydrated and a frame has been painted. */
export async function loadAnnIndexAfterHydrate(deps: AnnBootLoadDeps): Promise<boolean> {
  try { await deps.hydrated; } catch { /* hydrate failures are surfaced by the library store */ }
  await (deps.afterPaint ?? afterNextPaint)();
  return deps.load();
}
