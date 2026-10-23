/**
 * Candidate pool shaping for Oracle (pure — no store, worker or I/O imports).
 *
 * Extracted from RecoStore so the quotas, filters and cold-start selection can be unit-tested:
 *   - preFilterCandidates: ~25K → ≤3K with shelf-aware quotas
 *   - passesRetrievalQualityFloor: the same floor the Steam catalog source applies, for ANN/BM25 hits
 *   - selectColdStartSeedIds: Top Sellers ∩ genres for thin libraries
 *   - isLikelyAdultByTags / isWindowsPlayable / dedupeCandidatesByTitle: pool hygiene
 *   - expandTwinIds: carry dismissals across Steam/Epic twins
 */
import type { CandidateGame, UserGameSnapshot } from '@/types/reco';
import { toCanonicalGenre } from '@/data/canonical-genres';
import { computeEngagementWeight } from '@/services/engagement-weight';
import { canonicalFranchiseBase } from '@/services/franchise';
import {
  buildTasteProfile,
  hashString,
  normalizeTitleKey,
  seededRandom,
  splitCreditedNames,
} from '@/services/reco-scoring';

export const PREFILTER_MAX_POOL = 3000;

const QUOTA_SEMANTIC = 500;
const QUOTA_LEXICAL = 400;
const QUOTA_GENRE = 2000;
const QUOTA_FRANCHISE = 300;
const QUOTA_STUDIO = 200;
const QUOTA_METACRITIC = 200;
const QUOTA_STRETCH = 300;
const QUOTA_UNTAGGED = 150;
const QUOTA_WILDCARD = 200;

/** Reviews/positivity floor shared by every retrieval source (matches the Steam catalog query). */
export const RETRIEVAL_MIN_REVIEWS = 10;
export const RETRIEVAL_MIN_POSITIVITY = 0.5;

const genreKey = (g: string): string => (toCanonicalGenre(g) ?? g).toLowerCase();

/** Reviewed-quality ordering key: positivity weighted by (log) volume. 0 when unknown. */
export function reviewQualityKey(c: Pick<CandidateGame, 'reviewPositivity' | 'reviewVolume'>): number {
  const pos = c.reviewPositivity ?? 0;
  const vol = c.reviewVolume ?? 0;
  return pos * Math.log1p(vol);
}

function isReleased(releaseDate: string | undefined, comingSoon: boolean | undefined, nowMs: number): boolean {
  if (comingSoon === true) return false;
  if (!releaseDate) return true; // unknown date: do not treat as unreleased
  const t = Date.parse(releaseDate);
  return Number.isNaN(t) || t <= nowMs;
}

/**
 * Retrieval floor for ANN/BM25/cold-start hits: released games with enough reviews must be
 * reasonably positive. Unreleased titles and entries with no review data (Epic) pass — absence
 * of reviews is unknown, not bad.
 */
export function passesRetrievalQualityFloor(
  c: Pick<CandidateGame, 'reviewPositivity' | 'reviewVolume' | 'releaseDate' | 'comingSoon'>,
  nowMs: number,
): boolean {
  if (!isReleased(c.releaseDate, c.comingSoon, nowMs)) return true;
  if (c.reviewVolume === undefined || c.reviewPositivity === undefined) return true;
  if (c.reviewVolume < RETRIEVAL_MIN_REVIEWS) return c.reviewVolume === 0; // a handful of reviews is noise either way
  return c.reviewPositivity >= RETRIEVAL_MIN_POSITIVITY;
}

// ─── Pool hygiene ───────────────────────────────────────────────────────────────

/** Unambiguous adult-only tags: safe to drop on the tag alone. */
const ADULT_TAGS = /\b(hentai|erotic|nsfw|adult only|adults only)\b/i;
/** Ambiguous tags (Steam puts these on mainstream mature games like The Witcher 3): only a hint to run the description classifier. */
const ADULT_HINT_TAGS = /\b(sexual content|nudity|mature|adult)\b/i;

/** Unambiguous tag/genre rule (candidates carry no description text). */
export function isLikelyAdultByTags(c: Pick<CandidateGame, 'genres' | 'themes'>): boolean {
  return [...c.genres, ...c.themes].some(t => ADULT_TAGS.test(t));
}

/** True when ambiguous mature tags are present, so the description classifier is worth running. */
export function hasAdultHintTags(c: Pick<CandidateGame, 'genres' | 'themes'>): boolean {
  return [...c.genres, ...c.themes].some(t => ADULT_HINT_TAGS.test(t));
}

/** Windows (or platform-unknown) — Ark launches/tracks Windows games. */
export function isWindowsPlayable(platforms: string[] | undefined): boolean {
  if (!platforms || platforms.length === 0) return true;
  return platforms.some(p => /windows|\bpc\b/i.test(p));
}

/**
 * Collapse editions/duplicates: candidates sharing a normalised title key keep one (the best
 * reviewed; Steam over other stores on ties), and any whose key matches an owned library title
 * is dropped (the user already has that game in another edition/store). Empty keys never merge.
 */
export function dedupeCandidatesByTitle(
  candidates: CandidateGame[],
  ownedTitleKeys: ReadonlySet<string>,
): CandidateGame[] {
  const best = new Map<string, CandidateGame>();
  const losers = new Map<string, CandidateGame[]>();
  const better = (a: CandidateGame, b: CandidateGame): boolean => {
    const ka = reviewQualityKey(a) + (a.metacriticScore ?? 0) / 100;
    const kb = reviewQualityKey(b) + (b.metacriticScore ?? 0) / 100;
    if (ka !== kb) return ka > kb;
    return a.gameId.startsWith('steam-') && !b.gameId.startsWith('steam-');
  };
  for (const c of candidates) {
    const key = normalizeTitleKey(c.title);
    if (!key) continue;
    if (ownedTitleKeys.has(key)) continue;
    const prev = best.get(key);
    if (!prev) { best.set(key, c); continue; }
    if (better(c, prev)) { best.set(key, c); losers.set(key, [...(losers.get(key) ?? []), prev]); }
    else losers.set(key, [...(losers.get(key) ?? []), c]);
  }
  // The winner stands for its duplicates: keep a link to a twin (so dismissals still apply when a later
  // run picks the other copy) and the retrieval flags that protect it from the pre-filter quotas.
  for (const [key, winner] of best) {
    for (const loser of losers.get(key) ?? []) {
      if (!winner.secondaryGameId && loser.gameId !== winner.gameId) winner.secondaryGameId = loser.gameId;
      if (loser.semanticRetrieved) winner.semanticRetrieved = true;
      if (loser.lexicalRetrieved) winner.lexicalRetrieved = true;
      if (loser.coldStartSeeded) winner.coldStartSeeded = true;
    }
  }
  const kept = new Set(best.values());
  // Preserve original ordering.
  return candidates.filter(c => {
    const key = normalizeTitleKey(c.title);
    return !key || kept.has(c);
  });
}

/** Dismissed/thumbs-down ids plus their cross-store twins (via candidates' secondaryGameId). */
export function expandTwinIds(
  ids: Iterable<string>,
  candidates: ReadonlyArray<Pick<CandidateGame, 'gameId' | 'secondaryGameId'>>,
): string[] {
  const set = new Set(ids);
  for (const c of candidates) {
    if (!c.secondaryGameId) continue;
    if (set.has(c.gameId)) set.add(c.secondaryGameId);
    else if (set.has(c.secondaryGameId)) set.add(c.gameId);
  }
  return [...set];
}

// ─── Cold start ─────────────────────────────────────────────────────────────────

/**
 * Cold-start seeds: Top Sellers (trending/top category or 5000+ reviews) in the user's top
 * genres, best-reviewed first. Returns ids of *browse rows* — those rows are already candidates
 * (and already in the seen-set), so the caller flags them instead of re-adding them.
 */
export function selectColdStartSeedIds(
  userGames: UserGameSnapshot[],
  rawGames: Record<string, any>[],
  quota: number,
): string[] {
  const genreWeights = new Map<string, number>();
  for (const ug of userGames) {
    const w = computeEngagementWeight(ug);
    if (w <= 0) continue; // never seed from genres the user rejected
    for (const g of ug.genres) {
      const key = genreKey(g);
      genreWeights.set(key, (genreWeights.get(key) ?? 0) + w);
    }
  }
  const genreSet = new Set(
    [...genreWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g]) => g),
  );

  return rawGames
    .map(g => {
      const id = String(g.id ?? '');
      const genres: string[] = Array.isArray(g.genre) ? g.genre : [];
      const reviews = typeof g.totalReviews === 'number' ? g.totalReviews
        : typeof g.reviewVolume === 'number' ? g.reviewVolume
        : typeof g.recommendations === 'number' ? g.recommendations
        : 0;
      const category = String(g.category ?? g.browseCategory ?? '').toLowerCase();
      const isTopSeller = category.includes('trend') || category.includes('top') || reviews >= 5000;
      // Empty genre set (brand-new library) admits any top seller.
      const genreHit = genreSet.size === 0 || genres.some(x => genreSet.has(genreKey(String(x))));
      return { id, reviews, ok: !!id && isTopSeller && genreHit };
    })
    .filter(r => r.ok)
    .sort((a, b) => b.reviews - a.reviews)
    .slice(0, Math.max(0, quota))
    .map(r => r.id);
}

// ─── Quota pre-filter ───────────────────────────────────────────────────────────

export interface PreFilterOptions {
  /** Wall-clock for loyal-studio detection; defaults to Date.now(). */
  now?: number;
  /** Cold-start seeds kept unconditionally (default 300). */
  coldQuota?: number;
  maxPool?: number;
}

/**
 * Shelf-aware quotas: shrink an oversized pool (~25K) to ≤ maxPool while keeping every kind of
 * candidate the shelves need. Returns the SAME array when the pool already fits (callers rely on that).
 * Deterministic: the wildcard sample is seeded from the pool, not Math.random.
 */
export function preFilterCandidates(
  candidates: CandidateGame[],
  userGames: UserGameSnapshot[],
  opts: PreFilterOptions = {},
): CandidateGame[] {
  const maxPool = opts.maxPool ?? PREFILTER_MAX_POOL;
  if (candidates.length <= maxPool) return candidates;
  const now = opts.now ?? Date.now();
  const coldQuota = opts.coldQuota ?? 300;

  // Profile signals — rejected games (weight 0) must not open genre/studio/franchise quotas.
  const genreWeights = new Map<string, number>();
  const franchiseBases = new Set<string>();
  for (const ug of userGames) {
    const weight = computeEngagementWeight(ug);
    if (weight <= 0) continue;
    for (const key of new Set(ug.genres.map(genreKey))) {
      genreWeights.set(key, (genreWeights.get(key) ?? 0) + weight);
    }
    const base = canonicalFranchiseBase(ug.title);
    if (base) franchiseBases.add(base);
  }
  // Studio quota is for studios the user is actually loyal to, not every studio in the library.
  const profile = buildTasteProfile(userGames, now);
  const loyalDevs = new Set(profile.loyalDevelopers);
  const loyalPubs = new Set(profile.loyalPublishers);

  type Row = {
    candidate: CandidateGame;
    genreScore: number;
    isFranchise: boolean;
    isStudio: boolean;
    metacritic: number;
    isStretch: boolean;
    untagged: boolean;
    quality: number;
  };
  const rows: Row[] = [];
  for (const c of candidates) {
    // Mean weight of the genres that MATCH (extra unmatched genres neither help nor hurt).
    let sum = 0;
    let matched = 0;
    for (const key of new Set(c.genres.map(genreKey))) {
      const w = genreWeights.get(key);
      if (w !== undefined) { sum += w; matched++; }
    }
    const genreScore = matched > 0 ? sum / matched : 0;
    const candDevs = splitCreditedNames(c.developer);
    const candPubs = splitCreditedNames(c.publisher);
    rows.push({
      candidate: c,
      genreScore,
      isFranchise: franchiseBases.has(canonicalFranchiseBase(c.title)),
      isStudio: candDevs.some(d => loyalDevs.has(d)) || candPubs.some(p => loyalPubs.has(p)),
      metacritic: c.metacriticScore ?? 0,
      isStretch: matched === 0 && c.genres.length > 0 && (c.reviewPositivity ?? 0) >= 0.7 && (c.reviewVolume ?? 0) >= 50,
      untagged: c.genres.length === 0,
      quality: reviewQualityKey(c),
    });
  }

  const selected = new Set<CandidateGame>();
  const take = (list: Row[], quota: number, pred: (r: Row) => boolean) => {
    let n = 0;
    for (const r of list) {
      if (n >= quota) break;
      if (pred(r) && !selected.has(r.candidate)) { selected.add(r.candidate); n++; }
    }
  };

  // 0. ANN / BM25 / cold-start hits were found for a reason (zero genre overlap is normal): keep them.
  take(rows, QUOTA_SEMANTIC, r => r.candidate.semanticRetrieved === true);
  take(rows, QUOTA_LEXICAL, r => r.candidate.lexicalRetrieved === true);
  take(rows, coldQuota, r => r.candidate.coldStartSeeded === true);

  // 1. Genre overlap — by engagement-weighted score of the matching genres.
  const byGenre = [...rows].sort((a, b) => b.genreScore - a.genreScore);
  take(byGenre, QUOTA_GENRE, r => r.genreScore > 0);

  // 2. Franchise and loyal-studio matches.
  take(rows, QUOTA_FRANCHISE, r => r.isFranchise);
  take(rows, QUOTA_STUDIO, r => r.isStudio);

  // 3. High metacritic (genre-agnostic: feeds hidden gems + critics' choice).
  const byMeta = [...rows].sort((a, b) => b.metacritic - a.metacritic);
  take(byMeta, QUOTA_METACRITIC, r => r.metacritic >= 75);

  // 4. Stretch picks — outside the user's genres but best-reviewed first (not pool order).
  const byQuality = [...rows].sort((a, b) => b.quality - a.quality);
  take(byQuality, QUOTA_STRETCH, r => r.isStretch);

  // 5. Untagged candidates (no genre metadata) get their own path, best-reviewed first.
  take(byQuality, QUOTA_UNTAGGED, r => r.untagged);

  // 6. Seeded wildcard sample (partial Fisher–Yates) — varied but reproducible for the same pool.
  const remaining = rows.filter(r => !selected.has(r.candidate));
  const rand = seededRandom(hashString(`${candidates.length}|${candidates[0]?.gameId}|${candidates[candidates.length - 1]?.gameId}`));
  const wildcard = Math.min(QUOTA_WILDCARD, remaining.length);
  for (let i = 0; i < wildcard; i++) {
    const j = i + Math.floor(rand() * (remaining.length - i));
    [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    selected.add(remaining[i].candidate);
  }

  return [...selected];
}
