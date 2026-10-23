/**
 * Safe mode query (audit item 13) — renderer side of the crash-loop breaker.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadSafeMode, __resetSafeModeForTests } from '@/services/safe-mode';

const originalElectron = (window as any).electron;

afterEach(() => {
  __resetSafeModeForTests();
  Object.defineProperty(window, 'electron', { value: originalElectron, writable: true, configurable: true });
});

function installBridge(getSafeMode?: () => Promise<unknown>) {
  Object.defineProperty(window, 'electron', {
    value: getSafeMode ? { getSafeMode } : {},
    writable: true,
    configurable: true,
  });
}

describe('loadSafeMode', () => {
  it('reports safe mode when main says so (and caches the answer)', async () => {
    const getSafeMode = vi.fn(async () => ({ safeMode: true, reason: '3 crashes', recentCrashes: 3 }));
    installBridge(getSafeMode);
    await expect(loadSafeMode()).resolves.toEqual({ safeMode: true, reason: '3 crashes', recentCrashes: 3 });
    await loadSafeMode();
    expect(getSafeMode).toHaveBeenCalledTimes(1);
  });

  it('defaults to normal mode for older preloads / failures', async () => {
    installBridge(undefined);
    await expect(loadSafeMode()).resolves.toEqual({ safeMode: false });
    __resetSafeModeForTests();
    installBridge(async () => { throw new Error('no handler'); });
    await expect(loadSafeMode()).resolves.toEqual({ safeMode: false });
  });
});
