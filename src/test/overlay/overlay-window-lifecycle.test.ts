/**
 * Overlay window lifecycle (1.0.97 B05) — hotkeys only while enabled, sticky
 * hotkey dismiss, and bounded renderer-crash recovery.
 *
 * `require('electron')` via createRequire bypasses vi.mock, so the fake
 * BrowserWindow/screen/globalShortcut go in through __setOverlayElectronForTests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  __setOverlayElectronForTests,
  activateOverlay,
  applyOverlayHotkeys,
  getOverlayWindow,
  handleOverlayToggleHotkey,
  handleOverlayVisibilityChange,
  isOverlayCycleHotkeyRegistered,
  isOverlayVisible,
  notifyOverlayEnabledChanged,
  setOverlayEnabledChangedHook,
  setOverlayLifecycleHooks,
  setOverlayPreloadPath,
  OVERLAY_CYCLE_HOTKEY,
  OVERLAY_TOGGLE_HOTKEY,
} from '../../../electron/overlay-window';

type Listener = (...args: any[]) => void;

class FakeEmitter {
  listeners: Record<string, Listener[]> = {};
  on(ev: string, fn: Listener) { (this.listeners[ev] ??= []).push(fn); return this; }
  emit(ev: string, ...args: any[]) { for (const fn of this.listeners[ev] ?? []) fn(...args); }
}

class FakeWindow extends FakeEmitter {
  static created: FakeWindow[] = [];
  visible = false;
  destroyed = false;
  size: [number, number];
  webContents = Object.assign(new FakeEmitter(), {
    send: vi.fn(),
    setBackgroundThrottling: vi.fn(),
  });
  constructor(opts: { width: number; height: number }) {
    super();
    this.size = [opts.width, opts.height];
    FakeWindow.created.push(this);
  }
  setIgnoreMouseEvents() {}
  loadURL() { return Promise.resolve(); }
  loadFile() { return Promise.resolve(); }
  getSize() { return this.size; }
  setSize(w: number, h: number) { this.size = [w, h]; }
  setPosition() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
}

const registered = new Map<string, () => void>();
let registerOk = true;
const globalShortcut = {
  register: vi.fn((accel: string, fn: () => void) => {
    if (!registerOk) return false;
    registered.set(accel, fn);
    return true;
  }),
  unregister: vi.fn((accel: string) => { registered.delete(accel); }),
};

const flushImmediate = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  FakeWindow.created = [];
  registered.clear();
  registerOk = true;
  globalShortcut.register.mockClear();
  globalShortcut.unregister.mockClear();
  __setOverlayElectronForTests({
    app: { isPackaged: true, getAppPath: () => 'C:\\app' },
    BrowserWindow: FakeWindow,
    screen: {
      on: vi.fn(),
      removeListener: vi.fn(),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
    globalShortcut,
  });
  setOverlayPreloadPath('C:\\app\\preload.cjs');
});

afterEach(() => {
  vi.useRealTimers();
  __setOverlayElectronForTests();
});

describe('overlay hotkeys follow the enabled setting', () => {
  it('registers no global shortcut when the overlay is disabled at startup', () => {
    applyOverlayHotkeys(false, () => {});
    expect(globalShortcut.register).not.toHaveBeenCalled();
    expect(registered.size).toBe(0);
    // Intentionally unbound is not a bind failure (no Settings warning).
    expect(isOverlayCycleHotkeyRegistered()).toBe(true);
  });

  it('toggling on registers both hotkeys; toggling off unregisters them', () => {
    const onToggle = vi.fn();
    applyOverlayHotkeys(true, onToggle);
    expect([...registered.keys()].sort()).toEqual([OVERLAY_CYCLE_HOTKEY, OVERLAY_TOGGLE_HOTKEY].sort());
    registered.get(OVERLAY_TOGGLE_HOTKEY)!();
    expect(onToggle).toHaveBeenCalledTimes(1);

    applyOverlayHotkeys(false, onToggle);
    expect(registered.size).toBe(0);

    applyOverlayHotkeys(true, onToggle);
    expect(registered.size).toBe(2);
  });

  it('settings hook re-applies hotkeys on enable change', () => {
    const onToggle = vi.fn();
    setOverlayEnabledChangedHook((enabled) => applyOverlayHotkeys(enabled, onToggle));
    notifyOverlayEnabledChanged(true);
    expect(registered.size).toBe(2);
    notifyOverlayEnabledChanged(false);
    expect(registered.size).toBe(0);
  });

  it('reports a cycle-hotkey bind failure only after a failed register attempt', () => {
    registerOk = false;
    applyOverlayHotkeys(true, () => {});
    expect(isOverlayCycleHotkeyRegistered()).toBe(false);
  });
});

/**
 * Mirrors session-tracker updateOverlayVisibility: show edge-triggered on the
 * latch, hide level-triggered when no sessions are active.
 */
function makeTracker(enabled = () => true) {
  const state = { latch: false, active: 0 };
  const gate = {
    isEnabled: enabled,
    getActiveSessionCount: () => state.active,
    syncLatch: (v: boolean) => { state.latch = v; },
  };
  const pollTick = () => {
    if (state.active === 0) {
      state.latch = false;
      handleOverlayVisibilityChange(false, gate);
      return;
    }
    if (state.latch) return;
    state.latch = true;
    handleOverlayVisibilityChange(true, gate);
  };
  return { state, gate, pollTick };
}

describe('hotkey dismiss is sticky for the session', () => {
  it('does not re-show or rebuild the HUD on later polls after a dismiss', () => {
    const { state, gate, pollTick } = makeTracker();
    state.active = 1;
    pollTick();
    expect(isOverlayVisible()).toBe(true);
    expect(FakeWindow.created).toHaveLength(1);

    handleOverlayToggleHotkey(gate); // dismiss
    expect(isOverlayVisible()).toBe(false);
    expect(state.latch).toBe(true);

    pollTick();
    pollTick();
    pollTick();
    expect(isOverlayVisible()).toBe(false);
    expect(FakeWindow.created).toHaveLength(1);
  });

  it('shows again for the next game after all sessions end', () => {
    const { state, gate, pollTick } = makeTracker();
    state.active = 1;
    pollTick();
    handleOverlayToggleHotkey(gate);
    state.active = 0;
    pollTick();
    expect(state.latch).toBe(false);
    state.active = 1;
    pollTick();
    expect(isOverlayVisible()).toBe(true);
    expect(FakeWindow.created).toHaveLength(2);
  });

  it('hotkey re-show still works after a dismiss', () => {
    const { state, gate, pollTick } = makeTracker();
    state.active = 1;
    pollTick();
    handleOverlayToggleHotkey(gate);
    handleOverlayToggleHotkey(gate);
    expect(isOverlayVisible()).toBe(true);
    expect(state.latch).toBe(true);
  });

  it('with the overlay disabled a show edge is a no-op and keeps the latch', () => {
    const { state, pollTick } = makeTracker(() => false);
    state.active = 1;
    pollTick();
    expect(FakeWindow.created).toHaveLength(0);
    expect(state.latch).toBe(true);
  });
});

describe('overlay renderer crash recovery', () => {
  function setupHooks() {
    const latchReset = vi.fn();
    const onCreated = vi.fn();
    const onDestroyed = vi.fn();
    setOverlayLifecycleHooks({ onCreated, onDestroyed, onCrashLatchReset: latchReset });
    return { latchReset, onCreated, onDestroyed };
  }

  const crash = (win: FakeWindow, reason = 'crashed') =>
    win.webContents.emit('render-process-gone', {}, { reason });

  it('destroys and recreates once when the HUD was visible', async () => {
    const { latchReset, onCreated, onDestroyed } = setupHooks();
    activateOverlay();
    const first = FakeWindow.created[0];
    crash(first);
    await flushImmediate();
    expect(first.destroyed).toBe(true);
    expect(FakeWindow.created).toHaveLength(2);
    expect(getOverlayWindow()).toBe(FakeWindow.created[1]);
    expect(isOverlayVisible()).toBe(true);
    expect(onDestroyed).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(2);
    expect(latchReset).not.toHaveBeenCalled();
  });

  it('ignores a clean-exit', async () => {
    const { latchReset } = setupHooks();
    activateOverlay();
    const first = FakeWindow.created[0];
    crash(first, 'clean-exit');
    await flushImmediate();
    expect(first.destroyed).toBe(false);
    expect(FakeWindow.created).toHaveLength(1);
    expect(latchReset).not.toHaveBeenCalled();
  });

  it('gives up after 3 recreates in 60 s, leaving it destroyed with the latch reset', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
    const { latchReset } = setupHooks();
    activateOverlay();
    for (let i = 0; i < 4; i++) {
      crash(FakeWindow.created[FakeWindow.created.length - 1]);
      await flushImmediate();
      vi.setSystemTime(Date.now() + 5_000);
    }
    expect(FakeWindow.created).toHaveLength(4); // original + 3 recreates
    expect(getOverlayWindow()).toBeNull();
    expect(isOverlayVisible()).toBe(false);
    expect(latchReset).toHaveBeenCalledTimes(1);
  });

  it('recovers again once the rolling window has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
    setupHooks();
    activateOverlay();
    for (let i = 0; i < 3; i++) {
      crash(FakeWindow.created[FakeWindow.created.length - 1]);
      await flushImmediate();
    }
    vi.setSystemTime(Date.now() + 61_000);
    crash(FakeWindow.created[FakeWindow.created.length - 1]);
    await flushImmediate();
    expect(FakeWindow.created).toHaveLength(5);
    expect(isOverlayVisible()).toBe(true);
  });

  it('a stale window crash handler does not touch a newer overlay', async () => {
    const { latchReset } = setupHooks();
    activateOverlay();
    const stale = FakeWindow.created[0];
    // Dismiss + new session → a fresh window replaces the old one.
    handleOverlayToggleHotkey({ isEnabled: () => true, getActiveSessionCount: () => 1, syncLatch: () => {} });
    activateOverlay();
    const current = FakeWindow.created[1];
    crash(stale);
    stale.emit('closed');
    await flushImmediate();
    expect(current.destroyed).toBe(false);
    expect(getOverlayWindow()).toBe(current);
    expect(FakeWindow.created).toHaveLength(2);
    expect(latchReset).not.toHaveBeenCalled();
  });

  it('a crash while hidden destroys without recreating and resets the latch', async () => {
    const { latchReset } = setupHooks();
    activateOverlay();
    const first = FakeWindow.created[0];
    first.hide();
    crash(first);
    await flushImmediate();
    expect(first.destroyed).toBe(true);
    expect(FakeWindow.created).toHaveLength(1);
    expect(latchReset).toHaveBeenCalledTimes(1);
  });
});
