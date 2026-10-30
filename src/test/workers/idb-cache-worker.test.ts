/**
 * idb-cache.worker (1.0.97 B22, renderer-stores#8): a 'save' with no games is ignored, so an
 * empty refresh can never wipe the 7-day browse cache.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const openSpy = vi.fn();
vi.stubGlobal('indexedDB', { open: openSpy });

describe('idb-cache worker save', () => {
  beforeEach(() => {
    openSpy.mockReset();
  });

  it('ignores a save with an empty games array (no IndexedDB write)', async () => {
    const postSpy = vi.spyOn(self, 'postMessage').mockImplementation(() => {});
    await import('@/workers/idb-cache.worker');
    const handler = self.onmessage as (e: MessageEvent) => Promise<void>;
    expect(typeof handler).toBe('function');

    await handler({ data: { type: 'save', games: [] } } as MessageEvent);

    expect(openSpy).not.toHaveBeenCalled();
    expect(postSpy).toHaveBeenCalledWith({ type: 'save-done', skipped: true });
    postSpy.mockRestore();
  });

  it('still opens IndexedDB for a non-empty save', async () => {
    const postSpy = vi.spyOn(self, 'postMessage').mockImplementation(() => {});
    // An open request that never completes — enough to show the write path was taken.
    openSpy.mockReturnValue({});
    await import('@/workers/idb-cache.worker');
    const handler = self.onmessage as (e: MessageEvent) => Promise<void>;

    void handler({ data: { type: 'save', games: [{ id: 'steam-1', title: 'x' }] } } as MessageEvent);
    await Promise.resolve();

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).not.toHaveBeenCalledWith({ type: 'save-done', skipped: true });
    postSpy.mockRestore();
  });
});
