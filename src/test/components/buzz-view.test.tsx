/**
 * Transmissions (buzz-view) — Broadcasts strip drag/arrow binding after a
 * late expand, and the cache-respecting, visibility-aware auto-refresh (1.0.97 B23).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ResolvedEvent } from '@/data/gaming-events';

const fetchAllNews = vi.fn(async (_force?: boolean) => [] as unknown[]);
const clearNewsCache = vi.fn();

vi.mock('@/services/news-service', () => ({
  fetchAllNews: (force?: boolean) => fetchAllNews(force),
  clearNewsCache: () => clearNewsCache(),
}));

vi.mock('@/services/event-resolver-service', () => ({
  resolveEvents: vi.fn(async () => []),
  refreshStatuses: (e: unknown[]) => e,
  clearResolvedCache: vi.fn(),
}));

vi.mock('@/services/transmissions-history-store', () => ({
  transmissionsHistoryStore: {
    getDecodedIds: () => new Set<string>(),
    markDecoded: vi.fn(),
  },
}));

import { BuzzView, BroadcastsStrip } from '@/components/buzz-view';

// ─── Broadcasts strip ───────────────────────────────────────────────────────

function makeEvents(n: number): ResolvedEvent[] {
  const now = Math.floor(Date.now() / 1000);
  return Array.from({ length: n }, (_, i) => ({
    id: `ev-${i}`,
    name: `Event ${i}`,
    location: 'Online',
    startDate: now + 86400 * (i + 2),
    youtubeUrls: [],
    twitchUrls: [],
    status: 'upcoming' as const,
  }));
}

function pointer(type: string, clientX: number): Event {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX });
  Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  return ev;
}

const noop = () => {};

function Strip({ events }: { events: ResolvedEvent[] }) {
  return (
    <BroadcastsStrip
      events={events}
      eventsLoading={false}
      tick={0}
      eventFilter={null}
      onEventLatest={noop}
      onClearFilter={noop}
      onOpenUrl={noop}
    />
  );
}

describe('BroadcastsStrip', () => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  let origScrollWidth: PropertyDescriptor | undefined;
  let origClientWidth: PropertyDescriptor | undefined;

  beforeEach(() => {
    origScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    origClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    // Overflowing content: 2000px of cards in a 500px strip.
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 2000 });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 500 });
    // jsdom lacks pointer capture.
    proto.setPointerCapture = vi.fn();
    proto.releasePointerCapture = vi.fn();
  });

  afterEach(() => {
    if (origScrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', origScrollWidth);
    else delete proto.scrollWidth;
    if (origClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', origClientWidth);
    else delete proto.clientWidth;
    delete proto.setPointerCapture;
    delete proto.releasePointerCapture;
  });

  it('binds drag and arrow state when events arrive after a collapsed mount', () => {
    const { rerender } = render(<Strip events={[]} />);
    expect(screen.queryByTestId('broadcasts-scroll')).not.toBeInTheDocument();

    rerender(<Strip events={makeEvents(8)} />);
    const el = screen.getByTestId('broadcasts-scroll');
    expect(screen.getByLabelText('Next broadcasts')).not.toBeDisabled();

    el.scrollLeft = 300;
    act(() => {
      el.dispatchEvent(pointer('pointerdown', 400));
      el.dispatchEvent(pointer('pointermove', 300));
      el.dispatchEvent(pointer('pointerup', 300));
      // The trailing click after a drag is swallowed (and unhooks the suppressor).
      el.click();
    });
    // Dragging left by 100px pans right by 100px.
    expect(el.scrollLeft).toBe(400);
  });

  it('rebinds the handlers to the new element after collapse and re-expand', () => {
    render(<Strip events={makeEvents(8)} />);
    const header = screen.getByText('Scheduled Broadcasts');
    const first = screen.getByTestId('broadcasts-scroll');

    fireEvent.click(header);
    expect(screen.queryByTestId('broadcasts-scroll')).not.toBeInTheDocument();
    fireEvent.click(header);

    const second = screen.getByTestId('broadcasts-scroll');
    expect(second).not.toBe(first);
    expect(screen.getByLabelText('Next broadcasts')).not.toBeDisabled();

    second.scrollLeft = 0;
    act(() => {
      second.dispatchEvent(pointer('pointerdown', 300));
      second.dispatchEvent(pointer('pointermove', 150));
      second.dispatchEvent(pointer('pointerup', 150));
      second.click();
    });
    expect(second.scrollLeft).toBe(150);
  });
});

// ─── Auto-refresh ───────────────────────────────────────────────────────────

describe('BuzzView auto-refresh', () => {
  let hidden = false;

  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    fetchAllNews.mockClear();
    clearNewsCache.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (document as unknown as { hidden?: boolean }).hidden;
  });

  async function mount() {
    render(<BuzzView />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchAllNews).toHaveBeenCalledTimes(1);
    fetchAllNews.mockClear();
  }

  it('skips the timed refresh while the window is hidden', async () => {
    await mount();
    hidden = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(fetchAllNews).not.toHaveBeenCalled();
  });

  it('uses the news cache on a visible timed refresh (no forced refetch)', async () => {
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(fetchAllNews).toHaveBeenCalledTimes(1);
    expect(fetchAllNews).toHaveBeenCalledWith(false);
    expect(clearNewsCache).not.toHaveBeenCalled();
  });

  it('loads through the cache when the window becomes visible', async () => {
    await mount();
    hidden = true;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(fetchAllNews).not.toHaveBeenCalled();
    hidden = false;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(fetchAllNews).toHaveBeenCalledTimes(1);
    expect(fetchAllNews).toHaveBeenCalledWith(false);
  });

  it('manual refresh still clears the cache and forces a fetch', async () => {
    await mount();
    const btn = document.querySelector('[data-tour="buzz-refresh"]') as HTMLElement;
    await act(async () => { fireEvent.click(btn); });
    expect(clearNewsCache).toHaveBeenCalledTimes(1);
    expect(fetchAllNews).toHaveBeenCalledWith(true);
  });
});
