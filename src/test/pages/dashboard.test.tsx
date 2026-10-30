import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Game, GameFilters } from '@/types/game';

// ─── Shared, controllable mock state ────────────────────────────────────────
const h = vi.hoisted(() => {
  const baseFilters = {
    search: '',
    status: 'All',
    priority: 'All',
    genre: 'All',
    platform: 'All',
    category: 'trending',
    releaseYear: 'All',
    store: [] as string[],
  };
  return {
    baseFilters,
    initialFilters: { ...baseFilters },
    steamGames: [] as unknown[],
    steamError: null as string | null,
    allGamesRef: { current: [] as unknown[] },
    libraryGames: [] as unknown[],
    customGamesList: [] as unknown[],
    libraryEntries: new Map<string, { executablePath?: string }>(),
    customEntries: new Map<string, { executablePath?: string }>(),
    searchCalls: [] as string[],
    deferredInputs: [] as Array<{ isSearching: boolean; searchQuery: string; viewMode: string }>,
    refresh: vi.fn(),
    success: vi.fn(),
    showError: vi.fn(),
    EMPTY: [] as string[],
    liveGames: new Set<string>(),
  };
});

vi.mock('wouter', () => ({ useLocation: () => ['/', vi.fn()] }));

vi.mock('@/hooks/useGameStore', async () => {
  const React = await import('react');
  const noop = () => {};
  return {
    useSteamGames: () => ({
      games: h.steamGames,
      loading: false,
      hasMore: false,
      loadMore: noop,
      error: h.steamError,
      refresh: h.refresh,
      loadingMore: false,
      catalogLetter: null,
      jumpToLetter: noop,
      enrichGames: noop,
      allGamesRef: h.allGamesRef,
      enrichmentMapRef: { current: new Map() },
      catalogTotalCount: 0,
    }),
    useGameSearch: (q: string) => {
      h.searchCalls.push(q);
      return { results: h.EMPTY, loading: false, isSearching: q.trim().length > 0 };
    },
    useLibrary: () => ({
      addToLibrary: noop,
      removeFromLibrary: noop,
      updateEntry: noop,
      isInLibrary: (id: string) => h.libraryEntries.has(id),
      librarySize: h.libraryGames.length + h.customGamesList.length,
      addCustomGame: noop,
      removeCustomGame: noop,
      customGames: h.customGamesList,
    }),
    useLibraryGames: () => ({ games: h.libraryGames, loading: false }),
    useJourneyHistory: () => h.EMPTY,
    useSteamFilters: () => ({ genres: h.EMPTY, platforms: h.EMPTY }),
    useFilteredGames: () => {
      const [filters, setFilters] = React.useState(h.initialFilters);
      const updateFilter = React.useCallback((key: string, value: unknown) => setFilters((f) => ({ ...f, [key]: value })), []);
      const resetFilters = React.useCallback(() => setFilters({ ...h.baseFilters }), []);
      return { filters, updateFilter, resetFilters };
    },
    extractCachedMeta: () => ({}),
    useDebounce: <T,>(value: T, ms: number) => {
      const [v, setV] = React.useState(value);
      React.useEffect(() => {
        const t = setTimeout(() => setV(value), ms);
        return () => clearTimeout(t);
      }, [value, ms]);
      return v;
    },
  };
});

vi.mock('@/hooks/useDeferredFilterSort', () => ({
  useDeferredFilterSort: (input: { currentGames: Game[]; isSearching: boolean; searchQuery: string; viewMode: string }) => {
    h.deferredInputs.push({ isSearching: input.isSearching, searchQuery: input.searchQuery, viewMode: input.viewMode });
    return { sortedGames: input.currentGames, dynamicGenres: h.EMPTY, dynamicPlatforms: h.EMPTY, dynamicYears: h.EMPTY };
  },
  getAdjustedRatingForSort: () => 0,
}));

vi.mock('@/hooks/useDetailEnricher', () => ({ useDetailEnricher: () => {} }));
vi.mock('@/hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => ({ isOnline: true, wasOffline: false, isSyncing: false, acknowledgeOffline: () => {} }),
}));
vi.mock('@/hooks/session-tracker-context', () => ({
  useSessionTrackerContext: () => ({ isPlayingNow: () => false, liveGames: h.liveGames }),
}));
vi.mock('@/hooks/useDevMode', () => ({ useDevMode: () => [false, () => {}] }));
vi.mock('@/hooks/useBetaFeatures', () => ({ useBetaFeatures: () => [false, () => {}] }));
vi.mock('@/hooks/useAllowAdultContent', () => ({ useAllowAdultContent: () => [false, () => {}] }));
vi.mock('@/hooks/useChatAvailability', () => ({ useChatAvailability: () => ({ available: false, message: '' }) }));

vi.mock('@/services/galaxy-cache', () => ({
  scheduleBackgroundPrecompute: () => {},
  getBuildStage: () => 'done',
  subscribeGalaxy: () => () => {},
}));
vi.mock('@/services/safe-mode', () => ({ loadSafeMode: async () => ({ safeMode: true }) }));
vi.mock('@/services/embedding-service', () => ({
  embeddingService: { isOllamaChecked: false, isOllamaUnavailable: false, subscribe: () => () => {} },
}));
vi.mock('@/services/news-service', () => ({ prewarmNews: () => {} }));
vi.mock('@/services/event-resolver-service', () => ({ prewarmEvents: () => {} }));
vi.mock('@/services/prefetch-store', () => ({ setNavigatingGame: () => {} }));
vi.mock('@/services/library-store', () => ({
  libraryStore: {
    subscribe: () => () => {},
    getVersion: () => 0,
    getEntry: (id: string) => h.libraryEntries.get(id),
    getSize: () => h.libraryEntries.size,
    clear: () => {},
  },
}));
vi.mock('@/services/custom-game-store', () => ({
  customGameStore: {
    subscribe: () => () => {},
    getVersion: () => 0,
    getGame: (id: string) => h.customEntries.get(id),
    getCount: () => h.customEntries.size,
    clear: () => {},
    updateGame: () => {},
  },
}));

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: h.success, error: h.showError }) }));
vi.mock('@/components/ui/tooltip-card', () => ({ TooltipCard: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/ui/animate-icon', () => ({
  AnimateIcon: ({ children }: { children: ReactNode }) => <>{children}</>,
  MagneticWrap: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/ui/moving-border', () => ({ MovingBorderButton: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/components/game-dialog', () => ({ GameDialog: () => null }));
vi.mock('@/components/custom-game-dialog', () => ({ CustomGameDialog: () => null }));
vi.mock('@/components/search-suggestions', () => ({ SearchSuggestions: () => null }));
vi.mock('@/components/changelog-modal', () => ({ APP_VERSION: 'test' }));
vi.mock('@/components/window-controls', () => ({ WindowControls: () => null }));
vi.mock('@/components/journey-view', () => ({ JourneyView: () => null }));
vi.mock('@/components/view-error-boundary', () => ({ ViewErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/buzz-view', () => ({ BuzzView: () => null }));
vi.mock('@/components/release-calendar', () => ({ ReleaseCalendar: () => null }));
vi.mock('@/components/ai-chat-panel', () => ({ AIChatPanel: () => null }));
vi.mock('@/components/settings-screen', () => ({ SettingsScreen: () => null }));
vi.mock('@/components/system-status-panel', () => ({ NavbarStatusIndicator: () => null }));
vi.mock('@/components/year-wrapped', () => ({ YearWrapped: () => null, WrappedSnackbar: () => null }));
vi.mock('@/components/game-card-skeleton', () => ({ SkeletonGrid: () => null }));
vi.mock('@/components/guided-tour', () => ({
  GuidedTour: () => null,
  getTourSteps: () => [],
  useTourState: () => ({ tourRunning: false, tourKey: 0, activeTourId: 'welcome', startTour: () => {}, stopTour: () => {} }),
  viewModeToTourId: () => 'browse',
  waitForTourDomReady: async () => {},
}));
vi.mock('@/components/game-card', () => ({
  GameCard: ({ game, onPlay }: { game: Game; onPlay?: (id: string) => void }) => (
    <div data-testid="game-card">
      <button type="button" onClick={() => onPlay?.(game.id)}>Play {game.title}</button>
    </div>
  ),
}));

import { Dashboard } from '@/pages/dashboard';

function game(id: string, title: string, extra: Partial<Game> = {}): Game {
  return { id, title, ...extra } as Game;
}

const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
const launch = vi.fn();

beforeEach(() => {
  h.initialFilters = { ...h.baseFilters };
  h.steamGames = [];
  h.steamError = null;
  h.allGamesRef.current = [];
  h.libraryGames = [];
  h.customGamesList = [];
  h.libraryEntries.clear();
  h.customEntries.clear();
  h.searchCalls.length = 0;
  h.deferredInputs.length = 0;
  h.refresh.mockReset();
  h.success.mockReset();
  h.showError.mockReset();
  launch.mockReset().mockResolvedValue({ success: true });
  (window as unknown as { gameLauncher: unknown }).gameLauncher = { launch };
  sessionStorage.clear();
  // jsdom has no layout: give virtualized rows a height so only a window of them mounts.
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 276 });
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  (globalThis as unknown as { requestIdleCallback: unknown }).requestIdleCallback = (cb: () => void) => setTimeout(cb, 0);
  (globalThis as unknown as { cancelIdleCallback: unknown }).cancelIdleCallback = (id: number) => clearTimeout(id);
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
});

function renderIn(view: 'browse' | 'library') {
  sessionStorage.setItem('ark-return-view', view);
  return render(<Dashboard />);
}

describe('Dashboard card Play', () => {
  it('launches the stored exe for a library game that is also in the browse list (Browse view)', async () => {
    const browseCopy = game('steam-10', 'Shared');
    h.steamGames = [browseCopy];
    h.allGamesRef.current = [browseCopy];
    h.libraryEntries.set('steam-10', { executablePath: 'C:\\Games\\shared.exe' });
    renderIn('browse');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Play Shared' })); });
    expect(launch).toHaveBeenCalledWith('C:\\Games\\shared.exe');
    expect(h.showError).not.toHaveBeenCalled();
  });

  it('launches the stored exe in Library view even though the raw browse copy has none', async () => {
    const browseCopy = game('steam-10', 'Shared');
    h.steamGames = [browseCopy];
    h.allGamesRef.current = [browseCopy];
    h.libraryGames = [game('steam-10', 'Shared', { isInLibrary: true, status: 'Playing' })];
    h.libraryEntries.set('steam-10', { executablePath: 'C:\\Games\\shared.exe' });
    renderIn('library');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Play Shared' })); });
    expect(launch).toHaveBeenCalledWith('C:\\Games\\shared.exe');
    expect(h.showError).not.toHaveBeenCalled();
  });

  it('launches a custom game from the custom game store', async () => {
    h.customGamesList = [game('custom-1', 'Indie', { isInLibrary: true, status: 'Playing' })];
    h.customEntries.set('custom-1', { executablePath: 'D:\\indie.exe' });
    renderIn('library');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Play Indie' })); });
    expect(launch).toHaveBeenCalledWith('D:\\indie.exe');
  });

  it('still reports a missing exe', async () => {
    h.steamGames = [game('steam-11', 'NoExe')];
    renderIn('browse');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Play NoExe' })); });
    expect(launch).not.toHaveBeenCalled();
    expect(h.showError).toHaveBeenCalledWith(expect.stringMatching(/No executable/));
  });
});

describe('Dashboard search', () => {
  it('Library search never fires a store search but still filters locally', () => {
    h.libraryGames = [game('steam-1', 'Zelda', { isInLibrary: true, status: 'Playing' })];
    renderIn('library');
    const input = screen.getByPlaceholderText('Search your library...');
    fireEvent.change(input, { target: { value: 'zel' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(h.searchCalls.length).toBeGreaterThan(0);
    expect(h.searchCalls.every((q) => q === '')).toBe(true);
    const last = h.deferredInputs[h.deferredInputs.length - 1];
    expect(last).toMatchObject({ viewMode: 'library', isSearching: true, searchQuery: 'zel' });
  });

  it('Browse search does fire the store search', () => {
    h.steamGames = [game('steam-1', 'Zelda')];
    renderIn('browse');
    const input = screen.getByPlaceholderText('Search games...');
    fireEvent.change(input, { target: { value: 'zel' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(h.searchCalls).toContain('zel');
  });
});

describe('Dashboard filter badge', () => {
  it('a Release Year filter alone shows the header badge with the same count as FilterTrigger', () => {
    h.initialFilters = { ...h.baseFilters, releaseYear: '2019' } as GameFilters as typeof h.initialFilters;
    h.steamGames = [];
    renderIn('browse');
    const clear = screen.getByRole('button', { name: 'Clear all filters' });
    expect(clear.parentElement).toHaveTextContent('1');
    const trigger = screen.getByRole('button', { name: 'Open filters' });
    expect(trigger).toHaveTextContent('1');
    // Empty result with only a year set is a filter miss, not an empty category.
    expect(screen.getByText('No Matching Games')).toBeInTheDocument();
  });
});

describe('Dashboard empty and error states', () => {
  it('an empty Browse category shows no-browse-results and Retry refetches', () => {
    renderIn('browse');
    expect(screen.getByText('Nothing to Show Here')).toBeInTheDocument();
    expect(screen.queryByText(/No Games in Library/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('Library view hides the Browse fetch error and shows the empty-library state', () => {
    h.steamError = 'Steam fetch failed';
    renderIn('library');
    expect(screen.queryByText('Steam fetch failed')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: /caveman/i })).toBeInTheDocument();
  });

  it('Browse view still shows the fetch error, and Retry refetches instead of reloading', () => {
    h.steamError = 'Steam fetch failed';
    renderIn('browse');
    expect(screen.getByText('Steam fetch failed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('Dashboard layout', () => {
  it('<main> does not animate its padding', () => {
    const { container } = renderIn('browse');
    const main = container.querySelector('main')!;
    expect(main.className).not.toMatch(/transition-all/);
  });

  it('grouped Library view mounts a bounded number of cards for 2,000 games and keeps tour anchors', () => {
    h.libraryGames = Array.from({ length: 2000 }, (_, i) =>
      game(`steam-${i}`, `Game ${i}`, { isInLibrary: true, status: i % 2 ? 'Playing' : 'Completed' }));
    const { container } = renderIn('library');
    const mounted = screen.getAllByTestId('game-card').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(100);
    expect(container.querySelector('[data-tour="game-grid"]')).not.toBeNull();
    expect(container.querySelector('[data-tour="library-status-chips"]')).not.toBeNull();
  });

  it('collapsing a library section removes its cards', () => {
    h.libraryGames = [
      game('steam-1', 'A', { isInLibrary: true, status: 'Playing' }),
      game('steam-2', 'B', { isInLibrary: true, status: 'Completed' }),
    ];
    renderIn('library');
    const sections = screen.getByTestId('library-sections');
    expect(screen.getAllByTestId('game-card')).toHaveLength(2);
    fireEvent.click(within(sections).getByRole('button', { name: /Playing/ }));
    expect(screen.getAllByTestId('game-card')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Play A' })).not.toBeInTheDocument();
  });
});
