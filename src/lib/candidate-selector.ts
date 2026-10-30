/**
 * Which Steam catalog rows become Oracle candidates. Shared by the main-process query
 * (`catalog:queryCandidates`) and the renderer fallback scan so both return exactly the same
 * rows in the same order — the candidate pool, and so every shelf, depends on it.
 *
 *   matched      — passes the review floor and shares a top genre, loyal developer or publisher
 *   popularOnly  — passes the floor with no match but >= 1000 reviews; capped at maxPopularQuota
 *
 * Both groups are merged, most-reviewed first (stable: ties keep scan order), and capped at maxResults.
 */
export interface CandidateSelectOptions {
  topGenres: string[];
  loyalDevelopers: string[];
  loyalPublishers: string[];
  excludeIds: ReadonlySet<string>;
  minReviews: number;
  minPositivity: number;
  maxResults: number;
  maxPopularQuota: number;
}

export interface CandidateRowLike {
  appid: number;
  genres: string[];
  developer: string;
  publisher: string;
  reviewCount: number;
  reviewPositivity: number;
}

/** Reviews needed for a row with no genre/developer/publisher match to be admitted as "popular". */
export const POPULAR_ONLY_MIN_REVIEWS = 1000;

export class CandidateSelector<T extends CandidateRowLike> {
  private matched: T[] = [];
  private popularOnly: T[] = [];
  private genreSet: Set<string>;
  private devSet: Set<string>;
  private pubSet: Set<string>;

  constructor(private o: CandidateSelectOptions) {
    this.genreSet = new Set(o.topGenres.map(g => g.toLowerCase()));
    this.devSet = new Set(o.loyalDevelopers.map(d => d.toLowerCase()));
    this.pubSet = new Set(o.loyalPublishers.map(p => p.toLowerCase()));
  }

  admit(entry: T): void {
    if (this.o.excludeIds.has(`steam-${entry.appid}`)) return;
    if (entry.reviewCount < this.o.minReviews || entry.reviewPositivity < this.o.minPositivity) return;

    const genres = Array.isArray(entry.genres) ? entry.genres : [];
    const hasGenreMatch = genres.some(g => typeof g === 'string' && this.genreSet.has(g.toLowerCase()));
    const hasDevMatch = typeof entry.developer === 'string' && entry.developer !== ''
      && this.devSet.has(entry.developer.toLowerCase());
    const hasPubMatch = typeof entry.publisher === 'string' && entry.publisher !== '' && this.pubSet.size > 0
      && this.pubSet.has(entry.publisher.toLowerCase());

    if (hasGenreMatch || hasDevMatch || hasPubMatch) this.matched.push(entry);
    else if (entry.reviewCount >= POPULAR_ONLY_MIN_REVIEWS) this.popularOnly.push(entry);
  }

  result(): T[] {
    this.popularOnly.sort((a, b) => b.reviewCount - a.reviewCount);
    const combined = [...this.matched, ...this.popularOnly.slice(0, this.o.maxPopularQuota)];
    combined.sort((a, b) => b.reviewCount - a.reviewCount);
    return combined.slice(0, this.o.maxResults);
  }
}

// ─── IPC argument validation (main process) ─────────────────────────────────────

export const CANDIDATE_QUERY_MAX_RESULTS = 25_000;
export const CANDIDATE_QUERY_MAX_POPULAR_QUOTA = 1000;
/** Bounds on the string lists a renderer can send (library-derived; real values are far below these). */
export const CANDIDATE_QUERY_MAX_TERMS = 500;
export const CANDIDATE_QUERY_MAX_EXCLUDE_IDS = 200_000;

function stringList(v: unknown, max: number): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) return null;
  for (const s of v) if (typeof s !== 'string') return null;
  return v as string[];
}

function finiteOr(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/**
 * Validates and clamps `catalog:queryCandidates` arguments. Returns null for anything malformed
 * (non-object, non-string-array lists, oversized lists). Numeric caps are clamped, not rejected.
 * Defaults match CatalogStore.queryForCandidates.
 */
export function sanitizeCandidateQueryOpts(raw: unknown): CandidateSelectOptions | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const topGenres = stringList(o.topGenres, CANDIDATE_QUERY_MAX_TERMS);
  const loyalDevelopers = stringList(o.loyalDevelopers, CANDIDATE_QUERY_MAX_TERMS);
  const loyalPublishers = stringList(o.loyalPublishers, CANDIDATE_QUERY_MAX_TERMS);
  const excludeIds = stringList(o.excludeIds, CANDIDATE_QUERY_MAX_EXCLUDE_IDS);
  if (!topGenres || !loyalDevelopers || !loyalPublishers || !excludeIds) return null;
  const clampInt = (v: unknown, d: number, max: number) => Math.max(0, Math.min(max, Math.floor(finiteOr(v, d))));
  return {
    topGenres,
    loyalDevelopers,
    loyalPublishers,
    excludeIds: new Set(excludeIds),
    minReviews: finiteOr(o.minReviews, 10),
    minPositivity: finiteOr(o.minPositivity, 0.5),
    maxResults: clampInt(o.maxResults, CANDIDATE_QUERY_MAX_RESULTS, CANDIDATE_QUERY_MAX_RESULTS),
    maxPopularQuota: clampInt(o.maxPopularQuota, 200, CANDIDATE_QUERY_MAX_POPULAR_QUOTA),
  };
}

type ChunkReader = (
  opts: { startAfter?: string; limit: number },
) => Promise<{ rows?: Array<{ key: string; value: unknown }>; nextKey?: string; done?: boolean }>;

/**
 * Main-process scan: reads the namespace in key order (the same order the renderer's getChunk walk
 * sees) in chunks of `chunkSize`, yielding between chunks so other IPC keeps being served.
 */
export async function scanCatalogCandidates<T extends CandidateRowLike>(
  readChunk: ChunkReader,
  opts: CandidateSelectOptions,
  yieldFn: () => Promise<void>,
  chunkSize = 2000,
): Promise<T[]> {
  const selector = new CandidateSelector<T>(opts);
  let startAfter: string | undefined;
  for (;;) {
    const res = await readChunk({ startAfter, limit: chunkSize });
    for (const row of res.rows ?? []) {
      const v = row.value;
      if (v && typeof v === 'object') selector.admit(v as T);
    }
    if (res.done || !res.nextKey) break;
    startAfter = res.nextKey;
    await yieldFn();
  }
  return selector.result();
}
