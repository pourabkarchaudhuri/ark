/**
 * Analytics opt-in (1.0.97 B01): nothing is sent while analytics is off, game ids never leave
 * the machine, the renderer can only send allow-listed events, and opting out deletes the
 * persistent client id. fetch and the settings store are injected; no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../electron/settings-store.js', () => ({
  settingsStore: { getAnalyticsEnabled: () => false, setAnalyticsEnabled: () => {} },
}));

import {
  trackEvent,
  trackPageView,
  trackAppLaunch,
  normalizePagePath,
  sanitizeRendererEvent,
  setAnalyticsEnabled,
  __setAnalyticsDepsForTests,
} from '../../../electron/analytics';
import { handleRendererTrackEvent } from '../../../electron/ipc/analytics-handlers';

let dir: string;
let enabled: boolean;
let fetchMock: ReturnType<typeof vi.fn>;
const savedEnv = { id: process.env.GA_MEASUREMENT_ID, secret: process.env.GA_API_SECRET };

function sentBodies(): Array<{ client_id: string; events: Array<{ name: string; params: Record<string, unknown> }> }> {
  return fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-analytics-'));
  enabled = false;
  fetchMock = vi.fn(async () => ({ ok: true }));
  process.env.GA_MEASUREMENT_ID = 'G-TEST';
  process.env.GA_API_SECRET = 'test-secret';
  __setAnalyticsDepsForTests({
    isEnabled: () => enabled,
    saveEnabled: (v) => { enabled = v; },
    userDataDir: () => dir,
    appVersion: () => '1.0.97',
    fetch: fetchMock,
  });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedEnv.id === undefined) delete process.env.GA_MEASUREMENT_ID; else process.env.GA_MEASUREMENT_ID = savedEnv.id;
  if (savedEnv.secret === undefined) delete process.env.GA_API_SECRET; else process.env.GA_API_SECRET = savedEnv.secret;
});

describe('opt-in gate', () => {
  it('trackEvent and trackAppLaunch send nothing and write no client id while disabled', async () => {
    await trackEvent('app_launch', { a: 1 });
    trackAppLaunch();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, '.analytics-cid'))).toBe(false);
  });

  it('sends once enabled', async () => {
    enabled = true;
    await trackEvent('app_launch', { platform: 'win32' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBodies()[0].events[0].name).toBe('app_launch');
  });

  it('opt-out deletes the client id file and a later opt-in gets a new id', async () => {
    enabled = true;
    await trackEvent('app_launch');
    const cidFile = path.join(dir, '.analytics-cid');
    const firstId = fs.readFileSync(cidFile, 'utf-8');
    setAnalyticsEnabled(false);
    expect(enabled).toBe(false);
    expect(fs.existsSync(cidFile)).toBe(false);
    setAnalyticsEnabled(true);
    await trackEvent('app_launch');
    expect(sentBodies()[1].client_id).not.toBe(firstId);
  });
});

describe('page path normalisation', () => {
  it('sends /game/123?x=1 as /game', async () => {
    enabled = true;
    trackPageView('/game/123?x=1');
    await Promise.resolve();
    const params = sentBodies()[0].events[0].params;
    expect(params.page_title).toBe('/game');
    expect(params.page_location).toBe('app://ark/game');
    expect(JSON.stringify(sentBodies()[0])).not.toMatch(/123/);
  });

  it('drops query, hash, nested game segments and odd characters', () => {
    expect(normalizePagePath('/game/steam-570/reviews#top')).toBe('/game');
    expect(normalizePagePath('/?tab=library')).toBe('/');
    expect(normalizePagePath('/settings#x')).toBe('/settings');
    expect(normalizePagePath(undefined)).toBe('/');
    expect(normalizePagePath('/a b<script>')).toBe('/abscript');
  });
});

describe('renderer event allow-list', () => {
  it('rejects an unknown event name (handler returns false, nothing sent)', async () => {
    enabled = true;
    expect(handleRendererTrackEvent('totally_unknown', { a: 1 })).toBe(false);
    expect(handleRendererTrackEvent('page_view', { page_location: '/game/1' })).toBe(false);
    expect(handleRendererTrackEvent(42, {})).toBe(false);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps only primitive params with valid keys and truncates long strings', () => {
    const out = sanitizeRendererEvent('ok_event', {
      good: 'x'.repeat(500),
      n: 3,
      b: true,
      obj: { nested: 1 },
      'Bad-Key': 'v',
      inf: Infinity,
    }, new Set(['ok_event']));
    expect(out).toEqual({ good: 'x'.repeat(100), n: 3, b: true });
  });
});
