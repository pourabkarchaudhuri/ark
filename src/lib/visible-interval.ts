/**
 * An interval that only runs while the document is visible. A hidden (tray / minimised) window used to keep
 * re-rendering and re-fetching on its timers for nothing. When the document becomes visible again `fn` runs at
 * once if at least `ms` passed since it last ran (so a long-hidden window catches up), and the timer restarts.
 * Returns a stop function.
 */
export function startVisibleInterval(
  fn: () => void,
  ms: number,
  doc: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> = document,
  now: () => number = Date.now,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastRun = now();
  const run = () => { lastRun = now(); fn(); };
  const arm = () => { if (timer === null) timer = setInterval(run, ms); };
  const disarm = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
  const onVisibility = () => {
    if (doc.visibilityState === 'visible') {
      if (now() - lastRun >= ms) run();
      arm();
    } else {
      disarm();
    }
  };
  if (doc.visibilityState !== 'hidden') arm();
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    disarm();
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
