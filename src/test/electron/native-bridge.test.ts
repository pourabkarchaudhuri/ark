/**
 * Native Bridge (Phase 3) — safe-fallback contract tests.
 *
 * `native-bridge.ts` wraps the `ark-native` napi addon. The contract that
 * matters most: EVERY exported function must degrade gracefully (return
 * `null`/`false`, never throw) when the native module fails to load for
 * any reason — missing binary, wrong platform, corrupted install, or a
 * loaded module whose exports don't match what's expected.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  nativeSessionEnumerate,
  nativeBridgeStatus,
  __resetNativeBridgeForTests,
} from '../../../electron/native-bridge';

describe('nativeBridgeStatus / nativeSessionEnumerate — load failure', () => {
  beforeEach(() => {
    __resetNativeBridgeForTests(() => {
      throw new Error('simulated: module not found');
    });
  });

  it('reports nativeAvailable=false with the underlying error, never throws', () => {
    const status = nativeBridgeStatus();
    expect(status.nativeAvailable).toBe(false);
    expect(status.source).toBe('js-fallback');
    expect(status.error).toContain('simulated: module not found');
  });

  it('nativeSessionEnumerate returns null (not an empty array, not a throw)', () => {
    expect(() => nativeSessionEnumerate()).not.toThrow();
    expect(nativeSessionEnumerate()).toBeNull();
  });

  it('caches the failed load — does not re-attempt on every call', () => {
    let attempts = 0;
    __resetNativeBridgeForTests(() => {
      attempts++;
      throw new Error('boom');
    });
    nativeSessionEnumerate();
    nativeSessionEnumerate();
    nativeBridgeStatus();
    expect(attempts).toBe(1);
  });
});

describe('nativeBridgeStatus / nativeSessionEnumerate — module loads but has the wrong shape', () => {
  beforeEach(() => {
    // Loaded successfully (no throw) but missing the expected export —
    // must still degrade safely, not crash on `.sessionEnumerate()`.
    __resetNativeBridgeForTests(() => ({ somethingElse: () => [] }));
  });

  it('treats a malformed module the same as a failed load', () => {
    const status = nativeBridgeStatus();
    expect(status.nativeAvailable).toBe(false);
    expect(status.error).toContain('sessionEnumerate export is missing');
    expect(nativeSessionEnumerate()).toBeNull();
  });
});

describe('nativeSessionEnumerate — the underlying call itself throws', () => {
  beforeEach(() => {
    __resetNativeBridgeForTests(() => ({
      sessionEnumerate: () => {
        throw new Error('simulated syscall failure');
      },
    }));
  });

  it('catches the call-time throw and returns null instead of propagating', () => {
    // First call: loadNative() succeeds (module shape is valid), but the
    // actual sessionEnumerate() invocation throws.
    expect(() => nativeSessionEnumerate()).not.toThrow();
    expect(nativeSessionEnumerate()).toBeNull();
    // Module itself is still considered "available" — only this one call
    // failed, matching the JS/PowerShell fallback's per-tick failure model
    // rather than permanently disabling the native path over one bad call.
    expect(nativeBridgeStatus().nativeAvailable).toBe(true);
  });
});

describe('nativeSessionEnumerate — successful load', () => {
  beforeEach(() => {
    __resetNativeBridgeForTests(() => ({
      sessionEnumerate: () => [
        { pid: 4, path: 'c:\\windows\\system32\\smss.exe' },
        { pid: 1234 }, // unresolvable path (elevated/protected process)
      ],
    }));
  });

  it('returns the real array shape unchanged', () => {
    const result = nativeSessionEnumerate();
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({ pid: 4, path: 'c:\\windows\\system32\\smss.exe' });
    expect(result![1].path).toBeUndefined();
  });

  it('nativeBridgeStatus reports available with no error', () => {
    const status = nativeBridgeStatus();
    expect(status).toEqual({ nativeAvailable: true, source: 'ark-native' });
  });
});
