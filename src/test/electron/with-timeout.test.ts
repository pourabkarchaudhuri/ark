/**
 * withTimeout: the timer is cleared however the wrapped promise settles.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const warn = vi.fn();
vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: (...a: unknown[]) => warn(...a), error: vi.fn() },
}));

import { withTimeout } from '../../../electron/with-timeout';

describe('withTimeout', () => {
  beforeEach(() => { vi.useFakeTimers(); warn.mockClear(); });
  afterEach(() => vi.useRealTimers());

  it('resolves with the value and logs nothing', async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000, 'x')).resolves.toBe(7);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a rejected promise rejects and leaves no timer to log a bogus timeout', async () => {
    const p = withTimeout(Promise.reject(new Error('offline')), 1_000, 'Ad blocker filter download');
    await expect(p).rejects.toThrow('offline');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a slow promise resolves null and logs the timeout', async () => {
    const p = withTimeout(new Promise<number>(() => {}), 1_000, 'Slow thing');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('[Startup] Slow thing timed out after 1000ms');
  });
});
