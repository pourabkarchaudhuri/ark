/**
 * Google Analytics 4 — Measurement Protocol client (main process).
 *
 * Sends events via the GA4 Measurement Protocol so analytics work reliably
 * in an Electron context without injecting gtag.js into the renderer.
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

// Read lazily: ESM imports hoist above dotenv's loadEnv() call, so
// process.env isn't populated yet at module-scope evaluation time.
function gaMeasurementId() { return process.env.GA_MEASUREMENT_ID || ''; }
function gaApiSecret() { return process.env.GA_API_SECRET || ''; }
const GA_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

function getClientId(): string {
  const idFile = path.join(app.getPath('userData'), '.analytics-cid');
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

export async function trackEvent(
  name: string,
  params: Record<string, string | number | boolean> = {},
): Promise<void> {
  if (!gaMeasurementId() || !gaApiSecret()) return;
  const url = `${GA_ENDPOINT}?measurement_id=${gaMeasurementId()}&api_secret=${gaApiSecret()}`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: ensureClientId(),
        events: [{
          name,
          params: {
            ...params,
            engagement_time_msec: '1',
            app_version: app.getVersion(),
          },
        }],
      }),
    });
  } catch (err) {
    logger.warn('[Analytics] Event send failed (non-fatal):', err);
  }
}

export function trackPageView(page: string): void {
  trackEvent('page_view', { page_title: page, page_location: `app://ark/${page}` });
}

export function trackAppLaunch(): void {
  trackEvent('app_launch', {
    platform: process.platform,
    arch: process.arch,
    electron_version: process.versions.electron,
  });
}
