/**
 * Main renderer crash / reload handling (v1.0.97): the Buzz WebContentsView is
 * torn down whenever the main document goes away, and a tripped crash breaker
 * offers Restart/Quit instead of revealing a dead black window.
 */
import { describe, it, expect, vi } from 'vitest';
import { attachRendererRecovery, revealMainWindow } from '../../../electron/renderer-recovery';

function fakeWindow() {
  const handlers: Record<string, (...args: any[]) => void> = {};
  const webContents = {
    on: vi.fn((name: string, fn: (...args: any[]) => void) => { handlers[name] = fn; }),
    reload: vi.fn(),
    isCrashed: vi.fn(() => false),
  };
  return {
    webContents,
    handlers,
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

function setup(now = () => 1_000) {
  const win = fakeWindow();
  const deps = { destroyWebContentsView: vi.fn(), recordCrash: vi.fn(), now, log: vi.fn() };
  const state = attachRendererRecovery(win as any, deps);
  return { win, deps, state };
}

describe('attachRendererRecovery', () => {
  it('destroys the active web view on render-process-gone, including clean exits', () => {
    const { win, deps } = setup();
    win.handlers['render-process-gone']({}, { reason: 'clean-exit', exitCode: 0 });
    expect(deps.destroyWebContentsView).toHaveBeenCalledTimes(1);
    expect(win.webContents.reload).not.toHaveBeenCalled();

    win.handlers['render-process-gone']({}, { reason: 'crashed', exitCode: 1 });
    expect(deps.destroyWebContentsView).toHaveBeenCalledTimes(2);
    expect(deps.recordCrash).toHaveBeenCalledWith('crashed');
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
  });

  it('keeps the view on same-document (hash route) navigation and destroys it on a full navigation', () => {
    const { win, deps } = setup();
    win.handlers['did-start-navigation']({ isMainFrame: true, isSameDocument: true });
    expect(deps.destroyWebContentsView).not.toHaveBeenCalled();
    win.handlers['did-start-navigation']({ isMainFrame: false, isSameDocument: false });
    expect(deps.destroyWebContentsView).not.toHaveBeenCalled();
    win.handlers['did-start-navigation']({ isMainFrame: true, isSameDocument: false });
    expect(deps.destroyWebContentsView).toHaveBeenCalledTimes(1);
  });

  it('understands the legacy positional did-start-navigation arguments', () => {
    const { win, deps } = setup();
    // (event, url, isInPlace, isMainFrame)
    win.handlers['did-start-navigation']({}, 'file:///x#/a', true, true);
    expect(deps.destroyWebContentsView).not.toHaveBeenCalled();
    win.handlers['did-start-navigation']({}, 'file:///x', false, true);
    expect(deps.destroyWebContentsView).toHaveBeenCalledTimes(1);
  });

  it('marks the renderer dead when the breaker trips and stops reloading', () => {
    const { win, state } = setup();
    for (let i = 0; i < 3; i++) win.handlers['render-process-gone']({}, { reason: 'crashed', exitCode: 1 });
    expect(win.webContents.reload).toHaveBeenCalledTimes(2);
    expect(state.isRendererDead()).toBe(true);
  });

  it('fires onDead exactly once, on the third crash, so a recoverable prompt can be shown', () => {
    const win = fakeWindow();
    const onDead = vi.fn();
    attachRendererRecovery(win as any, { destroyWebContentsView: vi.fn(), recordCrash: vi.fn(), now: () => 1_000, log: vi.fn(), onDead });
    win.handlers['render-process-gone']({}, { reason: 'crashed' });
    win.handlers['render-process-gone']({}, { reason: 'crashed' });
    expect(onDead).not.toHaveBeenCalled();
    win.handlers['render-process-gone']({}, { reason: 'crashed' });
    win.handlers['render-process-gone']({}, { reason: 'crashed' });
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it('forgets crashes outside the 30 s window', () => {
    let t = 0;
    const { win, state } = setup(() => t);
    win.handlers['render-process-gone']({}, { reason: 'crashed' });
    t = 20_000;
    win.handlers['render-process-gone']({}, { reason: 'crashed' });
    t = 60_000;
    win.handlers['render-process-gone']({}, { reason: 'crashed' });
    expect(state.isRendererDead()).toBe(false);
    expect(win.webContents.reload).toHaveBeenCalledTimes(3);
  });
});

describe('revealMainWindow', () => {
  function revealDeps(response = 0) {
    return {
      showMessageBox: vi.fn(async () => ({ response })),
      relaunch: vi.fn(),
      exit: vi.fn(),
      quit: vi.fn(),
    };
  }

  it('restores, shows and focuses a healthy window', async () => {
    const win = fakeWindow();
    win.isMinimized.mockReturnValue(true);
    const deps = revealDeps();
    expect(await revealMainWindow(win as any, { isRendererDead: () => false }, deps)).toBe(true);
    expect(win.restore).toHaveBeenCalled();
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(deps.showMessageBox).not.toHaveBeenCalled();
  });

  it('offers Restart instead of showing a dead window', async () => {
    const win = fakeWindow();
    const deps = revealDeps(0);
    expect(await revealMainWindow(win as any, { isRendererDead: () => true }, deps)).toBe(false);
    expect(win.show).not.toHaveBeenCalled();
    expect(deps.showMessageBox).toHaveBeenCalledTimes(1);
    expect(deps.relaunch).toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('treats a crashed webContents as dead and honours Quit', async () => {
    const win = fakeWindow();
    win.webContents.isCrashed.mockReturnValue(true);
    const deps = revealDeps(1);
    await revealMainWindow(win as any, { isRendererDead: () => false }, deps);
    expect(win.show).not.toHaveBeenCalled();
    expect(deps.quit).toHaveBeenCalled();
    expect(deps.relaunch).not.toHaveBeenCalled();
  });

  it('returns false for a missing or destroyed window', async () => {
    const deps = revealDeps();
    expect(await revealMainWindow(null, { isRendererDead: () => false }, deps)).toBe(false);
    const win = fakeWindow();
    win.isDestroyed.mockReturnValue(true);
    expect(await revealMainWindow(win as any, { isRendererDead: () => false }, deps)).toBe(false);
  });
});
