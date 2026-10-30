/**
 * Main/overlay window navigation guard (v1.0.97): only the app's own entry page
 * (packaged) or the dev-server origin (unpackaged) is "internal"; everything else
 * is blocked in-window and only http(s)/mailto reach the OS.
 */
import { describe, it, expect, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  shouldUseDevServer,
  isAppUrl,
  isExternalOpenable,
  attachNavigationGuards,
  DEV_FLAG_ARG,
  devFlagArgs,
} from '../../../electron/navigation-guard';
import { buildContentSecurityPolicy } from '../../../electron/csp';

const INDEX = path.resolve('/Ark/resources/app.asar/dist/index.html');
const INDEX_URL = pathToFileURL(INDEX).href;
const packagedCtx = { useDevServer: false, indexPath: INDEX, devUrl: 'http://localhost:5173' };
const devCtx = { useDevServer: true, indexPath: INDEX, devUrl: 'http://localhost:5173' };

describe('shouldUseDevServer', () => {
  it('never uses the dev server in a packaged build, even with NODE_ENV=development', () => {
    expect(shouldUseDevServer({ isPackaged: true, nodeEnv: 'development' })).toBe(false);
    expect(shouldUseDevServer({ isPackaged: true, nodeEnv: undefined })).toBe(false);
  });
  it('keeps the unpackaged electron:dev / e2e / production-preview behaviour', () => {
    expect(shouldUseDevServer({ isPackaged: false, nodeEnv: 'development' })).toBe(true);
    expect(shouldUseDevServer({ isPackaged: false, nodeEnv: undefined })).toBe(true);
    expect(shouldUseDevServer({ isPackaged: false, nodeEnv: 'test' })).toBe(false);
    expect(shouldUseDevServer({ isPackaged: false, nodeEnv: 'production' })).toBe(false);
  });
  it('passes a preload flag only for dev-server runs', () => {
    expect(devFlagArgs(true)).toEqual([DEV_FLAG_ARG]);
    expect(devFlagArgs(false)).toEqual([]);
  });
});

describe('isAppUrl (packaged)', () => {
  it('allows the index page with any hash route', () => {
    expect(isAppUrl(INDEX_URL, packagedCtx)).toBe(true);
    expect(isAppUrl(`${INDEX_URL}#/game/steam-730`, packagedCtx)).toBe(true);
  });
  it('rejects UNC hosts, other local files and the dev server', () => {
    expect(isAppUrl('file://attacker/share/x.html', packagedCtx)).toBe(false);
    expect(isAppUrl('file:///C:/other.html', packagedCtx)).toBe(false);
    expect(isAppUrl(pathToFileURL(path.resolve('/Ark/resources/app.asar/dist/other.html')).href, packagedCtx)).toBe(false);
    expect(isAppUrl('http://localhost:5173', packagedCtx)).toBe(false);
    expect(isAppUrl('http://localhost.evil.tld/', packagedCtx)).toBe(false);
    expect(isAppUrl('', packagedCtx)).toBe(false);
    expect(isAppUrl('not a url', packagedCtx)).toBe(false);
  });
});

describe('isAppUrl (dev)', () => {
  it('allows only the exact dev-server origin', () => {
    expect(isAppUrl('http://localhost:5173/#/library', devCtx)).toBe(true);
    expect(isAppUrl('http://localhost:5173/overlay.html', devCtx)).toBe(true);
    expect(isAppUrl('http://localhost.evil.tld:5173/', devCtx)).toBe(false);
    expect(isAppUrl('http://localhost:5174/', devCtx)).toBe(false);
    expect(isAppUrl(INDEX_URL, devCtx)).toBe(false);
  });
});

describe('isExternalOpenable', () => {
  it('allows http, https and mailto only', () => {
    expect(isExternalOpenable('https://store.steampowered.com/app/1')).toBe(true);
    expect(isExternalOpenable('http://example.com')).toBe(true);
    expect(isExternalOpenable('mailto:a@b.c')).toBe(true);
    expect(isExternalOpenable('file:///C:/x.exe')).toBe(false);
    expect(isExternalOpenable('javascript:alert(1)')).toBe(false);
    expect(isExternalOpenable('ms-settings:privacy')).toBe(false);
    expect(isExternalOpenable('garbage')).toBe(false);
  });
});

function fakeWebContents() {
  const handlers: Record<string, (...args: any[]) => void> = {};
  return {
    on: vi.fn((name: string, fn: (...args: any[]) => void) => { handlers[name] = fn; }),
    fire(name: string, url: string) {
      const event = { preventDefault: vi.fn() };
      handlers[name](event, url);
      return event;
    },
    handlers,
  };
}

describe('attachNavigationGuards', () => {
  it('lets hash routing through and blocks + externally opens other http(s) targets', () => {
    const wc = fakeWebContents();
    const openExternal = vi.fn();
    attachNavigationGuards(wc as any, packagedCtx, openExternal);
    expect(Object.keys(wc.handlers).sort()).toEqual(['will-navigate', 'will-redirect']);

    expect(wc.fire('will-navigate', `${INDEX_URL}#/browse`).preventDefault).not.toHaveBeenCalled();

    const ext = wc.fire('will-navigate', 'https://store.epicgames.com/en-US/p/x');
    expect(ext.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://store.epicgames.com/en-US/p/x');
  });

  it('prevents file:// navigation without handing it to the OS', () => {
    const wc = fakeWebContents();
    const openExternal = vi.fn();
    attachNavigationGuards(wc as any, packagedCtx, openExternal);
    const ev = wc.fire('will-navigate', 'file:///C:/en-US/p/slug');
    expect(ev.preventDefault).toHaveBeenCalled();
    const unc = wc.fire('will-redirect', 'file://attacker/share/x.html');
    expect(unc.preventDefault).toHaveBeenCalled();
    const js = wc.fire('will-navigate', 'steam://run/1');
    expect(js.preventDefault).toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('buildContentSecurityPolicy', () => {
  it('locks scripts to self and forbids objects/base', () => {
    const csp = buildContentSecurityPolicy();
    // 'wasm-unsafe-eval' only: the splash scene's Draco decoder compiles WebAssembly
    // in a blob worker, which inherits this policy. No eval, no inline script.
    expect(csp).toMatch(/script-src 'self' 'wasm-unsafe-eval'(;|$)/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain('https://fonts.googleapis.com');
    expect(csp).toContain('https://fonts.gstatic.com');
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toContain('frame-ancestors');
  });
  it('adds frame-ancestors only for the header form (ignored in a meta tag)', () => {
    expect(buildContentSecurityPolicy({ forHeader: true })).toContain("frame-ancestors 'none'");
  });
});
