/**
 * useOnlineStatus — StrictMode event handling, fallback probe host,
 * recovery hysteresis and hidden-window probe skipping (1.0.97 B23).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode, type ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/services/cache-store', () => ({
  cacheStore: {
    getSyncQueue: vi.fn(async () => []),
    removeSyncQueueItem: vi.fn(async () => {}),
  },
}));

import { useOnlineStatus } from '@/hooks/useOnlineStatus';

const GSTATIC = 'https://connectivitycheck.gstatic.com/generate_204';
const STEAM = 'https://store.steampowered.com/favicon.ico';

let hidden = false;
const fetchMock = vi.fn();

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useOnlineStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // Restore jsdom's prototype getter.
    delete (document as unknown as { hidden?: boolean }).hidden;
  });

  it('reacts to offline/online events inside StrictMode', async () => {
    fetchMock.mockResolvedValue({});
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useOnlineStatus(), { wrapper });
    expect(result.current.isOnline).toBe(true);

    await act(async () => { window.dispatchEvent(new Event('offline')); });
    expect(result.current.isOnline).toBe(false);

    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(result.current.isOnline).toBe(true);
  });

  it('stays online when gstatic fails but the Steam fallback answers', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === GSTATIC) throw new Error('blocked');
      return {};
    });
    const { result } = renderHook(() => useOnlineStatus());
    await advance(3_000);
    await advance(30_000);
    await advance(30_000);
    expect(result.current.isOnline).toBe(true);
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain(GSTATIC);
    expect(urls).toContain(STEAM);
  });

  it('goes offline after two failed probes and needs two successes to recover', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useOnlineStatus());
    await advance(3_000);
    expect(result.current.isOnline).toBe(true);
    await advance(30_000);
    expect(result.current.isOnline).toBe(false);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue({});
    await advance(30_000);
    expect(result.current.isOnline).toBe(false);
    await advance(30_000);
    expect(result.current.isOnline).toBe(true);
  });

  it('skips probes while hidden and probes once when shown again', async () => {
    fetchMock.mockResolvedValue({});
    hidden = true;
    renderHook(() => useOnlineStatus());
    await advance(3_000);
    await advance(30_000);
    expect(fetchMock).not.toHaveBeenCalled();

    hidden = false;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(GSTATIC);
  });
});
