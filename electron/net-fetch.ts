/**
 * One shared network call for every external host the main process talks to.
 *
 * - Inside Electron it is Chromium's `net.fetch`: it trusts the Windows certificate store and follows the
 *   system proxy, so it works behind a TLS-inspecting corporate proxy where Node's own fetch / https fails
 *   with SELF_SIGNED_CERT_IN_CHAIN. Plain Node (unit tests, scripts) falls back to the global fetch.
 * - The timeout stays armed until the response BODY has been read (or cancelled), so a host that sends
 *   headers and then stalls can no longer hang the caller.
 * - Every request is also aborted when the app quits, and when the caller's own signal aborts.
 */
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export const DEFAULT_NET_TIMEOUT_MS = 20_000;

export interface NetFetchOptions {
  /** Deadline for the whole exchange including the body. Default 20 s; 0 disables it. */
  timeoutMs?: number;
  /** Extra caller signal (also honoured when it is passed in `init.signal`). */
  signal?: AbortSignal;
}

export type NetFetchTransport = (url: string, init: RequestInit) => Promise<Response>;

let transportOverride: NetFetchTransport | undefined;

/** Test seam: replace the transport (call with no argument to restore). */
export function __setNetFetchTransportForTests(t?: NetFetchTransport): void {
  transportOverride = t;
}

/** Aborted once when the app starts quitting; every in-flight request listens to it. */
const quitController = new AbortController();
let quitHooked = false;

interface ElectronNet {
  app?: { isReady?: () => boolean; once?: (ev: string, fn: () => void) => void };
  net?: { fetch?: (url: string, init?: unknown) => Promise<Response> };
}

function electronNet(): ElectronNet | null {
  try {
    if (!process.versions.electron) return null;
    const e = nodeRequire('electron') as ElectronNet;
    return e?.net?.fetch && e.app?.isReady?.() ? e : null;
  } catch {
    return null;
  }
}

function defaultTransport(url: string, init: RequestInit): Promise<Response> {
  const e = electronNet();
  if (e) {
    if (!quitHooked) {
      quitHooked = true;
      try { e.app?.once?.('before-quit', () => quitController.abort(new Error('The app is quitting'))); } catch { /* best effort */ }
    }
    return e.net!.fetch!(url, init) as Promise<Response>;
  }
  return fetch(url, init);
}

/** Re-wrap the response so `onSettled` runs when its body ends, errors or is cancelled. */
function watchBody(res: Response, onSettled: () => void): Response {
  if (!res.body) { onSettled(); return res; }
  try {
    const reader = res.body.getReader();
    let finished = false;
    const finish = () => { if (!finished) { finished = true; onSettled(); } };
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        try {
          const { done, value } = await reader.read();
          if (done) { finish(); ctrl.close(); } else ctrl.enqueue(value);
        } catch (err) {
          finish();
          ctrl.error(err);
        }
      },
      cancel(reason) {
        finish();
        return reader.cancel(reason);
      },
    });
    const wrapped = new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
    Object.defineProperty(wrapped, 'url', { value: res.url });
    Object.defineProperty(wrapped, 'redirected', { value: res.redirected });
    return wrapped;
  } catch {
    // A status that cannot carry a body (or a locked stream): hand the original back, unwatched.
    onSettled();
    return res;
  }
}

/**
 * Fetch `url` with a deadline that covers the body. Rejects with the abort reason on timeout, quit or
 * caller abort. The response is a normal `Response`; read its body promptly (the timer is running).
 */
export async function netFetch(url: string, init: RequestInit = {}, opts: NetFetchOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_NET_TIMEOUT_MS;
  const controller = new AbortController();
  const sources = [init.signal, opts.signal, quitController.signal].filter((s): s is AbortSignal => !!s);
  const unlinks: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    for (const u of unlinks.splice(0)) u();
  };

  for (const s of sources) {
    if (s.aborted) { controller.abort(s.reason); break; }
    const onAbort = () => controller.abort(s.reason);
    s.addEventListener('abort', onAbort, { once: true });
    unlinks.push(() => s.removeEventListener('abort', onAbort));
  }
  if (timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();
  }

  try {
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error('Request aborted');
    const res = await (transportOverride ?? defaultTransport)(url, { ...init, signal: controller.signal });
    return watchBody(res, cleanup);
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * A `fetch` for libraries that take one (LangChain / OpenAI SDK): same as `netFetch` with a fixed deadline.
 * Chat turns can legitimately stream for minutes, so the default here is generous.
 */
export function makeNetFetch(opts: NetFetchOptions = {}): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return netFetch(url, init ?? {}, opts);
  }) as typeof fetch;
}

/**
 * Wrap a fetch so `touch` runs when a request starts, every `intervalMs` while its response is still
 * being read (or awaited) and when it ends. Used to keep the local chat server's idle timer from
 * unloading a model in the middle of a long turn.
 */
export function withKeepAlive(
  base: typeof fetch,
  touch: () => void,
  intervalMs = 30_000,
  hooks: { onStart?: () => void; onEnd?: () => void } = {},
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    touch();
    hooks.onStart?.();
    const timer = setInterval(touch, intervalMs);
    timer.unref?.();
    const stop = () => { clearInterval(timer); touch(); hooks.onEnd?.(); };
    let res: Response;
    try {
      res = await base(input, init);
    } catch (err) {
      stop();
      throw err;
    }
    return watchBody(res, stop);
  }) as typeof fetch;
}

let bridgedHosts: Set<string> | null = null;

/**
 * For SDKs that call the global `fetch` and accept no custom one (the Gemini client), send requests to
 * these hosts through `netFetch` and leave every other host on the original global fetch. A no-op outside
 * a ready Electron app, so tests and plain Node keep their own fetch. Returns whether the bridge is active.
 */
export function bridgeGlobalFetchForHosts(hosts: string[], opts: NetFetchOptions = {}): boolean {
  if (!electronNet()) return false;
  if (bridgedHosts) {
    for (const h of hosts) bridgedHosts.add(h.toLowerCase());
    return true;
  }
  bridgedHosts = new Set(hosts.map((h) => h.toLowerCase()));
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    try {
      if (typeof input === 'string' || input instanceof URL) {
        const u = new URL(typeof input === 'string' ? input : input.href);
        if (u.protocol === 'https:' && bridgedHosts!.has(u.hostname.toLowerCase())) return netFetch(u.href, init ?? {}, opts);
      }
    } catch { /* not a parseable URL: let the original fetch report it */ }
    return original(input, init);
  }) as typeof fetch;
  return true;
}
