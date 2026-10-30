/**
 * Buzz / Decode Bay inline web view policy (v1.0.97): window.open only reaches
 * the OS browser after a real user gesture, at most once per 3 s; downloads and
 * permission prompts in the view's own session are refused.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createPopupGate,
  installDecodeBaySessionGuards,
  DECODE_BAY_PARTITION,
  isUserInputEvent,
} from '../../../electron/webview-policy';

function gate(opts: { focused?: boolean } = {}) {
  let t = 10_000;
  const g = createPopupGate({ now: () => t, isMainWindowFocused: () => opts.focused ?? true });
  return { g, advance: (ms: number) => { t += ms; } };
}

describe('createPopupGate', () => {
  it('denies window.open without recent input', () => {
    const { g } = gate();
    expect(g.shouldOpenExternal('https://ads.example/x', 'foreground-tab')).toBe(false);
  });

  it('opens once after a click, then rate-limits for 3 s', () => {
    const { g, advance } = gate();
    g.noteInput();
    expect(g.shouldOpenExternal('https://news.example/a', 'foreground-tab')).toBe(true);
    g.noteInput();
    expect(g.shouldOpenExternal('https://news.example/b', 'new-window')).toBe(false);
    advance(3_100);
    g.noteInput();
    expect(g.shouldOpenExternal('https://news.example/c', 'new-window')).toBe(true);
  });

  it('expires input after ~1 s', () => {
    const { g, advance } = gate();
    g.noteInput();
    advance(1_500);
    expect(g.shouldOpenExternal('https://x.example', 'foreground-tab')).toBe(false);
  });

  it('denies background-tab and other dispositions, non-http URLs and an unfocused window', () => {
    const { g } = gate();
    g.noteInput();
    expect(g.shouldOpenExternal('https://x.example', 'background-tab')).toBe(false);
    expect(g.shouldOpenExternal('https://x.example', 'other')).toBe(false);
    expect(g.shouldOpenExternal('file:///C:/x', 'foreground-tab')).toBe(false);
    expect(g.shouldOpenExternal('javascript:alert(1)', 'foreground-tab')).toBe(false);

    const unfocused = gate({ focused: false });
    unfocused.g.noteInput();
    expect(unfocused.g.shouldOpenExternal('https://x.example', 'foreground-tab')).toBe(false);
  });

  it('reset() forgets input from a previous page', () => {
    const { g } = gate();
    g.noteInput();
    g.reset();
    expect(g.shouldOpenExternal('https://x.example', 'foreground-tab')).toBe(false);
  });
});

describe('isUserInputEvent', () => {
  it('counts mouse-down and key-down only', () => {
    expect(isUserInputEvent({ type: 'mouseDown' })).toBe(true);
    expect(isUserInputEvent({ type: 'keyDown' })).toBe(true);
    expect(isUserInputEvent({ type: 'rawKeyDown' })).toBe(true);
    expect(isUserInputEvent({ type: 'mouseMove' })).toBe(false);
    expect(isUserInputEvent({ type: 'mouseWheel' })).toBe(false);
    expect(isUserInputEvent(null)).toBe(false);
  });
});

describe('installDecodeBaySessionGuards', () => {
  function fakeSession() {
    const listeners: Record<string, (...a: any[]) => void> = {};
    return {
      on: vi.fn((name: string, fn: (...a: any[]) => void) => { listeners[name] = fn; }),
      setPermissionRequestHandler: vi.fn(),
      listeners,
    };
  }

  it('cancels downloads and denies permissions on the view session only', () => {
    const viewSession = fakeSession();
    const defaultSession = fakeSession();
    const fromPartition = vi.fn((p: string) => (p === DECODE_BAY_PARTITION ? viewSession : defaultSession));
    installDecodeBaySessionGuards(fromPartition as any);

    expect(fromPartition).toHaveBeenCalledTimes(1);
    expect(fromPartition).toHaveBeenCalledWith(DECODE_BAY_PARTITION);
    expect(DECODE_BAY_PARTITION.startsWith('persist:')).toBe(false);
    expect(defaultSession.on).not.toHaveBeenCalled();
    expect(defaultSession.setPermissionRequestHandler).not.toHaveBeenCalled();

    const ev = { preventDefault: vi.fn() };
    viewSession.listeners['will-download'](ev, { getFilename: () => 'setup.exe' });
    expect(ev.preventDefault).toHaveBeenCalled();

    const cb = vi.fn();
    const handler = viewSession.setPermissionRequestHandler.mock.calls[0][0];
    handler({}, 'media', cb);
    expect(cb).toHaveBeenCalledWith(false);
  });
});
