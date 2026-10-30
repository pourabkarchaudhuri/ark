/**
 * Windows login item ("Launch on Startup").
 *
 * Only a packaged build may write the login item: a dev run would register node_modules'
 * electron.exe under the same Run value and the installed Ark would stop starting at login.
 * The preference itself is saved by SettingsStore either way.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
import { logger } from './safe-logger.js';

interface LoginItemDeps {
  isPackaged: () => boolean;
  setLoginItemSettings: (settings: { openAtLogin: boolean; args: string[] }) => void;
}

// Test-only injectable seam: `require('electron')` via createRequire isn't visible to
// vi.mock('electron', ...), same pattern as launch-handlers.ts.
const realDeps = (): LoginItemDeps => ({
  isPackaged: () => electron.app?.isPackaged === true,
  setLoginItemSettings: (s) => electron.app.setLoginItemSettings(s),
});
let deps: LoginItemDeps = realDeps();

export function __setLoginItemDepsForTests(d?: Partial<LoginItemDeps>): void {
  deps = { ...realDeps(), ...d };
}

/** Apply the login item; returns false (and writes nothing) in an unpackaged dev run. */
export function applyLoginItem(enabled: boolean): boolean {
  if (!deps.isPackaged()) {
    logger.log(`[LoginItem] Dev run — not touching the Windows login item (auto-launch ${enabled ? 'on' : 'off'} saved only)`);
    return false;
  }
  deps.setLoginItemSettings({ openAtLogin: enabled, args: enabled ? ['--hidden'] : [] });
  return true;
}
