import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startVisibleInterval } from '@/lib/visible-interval';

function fakeDoc(initial: 'visible' | 'hidden') {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: initial as DocumentVisibilityState,
    addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
  };
  return { doc, listeners, set(v: 'visible' | 'hidden') { doc.visibilityState = v; for (const l of [...listeners]) l(); } };
}

describe('startVisibleInterval', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('ticks while visible, stops while hidden, and catches up on return after a long hide', () => {
    const d = fakeDoc('visible');
    const fn = vi.fn();
    const stop = startVisibleInterval(fn, 1000, d.doc as never, () => Date.now());
    vi.advanceTimersByTime(2500);
    expect(fn).toHaveBeenCalledTimes(2);

    d.set('hidden');
    vi.advanceTimersByTime(60_000);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    d.set('visible'); // hidden for far longer than the period: runs at once
    expect(fn).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(4);

    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(d.listeners.size).toBe(0);
  });

  it('does not run on return after a short hide, and never starts a timer for a window that begins hidden', () => {
    const hiddenStart = fakeDoc('hidden');
    const fn = vi.fn();
    startVisibleInterval(fn, 1000, hiddenStart.doc as never, () => Date.now());
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();

    const d = fakeDoc('visible');
    const g = vi.fn();
    startVisibleInterval(g, 1000, d.doc as never, () => Date.now());
    vi.advanceTimersByTime(400);
    d.set('hidden');
    d.set('visible');
    expect(g).not.toHaveBeenCalled();
  });
});
