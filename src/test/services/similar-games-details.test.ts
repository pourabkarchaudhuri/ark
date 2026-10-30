import { describe, it, expect, vi, beforeEach } from 'vitest';

// 1.0.97 B25: the details strip used to send every folded ANN neighbour (~128) to Steam
// appdetails and Epic, then show 8. Now: distance gate, local titles + dedupe, then at most
// 2k ids to the stores, and a per-source session cache.

vi.mock('@/services/ann-index', () => ({
  annIndex: { isReady: true },
}));

vi.mock('@/services/embedding-service', () => ({
  getEmbeddingById: vi.fn(),
}));

vi.mock('@/services/ann-neighbor-query', () => ({
  queryAnnNeighborGames: vi.fn(),
  annNeighborOverFetch: vi.fn(() => 128),
  isChunkAnnMaxSimEnabled: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/services/prefetch-store', () => ({
  findGameById: vi.fn(() => null),
}));

vi.mock('@/services/library-store', () => ({
  libraryStore: { getEntry: () => undefined },
}));

vi.mock('@/services/custom-game-store', () => ({
  customGameStore: { getGame: () => undefined },
}));

import { getEmbeddingById } from '@/services/embedding-service';
import { queryAnnNeighborGames } from '@/services/ann-neighbor-query';
import { getSimilarGamesForDetails, clearSimilarGamesCache } from '@/services/similar-games';

function rows(n: number, from = 100) {
  return Array.from({ length: n }, (_, i) => ({ id: `steam-${from + i}`, distance: 0.1 + i * 0.002 }));
}

function steamDetails(appId: number, name: string) {
  return { appId, details: { name, steam_appid: appId, header_image: '', genres: [], screenshots: [] } };
}

let getMultipleAppDetails: ReturnType<typeof vi.fn>;
let getCachedGameNames: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearSimilarGamesCache();
  vi.mocked(getEmbeddingById).mockResolvedValue(new Array(8).fill(0.1));
  getMultipleAppDetails = vi.fn(async (ids: number[]) => ids.map((id) => steamDetails(id, `Game ${id}`)));
  getCachedGameNames = vi.fn(async (ids: number[]) => Object.fromEntries(ids.map((id) => [id, `Game ${id}`])));
  Object.defineProperty(window, 'steam', {
    value: { getMultipleAppDetails, getCachedGameNames },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, 'epic', { value: undefined, writable: true, configurable: true });
});

describe('getSimilarGamesForDetails', () => {
  it('sends at most 2k ids to Steam appdetails for 128 neighbours and returns k cards', async () => {
    vi.mocked(queryAnnNeighborGames).mockResolvedValue(rows(128));
    const res = await getSimilarGamesForDetails('steam-1', 8);
    expect(res.status).toBe('ok');
    expect(res.items).toHaveLength(8);
    const sent = getMultipleAppDetails.mock.calls.flatMap((c) => c[0] as number[]);
    expect(sent.length).toBeLessThanOrEqual(16);
    // Placeholder titles resolved in ONE batched cached-name lookup.
    expect(getCachedGameNames).toHaveBeenCalledTimes(1);
  });

  it('applies the distance ceiling', async () => {
    vi.mocked(queryAnnNeighborGames).mockResolvedValue([
      { id: 'steam-10', distance: 0.2 },
      { id: 'steam-11', distance: 0.5 },
    ]);
    const res = await getSimilarGamesForDetails('steam-2', 8);
    expect(res.items.map((c) => c.gameId)).toEqual(['steam-10']);
  });

  it('dedupes same-title twins that only had App N placeholders locally', async () => {
    getCachedGameNames.mockResolvedValue({}); // nothing local: both stay "App N" until enrichment
    getMultipleAppDetails.mockImplementation(async (ids: number[]) =>
      ids.map((id) => steamDetails(id, id === 20 || id === 21 ? 'Portal' : `Game ${id}`)),
    );
    vi.mocked(queryAnnNeighborGames).mockResolvedValue([
      { id: 'steam-20', distance: 0.1 },
      { id: 'steam-21', distance: 0.11 },
      { id: 'steam-22', distance: 0.12 },
    ]);
    const res = await getSimilarGamesForDetails('steam-3', 8);
    expect(res.items.map((c) => c.title)).toEqual(['Portal', 'Game 22']);
  });

  it('enriches a further slice only when fewer than k remain after dedupe', async () => {
    getCachedGameNames.mockResolvedValue({});
    // First 4 (2k for k=2) all enrich to the same title, so a second slice is needed.
    getMultipleAppDetails.mockImplementation(async (ids: number[]) =>
      ids.map((id) => steamDetails(id, id < 104 ? 'Same' : `Game ${id}`)),
    );
    vi.mocked(queryAnnNeighborGames).mockResolvedValue(rows(20));
    const res = await getSimilarGamesForDetails('steam-4', 2);
    expect(res.items.map((c) => c.title)).toEqual(['Same', 'Game 104']);
    expect(getMultipleAppDetails).toHaveBeenCalledTimes(2);
    const sent = getMultipleAppDetails.mock.calls.flatMap((c) => c[0] as number[]);
    expect(sent).toHaveLength(8);
  });

  it('serves a second call for the same source from the session cache', async () => {
    vi.mocked(queryAnnNeighborGames).mockResolvedValue(rows(30));
    const a = await getSimilarGamesForDetails('steam-5', 8);
    const b = await getSimilarGamesForDetails('steam-5', 8);
    expect(b).toBe(a);
    expect(queryAnnNeighborGames).toHaveBeenCalledTimes(1);
  });
});
