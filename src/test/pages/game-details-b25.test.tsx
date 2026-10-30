/**
 * 1.0.97 B25 — game details page: library buttons on dual-store / custom pages, remove
 * confirmation, description Read More and memoised HTML, store buttons and links, product
 * content de-dup, and autoplay / auto-scroll only while the Details tab is showing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { Router, useRoute } from 'wouter';
import { sanitizeStoreHtml } from '@/lib/content-links';
import { GameDetailsPage } from '@/pages/game-details';
import { ToastProvider } from '@/components/ui/toast';
import type { SteamAppDetails } from '@/types/steam';
import type { Game } from '@/types/game';

const navigateMock = vi.fn();
vi.mock('wouter', async () => {
  const actual = await vi.importActual('wouter');
  return {
    ...actual,
    useRoute: vi.fn(() => [true, { id: 'steam-730' }]),
    useLocation: vi.fn(() => ['/', navigateMock]),
  };
});

vi.mock('@/services/prefetch-store', () => ({
  findGameById: vi.fn(() => null),
  searchPrefetchedGames: vi.fn(() => []),
  getPrefetchedGames: vi.fn(() => null),
  isPrefetchReady: vi.fn(() => false),
}));

vi.mock('@/services/similar-games', () => ({
  getSimilarGamesForDetails: vi.fn().mockResolvedValue({ status: 'ann_unavailable', items: [] }),
  formatNeighborDistance: (d: number) => String(d),
}));

vi.mock('@/services/ann-index', () => ({
  annIndex: {
    isReady: true,
    isBuilding: false,
    subscribe: () => () => {},
    refreshStatus: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/services/steam-service', () => ({
  steamService: {
    getNewsForApp: vi.fn().mockResolvedValue([]),
    getMultiplePlayerCounts: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/services/epic-service', () => ({
  epicService: { getGameDetails: vi.fn().mockResolvedValue(null) },
}));

// window.electron is stubbed with only openExternal below.
vi.mock('@/components/window-controls', () => ({ WindowControls: () => null }));

// Store HTML goes through sanitizeStoreHtml (its own DOMPurify instance); wrap it to count calls.
vi.mock('@/lib/content-links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/content-links')>();
  return { ...actual, sanitizeStoreHtml: vi.fn(actual.sanitizeStoreHtml) };
});

// The real dialog is a large form; a stub exposes what the page hands it and a save button.
const dialogProps: { current: Record<string, unknown> | null } = { current: null };
vi.mock('@/components/game-dialog', () => ({
  GameDialog: (props: { open: boolean; game: Game | null; onSave: (d: Record<string, unknown>) => void }) => {
    dialogProps.current = props as unknown as Record<string, unknown>;
    if (!props.open) return null;
    return (
      <div data-testid="game-dialog">
        <span data-testid="dialog-game-id">{props.game?.id}</span>
        <button type="button" onClick={() => props.onSave({ status: 'Playing' })}>Mock Save</button>
      </div>
    );
  },
}));

import { findGameById } from '@/services/prefetch-store';
import { getSimilarGamesForDetails } from '@/services/similar-games';
import { epicService } from '@/services/epic-service';
import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';

const mockUseRoute = vi.mocked(useRoute);
const mockFindGameById = vi.mocked(findGameById);

function steamDetails(overrides: Partial<SteamAppDetails> = {}): SteamAppDetails {
  return {
    type: 'game',
    name: 'Counter-Strike 2',
    steam_appid: 730,
    required_age: 0,
    is_free: false,
    detailed_description: '<p>Short text</p>',
    about_the_game: '',
    short_description: 'Short',
    supported_languages: 'English<strong>*</strong>, French<strong>*</strong>, German<strong>*</strong><br><strong>*</strong>languages with full audio support',
    header_image: 'https://example.com/h.jpg',
    capsule_image: '',
    capsule_imagev5: '',
    website: null,
    pc_requirements: { minimum: '<strong>Minimum:</strong> OS: Windows 10' },
    developers: ['Valve'],
    publishers: ['Valve'],
    platforms: { windows: true, mac: false, linux: false },
    price_overview: { currency: 'USD', initial: 1999, final: 1999, discount_percent: 0, final_formatted: '$19.99' },
    genres: [{ id: '1', description: 'Action' }],
    screenshots: [
      { id: 1, path_thumbnail: 'https://example.com/t1.jpg', path_full: 'https://example.com/f1.jpg' },
      { id: 2, path_thumbnail: 'https://example.com/t2.jpg', path_full: 'https://example.com/f2.jpg' },
      { id: 3, path_thumbnail: 'https://example.com/t3.jpg', path_full: 'https://example.com/f3.jpg' },
    ],
    movies: [],
    release_date: { coming_soon: false, date: 'Aug 21, 2012' },
    ...overrides,
  } as SteamAppDetails;
}

function epicGame(overrides: Partial<Game> = {}): Game {
  return {
    id: 'epic-ns:offer1',
    title: 'Epic Test Game',
    developer: 'Dev',
    publisher: 'Pub',
    genre: ['Action'],
    platform: ['Windows'],
    metacriticScore: null,
    releaseDate: '2025-01-01',
    summary: 'An Epic game',
    coverUrl: '',
    status: 'Want to Play',
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    store: 'epic',
    epicNamespace: 'ns',
    epicOfferId: 'offer1',
    epicSlug: 'epic-test-game',
    price: { isFree: false, finalFormatted: '$29.99', discountPercent: 0 },
    ...overrides,
  } as Game;
}

let getAppDetails: ReturnType<typeof vi.fn>;
let getProductContent: ReturnType<typeof vi.fn>;
let openExternal: ReturnType<typeof vi.fn>;
let launch: ReturnType<typeof vi.fn>;

function setWindowApis() {
  getAppDetails = vi.fn().mockResolvedValue(steamDetails());
  getProductContent = vi.fn().mockResolvedValue({ about: '<p>About</p>', requirements: [] });
  openExternal = vi.fn();
  launch = vi.fn().mockResolvedValue({ success: true });
  const define = (key: string, value: unknown) =>
    Object.defineProperty(window, key, { value, writable: true, configurable: true });
  define('steam', {
    getAppDetails,
    getGameReviews: vi.fn().mockResolvedValue(null),
  });
  define('epic', {
    getGameDetails: vi.fn().mockResolvedValue(null),
    getProductContent,
    getNewsFeed: vi.fn().mockResolvedValue([]),
    getProductReviews: vi.fn().mockResolvedValue(null),
    getAddons: vi.fn().mockResolvedValue([]),
  });
  define('metacritic', undefined);
  define('electron', { openExternal });
  define('gameLauncher', { launch });
  define('ann', {});
}

function renderPage() {
  return render(
    <ToastProvider>
      <Router>
        <GameDetailsPage />
      </Router>
    </ToastProvider>
  );
}

function route(id: string) {
  mockUseRoute.mockReturnValue([true, { id }] as never);
}

async function openDetailsTab() {
  const trigger = await screen.findByRole('tab', { name: /Game Details/ });
  // Radix tabs activate on mousedown.
  fireEvent.mouseDown(trigger);
  await waitFor(() => expect(trigger.getAttribute('data-state')).toBe('active'));
}

async function openProgressTab() {
  const trigger = screen.getByRole('tab', { name: /My Progress/ });
  fireEvent.mouseDown(trigger);
  await waitFor(() => expect(trigger.getAttribute('data-state')).toBe('active'));
}

beforeEach(() => {
  localStorage.clear();
  libraryStore.clear();
  customGameStore.clear();
  dialogProps.current = null;
  setWindowApis();
  window.scrollTo = vi.fn() as never;
  route('steam-730');
});

afterEach(() => {
  vi.clearAllMocks();
  mockFindGameById.mockReturnValue(null);
  vi.mocked(epicService.getGameDetails).mockResolvedValue(null);
  vi.mocked(getSimilarGamesForDetails).mockResolvedValue({ status: 'ann_unavailable', items: [] });
});

// ── Dual-store page opened by an epic- id ────────────────────────────────────

describe('dual-store page opened by an epic- id', () => {
  const mergedSteamPrimary = (): Game => epicGame({
    id: 'steam-500',
    title: 'Dual Game',
    store: 'steam',
    steamAppId: 500,
    secondaryId: 'epic-ns:offer',
    availableOn: ['steam', 'epic'],
    epicNamespace: 'ns',
    epicOfferId: 'offer',
    epicSlug: 'dual-game',
  });

  beforeEach(() => {
    route('epic-ns:offer');
    mockFindGameById.mockReturnValue(mergedSteamPrimary());
    getAppDetails.mockResolvedValue(steamDetails({ name: 'Dual Game', steam_appid: 500 }));
  });

  it('Add opens the dialog and saves an entry keyed by the URL id', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Add to Library/ }));
    expect(await screen.findByTestId('game-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('dialog-game-id').textContent).toBe('epic-ns:offer');
    fireEvent.click(screen.getByText('Mock Save'));
    await waitFor(() => expect(libraryStore.isInLibrary('epic-ns:offer')).toBe(true));
    expect(libraryStore.isInLibrary('steam-500')).toBe(false);
  });

  it('Edit opens prefilled for an existing epic- entry', async () => {
    libraryStore.addToLibrary({ gameId: 'epic-ns:offer', status: 'On Hold', priority: 'High', publicReviews: 'n', recommendationSource: '' });
    renderPage();
    await openDetailsTab();
    fireEvent.click(await screen.findByRole('button', { name: /Edit Library Entry/ }));
    expect(await screen.findByTestId('game-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('dialog-game-id').textContent).toBe('epic-ns:offer');
    expect(dialogProps.current?.initialEntry).toMatchObject({ status: 'On Hold', priority: 'High' });
  });

  it('edits the steam- twin instead of adding an epic- duplicate', async () => {
    libraryStore.addToLibrary({ gameId: 'steam-500', status: 'Want to Play', priority: 'Low', publicReviews: '', recommendationSource: '' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Edit Library Entry/ }));
    expect(screen.getByTestId('dialog-game-id').textContent).toBe('steam-500');
    fireEvent.click(screen.getByText('Mock Save'));
    await waitFor(() => expect(libraryStore.getEntry('steam-500')?.status).toBe('Playing'));
    expect(libraryStore.isInLibrary('epic-ns:offer')).toBe(false);
  });
});

// ── Custom games ─────────────────────────────────────────────────────────────

describe('custom game page', () => {
  it('shows Play (launching the exe), the edit state and a confirmed Remove', async () => {
    const g = customGameStore.addGame({ title: 'My Mod', platform: ['PC'], status: 'Playing', executablePath: 'C:/mod.exe' });
    route(g.id);
    renderPage();
    await openDetailsTab();

    fireEvent.click(await screen.findByRole('button', { name: /^Play$/ }));
    expect(launch).toHaveBeenCalledWith('C:/mod.exe');
    expect(screen.getByRole('button', { name: /Edit Library Entry/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Remove from Library/ }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(customGameStore.getGame(g.id)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(customGameStore.getGame(g.id)).toBeUndefined());
    expect(navigateMock).toHaveBeenCalledWith('/');
    expect(screen.queryByRole('button', { name: /^Play$/ })).not.toBeInTheDocument();
  });

  it('shows Play after an exe is set via Edit, without a remount', async () => {
    const g = customGameStore.addGame({ title: 'No Exe', platform: ['PC'], status: 'Playing' });
    route(g.id);
    renderPage();
    await openDetailsTab();
    expect(screen.queryByRole('button', { name: /^Play$/ })).not.toBeInTheDocument();
    act(() => { customGameStore.updateGame(g.id, { executablePath: 'C:/x.exe' }); });
    expect(await screen.findByRole('button', { name: /^Play$/ })).toBeInTheDocument();
  });
});

// ── Remove confirmation ──────────────────────────────────────────────────────

describe('Remove from Library', () => {
  it('asks first; cancel keeps the entry, confirm removes it with a toast', async () => {
    libraryStore.addToLibrary({ gameId: 'steam-730', status: 'Playing', priority: 'Medium', publicReviews: '', recommendationSource: '' });
    renderPage();
    await openDetailsTab();

    fireEvent.click(screen.getByRole('button', { name: /Remove from Library/ }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(libraryStore.isInLibrary('steam-730')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(libraryStore.isInLibrary('steam-730')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Remove from Library/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(libraryStore.isInLibrary('steam-730')).toBe(false));
    expect(await screen.findByText(/removed from your library/)).toBeInTheDocument();
  });
});

// ── Description ──────────────────────────────────────────────────────────────

describe('About This Game', () => {
  it('offers Read More when the rendered box overflows, even for a short description', async () => {
    const sh = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(400);
    const ch = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(160);
    getAppDetails.mockResolvedValue(steamDetails({ detailed_description: `<p>${'x'.repeat(300)}</p><img src="https://example.com/a.png">` }));
    try {
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Read More' }));
      expect(await screen.findByRole('button', { name: 'Show Less' })).toBeInTheDocument();
    } finally {
      sh.mockRestore();
      ch.mockRestore();
    }
  });

  it('does not offer Read More for a short text-only description', async () => {
    renderPage();
    await screen.findByText('About This Game');
    expect(screen.queryByRole('button', { name: 'Read More' })).not.toBeInTheDocument();
  });

  it('sanitizes the description once, not on every media change', async () => {
    const spy = vi.mocked(sanitizeStoreHtml);
    spy.mockClear();
    try {
      renderPage();
      await screen.findByText('About This Game');
      const descCalls = () => spy.mock.calls.filter(c => String(c[0]).includes('Short text')).length;
      expect(descCalls()).toBe(1);
      const next = screen.getByText('1 / 3').parentElement!.querySelectorAll('button')[1];
      fireEvent.click(next);
      fireEvent.click(next);
      await screen.findByText('3 / 3');
      expect(descCalls()).toBe(1);
    } finally {
      spy.mockClear();
    }
  });
});

// ── Languages ────────────────────────────────────────────────────────────────

describe('Languages', () => {
  it('drops the full-audio footnote and asterisks', async () => {
    renderPage();
    expect(await screen.findByText('German')).toBeInTheDocument();
    expect(screen.queryByText(/languages with full audio support/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\*/)).not.toBeInTheDocument();
  });
});

// ── Store buttons and links ──────────────────────────────────────────────────

describe('store buttons', () => {
  it('Epic-primary fallback: one Steam button without a price, Epic shows Epic price', async () => {
    route('epic-ns:offer1');
    mockFindGameById.mockReturnValue(epicGame({ availableOn: ['epic', 'steam'], steamAppId: 77 }));
    getAppDetails.mockResolvedValue(null); // Steam unreachable → Epic-only view
    renderPage();
    await screen.findByText('Epic Test Game');
    await waitFor(() => {
      const steamButtons = screen.getAllByRole('button').filter(b => /Steam/.test(b.textContent ?? '') && !/Epic/.test(b.textContent ?? ''));
      expect(steamButtons).toHaveLength(1);
      expect(steamButtons[0].textContent).not.toContain('$29.99');
    });
    const epicBtn = screen.getAllByRole('button').find(b => /Epic Games/.test(b.textContent ?? ''));
    expect(epicBtn?.textContent).toContain('$29.99');
    expect(screen.queryByText(/% cheaper/)).not.toBeInTheDocument();
  });

  it('cross-store game with a namespace but no slug links to an Epic store search', async () => {
    mockFindGameById.mockReturnValue(epicGame({
      id: 'steam-730',
      title: 'Counter-Strike 2',
      store: 'steam',
      availableOn: ['steam', 'epic'],
      epicSlug: undefined,
      epicNamespace: 'a1b2c3d4',
      epicOfferId: 'o1',
      epicPrice: { isFree: false, finalFormatted: '$5.00', discountPercent: 0 },
    }));
    renderPage();
    await screen.findByText('Counter-Strike 2');
    const epicBtn = await waitFor(() => {
      const b = screen.getAllByRole('button').find(x => /Epic Games/.test(x.textContent ?? ''));
      expect(b).toBeDefined();
      return b!;
    });
    fireEvent.click(epicBtn);
    expect(openExternal).toHaveBeenCalledWith('https://store.epicgames.com/en-US/browse?q=Counter-Strike%202');
  });
});

// ── Epic product content ─────────────────────────────────────────────────────

describe('Epic product content', () => {
  it('Epic-only page without requirements requests product content once', async () => {
    route('epic-ns:offer1');
    mockFindGameById.mockReturnValue(epicGame());
    vi.mocked(epicService.getGameDetails).mockResolvedValue(epicGame());
    renderPage();
    await screen.findByText('Epic Test Game');
    await new Promise(r => setTimeout(r, 50));
    expect(getProductContent).toHaveBeenCalledTimes(1);
  });

  it('Steam-null fallback still fetches requirements for the Epic slug', async () => {
    getAppDetails.mockResolvedValue(null);
    mockFindGameById.mockReturnValue(epicGame({
      id: 'steam-730',
      title: 'Counter-Strike 2',
      store: 'steam',
      availableOn: ['steam', 'epic'],
      epicSlug: 'cs2',
      epicPrice: { isFree: false, finalFormatted: '$5.00', discountPercent: 0 },
    }));
    vi.mocked(epicService.getGameDetails).mockResolvedValue(epicGame({ title: 'Counter-Strike 2', epicSlug: 'cs2' }));
    renderPage();
    await waitFor(() => expect(getProductContent).toHaveBeenCalledWith('cs2'));
  });
});

// ── Timers only while Details is showing ────────────────────────────────────

describe('Details-tab timers for library games', () => {
  beforeEach(() => {
    libraryStore.addToLibrary({ gameId: 'steam-730', status: 'Playing', priority: 'Medium', publicReviews: '', recommendationSource: '' });
  });

  it('media autoplay does not run on My Progress and resumes on Game Details', async () => {
    const st = vi.spyOn(globalThis, 'setTimeout');
    try {
      renderPage();
      await screen.findByRole('tab', { name: /My Progress/ });
      await new Promise(r => setTimeout(r, 20));
      const autoplayTimers = () => st.mock.calls.filter(c => c[1] === 5000).length;
      expect(autoplayTimers()).toBe(0);
      await openDetailsTab();
      await waitFor(() => expect(autoplayTimers()).toBeGreaterThan(0));
    } finally {
      st.mockRestore();
    }
  });

  it('similar-games auto-scroll starts when the strip mounts and stops when it unmounts', async () => {
    vi.mocked(getSimilarGamesForDetails).mockResolvedValue({
      status: 'ok',
      items: [{ gameId: 'steam-1', title: 'Neighbour', distance: 0.1, imageChain: [], genreTags: [] }],
    });
    const si = vi.spyOn(globalThis, 'setInterval');
    const ci = vi.spyOn(globalThis, 'clearInterval');
    const scrollBy = vi.fn();
    (HTMLElement.prototype as unknown as { scrollBy: unknown }).scrollBy = scrollBy;
    try {
      renderPage();
      await screen.findByRole('tab', { name: /My Progress/ });
      await waitFor(() => expect(getSimilarGamesForDetails).toHaveBeenCalled());
      await new Promise(r => setTimeout(r, 20));
      const recsIntervals = () => si.mock.calls.map((c, i) => ({ ms: c[1], id: si.mock.results[i]?.value })).filter(c => c.ms === 10000);
      expect(recsIntervals()).toHaveLength(0);

      await openDetailsTab();
      await waitFor(() => expect(recsIntervals()).toHaveLength(1));
      const intervalId = recsIntervals()[0].id;

      fireEvent.click(screen.getByRole('button', { name: 'Scroll right' }));
      expect(scrollBy).toHaveBeenCalledWith({ left: 280, behavior: 'smooth' });

      await openProgressTab();
      await waitFor(() => expect(ci).toHaveBeenCalledWith(intervalId));
    } finally {
      si.mockRestore();
      ci.mockRestore();
      delete (HTMLElement.prototype as unknown as { scrollBy?: unknown }).scrollBy;
    }
  });
});
