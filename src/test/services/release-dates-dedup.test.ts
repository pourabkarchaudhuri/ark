/**
 * 1.0.97 B20 — release-date parsing and dedup.
 * Shared parser (dedup.ts), its consumers (steam-service, detail dialog game,
 * Browse filter/sort, release calendar, Ark terminal panel, news cards) and the
 * id/strict-title dedup rewrite.
 */

import { describe, it, expect } from 'vitest';
import {
  releaseTsOf,
  releaseYearOf,
  parseSteamReleaseDate,
  deduplicateGames,
  dedupSortAndStamp,
  SENTINEL_YEAR,
} from '@/services/dedup';
import { transformSteamGame, steamDetailsToDialogGame } from '@/services/steam-service';
import { extractCachedMeta } from '@/hooks/useGameStore';
import { computeAll, type FilterSortInput } from '@/hooks/useDeferredFilterSort';
import { prefetchReleaseSlot } from '@/components/release-calendar';
import { formatRegistryReleaseDate, newsDateLabel, newsDateSeconds } from '@/lib/release-date-display';
import type { Game, GameFilters } from '@/types/game';
import type { SteamAppDetails } from '@/types/steam';

function game(overrides: Partial<Game> & { id: string; title: string }): Game {
  return {
    store: 'steam',
    developer: 'Dev',
    publisher: 'Pub',
    genre: ['Action'],
    metacriticScore: null,
    platform: ['Windows'],
    status: 'Want to Play',
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
    releaseDate: '2024-01-01',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function details(overrides: Partial<SteamAppDetails> = {}): SteamAppDetails {
  return {
    type: 'game',
    name: 'Test Game',
    steam_appid: 730,
    required_age: 0,
    is_free: false,
    detailed_description: '',
    about_the_game: '',
    short_description: '',
    supported_languages: 'English',
    header_image: 'https://cdn.example.com/730/header.jpg',
    capsule_image: '',
    capsule_imagev5: '',
    website: '',
    pc_requirements: { minimum: '', recommended: '' },
    platforms: { windows: true, mac: false, linux: false },
    ...overrides,
  };
}

const FILTERS: GameFilters = {
  search: '', status: 'All', priority: 'All', genre: 'All', platform: 'All',
  category: 'all', releaseYear: 'All', store: [],
};

function run(games: Game[], over: Partial<FilterSortInput> = {}, filters: Partial<GameFilters> = {}) {
  return computeAll({
    currentGames: games,
    searchResults: [],
    isSearching: false,
    viewMode: 'browse',
    searchQuery: '',
    filters: { ...FILTERS, ...filters },
    sortBy: 'releaseDate',
    sortDirection: 'asc',
    ...over,
  });
}

describe('releaseTsOf / releaseYearOf', () => {
  it('maps text dates to 0 instead of NaN', () => {
    expect(releaseTsOf('Coming soon')).toBe(0);
    expect(releaseTsOf('To be announced')).toBe(0);
    expect(releaseTsOf('Q1 2027')).toBe(0);
    expect(releaseTsOf(undefined)).toBe(0);
    expect(releaseTsOf('')).toBe(0);
  });

  it('parses real dates', () => {
    expect(releaseTsOf('2019-10-25T12:00:00.000Z')).toBe(Date.UTC(2019, 9, 25, 12));
    expect(releaseTsOf('December 2026')).toBeGreaterThan(0);
    expect(releaseTsOf('2027')).toBe(Date.UTC(2027, 0, 1));
  });

  it('finds the year in any format', () => {
    expect(releaseYearOf('Coming soon')).toBeUndefined();
    expect(releaseYearOf('To be announced')).toBeUndefined();
    expect(releaseYearOf('Q1 2027')).toBe(2027);
    expect(releaseYearOf('December 2026')).toBe(2026);
    expect(releaseYearOf('2027')).toBe(2027);
    expect(releaseYearOf('2019-10-25T00:00:00.000Z')).toBe(2019);
    expect(releaseYearOf('2099-01-01')).toBe(2099);
  });
});

describe('parseSteamReleaseDate', () => {
  it('converts a day-precise date to ISO on the same calendar day in any time zone', () => {
    expect(parseSteamReleaseDate('Oct 25, 2019').releaseDate.startsWith('2019-10-25')).toBe(true);
    expect(parseSteamReleaseDate('12 Mar, 2026').releaseDate.startsWith('2026-03-12')).toBe(true);
    expect(parseSteamReleaseDate('12 Mar, 2026', true).releaseDate.startsWith('2026-03-12')).toBe(true);
  });

  it('keeps an existing ISO string unchanged', () => {
    expect(parseSteamReleaseDate('2019-10-24T18:30:00.000Z')).toEqual({ releaseDate: '2019-10-24T18:30:00.000Z' });
  });

  it('upcoming year/quarter-only dates become the Coming Soon placeholder with the raw text kept', () => {
    expect(parseSteamReleaseDate('2026', true)).toEqual({ releaseDate: 'Coming Soon', releaseDateText: '2026' });
    expect(parseSteamReleaseDate('Q1 2026', true)).toEqual({ releaseDate: 'Coming Soon', releaseDateText: 'Q1 2026' });
  });

  it('text without a year stays as is', () => {
    expect(parseSteamReleaseDate('Coming soon', true)).toEqual({ releaseDate: 'Coming soon' });
    expect(parseSteamReleaseDate('To be announced', true)).toEqual({ releaseDate: 'To be announced' });
    expect(parseSteamReleaseDate(undefined)).toEqual({ releaseDate: '' });
  });

  it('a year-only date of a released game is not turned into the placeholder', () => {
    expect(parseSteamReleaseDate('2019', false)).toEqual({ releaseDate: '2019' });
  });
});

describe('transformSteamGame release dates', () => {
  it("'2026' with coming_soon -> 'Coming Soon', stamped 0", () => {
    const g = transformSteamGame(details({ release_date: { coming_soon: true, date: '2026' } }));
    expect(g.releaseDate).toBe('Coming Soon');
    expect(g.releaseDateText).toBe('2026');
    expect(g.comingSoon).toBe(true);
    const [stamped] = dedupSortAndStamp([g]);
    expect((stamped as any)._releaseTs).toBe(0);
  });

  it("'12 Mar, 2026' -> ISO", () => {
    const g = transformSteamGame(details({ release_date: { coming_soon: true, date: '12 Mar, 2026' } }));
    expect(g.releaseDate).toMatch(/^2026-03-12T/);
    expect(g.releaseDateText).toBeUndefined();
  });
});

describe('details-page dialog game', () => {
  it('stores an ISO date, store steam and the header image', () => {
    const g = steamDetailsToDialogGame(
      details({ steam_appid: 400, name: 'Portal', release_date: { coming_soon: false, date: 'Oct 25, 2019' } }),
      false,
    );
    const meta = extractCachedMeta(g);
    expect(meta.releaseDate?.startsWith('2019-10-25')).toBe(true);
    expect(meta.store).toBe('steam');
    expect(meta.headerImage).toBe('https://cdn.example.com/730/header.jpg');
    expect(g.status).toBe('Want to Play');
    expect(g.recommendationSource).toBe('Personal Discovery');
    expect(g.isInLibrary).toBe(false);
  });

  it("'Coming soon' stays as is", () => {
    const g = steamDetailsToDialogGame(details({ release_date: { coming_soon: true, date: 'Coming soon' } }), true);
    expect(g.releaseDate).toBe('Coming soon');
    expect(g.isInLibrary).toBe(true);
  });

  it('the library Release Year filter 2019 includes it', () => {
    const g = { ...steamDetailsToDialogGame(details({ release_date: { coming_soon: false, date: 'Oct 25, 2019' } }), true) };
    const out = run([g], { viewMode: 'library' }, { releaseYear: '2019' });
    expect(out.displayedGames.map((x) => x.id)).toEqual([g.id]);
    expect(run([g], { viewMode: 'library' }).dynamicYears).toContain('2019');
  });
});

describe('Browse filter and sort with text dates', () => {
  it("a 'Q1 2027' game appears in All and Trending and matches year 2027", () => {
    const tba = game({ id: 'steam-1', title: 'Future', releaseDate: 'Q1 2027', comingSoon: true });
    for (const category of ['all', 'trending'] as const) {
      expect(run([tba], {}, { category }).displayedGames).toHaveLength(1);
    }
    expect(run([tba], {}, { releaseYear: '2027' }).displayedGames).toHaveLength(1);
    expect(run([tba], {}, { releaseYear: '2026' }).displayedGames).toHaveLength(0);
    expect(run([tba]).dynamicYears).toContain('2027');
  });

  it('a Steam year-only placeholder (releaseDateText set) stays visible and matches its year', () => {
    const g = game({ id: 'steam-2', title: 'Soon', releaseDate: 'Coming Soon', releaseDateText: '2026', comingSoon: true });
    expect(run([g]).displayedGames).toHaveLength(1);
    expect(run([g], {}, { releaseYear: '2026' }).displayedGames).toHaveLength(1);
  });

  it('a parsed 2099 date and the dedup sentinel placeholder stay hidden', () => {
    const far = game({ id: 'epic-a', title: 'Far', store: 'epic', releaseDate: '2099-01-01T00:00:00.000Z' });
    const sentinel = game({ id: 'epic-b', title: 'Sentinel', store: 'epic', releaseDate: 'Coming Soon', comingSoon: true });
    expect(run([far, sentinel]).displayedGames).toHaveLength(0);
    expect(run([far]).dynamicYears).not.toContain('2099');
    expect(SENTINEL_YEAR).toBe(2090);
  });

  it('a list with NaN-producing dates is strictly ordered by timestamp', () => {
    const games = [
      game({ id: 'a', title: 'A', releaseDate: '2021-05-01' }),
      game({ id: 'b', title: 'B', releaseDate: 'Coming soon' }),
      game({ id: 'c', title: 'C', releaseDate: '2019-01-01' }),
      game({ id: 'd', title: 'D', releaseDate: 'Q1 2027' }),
      game({ id: 'e', title: 'E', releaseDate: '2023-03-01' }),
    ];
    const stamped = dedupSortAndStamp(games);
    const ts = stamped.map((g) => (g as any)._releaseTs as number);
    ts.forEach((t) => expect(Number.isFinite(t)).toBe(true));
    for (let i = 1; i < ts.length; i++) expect(ts[i - 1]).toBeGreaterThanOrEqual(ts[i]);
    expect(stamped.slice(0, 3).map((g) => g.id)).toEqual(['e', 'a', 'c']);

    // Comparator backstop: a NaN stamp sorts as 0 instead of breaking the order.
    const withNaN = games.map((g) => ({ ...g, _releaseTs: g.id === 'b' ? NaN : releaseTsOf(g.releaseDate) }) as Game);
    const sorted = run(withNaN, {}, { category: 'all' }).sortedGames;
    const sortedTs = sorted.map((g) => (Number.isFinite((g as any)._releaseTs) ? (g as any)._releaseTs : 0));
    for (let i = 1; i < sortedTs.length; i++) expect(sortedTs[i - 1]).toBeLessThanOrEqual(sortedTs[i]);
  });
});

describe('deduplicateGames grouping', () => {
  it('two Steam ids titled Dead Space -> 2 results', () => {
    const out = deduplicateGames([
      game({ id: 'steam-17470', title: 'Dead Space', steamAppId: 17470 }),
      game({ id: 'steam-1693980', title: 'Dead Space', steamAppId: 1693980 }),
    ]);
    expect(out.map((g) => g.id)).toEqual(['steam-17470', 'steam-1693980']);
  });

  it('the same id twice -> 1', () => {
    const out = deduplicateGames([
      game({ id: 'steam-1', title: 'Game' }),
      game({ id: 'steam-1', title: 'Game' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps Skyrim and Skyrim Special Edition apart', () => {
    const out = deduplicateGames([
      game({ id: 'steam-72850', title: 'The Elder Scrolls V: Skyrim' }),
      game({ id: 'steam-489830', title: 'The Elder Scrolls V: Skyrim Special Edition' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('Mafia II Classic + Definitive (Steam) + Epic Definitive -> Epic merges with Definitive', () => {
    const out = deduplicateGames([
      game({ id: 'steam-50130', title: 'Mafia II (Classic)', steamAppId: 50130 }),
      game({ id: 'steam-1030830', title: 'Mafia II: Definitive Edition', steamAppId: 1030830 }),
      game({ id: 'epic-mafia:def', title: 'Mafia II: Definitive Edition', store: 'epic', epicNamespace: 'mafia', epicOfferId: 'def' }),
    ]);
    expect(out).toHaveLength(2);
    const classic = out.find((g) => g.id === 'steam-50130')!;
    const definitive = out.find((g) => g.id === 'steam-1030830')!;
    expect(classic.availableOn).toEqual(['steam']);
    expect(definitive.availableOn).toEqual(['steam', 'epic']);
    expect(definitive.secondaryId).toBe('epic-mafia:def');
  });

  it('Steam X + Epic X + Epic X Deluxe -> merged entry keeps the base Epic offer', () => {
    const out = deduplicateGames([
      game({ id: 'steam-9', title: 'Hades', steamAppId: 9 }),
      game({ id: 'epic-h:base', title: 'Hades', store: 'epic', epicNamespace: 'h', epicOfferId: 'base', price: { isFree: false, finalFormatted: '$20' } }),
      game({ id: 'epic-h:dlx', title: 'Hades Deluxe Edition', store: 'epic', epicNamespace: 'h', epicOfferId: 'dlx', price: { isFree: false, finalFormatted: '$30' } }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('steam-9');
    expect(out[0].epicOfferId).toBe('base');
    expect(out[0].epicPrice?.finalFormatted).toBe('$20');
  });

  it('pairs an Epic entry that arrives before its Steam twin', () => {
    const out = deduplicateGames([
      game({ id: 'epic-ns:x', title: 'Elden Ring', store: 'epic', epicNamespace: 'ns', epicOfferId: 'x' }),
      game({ id: 'steam-5', title: 'Elden Ring', steamAppId: 5 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('steam-5');
    expect(out[0].availableOn).toEqual(['steam', 'epic']);
  });

  it('collapses Epic-only edition offers of one namespace', () => {
    const out = deduplicateGames([
      game({ id: 'epic-n:a', title: 'Control', store: 'epic', epicNamespace: 'n', epicOfferId: 'a' }),
      game({ id: 'epic-n:b', title: 'Control Ultimate Edition', store: 'epic', epicNamespace: 'n', epicOfferId: 'b' }),
    ]);
    expect(out.map((g) => g.id)).toEqual(['epic-n:a']);
  });
});

describe('release calendar slot', () => {
  const now = Date.UTC(2026, 9, 30);

  it('puts a comingSoon game without a future date in the Coming Soon bucket', () => {
    expect(prefetchReleaseSlot({ releaseDate: 'Coming Soon', comingSoon: true }, now)).toBe('coming-soon');
    expect(prefetchReleaseSlot({ releaseDate: '2026-01-01T00:00:00.000Z', comingSoon: true }, now)).toBe('coming-soon');
    expect(prefetchReleaseSlot({ releaseDate: 'Q1 2027', comingSoon: true }, now)).toBe('coming-soon');
  });

  it('keeps dated games dated and drops unusable dates', () => {
    const future = '2026-12-12T12:00:00.000Z';
    expect(prefetchReleaseSlot({ releaseDate: future, comingSoon: true }, now)).toBe(Date.parse(future));
    expect(prefetchReleaseSlot({ releaseDate: '2026-10-01T12:00:00.000Z', comingSoon: false }, now)).toBe(Date.parse('2026-10-01T12:00:00.000Z'));
    expect(prefetchReleaseSlot({ releaseDate: 'Coming soon', comingSoon: false }, now)).toBeNull();
    expect(prefetchReleaseSlot({ releaseDate: '', comingSoon: true }, now)).toBeNull();
  });
});

describe('Ark terminal REL:: formatter', () => {
  it("'Coming soon' -> 'COMING SOON'", () => {
    expect(formatRegistryReleaseDate('Coming soon', undefined)).toBe('COMING SOON');
  });

  it('an invalid entry date with a valid meta date uses the meta date', () => {
    expect(formatRegistryReleaseDate('Coming soon', '2023-10-15T12:00:00.000Z')).toBe('Oct 2023');
  });

  it("an ISO date formats as 'Oct 2023'", () => {
    expect(formatRegistryReleaseDate('2023-10-15T12:00:00.000Z', undefined)).toBe('Oct 2023');
  });

  it('long text is truncated and nothing at all gives null', () => {
    const out = formatRegistryReleaseDate('To be announced soon', undefined)!;
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out.startsWith('TO BE ANNOU')).toBe(true);
    expect(formatRegistryReleaseDate(undefined, undefined)).toBeNull();
  });
});

describe('news card dates', () => {
  it('date 0 and NaN render no date; a valid date renders formatted', () => {
    expect(newsDateLabel(0)).toBeNull();
    expect(newsDateLabel(NaN)).toBeNull();
    expect(newsDateLabel(Date.UTC(2024, 4, 15, 12) / 1000)).toBe('May 15, 2024');
  });

  it('Epic article dates convert to seconds, 0 when missing or unparseable', () => {
    expect(newsDateSeconds(undefined)).toBe(0);
    expect(newsDateSeconds('not a date')).toBe(0);
    expect(newsDateSeconds('2024-05-15T12:00:00.000Z')).toBe(Date.UTC(2024, 4, 15, 12) / 1000);
  });
});
