/**
 * Franchise base extraction, umbrella-brand membership gating, and
 * franchise cluster helpers used by the Oracle reco worker.
 *
 * Umbrella brands (Star Wars, Final Fantasy, …) collapse many unrelated
 * products to the same base via colon/subtitle stripping. Membership for
 * those brands (or very large clusters) requires studio overlap with an
 * owned entry or subtitle-token overlap with an owned entry.
 */

import type {
  CandidateGame,
  FranchiseCluster,
  FranchiseEntry,
  UserGameSnapshot,
} from '@/types/reco';

const norm = (s: string) => s.toLowerCase().trim();

/** Common franchise suffixes/numbering patterns to strip. */
const FRANCHISE_STRIP_PATTERNS = [
  /\s+([\divxlc]+|\d+)$/i,
  /\s*:\s*(remastered|goty|game of the year|deluxe|ultimate|definitive|complete|enhanced|anniversary|remake|hd|collection|gold|premium|special|digital|standard)(\s+edition)?$/i,
  /\s+(remastered|remake|definitive|enhanced|anniversary|hd|complete|ultimate|deluxe|goty|gold|premium|special|digital|standard)(\s+edition)?$/i,
  /\s+game\s+of\s+the\s+year(\s+edition)?$/i,
  /\s+edition$/i,
  /\s*\([^)]*\)$/,
  /\s*:\s+[^:]+$/,
  /\s+-\s+.*$/,
];

/** Multi-product brand prefixes that must not treat every spinoff as a sequel. */
export const UMBRELLA_BRANDS: ReadonlySet<string> = new Set([
  'star wars',
  'final fantasy',
  "assassin's creed",
  'call of duty',
  'resident evil',
  'tomb raider',
  'lego',
  'marvel',
  'batman',
  'harry potter',
  'the elder scrolls',
  'far cry',
]);

/** Clusters this large get the same gate even if the base is not listed. */
export const LARGE_CLUSTER_GATE_SIZE = 8;

const SUBTITLE_STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'at', 'for', 'with',
  'from', 'by', 'vs', 'versus', 'part', 'episode', 'chapter', 'edition',
  'remastered', 'remake', 'definitive', 'complete', 'ultimate', 'deluxe',
  'goty', 'gold', 'premium', 'special', 'digital', 'standard', 'enhanced',
  'anniversary', 'collection', 'hd', 'game', 'year',
]);

export interface FranchiseStudioFields {
  title: string;
  developer?: string;
  publisher?: string;
}

/** Extract the base franchise name from a game title. */
export function extractFranchiseBase(title: string): string {
  let base = title.trim();
  const original = base;
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (const pattern of FRANCHISE_STRIP_PATTERNS) {
      const stripped = base.replace(pattern, '').trim();
      if (stripped.length >= 3 && stripped !== base) {
        base = stripped;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Fallback: strip trailing word for 4+-word titles where no pattern matched
  // (catches "Assassin's Creed Valhalla" → "Assassin's Creed")
  // Requires 4+ words to avoid false positives like "Grand Theft Auto" → "Grand Theft"
  if (base === original) {
    const words = base.split(/\s+/);
    if (words.length >= 4) {
      const candidate = words.slice(0, -1).join(' ');
      const newLast = candidate.split(/\s+/).pop()?.toLowerCase() ?? '';
      const stopWords = new Set(['of', 'the', 'and', 'in', 'on', 'at', 'for', 'to', 'a', 'an']);
      if (candidate.length >= 3 && !stopWords.has(newLast)) base = candidate;
    }
  }
  return norm(base);
}

export function isUmbrellaBrand(baseName: string): boolean {
  const n = norm(baseName);
  if (!n) return false;
  if (UMBRELLA_BRANDS.has(n)) return true;
  // Prefix match: "lego star wars" → umbrella via "lego" / "star wars"
  for (const brand of UMBRELLA_BRANDS) {
    if (n === brand || n.startsWith(`${brand} `) || n.endsWith(` ${brand}`)) return true;
  }
  return false;
}

export function needsUmbrellaGate(baseName: string, clusterSize: number): boolean {
  return isUmbrellaBrand(baseName) || clusterSize >= LARGE_CLUSTER_GATE_SIZE;
}

/** Meaningful tokens from the title after removing the brand base. */
export function extractSubtitleTokens(title: string, brandBase: string): string[] {
  let rest = norm(title);
  rest = rest.replace(/\s*\([^)]*\)/g, ' ').trim();
  const base = norm(brandBase);
  if (base && rest.startsWith(base)) {
    rest = rest.slice(base.length);
  }
  rest = rest.replace(/^[\s:–—\-]+/, '').trim();
  // Drop common edition tails from the subtitle segment
  rest = rest
    .replace(/\s+(remastered|remake|definitive|enhanced|anniversary|hd|complete|ultimate|deluxe|goty|gold|premium|special|digital|standard)(\s+edition)?$/i, '')
    .replace(/\s+edition$/i, '')
    .trim();

  const tokens: string[] = [];
  for (const raw of rest.split(/[^a-z0-9]+/i)) {
    const t = raw.toLowerCase();
    if (t.length < 3) continue;
    if (SUBTITLE_STOP_WORDS.has(t)) continue;
    // Skip pure numerals / roman-ish tokens
    if (/^[\divxlc]+$/i.test(t)) continue;
    tokens.push(t);
  }
  return tokens;
}

export function hasSubtitleTokenOverlap(
  candidateTitle: string,
  ownedTitle: string,
  brandBase: string,
): boolean {
  const a = new Set(extractSubtitleTokens(candidateTitle, brandBase));
  if (a.size === 0) return false;
  for (const t of extractSubtitleTokens(ownedTitle, brandBase)) {
    if (a.has(t)) return true;
  }
  return false;
}

export function hasStudioOverlap(
  candidate: FranchiseStudioFields,
  ownedEntries: FranchiseStudioFields[],
): boolean {
  const candStudios = new Set(
    [candidate.developer, candidate.publisher].map(s => (s ? norm(s) : '')).filter(Boolean),
  );
  if (candStudios.size === 0) return false;
  for (const owned of ownedEntries) {
    for (const s of [owned.developer, owned.publisher]) {
      if (s && candStudios.has(norm(s))) return true;
    }
  }
  return false;
}

/**
 * Umbrella / large-cluster membership: studio overlap with owned entries
 * OR subtitle-token overlap with an owned entry.
 */
export function passesUmbrellaMembership(
  candidate: FranchiseStudioFields,
  ownedEntries: FranchiseStudioFields[],
  brandBase: string,
): boolean {
  if (ownedEntries.length === 0) return false;
  if (hasStudioOverlap(candidate, ownedEntries)) return true;
  return ownedEntries.some(o =>
    hasSubtitleTokenOverlap(candidate.title, o.title, brandBase),
  );
}

/** Upcoming Sequels: parseable future releaseDate only (empty string ≠ upcoming). */
export function isFutureReleaseDate(releaseDate: string, nowMs: number = Date.now()): boolean {
  const trimmed = releaseDate?.trim();
  if (!trimmed) return false;
  const rd = new Date(trimmed).getTime();
  return !Number.isNaN(rd) && rd > nowMs;
}

type MutableCluster = {
  entries: Map<string, {
    gameId: string;
    title: string;
    releaseDate: string;
    isUserOwned: boolean;
    developer: string;
    publisher: string;
  }>;
  developers: Map<string, number>;
  userRatings: number[];
  userHours: number;
};

/** Detect all franchises from user + candidate game titles. */
export function detectFranchises(
  userGames: UserGameSnapshot[],
  candidates: CandidateGame[],
  onProgress?: (fraction: number) => void,
): FranchiseCluster[] {
  const baseMap = new Map<string, MutableCluster>();

  const addToMap = (
    gameId: string,
    title: string,
    releaseDate: string,
    isUser: boolean,
    developer: string,
    publisher: string,
    rating: number,
    hours: number,
  ) => {
    const baseName = extractFranchiseBase(title);
    if (!baseName || baseName.length < 3) return;

    if (!baseMap.has(baseName)) {
      baseMap.set(baseName, {
        entries: new Map(),
        developers: new Map(),
        userRatings: [],
        userHours: 0,
      });
    }

    const cluster = baseMap.get(baseName)!;

    if (!cluster.entries.has(gameId)) {
      cluster.entries.set(gameId, {
        gameId,
        title,
        releaseDate,
        isUserOwned: isUser,
        developer,
        publisher,
      });
    } else if (isUser) {
      const existing = cluster.entries.get(gameId)!;
      existing.isUserOwned = true;
      if (developer) existing.developer = developer;
      if (publisher) existing.publisher = publisher;
    }

    if (developer) {
      cluster.developers.set(norm(developer), (cluster.developers.get(norm(developer)) || 0) + 1);
    }

    if (isUser) {
      if (rating > 0) cluster.userRatings.push(rating);
      cluster.userHours += hours;
    }
  };

  for (const ug of userGames) {
    addToMap(
      ug.gameId,
      ug.title,
      ug.releaseDate,
      true,
      ug.developer,
      ug.publisher,
      ug.rating,
      ug.hoursPlayed,
    );
  }

  const franchiseProgressStep = Math.max(1, Math.floor(candidates.length / 5));
  for (let fi = 0; fi < candidates.length; fi++) {
    const c = candidates[fi];
    addToMap(c.gameId, c.title, c.releaseDate, false, c.developer, c.publisher, 0, 0);
    if (onProgress && fi % franchiseProgressStep === 0) {
      onProgress(fi / candidates.length);
    }
  }

  const franchises: FranchiseCluster[] = [];

  for (const [baseName, data] of baseMap) {
    // Gate non-owned entries for umbrella brands / large clusters
    if (needsUmbrellaGate(baseName, data.entries.size)) {
      const owned = [...data.entries.values()].filter(e => e.isUserOwned);
      if (owned.length === 0) continue;
      for (const [id, entry] of [...data.entries.entries()]) {
        if (entry.isUserOwned) continue;
        if (!passesUmbrellaMembership(entry, owned, baseName)) {
          data.entries.delete(id);
        }
      }
    }

    if (data.entries.size < 2) continue;

    const hasUserEntry = [...data.entries.values()].some(e => e.isUserOwned);
    if (!hasUserEntry) continue;

    const entries: FranchiseEntry[] = [...data.entries.values()]
      .sort((a, b) => {
        const dateA = new Date(a.releaseDate).getTime();
        const dateB = new Date(b.releaseDate).getTime();
        if (isNaN(dateA) && isNaN(dateB)) return 0;
        if (isNaN(dateA)) return 1;
        if (isNaN(dateB)) return -1;
        return dateA - dateB;
      })
      .map((e, i) => ({
        gameId: e.gameId,
        title: e.title,
        releaseDate: e.releaseDate,
        isUserOwned: e.isUserOwned,
        sequenceIndex: i,
        developer: e.developer,
        publisher: e.publisher,
      }));

    let topDev = '';
    let topDevCount = 0;
    for (const [dev, count] of data.developers) {
      if (count > topDevCount) {
        topDev = dev;
        topDevCount = count;
      }
    }

    const userPlayedIds = entries.filter(e => e.isUserOwned).map(e => e.gameId);
    const avgRating = data.userRatings.length > 0
      ? data.userRatings.reduce((s, r) => s + r, 0) / data.userRatings.length
      : 0;

    const firstEntry = entries[0];
    const displayParts = firstEntry.title.split(/[:\-–]/);
    const displayName = displayParts[0].trim();

    franchises.push({
      baseName,
      displayName,
      entries,
      userPlayedIds,
      userAvgRating: avgRating,
      userTotalHours: data.userHours,
      developer: topDev,
    });
  }

  return franchises.sort((a, b) => b.userTotalHours - a.userTotalHours);
}

/** Compute franchise boost for a single candidate. */
export function computeFranchiseBoost(
  candidate: CandidateGame,
  franchises: FranchiseCluster[],
  userGameIds: Set<string>,
): { boost: number; franchiseName?: string; isFranchiseEntry: boolean } {
  if (userGameIds.has(candidate.gameId)) {
    return { boost: 0, isFranchiseEntry: false };
  }

  const candidateBase = extractFranchiseBase(candidate.title);

  for (const franchise of franchises) {
    const inEntries = franchise.entries.some(e => e.gameId === candidate.gameId);
    const baseMatch = franchise.baseName === candidateBase;
    if (!inEntries && !baseMatch) continue;

    if (needsUmbrellaGate(franchise.baseName, franchise.entries.length)) {
      const owned = franchise.entries.filter(e => e.isUserOwned);
      if (!passesUmbrellaMembership(
        {
          title: candidate.title,
          developer: candidate.developer,
          publisher: candidate.publisher,
        },
        owned,
        franchise.baseName,
      )) {
        continue;
      }
    }

    const userPlayed = franchise.userPlayedIds.length;
    const totalEntries = franchise.entries.length;

    const ratingMult = franchise.userAvgRating >= 4 ? 1.5
      : franchise.userAvgRating >= 3 ? 1.0
      : franchise.userAvgRating > 0 ? 0.5
      : franchise.userTotalHours >= 10 ? 1.2
      : 1.0;

    const completionFactor = Math.min(userPlayed / totalEntries, 0.8);
    const boost = Math.max(0, Math.min(1, (0.4 + completionFactor * 0.5) * ratingMult));

    return {
      boost,
      franchiseName: franchise.displayName,
      isFranchiseEntry: true,
    };
  }

  return { boost: 0, isFranchiseEntry: false };
}
