/**
 * Shared relevance scoring for Browse search (prefetch + API merge), Library search,
 * and graph search. Kept separate from prefetch-store to avoid circular imports with game-service.
 */

import type { Game } from '@/types/game';

export interface SearchIndexEntry {
  titleLower: string;
  /** Lowercase title with punctuation collapsed (aligned tokens / phrase match). */
  titleNorm: string;
  /** Individual lowercase words from the title */
  titleWords: string[];
  devLower: string;
  pubLower: string;
  genresLower: string[];
}

/** Normalize for search: lower, strip non-alnum to spaces, collapse whitespace. */
export function normalizeSearchText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * When every scored hit is 0, order by: normalized title contains query → shorter title →
 * store API rank → metacritic → title alpha.
 */
export function compareBrowseSearchZeroScore(a: Game, b: Game, fullQuery: string): number {
  const qn = normalizeSearchText(fullQuery);
  const ql = fullQuery.trim().toLowerCase();
  if (!qn && !ql) return a.title.localeCompare(b.title);

  const aNorm = normalizeSearchText(a.title);
  const bNorm = normalizeSearchText(b.title);
  const aHit =
    (qn.length > 0 && (aNorm.includes(qn) || aNorm.split(/\s+/).some((w) => w.startsWith(qn)))) ||
    (ql.length > 0 && a.title.toLowerCase().includes(ql));
  const bHit =
    (qn.length > 0 && (bNorm.includes(qn) || bNorm.split(/\s+/).some((w) => w.startsWith(qn)))) ||
    (ql.length > 0 && b.title.toLowerCase().includes(ql));
  if (aHit !== bHit) return aHit ? -1 : 1;

  if (a.title.length !== b.title.length) return a.title.length - b.title.length;

  const ar = a.searchResultRank ?? 9999;
  const br = b.searchResultRank ?? 9999;
  if (ar !== br) return ar - br;

  const am = a.metacriticScore ?? 0;
  const bm = b.metacriticScore ?? 0;
  if (bm !== am) return bm - am;

  return a.title.localeCompare(b.title);
}

function searchScoreTiebreak(game?: Game | null): number {
  if (!game) return 0;
  let t = 0;
  t += (game.metacriticScore ?? 0) / 1000;
  if (game.playerCount) t += Math.min(game.playerCount / 100_000, 0.5);
  return t;
}

/**
 * Abbrev-style queries (digits, or few vowels) use subsequence shorthand.
 * Plain dictionary words skip shorthand to avoid scattered-letter false positives.
 */
function looksLikeSearchAbbreviation(token: string): boolean {
  const t = token.toLowerCase();
  if (t.length < 4) return false;
  if (/\d/.test(t)) return true;
  const letters = t.replace(/[^a-z]/g, '');
  if (letters.length < 4) return false;
  const vowels = (letters.match(/[aeiou]/g) ?? []).length;
  const vowelRatio = vowels / letters.length;
  return vowelRatio <= 0.22;
}

/**
 * Short tags → substrings / prefixes we allow against Steam/Epic genre strings (no broad `.includes` on 3-letter substrings).
 */
const GENRE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  rpg: ['rpg', 'role-playing', 'role playing', 'roleplaying', 'jrpg'],
  fps: ['fps', 'first-person shooter', 'first person shooter'],
  tps: ['third-person', 'third person'],
  moba: ['moba'],
  mmo: ['mmo', 'massively multiplayer'],
  jrpg: ['jrpg', 'japanese role-playing', 'japanese role playing'],
  sim: ['simulation', 'simulator'],
  rts: ['rts', 'real-time strategy', 'real time strategy'],
  tbs: ['turn-based strategy', 'turn based strategy'],
  horror: ['horror'],
  roguelike: ['roguelike', 'rogue-lite', 'rogue lite'],
  souls: ['souls-like', 'soulslike'],
};

function genreMatchesToken(genreLower: string, token: string, tLen: number): boolean {
  if (genreLower === token) return true;

  const aliases = GENRE_ALIASES[token];
  if (aliases) {
    for (const a of aliases) {
      if (genreLower === a) return true;
      if (genreLower.startsWith(a)) return true;
      if (a.length >= 4 && genreLower.includes(a)) return true;
    }
  }

  if (tLen < 4) return false;
  return genreLower.startsWith(token);
}

function isWithinEditDistance(a: string, b: string, maxDist: number): boolean {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDist) return false;
  if (la === 0) return lb <= maxDist;
  if (lb === 0) return la <= maxDist;

  let prev = new Uint16Array(lb + 1);
  let curr = new Uint16Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let minVal = curr[0];
    const jStart = Math.max(1, i - maxDist);
    const jEnd = Math.min(lb, i + maxDist);
    if (jStart > 1) curr[jStart - 1] = maxDist + 1;
    for (let j = jStart; j <= jEnd; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < minVal) minVal = curr[j];
    }
    if (jEnd < lb) curr[jEnd + 1] = maxDist + 1;
    if (minVal > maxDist) return false;
    [prev, curr] = [curr, prev];
  }
  return prev[lb] <= maxDist;
}

function subsequenceDensity(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let j = 0;
  let firstMatch = -1;
  let lastMatch = -1;

  for (let i = 0; i < t.length && j < q.length; i++) {
    if (t[i] === q[j]) {
      if (firstMatch === -1) firstMatch = i;
      lastMatch = i;
      j++;
    }
  }

  if (j < q.length) return 0;
  const span = lastMatch - firstMatch + 1;
  if (span <= 0) return 1;
  return q.length / span;
}

/**
 * Score a game against query tokens. Higher = more relevant. 0 = no match.
 *
 * Title matches dominate. Developer/publisher/genre add small bonuses only;
 * metadata-only hits stay in a low tier so they do not bury real title matches.
 */
export function scoreGame(
  idx: SearchIndexEntry,
  tokens: string[],
  fullQuery: string,
  game?: Game | null,
  options?: { allowShorthand?: boolean },
): number {
  const allowShorthand = options?.allowShorthand !== false;
  const qNorm = normalizeSearchText(fullQuery);

  if (idx.titleLower === fullQuery) return 200 + searchScoreTiebreak(game);
  if (qNorm.length >= 2 && idx.titleNorm === qNorm) return 200 + searchScoreTiebreak(game);

  if (idx.titleLower.startsWith(fullQuery)) return 100 + searchScoreTiebreak(game);
  if (qNorm.length >= 2 && idx.titleNorm.startsWith(qNorm)) return 100 + searchScoreTiebreak(game);

  let titleTokensMatched = 0;
  let titleWordBoundaries = 0;
  let metadataScore = 0;

  for (const token of tokens) {
    const tLen = token.length;
    const tokenNorm = normalizeSearchText(token);
    let hitTitle = false;
    let hitBoundary = false;

    for (const word of idx.titleWords) {
      if (word.startsWith(token)) {
        hitTitle = true;
        hitBoundary = true;
        break;
      }
    }

    if (!hitTitle && idx.titleLower.includes(token)) {
      hitTitle = true;
    }

    if (!hitTitle && tokenNorm.length >= 2 && idx.titleNorm.includes(tokenNorm)) {
      hitTitle = true;
    }

    if (!hitTitle && tLen >= 4) {
      const maxDist = tLen <= 5 ? 1 : 2;
      for (const word of idx.titleWords) {
        if (Math.abs(word.length - tLen) > maxDist) continue;
        if (isWithinEditDistance(token, word, maxDist)) {
          hitTitle = true;
          break;
        }
      }
    }

    if (hitTitle) titleTokensMatched++;
    if (hitBoundary) titleWordBoundaries++;

    if (idx.devLower.includes(token) || idx.pubLower.includes(token)) {
      metadataScore += 3;
    }
    if (idx.genresLower.some((g) => genreMatchesToken(g, token, tLen))) {
      metadataScore += 2;
    }
  }

  if (
    allowShorthand &&
    tokens.length === 1 &&
    tokens[0].length >= 4 &&
    looksLikeSearchAbbreviation(tokens[0]) &&
    titleTokensMatched === 0
  ) {
    const token = tokens[0];
    const density = subsequenceDensity(token, idx.titleLower);
    if (density > 0) {
      const q = token.toLowerCase();
      const t = idx.titleLower;
      let j = 0;
      let firstMatch = -1;
      let lastMatch = -1;
      for (let i = 0; i < t.length && j < q.length; i++) {
        if (t[i] === q[j]) {
          if (firstMatch === -1) firstMatch = i;
          lastMatch = i;
          j++;
        }
      }
      const span = j === q.length && firstMatch >= 0 ? lastMatch - firstMatch + 1 : 0;
      const maxSpan = Math.min(60, Math.max(24, token.length * 12));
      if (span > 0 && span <= maxSpan && density >= 0.12) {
        const shorthandScore = Math.round(32 + 48 * Math.min(1, density / 0.45));
        return shorthandScore + Math.min(metadataScore, 5) + searchScoreTiebreak(game);
      }
    }
  }

  let score = 0;

  if (titleTokensMatched === tokens.length) {
    if (titleWordBoundaries === tokens.length) {
      score = 60;
    } else {
      score = 40;
    }
  } else if (titleTokensMatched > 0) {
    score = Math.round(25 * (titleTokensMatched / tokens.length));
  } else if (metadataScore > 0) {
    return Math.min(metadataScore, 8) + searchScoreTiebreak(game);
  } else {
    return 0;
  }

  score += Math.min(metadataScore, 5);
  // Contiguous phrase in normalized title (helps multi-word queries with odd tokenization)
  if (tokens.length > 1 && qNorm.length >= 4 && idx.titleNorm.includes(qNorm)) {
    score = Math.max(score, 52);
  }
  return score + searchScoreTiebreak(game);
}

export function buildSingleSearchIndex(g: Game): SearchIndexEntry {
  const titleLower = g.title.toLowerCase().trim();
  return {
    titleLower,
    titleNorm: normalizeSearchText(g.title),
    titleWords: titleLower.split(/\s+/).filter(Boolean),
    devLower: (g.developer || '').toLowerCase(),
    pubLower: (g.publisher || '').toLowerCase(),
    genresLower: (g.genre || []).map((genre) => genre.toLowerCase()),
  };
}
