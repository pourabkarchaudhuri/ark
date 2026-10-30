/**
 * 1.0.97 B31: Release calendar Week view anchoring, render churn, stepwise '+N more',
 * My Radar copy / empty state, and the empty catalog-list cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import {
  ReleaseCalendar,
  getCalendarWeekStart,
  getWeekNavFloor,
  resetCatalogUpcomingCacheForTests,
  RADAR_TOOLTIP,
  RADAR_EMPTY_MESSAGE,
} from '@/components/release-calendar';
import { ToastProvider } from '@/components/ui/toast';
import { libraryStore } from '@/services/library-store';
import { Game } from '@/types/game';

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);
class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { cardRenders, catalogMock } = vi.hoisted(() => ({
  cardRenders: new Map<string, number>(),
  catalogMock: {
    listeners: new Set<() => void>(),
    syncProgress: { stage: 'idle' } as { stage: string },
    queryUpcoming: (() => Promise.resolve([])) as (opts: unknown) => Promise<unknown[]>,
  },
}));

vi.mock('wouter', () => ({
  useLocation: vi.fn(() => ['/', vi.fn()]),
}));

const mockGetPrefetchedGames = vi.fn<() => Game[] | null>(() => null);
const mockIsPrefetchReady = vi.fn(() => false);
vi.mock('@/services/prefetch-store', () => ({
  getPrefetchedGames: (...args: unknown[]) => mockGetPrefetchedGames(...(args as [])),
  isPrefetchReady: (...args: unknown[]) => mockIsPrefetchReady(...(args as [])),
}));

// GameCard stand-in that counts renders but keeps the real memo comparator.
vi.mock('@/components/game-card', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/game-card')>();
  const React = await import('react');
  const Inner = (props: { game: Game; onAddToLibrary?: (id: string) => void }) => {
    cardRenders.set(props.game.id, (cardRenders.get(props.game.id) ?? 0) + 1);
    return (
      <div data-testid="cal-card" data-id={props.game.id}>
        {props.game.title}
        <button onClick={() => props.onAddToLibrary?.(props.game.id)}>add {props.game.title}</button>
      </div>
    );
  };
  const compare = (actual.GameCard as unknown as { compare: (a: object, b: object) => boolean }).compare;
  return { ...actual, GameCard: React.memo(Inner, compare) };
});

vi.mock('@/services/catalog-store', () => {
  return {
    catalogStore: {
      subscribe: (fn: () => void) => { catalogMock.listeners.add(fn); return () => catalogMock.listeners.delete(fn); },
      get syncProgress() { return catalogMock.syncProgress; },
      queryUpcoming: (opts: unknown) => catalogMock.queryUpcoming(opts),
    },
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGameOn(year: number, month: number, day: number, title: string, id: string): Game {
  const date = new Date(year, month, day);
  return {
    id,
    title,
    developer: 'Dev',
    publisher: 'Pub',
    genre: [],
    platform: ['Windows'],
    metacriticScore: null,
    releaseDate: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    comingSoon: false,
    store: 'steam',
    status: 'Want to Play',
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function renderCalendar() {
  await act(async () => {
    render(
      <ToastProvider>
        <ReleaseCalendar />
      </ToastProvider>,
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
}

const ymd = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours()];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Release calendar week math', () => {
  const now = new Date(2026, 9, 30, 12, 0, 0); // Fri Oct 30 2026

  it("anchors on today's week in today's month, on the week of the 1st otherwise", () => {
    expect(ymd(getCalendarWeekStart(2026, 9, 0, now))).toEqual([2026, 10, 25, 0]);
    expect(ymd(getCalendarWeekStart(2026, 9, -1, now))).toEqual([2026, 10, 18, 0]);
    expect(ymd(getCalendarWeekStart(2026, 11, 0, now))).toEqual([2026, 11, 29, 0]);
  });

  it('steps whole local days across DST changes', () => {
    const nov1 = getCalendarWeekStart(2026, 9, 1, now);
    expect(ymd(nov1)).toEqual([2026, 11, 1, 0]);
    expect(nov1.getDay()).toBe(0);
    expect(ymd(getCalendarWeekStart(2026, 9, 2, now))).toEqual([2026, 11, 8, 0]);
    const mar14 = getCalendarWeekStart(2027, 2, 2, now);
    expect(ymd(mar14)).toEqual([2027, 3, 14, 0]);
    expect(mar14.getDay()).toBe(0);
  });

  it('floors navigation at the week containing the window start', () => {
    expect(ymd(getWeekNavFloor(now))).toEqual([2026, 8, 30, 0]);
  });
});

describe('ReleaseCalendar (B31)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 30, 12, 0, 0));
    sessionStorage.clear();
    libraryStore.clear();
    cardRenders.clear();
    resetCatalogUpcomingCacheForTests();
    catalogMock.listeners.clear();
    catalogMock.syncProgress = { stage: 'idle' };
    catalogMock.queryUpcoming = () => Promise.resolve([]);
    mockIsPrefetchReady.mockReturnValue(true);
    mockGetPrefetchedGames.mockReturnValue([]);
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(),
        addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
      })),
    });
    Object.defineProperty(window, 'steam', {
      value: { getUpcomingReleases: vi.fn().mockResolvedValue([]) }, writable: true, configurable: true,
    });
    Object.defineProperty(window, 'epic', {
      value: { getUpcomingReleases: vi.fn().mockResolvedValue([]) }, writable: true, configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── Week view ────────────────────────────────────────────────────────────

  it("Week view opens on today's week and Prev walks back to the window floor", async () => {
    sessionStorage.setItem('ark-calendar-view', 'week');
    mockGetPrefetchedGames.mockReturnValue([makeGameOn(2026, 9, 28, 'Week Game', 'steam-1')]);
    await renderCalendar();

    expect(screen.getByText('Oct 25 – Oct 31, 2026')).toBeInTheDocument();
    expect(screen.queryByText('Today')).not.toBeInTheDocument();

    const prev = screen.getByRole('button', { name: 'Previous period' });
    expect(prev).not.toBeDisabled();
    fireEvent.click(prev);
    expect(screen.getByText('Oct 18 – Oct 24, 2026')).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();

    for (let i = 0; i < 7; i++) fireEvent.click(screen.getByRole('button', { name: 'Previous period' }));
    expect(screen.getByText('Aug 30 – Sep 5, 2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous period' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Previous period' }));
    expect(screen.getByText('Aug 30 – Sep 5, 2026')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Today'));
    expect(screen.getByText('Oct 25 – Oct 31, 2026')).toBeInTheDocument();
  });

  it('switching to Week after navigating Month view to December shows the week of Dec 1', async () => {
    sessionStorage.setItem('ark-calendar-view', 'month');
    await renderCalendar();
    expect(screen.getAllByText('October 2026').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Next period' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next period' }));
    expect(screen.getAllByText('December 2026').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('radio', { name: /Week/ }));
    expect(screen.getByText('Nov 29 – Dec 5, 2026')).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
  });

  // ── Render churn ─────────────────────────────────────────────────────────

  it('adding one game re-renders only that card; a status change re-renders none', async () => {
    mockGetPrefetchedGames.mockReturnValue([
      makeGameOn(2026, 9, 20, 'Alpha', 'steam-101'),
      makeGameOn(2026, 9, 21, 'Bravo', 'steam-102'),
      makeGameOn(2026, 9, 22, 'Charlie', 'steam-103'),
    ]);
    await renderCalendar();
    expect(screen.getAllByTestId('cal-card')).toHaveLength(3);

    cardRenders.clear();
    await act(async () => {
      fireEvent.click(screen.getByText('add Bravo'));
    });
    expect(libraryStore.isInLibrary('steam-102')).toBe(true);
    expect(cardRenders.get('steam-102') ?? 0).toBeGreaterThan(0);
    expect(cardRenders.get('steam-101') ?? 0).toBe(0);
    expect(cardRenders.get('steam-103') ?? 0).toBe(0);

    cardRenders.clear();
    await act(async () => {
      libraryStore.updateEntry('steam-102', { status: 'Playing' });
    });
    expect(cardRenders.size).toBe(0);
  });

  it('My Radar still filters to library games, with a Radar-specific empty state', async () => {
    mockGetPrefetchedGames.mockReturnValue([
      makeGameOn(2026, 9, 20, 'Alpha', 'steam-101'),
      makeGameOn(2026, 9, 21, 'Bravo', 'steam-102'),
    ]);
    await renderCalendar();

    fireEvent.click(screen.getByText('My Radar'));
    expect(screen.queryAllByTestId('cal-card')).toHaveLength(0);
    expect(screen.getByText(RADAR_EMPTY_MESSAGE)).toBeInTheDocument();

    await act(async () => {
      libraryStore.addToLibrary({
        gameId: 'steam-101', status: 'Want to Play', priority: 'Medium', publicReviews: '', recommendationSource: '',
      });
    });
    const cards = screen.getAllByTestId('cal-card');
    expect(cards.map((c) => c.getAttribute('data-id'))).toEqual(['steam-101']);

    fireEvent.click(screen.getByText('My Radar'));
    expect(screen.getAllByTestId('cal-card')).toHaveLength(2);
    expect(screen.queryByText(RADAR_EMPTY_MESSAGE)).not.toBeInTheDocument();
  });

  it('My Radar tooltip describes the library filter (no taste matching)', () => {
    expect(RADAR_TOOLTIP).toBe('Show only releases already in your library (tracked or Want to Play).');
    expect(RADAR_TOOLTIP).not.toMatch(/taste/i);
  });

  // ── Stepwise expansion ───────────────────────────────────────────────────

  it("'+N more' adds 60 cards per click and Show less returns to 30", async () => {
    const games = Array.from({ length: 300 }, (_, i) => makeGameOn(2026, 9, 15, `Big Game ${i}`, `steam-${5000 + i}`));
    mockGetPrefetchedGames.mockReturnValue(games);
    await renderCalendar();

    expect(screen.getAllByTestId('cal-card')).toHaveLength(30);
    expect(screen.getByText('270 of 300 hidden')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /\+60 more/ })); });
    expect(screen.getAllByTestId('cal-card')).toHaveLength(90);
    expect(screen.getByText('210 of 300 hidden')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /\+60 more/ })); });
    expect(screen.getAllByTestId('cal-card')).toHaveLength(150);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show less' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getAllByTestId('cal-card')).toHaveLength(30);
    expect(screen.queryByRole('button', { name: 'Show less' })).not.toBeInTheDocument();
  });

  // ── Catalog cache ────────────────────────────────────────────────────────

  it('does not cache an empty catalog list and reloads when a catalog sync completes', async () => {
    const query = vi.fn((_opts: unknown) => Promise.resolve([] as unknown[]));
    catalogMock.queryUpcoming = query;
    await renderCalendar();
    expect(query).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Synced Game')).not.toBeInTheDocument();

    const ts = Math.floor(new Date(2026, 9, 27, 12).getTime() / 1000);
    query.mockImplementation(() => Promise.resolve([
      { appid: 777, name: 'Synced Game', releaseDate: ts, genres: [], windows: true, mac: false, linux: false },
    ]));
    catalogMock.syncProgress = { stage: 'done' };
    await act(async () => {
      catalogMock.listeners.forEach((fn) => fn());
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Synced Game')).toBeInTheDocument();
  });
});
