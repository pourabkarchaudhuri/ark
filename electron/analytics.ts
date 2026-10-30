/**
 * Google Analytics 4 — Measurement Protocol client (main process).
 *
 * Sends events via the GA4 Measurement Protocol so analytics work reliably
 * in an Electron context without injecting gtag.js into the renderer.
 *
 * Opt-in (v1.0.97): nothing is sent unless `analyticsEnabled` is on in the
 * main-side settings store (default off). Page paths are normalised so no game
 * id, query or hash leaves the machine, and the renderer can only send
 * allow-listed event names and primitive params (see sanitizeRendererEvent).
 *
 * Keys are loaded from .env via dotenv (initialised in main.ts).
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { app } = electron;
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { logger } from './safe-logger.js';
import { settingsStore } from './settings-store.js';

// Read lazily: ESM imports hoist above dotenv's loadEnv() call, so
// process.env isn't populated yet at module-scope evaluation time.
function gaMeasurementId() { return process.env.GA_MEASUREMENT_ID || ''; }
function gaApiSecret() { return process.env.GA_API_SECRET || ''; }
const GA_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

type EventParams = Record<string, string | number | boolean>;

interface AnalyticsDeps {
  isEnabled: () => boolean;
  saveEnabled: (enabled: boolean) => void;
  userDataDir: () => string;
  appVersion: () => string;
  fetch: (url: string, init: RequestInit) => Promise<unknown>;
}

// Test-only injectable seam: `require('electron')` via createRequire isn't
// visible to vi.mock('electron', ...), same pattern as launch-handlers.ts.
const realDeps = (): AnalyticsDeps => ({
  isEnabled: () => settingsStore.getAnalyticsEnabled(),
  saveEnabled: (enabled) => settingsStore.setAnalyticsEnabled(enabled),
  userDataDir: () => app.getPath('userData'),
  appVersion: () => app.getVersion(),
  fetch: (url, init) => fetch(url, init),
});
let deps: AnalyticsDeps = realDeps();

export function __setAnalyticsDepsForTests(d?: Partial<AnalyticsDeps>): void {
  deps = { ...realDeps(), ...d };
  clientId = null;
}

function clientIdFile(): string {
  return path.join(deps.userDataDir(), '.analytics-cid');
}

function getClientId(): string {
  const idFile = clientIdFile();
  try {
    const existing = fs.readFileSync(idFile, 'utf-8').trim();
    if (existing) return existing;
  } catch { /* first run */ }
  const cid = randomUUID();
  try { fs.writeFileSync(idFile, cid, 'utf-8'); } catch { /* non-fatal */ }
  return cid;
}

let clientId: string | null = null;

function ensureClientId(): string {
  if (!clientId) clientId = getClientId();
  return clientId;
}

export function isAnalyticsEnabled(): boolean {
  try { return deps.isEnabled(); } catch { return false; }
}

/** Save the opt-in; opting out also forgets the persistent client id. */
export function setAnalyticsEnabled(enabled: boolean): void {
  deps.saveEnabled(enabled);
  if (!enabled) {
    clientId = null;
    try { fs.rmSync(clientIdFile(), { force: true }); } catch (err) {
      logger.warn('[Analytics] Could not delete client id file:', err);
    }
  }
}

export async function trackEvent(name: string, params: EventParams = {}): Promise<void> {
  // First check: covers trackAppLaunch and every other caller.
  if (!isAnalyticsEnabled()) return;
  if (!gaMeasurementId() || !gaApiSecret()) return;
  const url = `${GA_ENDPOINT}?measurement_id=${encodeURIComponent(gaMeasurementId())}&api_secret=${encodeURIComponent(gaApiSecret())}`;
  try {
    await deps.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: ensureClientId(),
        events: [{
          name,
          params: {
            ...params,
            engagement_time_msec: '1',
            app_version: deps.appVersion(),
          },
        }],
      }),
    });
  } catch (err) {
    logger.warn('[Analytics] Event send failed (non-fatal):', err);
  }
}

const MAX_PATH_LEN = 64;

/**
 * Route → path that is safe to send: `/game/<id>...` becomes `/game`, query and
 * hash are dropped, and anything that is not a plain path segment is removed.
 */
export function normalizePagePath(page: unknown): string {
  let p = typeof page === 'string' ? page : '';
  p = p.split(/[?#]/, 1)[0];
  p = p.replace(/^\/?game\/[^/?#]*.*$/i, '/game');
  p = p.replace(/[^A-Za-z0-9/_-]/g, '');
  if (!p.startsWith('/')) p = `/${p}`;
  return p.slice(0, MAX_PATH_LEN);
}

export function trackPageView(page: string): void {
  const p = normalizePagePath(page);
  trackEvent('page_view', { page_title: p, page_location: `app://ark${p}` });
}

export function trackAppLaunch(): void {
  trackEvent('app_launch', {
    platform: process.platform,
    arch: process.arch,
    electron_version: process.versions.electron,
  });
}

/**
 * Event names the renderer may send through `analytics:trackEvent`. No renderer
 * code sends a custom event today; page views go through trackPageView (which
 * normalises the path), so `page_view` is deliberately not accepted here.
 * Add a name here when a renderer event is introduced.
 */
export const RENDERER_EVENT_NAMES: ReadonlySet<string> = new Set<string>([]);

const MAX_PARAMS = 10;
const MAX_PARAM_KEY_LEN = 40;
const MAX_PARAM_VALUE_LEN = 100;
const PARAM_KEY_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Validate a renderer event: returns the cleaned params, or null when the name
 * is not allow-listed. Non-primitive values and malformed keys are dropped,
 * strings are truncated.
 */
export function sanitizeRendererEvent(
  name: unknown,
  params: unknown,
  allowed: ReadonlySet<string> = RENDERER_EVENT_NAMES,
): EventParams | null {
  if (typeof name !== 'string' || !allowed.has(name)) return null;
  const out: EventParams = {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) return out;
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_PARAMS) break;
    if (k.length > MAX_PARAM_KEY_LEN || !PARAM_KEY_RE.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, MAX_PARAM_VALUE_LEN);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}
