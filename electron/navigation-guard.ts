/**
 * Navigation guard for the privileged windows (main + overlay), v1.0.97.
 *
 * Both windows carry the full preload bridge, so they may only ever show the
 * app's own entry page. Before this, `will-navigate` treated any file:// URL
 * (including UNC hosts such as file://attacker/share — a protocol-relative href
 * in store HTML resolves there), any http://localhost* host, and everything when
 * getURL() was empty as internal. Kept free of `electron` imports so it is unit
 * testable.
 */
import { pathToFileURL } from 'node:url';

/** Passed to the preload via additionalArguments; preload has no reliable NODE_ENV. */
export const DEV_FLAG_ARG = '--ark-dev-server';

/**
 * Dev server (and DevTools) only for unpackaged runs. A packaged build used to
 * switch to http://localhost:5173 when NODE_ENV=development was set in the
 * user's environment.
 */
export function shouldUseDevServer(opts: { isPackaged: boolean; nodeEnv: string | undefined }): boolean {
  if (opts.isPackaged) return false;
  return opts.nodeEnv !== 'production' && opts.nodeEnv !== 'test';
}

export function devFlagArgs(useDevServer: boolean): string[] {
  return useDevServer ? [DEV_FLAG_ARG] : [];
}

export interface AppUrlContext {
  useDevServer: boolean;
  /** Absolute path of the page loaded with loadFile (packaged / test runs). */
  indexPath: string;
  /** Dev server base URL (only consulted when useDevServer). */
  devUrl: string;
}

function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  // Windows paths are case-insensitive; drive letters in particular vary.
  if (process.platform !== 'win32') return false;
  try {
    return decodeURIComponent(a).toLowerCase() === decodeURIComponent(b).toLowerCase();
  } catch {
    return false;
  }
}

/** True only for the window's own page (any hash route). Never compares against getURL(). */
export function isAppUrl(u: string, ctx: AppUrlContext): boolean {
  let parsed: URL;
  try { parsed = new URL(u); } catch { return false; }
  if (ctx.useDevServer) {
    try { return parsed.origin === new URL(ctx.devUrl).origin; } catch { return false; }
  }
  if (parsed.protocol !== 'file:' || parsed.host !== '') return false;
  return samePath(parsed.pathname, pathToFileURL(ctx.indexPath).pathname);
}

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** http(s)/mailto only (shell:openExternal also allows magnet:, which no in-window navigation needs). */
export function isExternalOpenable(u: string): boolean {
  try { return EXTERNAL_PROTOCOLS.has(new URL(u).protocol); } catch { return false; }
}

interface NavigableWebContents {
  on(event: 'will-navigate' | 'will-redirect', listener: (event: { preventDefault(): void }, url: string) => void): unknown;
}

/**
 * Block every in-window navigation that is not the app itself (will-navigate and
 * will-redirect). Blocked http(s)/mailto targets open in the OS browser;
 * anything else (file:, steam:, javascript:, …) is only dropped.
 */
export function attachNavigationGuards(
  wc: NavigableWebContents,
  ctx: AppUrlContext,
  openExternal: (url: string) => void,
  log: (msg: string) => void = () => {},
): void {
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (isAppUrl(url, ctx)) return;
    event.preventDefault();
    if (isExternalOpenable(url)) {
      openExternal(url);
      log(`[Navigation] Blocked in-window navigation, opened in OS browser: ${url}`);
    } else {
      log(`[Navigation] Blocked in-window navigation: ${url}`);
    }
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
}
