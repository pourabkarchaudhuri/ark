/**
 * Shutdown finalisation: shared by before-quit, will-quit and Windows session-end
 * (shutdown / restart / log-off), where before-quit and will-quit never fire.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createShutdownFinalizer, createSessionEndHandler } from '../../../electron/shutdown';

function steps(order: string[]) {
  const mk = (label: string) => ({ label, run: vi.fn(() => { order.push(label); }) });
  return ['session tracker', 'steam cache', 'epic cache', 'hltb cache', 'gg.deals cache', 'chat store', 'clean exit'].map(mk);
}

describe('createShutdownFinalizer', () => {
  it('runs every step once, in order, however often it is called', () => {
    const order: string[] = [];
    const s = steps(order);
    const finalize = createShutdownFinalizer(s);
    finalize();
    finalize();
    expect(order).toEqual(['session tracker', 'steam cache', 'epic cache', 'hltb cache', 'gg.deals cache', 'chat store', 'clean exit']);
    for (const step of s) expect(step.run).toHaveBeenCalledTimes(1);
  });

  it('a failing step does not stop the rest', () => {
    const order: string[] = [];
    const s = steps(order);
    s[1].run.mockImplementationOnce(() => { throw new Error('disk full'); });
    createShutdownFinalizer(s)();
    expect(order).toContain('clean exit');
    expect(order).not.toContain('steam cache');
  });
});

describe('createSessionEndHandler', () => {
  it('sets isQuitting, finalises synchronously, closes the DB fire-and-forget, then quits', () => {
    const calls: string[] = [];
    let closeResolved = false;
    const handler = createSessionEndHandler({
      setQuitting: () => calls.push('quitting'),
      finalize: () => calls.push('finalize'),
      closeDb: () => { calls.push('closeDb'); return new Promise<void>((r) => setTimeout(() => { closeResolved = true; r(); }, 50)); },
      quit: () => calls.push('quit'),
    });
    handler();
    // Everything ran synchronously; the DB close was not awaited
    expect(calls).toEqual(['quitting', 'finalize', 'closeDb', 'quit']);
    expect(closeResolved).toBe(false);
  });

  it('runs once even if session-end and powerMonitor shutdown both fire', () => {
    const quit = vi.fn();
    const finalize = vi.fn();
    const handler = createSessionEndHandler({ setQuitting: () => {}, finalize, closeDb: async () => {}, quit });
    handler();
    handler();
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('a rejected DB close is swallowed (no unhandled rejection)', async () => {
    const handler = createSessionEndHandler({
      setQuitting: () => {}, finalize: () => {}, quit: () => {},
      closeDb: () => Promise.reject(new Error('locked')),
    });
    expect(() => handler()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('wires the real finalizer: steps run exactly once across session-end and a later before-quit', () => {
    const order: string[] = [];
    const s = steps(order);
    const finalize = createShutdownFinalizer(s);
    let isQuitting = false;
    createSessionEndHandler({ setQuitting: () => { isQuitting = true; }, finalize, closeDb: async () => {}, quit: () => finalize() })();
    finalize(); // before-quit / will-quit afterwards
    expect(isQuitting).toBe(true);
    for (const step of s) expect(step.run).toHaveBeenCalledTimes(1);
  });
});
