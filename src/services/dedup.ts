/**
 * Deduplication utilities — pure functions with no DOM/window dependencies.
 * Safe to import from both the main thread and Web Workers.
 */

import type { Game } from '@/types/game';

// ---------------------------------------------------------------------------
// Title normalisation for deduplication
// ---------------------------------------------------------------------------

// Normalise Roman numerals to Arabic (up to 20 covers virtually all games)
const ROMAN_MAP: [RegExp, string][] = [
  [/\bxx\b/g, '20'], [/\bxix\b/g, '19'], [/\bxviii\b/g, '18'],
  [/\bxvii\b/g, '17'], [/\bxvi\b/g, '16'], [/\bxv\b/g, '15'],
  [/\bxiv\b/g, '14'], [/\bxiii\b/g, '13'], [/\bxii\b/g, '12'],
  [/\bxi\b/g, '11'], [/\bx\b/g, '10'], [/\bix\b/g, '9'],
  [/\bviii\b/g, '8'], [/\bvii\b/g, '7'], [/\bvi\b/g, '6'],
  [/\bv\b/g, '5'], [/\biv\b/g, '4'], [/\biii\b/g, '3'],
  [/\bii\b/g, '2'],
];

/** Lowercase, drop quotes and trademark symbols, every other symbol → space. */
function stripTitleSymbols(title: string): string {
  return title
    .toLowerCase()
    .replace(/['‘’‚‛]/g, '')   // ASCII + smart single quotes
    .replace(/["“”„‟]/g, '')   // ASCII + smart double quotes
    .replace(/[™®©]/g, '')           // ™ ® ©
    .replace(/&/g, 'and')                            // ampersand
    .replace(/[^a-z0-9\s]/g, ' ');                   // all remaining special chars → space
}

function mapRomanNumerals(t: string): string {
  for (const [rx, num] of ROMAN_MAP) {
    t = t.replace(rx, num);
  }
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Normalise a game title for fuzzy matching across stores.
 * Aggressively strips edition suffixes, symbols, and normalises Roman
 * numerals so "Cyberpunk 2077: Ultimate Edition" on Steam and
 * "Cyberpunk 2077" on Epic resolve to the same key.
 */
export function normalizeTitle(title: string | undefined | null): string {
  if (!title) return '';
  const t = stripTitleSymbols(title)
    // Strip common edition / variant phrase suffixes (longer phrases first)
    .replace(/\b(game of the year|goty|directors cut|digital deluxe|digital edition|special edition|anniversary edition|legendary edition|ultimate edition|definitive edition|complete edition|deluxe edition|premium edition|gold edition|standard edition|first edition|limited edition|collectors edition|emperor edition|imperial edition|commander edition|warlord edition|dynasty edition)\b/g, '')
    // Strip standalone edition / packaging words that are always suffixes
    .replace(/\b(edition|deluxe|ultimate|standard|remastered|definitive|enhanced|complete|premium|gold|anniversary|remake|hd|redux|classic|collection|bundle|pack|trilogy|anthology)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return mapRomanNumerals(t);
}

/**
 * Stricter title key: symbols removed and numerals mapped like normalizeTitle,
 * but edition words are kept, so "Mafia II: Definitive Edition" pairs with the
 * Definitive Steam app rather than "Mafia II (Classic)".
 */
export function strictTitleKey(title: string | undefined | null): string {
  if (!title) return '';
  return mapRomanNumerals(stripTitleSymbols(title));
}

// ---------------------------------------------------------------------------
// Release dates
// ---------------------------------------------------------------------------

/**
 * Sentinel year threshold — Epic uses 2099-01-01 (and similar) as a placeholder
 * for games without a confirmed release date.
 */
export const SENTINEL_YEAR = 2090;

/** Placeholder release date for upcoming games without a usable date. */
export const COMING_SOON_DATE = 'Coming Soon';

/**
 * Numeric release timestamp for sorting. Text dates Steam sends for unreleased
 * games ('Coming soon', 'Q1 2027') used to become NaN, which `?? 0` does not
 * catch, so sorted lists came out jumbled. Anything unparseable is 0.
 */
export function releaseTsOf(date: string | undefined | null): number {
  if (!date) return 0;
  const t = Date.parse(date);
  return Number.isFinite(t) ? t : 0;
}

/** First 4-digit year in a release-date string ("Oct 25, 2019", "2019-10-25", "Q1 2027"), if any. */
export function releaseYearOf(date: string | undefined | null): number | undefined {
  const m = /\b(19[7-9]\d|20\d\d)\b/.exec(date ?? '');
  return m ? Number(m[1]) : undefined;
}

// "Oct 25, 2019", "25 Oct, 2019", "12 Mar, 2026", "2019-10-25": a real day of month.
const DAY_PRECISE_RX = /\b\d{1,2},?\s+\d{4}\b|\b\d{1,2}\s+[a-z]{3,}\.?,?\s+\d{4}\b|\d{4}-\d{2}-\d{2}/i;
const ISO_RX = /^\d{4}-\d{2}-\d{2}/;

/**
 * One parser for Steam's display release dates (steam-service and
 * detail-enricher). Only a date with a day of month becomes ISO; it is pinned
 * to 12:00 UTC so the calendar day is the same in every time zone (local
 * midnight via toISOString used to land on the previous UTC day east of UTC).
 * A year/quarter/month-only date of an upcoming game ('2026', 'Q1 2027') is not
 * an exact date: it becomes the 'Coming Soon' placeholder, with the raw text
 * kept in releaseDateText. Text without a year ('Coming soon') is kept as is.
 */
export function parseSteamReleaseDate(
  raw: string | undefined | null,
  comingSoon?: boolean,
): { releaseDate: string; releaseDateText?: string } {
  const text = (raw ?? '').trim();
  if (!text) return { releaseDate: '' };
  if (ISO_RX.test(text) && Number.isFinite(Date.parse(text))) return { releaseDate: text };
  if (DAY_PRECISE_RX.test(text)) {
    const d = new Date(text);
    if (Number.isFinite(d.getTime())) {
      return { releaseDate: new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12)).toISOString() };
    }
  }
  if (comingSoon && releaseYearOf(text) != null) {
    return { releaseDate: COMING_SOON_DATE, releaseDateText: text };
  }
  return { releaseDate: text };
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

type StoreSide = 'steam' | 'epic';

const storeOf = (game: Game): StoreSide => (game.store === 'epic' ? 'epic' : 'steam');

/** Unmerged entry: keep cached dual-store info, otherwise its own store. */
function withAvailableOn(game: Game): Game {
  return {
    ...game,
    availableOn: game.availableOn && game.availableOn.length > 0
      ? game.availableOn          // preserve existing dual-store info from cache
      : [storeOf(game)],
  };
}

/**
 * Steam stays primary — richer data (metacritic, player count, reviews) — and
 * keeps Epic-specific metadata (namespace, offerId, price, images) so the
 * details page can show cross-store links and pricing.
 */
function mergeCrossStore(steamSide: Game, epicSide: Game): Game {
  const stores = new Set<StoreSide>(steamSide.availableOn && steamSide.availableOn.length > 0 ? steamSide.availableOn : ['steam']);
  stores.add('epic');
  return {
    ...steamSide,
    searchResultRank: Math.min(
      steamSide.searchResultRank ?? 9999,
      epicSide.searchResultRank ?? 9999,
    ),
    availableOn: Array.from(stores),
    secondaryId: epicSide.id,
    // Always keep both stores' key identifiers
    epicNamespace: epicSide.epicNamespace,
    epicOfferId:  epicSide.epicOfferId,
    epicSlug:     epicSide.epicSlug,
    steamAppId:   steamSide.steamAppId,
    // Preserve Epic price for cross-store display when Steam is primary
    epicPrice: epicSide.price ?? undefined,
    // Preserve Epic cover if Steam doesn't have one
    coverUrl: steamSide.coverUrl || epicSide.coverUrl,
    headerImage: steamSide.headerImage || epicSide.headerImage,
    // Store-order: keep both stores' list positions for single-store re-sort
    steamListPosition: steamSide.steamListPosition,
    epicListPosition: epicSide.epicListPosition,
  };
}

/**
 * Merge a list of Steam + Epic games by normalised title.
 * Exact id repeats (the same app in several browse lists) are dropped first.
 * Distinct same-store apps under one title key are all kept (Skyrim and Skyrim
 * Special Edition, Dead Space 2008 and 2023). Each Epic entry pairs with at
 * most one Steam entry — the one with the same strict title when there is one,
 * else the first — and a Steam entry takes only its first Epic offer, so a
 * later "X Deluxe Edition" offer no longer replaces the base Epic link/price.
 * Epic-only groups collapse edition offers of one namespace.
 */
export function deduplicateGames(games: Game[]): Game[] {
  const groups = new Map<string, Game[]>();
  const seenIds = new Set<string>();

  for (const game of games) {
    if (seenIds.has(game.id)) continue;
    const key = normalizeTitle(game.title);
    if (!key) continue; // skip untitled entries
    seenIds.add(game.id);
    const group = groups.get(key);
    if (group) group.push(game);
    else groups.set(key, [game]);
  }

  const out: Game[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(withAvailableOn(group[0]));
      continue;
    }

    const steam = group.filter((g) => storeOf(g) === 'steam');
    const pairedEpic = new Map<Game, Game>(); // Steam entry → its Epic offer
    const keptEpic = new Set<Game>();

    if (steam.length > 0) {
      const steamKeys = steam.map((s) => strictTitleKey(s.title));
      for (const e of group) {
        if (storeOf(e) !== 'epic') continue;
        const ek = strictTitleKey(e.title);
        const exact = steam.filter((_, i) => steamKeys[i] === ek);
        const target = exact.length > 0
          ? exact.find((s) => !pairedEpic.has(s))
          : steam[0];
        // No free target: a further offer of an already merged game — dropped.
        if (target && !pairedEpic.has(target)) pairedEpic.set(target, e);
      }
    } else {
      const namespaces = new Set<string>();
      for (const e of group) {
        const ns = e.epicNamespace;
        if (ns && namespaces.has(ns)) continue; // same product, another edition offer
        if (ns) namespaces.add(ns);
        keptEpic.add(e);
      }
    }

    for (const g of group) {
      if (storeOf(g) === 'steam') {
        const e = pairedEpic.get(g);
        out.push(e ? mergeCrossStore(g, e) : withAvailableOn(g));
      } else if (keptEpic.has(g)) {
        out.push(withAvailableOn(g));
      }
    }
  }

  return out;
}

/**
 * Dedup + sort + pre-compute numeric release timestamp.
 * Also normalises far-future sentinel dates (2099 etc.) to "Coming Soon".
 * This is the combined pipeline used by the dedup worker.
 */
export function dedupSortAndStamp(games: Game[]): Game[] {
  const deduped = deduplicateGames(games);

  // Pre-compute numeric timestamp for O(1) sorting downstream
  for (const g of deduped) {
    const ts = releaseTsOf(g.releaseDate);
    (g as any)._releaseTs = ts;

    // Normalise far-future sentinel dates → "Coming Soon"
    // These are Epic placeholder dates (e.g. 2099-01-01) that clutter the browse grid.
    if (ts > 0) {
      const year = new Date(ts).getFullYear();
      if (year >= SENTINEL_YEAR) {
        g.releaseDate = COMING_SOON_DATE;
        g.comingSoon = true;
        (g as any)._releaseTs = 0; // sort them to the end
      }
    }
  }

  // Sort by release date descending (newest first)
  deduped.sort((a, b) => ((b as any)._releaseTs ?? 0) - ((a as any)._releaseTs ?? 0));

  return deduped;
}
