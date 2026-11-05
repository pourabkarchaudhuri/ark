/**
 * Policy for the Buzz / Decode Bay inline WebContentsView, v1.0.97. Kept free
 * of `electron` imports so it is unit testable; webview-handlers.ts wires it.
 *
 * - window.open: Electron has no popup blocker here, so ad scripts on an article
 *   could open OS browser tabs repeatedly, even with Ark in the background. A
 *   target now reaches the OS browser only right after a real click/keypress in
 *   the view, while Ark is focused, at most once per POPUP_COOLDOWN_MS.
 * - The view runs in its own non-persistent session so downloads and permission
 *   prompts can be refused there without touching the app's default session.
 */
import { logger } from './safe-logger.js';

/** In-memory (no `persist:` prefix): article cookies are dropped on quit. */
export const DECODE_BAY_PARTITION = 'decode-bay';

const INPUT_WINDOW_MS = 1_000;
const POPUP_COOLDOWN_MS = 3_000;
const OPENABLE_DISPOSITIONS = new Set(['foreground-tab', 'new-window']);

export interface PopupGate {
  /** Record a user gesture inside the view. */
  noteInput(): void;
  /** Forget gestures (a new page was opened in the view). */
  reset(): void;
  /** Decide whether a window.open target may go to the OS browser; records the open. */
  shouldOpenExternal(url: string, disposition: string | undefined): boolean;
}

export function createPopupGate(deps: { now?: () => number; isMainWindowFocused: () => boolean }): PopupGate {
  const now = deps.now ?? Date.now;
  let lastInputAt = -Infinity;
  let lastOpenAt = -Infinity;
  return {
    noteInput() { lastInputAt = now(); },
    reset() { lastInputAt = -Infinity; },
    shouldOpenExternal(url, disposition) {
      let protocol: string;
      try { protocol = new URL(url).protocol; } catch { return false; }
      if (protocol !== 'http:' && protocol !== 'https:') return false;
      if (!disposition || !OPENABLE_DISPOSITIONS.has(disposition)) return false;
      const t = now();
      if (t - lastInputAt > INPUT_WINDOW_MS) return false;
      if (t - lastOpenAt < POPUP_COOLDOWN_MS) return false;
      if (!deps.isMainWindowFocused()) return false;
      lastOpenAt = t;
      // One gesture, one popup.
      lastInputAt = -Infinity;
      return true;
    },
  };
}

/** `input-event` payloads that count as a user gesture (before-input-event is keyboard-only). */
export function isUserInputEvent(input: { type?: string } | null | undefined): boolean {
  const type = input?.type;
  return type === 'mouseDown' || type === 'keyDown' || type === 'rawKeyDown';
}

interface GuardableSession {
  on(event: 'will-download', listener: (event: { preventDefault(): void }, item: any) => void): unknown;
  setPermissionRequestHandler(handler: (wc: unknown, permission: string, callback: (granted: boolean) => void) => void): void;
  /** Synchronous checks (`navigator.permissions.query`, device enumeration) bypass the request handler. */
  setPermissionCheckHandler?(handler: (wc: unknown, permission: string) => boolean): void;
}

/**
 * Register once (from webview-handlers register(), never per webview:open, which
 * would stack listeners). A fresh partition does not inherit the default
 * session's deny-all permission handler, so it gets its own.
 */
export function installDecodeBaySessionGuards(fromPartition: (partition: string) => GuardableSession): void {
  const ses = fromPartition(DECODE_BAY_PARTITION);
  ses.on('will-download', (event, item) => {
    event.preventDefault();
    let name = '';
    try { name = item?.getFilename?.() ?? ''; } catch { /* ignore */ }
    logger.warn(`[Webview] Blocked download in Decode Bay${name ? `: ${name}` : ''}`);
  });
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    logger.warn(`[Webview] Denied permission request in Decode Bay: ${permission}`);
    callback(false);
  });
  // Without a check handler, Chromium answers permission *checks* from its defaults and some
  // capabilities (for example device enumeration) work without ever asking. Refuse them all.
  ses.setPermissionCheckHandler?.(() => false);
}
