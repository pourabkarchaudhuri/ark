/**
 * App identity and login item (1.0.97 B01): the runtime AppUserModelId equals the installer's
 * build.appId, and only a packaged build writes the Windows login item.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import pkg from '../../../package.json';

// settings-store loads electron through createRequire, which vi.mock('electron') does not reach,
// so a fake is placed in Node's require cache for the dynamic imports below. userData points at a
// folder that never exists (atomicWriteFileSync is mocked, so nothing is written).
const nodeRequire = createRequire(import.meta.url);
const electronId = nodeRequire.resolve('electron');
const savedElectron = nodeRequire.cache[electronId];
nodeRequire.cache[electronId] = {
  id: electronId, filename: electronId, loaded: true,
  exports: {
    app: { getPath: () => '/nonexistent/ark-b01-test', isPackaged: false, setLoginItemSettings: vi.fn() },
    safeStorage: { isEncryptionAvailable: () => false },
  },
} as unknown as NodeModule;
afterAll(() => {
  if (savedElectron) nodeRequire.cache[electronId] = savedElectron;
  else delete nodeRequire.cache[electronId];
});

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { APP_USER_MODEL_ID } from '../../../electron/app-identity';
import { applyLoginItem, __setLoginItemDepsForTests } from '../../../electron/login-item';

describe('APP_USER_MODEL_ID', () => {
  it('equals package.json build.appId (the id on the NSIS shortcuts)', () => {
    expect(APP_USER_MODEL_ID).toBe(pkg.build.appId);
  });
});

describe('applyLoginItem', () => {
  const setLoginItemSettings = vi.fn();
  beforeEach(() => setLoginItemSettings.mockReset());

  it('does nothing in an unpackaged dev run', () => {
    __setLoginItemDepsForTests({ isPackaged: () => false, setLoginItemSettings });
    expect(applyLoginItem(true)).toBe(false);
    expect(setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('writes the login item with --hidden when packaged', () => {
    __setLoginItemDepsForTests({ isPackaged: () => true, setLoginItemSettings });
    expect(applyLoginItem(true)).toBe(true);
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, args: ['--hidden'] });
    applyLoginItem(false);
    expect(setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false, args: [] });
  });
});

describe('SettingsStore.setAutoLaunch', () => {
  it('saves the preference but leaves the login item alone in a dev run', async () => {
    vi.resetModules();
    vi.doMock('../../../electron/safe-write.js', () => ({ atomicWriteFileSync: vi.fn() }));
    const loginItem = await import('../../../electron/login-item');
    const setLoginItemSettings = vi.fn();
    loginItem.__setLoginItemDepsForTests({ isPackaged: () => false, setLoginItemSettings });
    const { settingsStore } = await import('../../../electron/settings-store');
    const safeWrite = await import('../../../electron/safe-write.js');

    settingsStore.setAutoLaunch(false);
    expect(settingsStore.getAutoLaunch()).toBe(false);
    expect(safeWrite.atomicWriteFileSync).toHaveBeenCalled();
    expect(setLoginItemSettings).not.toHaveBeenCalled();

    loginItem.__setLoginItemDepsForTests({ isPackaged: () => true, setLoginItemSettings });
    settingsStore.setAutoLaunch(true);
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, args: ['--hidden'] });
  });

  it('defaults analyticsEnabled to off', async () => {
    vi.resetModules();
    vi.doMock('../../../electron/safe-write.js', () => ({ atomicWriteFileSync: vi.fn() }));
    const { settingsStore } = await import('../../../electron/settings-store');
    expect(settingsStore.getAnalyticsEnabled()).toBe(false);
    settingsStore.setAnalyticsEnabled(true);
    expect(settingsStore.getAnalyticsEnabled()).toBe(true);
  });
});
