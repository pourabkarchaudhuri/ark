/**
 * Boot ordering for ann:load (1.0.97): the multi-GB native index load blocks
 * the main process, so it must run only after the library hydrate and a paint.
 */
import { describe, it, expect, vi } from 'vitest';
import { afterNextPaint, loadAnnIndexAfterHydrate } from '@/services/ann-boot-load';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('loadAnnIndexAfterHydrate', () => {
  it('runs ann:load only after the library hydrate and the paint', async () => {
    const order: string[] = [];
    const hydrate = deferred();
    const load = vi.fn(async () => { order.push('load'); return true; });
    const p = loadAnnIndexAfterHydrate({
      hydrated: hydrate.promise.then(() => { order.push('hydrate'); }),
      afterPaint: async () => { order.push('paint'); },
      load,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(load).not.toHaveBeenCalled();
    hydrate.resolve();
    expect(await p).toBe(true);
    expect(order).toEqual(['hydrate', 'paint', 'load']);
  });

  it('still loads when the hydrate fails', async () => {
    const load = vi.fn(async () => true);
    await expect(loadAnnIndexAfterHydrate({
      hydrated: Promise.reject(new Error('leveldb read failed')),
      afterPaint: async () => {},
      load,
    })).resolves.toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('afterNextPaint', () => {
  it('resolves after a frame', async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      void afterNextPaint().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(50);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to a timeout when frames never run (window hidden at boot)', async () => {
    vi.useFakeTimers();
    const raf = globalThis.requestAnimationFrame;
    (globalThis as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;
    try {
      let done = false;
      void afterNextPaint().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(500);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(600);
      expect(done).toBe(true);
    } finally {
      globalThis.requestAnimationFrame = raf;
      vi.useRealTimers();
    }
  });
});
