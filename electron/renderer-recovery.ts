/**
 * Main-window renderer crash recovery, v1.0.97. Kept free of `electron`
 * imports (everything comes in through deps) so it is unit testable.
 *
 * - The inline Buzz WebContentsView is owned by main, so a renderer crash or a
 *   full reload never ran the React cleanup that closes it: the old article
 *   stayed stacked over the new UI. It is now destroyed whenever the main
 *   document goes away (render-process-gone, or a main-frame cross-document
 *   navigation). Hash routing is same-document and keeps it.
 * - After MAX_CRASHES_IN_WINDOW crashes the breaker stops reloading; the window
 *   is then marked dead and every show/focus path goes through
 *   revealMainWindow, which offers Restart/Quit instead of a black window.
 */

const CRASH_WINDOW_MS = 30_000;
const MAX_CRASHES_IN_WINDOW = 3;

interface RecoverableWebContents {
  on(event: string, listener: (...args: any[]) => void): unknown;
  reload(): void;
  isCrashed?(): boolean;
}

interface RecoverableWindow {
  webContents: RecoverableWebContents;
}

export interface RendererRecoveryDeps {
  destroyWebContentsView: () => void;
  /** Persisted boot-health counter (safe mode after repeated crashes). */
  recordCrash: (reason: string) => void;
  log?: (level: 'log' | 'error', msg: string) => void;
  isSafeMode?: () => boolean;
  /** Called once when the breaker trips: the caller shows the Restart/Quit prompt. */
  onDead?: () => void;
  now?: () => number;
}

export interface RendererRecoveryState {
  isRendererDead: () => boolean;
}

export function attachRendererRecovery(win: RecoverableWindow, deps: RendererRecoveryDeps): RendererRecoveryState {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const crashTimestamps: number[] = [];
  let rendererDead = false;

  win.webContents.on('render-process-gone', (_event: unknown, details: { reason?: string; exitCode?: number } = {}) => {
    // First, before any early return: the old document is gone either way.
    deps.destroyWebContentsView();
    log('error', `[Ark] Renderer process gone: ${details.reason} ${details.exitCode}`);
    if (details.reason === 'clean-exit') return;

    deps.recordCrash(String(details.reason));

    const t = now();
    crashTimestamps.push(t);
    // Keep only crashes within the rolling window
    while (crashTimestamps.length > 0 && crashTimestamps[0] < t - CRASH_WINDOW_MS) {
      crashTimestamps.shift();
    }

    if (crashTimestamps.length >= MAX_CRASHES_IN_WINDOW) {
      const wasDead = rendererDead;
      rendererDead = true;
      log('error', `[Ark] ${MAX_CRASHES_IN_WINDOW} crashes in ${CRASH_WINDOW_MS / 1000}s — stopping reload loop`);
      if (!wasDead) {
        try { deps.onDead?.(); } catch { /* the prompt is best effort */ }
      }
      return;
    }

    log('log', `[Ark] Attempting renderer reload…${deps.isSafeMode?.() ? ' (safe mode)' : ''}`);
    win.webContents.reload();
  });

  // Electron 33 passes a details event ({ isMainFrame, isSameDocument }) and
  // also the legacy positional (url, isInPlace, isMainFrame) arguments.
  win.webContents.on('did-start-navigation', (details: any, _url?: string, isInPlace?: boolean, isMainFrame?: boolean) => {
    const mainFrame = details?.isMainFrame ?? isMainFrame;
    const sameDocument = details?.isSameDocument ?? isInPlace;
    if (mainFrame && !sameDocument) deps.destroyWebContentsView();
  });

  return { isRendererDead: () => rendererDead };
}

interface RevealableWindow extends RecoverableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface RevealDeps {
  showMessageBox: (opts: {
    type: 'error';
    title: string;
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    noLink: boolean;
  }) => Promise<{ response: number }>;
  relaunch: () => void;
  exit: (code: number) => void;
  quit: () => void;
}

let deadDialogOpen = false;

/**
 * Every tray / second-instance / showAndFocus / activate path. Returns true when
 * the window was revealed.
 */
export async function revealMainWindow(
  win: RevealableWindow | null,
  state: RendererRecoveryState,
  deps: RevealDeps,
): Promise<boolean> {
  if (!win || win.isDestroyed()) return false;
  let crashed = false;
  try { crashed = !!win.webContents.isCrashed?.(); } catch { /* treat as alive */ }
  if (state.isRendererDead() || crashed) {
    if (deadDialogOpen) return false;
    deadDialogOpen = true;
    try {
      const { response } = await deps.showMessageBox({
        type: 'error',
        title: 'Ark',
        message: 'Ark stopped responding',
        detail: 'The Ark window crashed several times and was not reloaded. Restart Ark to continue.',
        buttons: ['Restart Ark', 'Quit'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0) {
        deps.relaunch();
        deps.exit(0);
      } else {
        deps.quit();
      }
    } finally {
      deadDialogOpen = false;
    }
    return false;
  }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return true;
}
