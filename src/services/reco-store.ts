/**
 * Oracle v3 Recommendation Store
 *
 * Manages recommendation state: computed shelves, taste profile, loading state,
 * and progress updates from the worker. Follows the same singleton + subscriber
 * pattern as LibraryStore, JourneyStore, etc.
 *
 * v3 changes:
 *  - Passes dismissed game IDs to worker for exclusion
 *  - Enriches candidates with review sentiment, price info
 *  - Tracks conversion events (click → add → play → rate)
 */

import type {
  TasteProfile,
  RecoShelf,
  RecoWorkerInput,
  RecoWorkerMessage,
  UserGameSnapshot,
  CandidateGame,
  EngagementPattern,
} from '@/types/reco';
import type { GameSession, StatusChangeEntry } from '@/types/game';
import { libraryStore } from './library-store';
import { journeyStore } from './journey-store';
import { sessionStore } from './session-store';
import { statusHistoryStore } from './status-history-store';
import { recoHistoryStore } from './reco-history-store';
import { catalogStore } from './catalog-store';
import { epicCatalogStore } from './epic-catalog-store';
import { annIndex } from './ann-index';
import { embeddingService } from './embedding-service';

// ─── Embedding cache (populated externally by embedding-service) ────────────

let embeddingCache: Map<string, number[]> = new Map();

/** Called by the embedding service to inject cached vectors. */
export function setEmbeddingCache(cache: Map<string, number[]>) {
  embeddingCache = cache;
}

/** Returns the current embedding cache (for visualization/debug). */
export function getEmbeddingCache(): ReadonlyMap<string, number[]> {
  return embeddingCache;
}

// ─── State ─────────────────────────────────────────────────────────────────────

interface RecoState {
  status: 'idle' | 'computing' | 'done' | 'error';
  progress: { stage: string; percent: number };
  tasteProfile: TasteProfile | null;
  shelves: RecoShelf[];
  computeTimeMs: number;
  lastComputed: number | null; // timestamp
  error: string | null;
  /** How many user games were fed to the engine. */
  libraryCount: number;
  /** How many candidate games were available to score. */
  candidateCount: number;
}

const INITIAL_STATE: RecoState = {
  status: 'idle',
  progress: { stage: '', percent: 0 },
  tasteProfile: null,
  shelves: [],
  computeTimeMs: 0,
  lastComputed: null,
  error: null,
  libraryCount: 0,
  candidateCount: 0,
};

// ─── Store ─────────────────────────────────────────────────────────────────────

class RecoStore {
  private state: RecoState = { ...INITIAL_STATE };
  private listeners: Set<() => void> = new Set();
  private worker: Worker | null = null;

  // Cold-start result caching — persists across app restarts
  private static readonly RESULT_CACHE_KEY = 'ark-oracle-results';
  private static readonly RESULT_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

  // ── Subscriptions ──

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((fn) => fn());
  }

  // ── Getters ──

  getState(): Readonly<RecoState> {
    return this.state;
  }

  // ── Result Cache ──

  private saveResultsToCache() {
    try {
      const cache = {
        shelves: this.state.shelves,
        tasteProfile: this.state.tasteProfile,
        computeTimeMs: this.state.computeTimeMs,
        lastComputed: this.state.lastComputed,
        libraryCount: this.state.libraryCount,
        candidateCount: this.state.candidateCount,
      };
      localStorage.setItem(RecoStore.RESULT_CACHE_KEY, JSON.stringify(cache));
    } catch {
      // localStorage full or unavailable — ignore
    }
  }

  private loadResultsFromCache(): Partial<RecoState> | null {
    try {
      const raw = localStorage.getItem(RecoStore.RESULT_CACHE_KEY);
      if (!raw) return null;
      const cache = JSON.parse(raw);
      if (!cache.lastComputed || Date.now() - cache.lastComputed > RecoStore.RESULT_CACHE_TTL) {
        return null;
      }
      if (!cache.shelves || cache.shelves.length === 0) return null;
      return cache;
    } catch {
      return null;
    }
  }

  private clearResultsCache() {
    try {
      localStorage.removeItem(RecoStore.RESULT_CACHE_KEY);
    } catch {
      // ignore
    }
  }

  // ── Compute ──

  /**
   * Gather user data from all stores, build the candidate pool,
   * and dispatch to the worker for scoring.
   *
   * @param embeddingGenerator Optional callback invoked after data gathering
   *   to generate missing semantic embeddings via Ollama.  Receives the full
   *   game list (user + candidates) and should return the number of newly
   *   generated embeddings.  Keeps reco-store free of circular deps on
   *   embedding-service — the caller (OracleView) wires them together.
   */
  async compute(
    embeddingGenerator?: (
      games: Array<{
        id: string; title: string; genres?: string[]; themes?: string[];
        modes?: string[]; developer?: string; publisher?: string;
        playerPerspectives?: string[]; summary?: string; description?: string;
        userNotes?: string; similarGames?: Array<{ name: string }>;
      }>,
    ) => Promise<number>,
    catalogEmbeddingEnricher?: (candidateIds: Set<string>) => Promise<number>,
  ) {
    if (this.state.status === 'computing') return; // prevent double-fire

    // Cold-start optimization: restore recent results from localStorage
    const cached = this.loadResultsFromCache();
    if (cached && cached.shelves && cached.shelves.length > 0) {
      console.log(`[RecoStore] Restored cached results (${cached.shelves.length} shelves, computed ${Math.round((Date.now() - (cached.lastComputed || 0)) / 1000)}s ago)`);
      this.state = {
        ...this.state,
        status: 'done',
        progress: { stage: 'Complete (cached)', percent: 100 },
        tasteProfile: (cached.tasteProfile as RecoState['tasteProfile']) ?? null,
        shelves: cached.shelves as RecoShelf[],
        computeTimeMs: (cached.computeTimeMs as number) ?? 0,
        lastComputed: (cached.lastComputed as number) ?? Date.now(),
        libraryCount: (cached.libraryCount as number) ?? 0,
        candidateCount: (cached.candidateCount as number) ?? 0,
      };
      this.notify();
      return;
    }

    this.state = {
      ...this.state,
      status: 'computing',
      progress: { stage: 'Gathering data...', percent: 5 },
      error: null,
    };
    this.notify();

    try {
      // 1. Build user game snapshots from library + journey
      this.state = { ...this.state, progress: { stage: 'Building user profile...', percent: 3 } };
      this.notify();
      const userGames = this.buildUserGameSnapshots();

      // 2. Build candidate pool (from cached browse data + similar games)
      this.state = { ...this.state, progress: { stage: 'Loading candidate pool...', percent: 5 } };
      this.notify();
      const candidates = await this.buildCandidatePool(userGames);

      // Store counts for the UI (before pre-filter, so the user sees the real pool size)
      this.state = {
        ...this.state,
        libraryCount: userGames.length,
        candidateCount: candidates.length,
      };
      this.notify();

      // 2.1. Pre-filter candidates with shelf-aware quotas (25K → ~3K)
      this.state = { ...this.state, progress: { stage: 'Pre-filtering candidates...', percent: 6 } };
      this.notify();
      const poolSizeBefore = candidates.length;
      const filtered = this.preFilterCandidates(candidates, userGames);
      candidates.length = 0;
      candidates.push(...filtered);
      console.log(`[RecoStore] Pre-filter: ${poolSizeBefore.toLocaleString()} → ${candidates.length.toLocaleString()} candidates`);

      // 2.5. Generate missing semantic embeddings if a generator was provided
      if (embeddingGenerator) {
        this.state = {
          ...this.state,
          progress: { stage: 'Generating semantic embeddings...', percent: 10 },
        };
        this.notify();

        const embeddingInput = [
          ...userGames.map(g => {
            const lib = libraryStore.getEntry(g.gameId);
            const meta = lib?.cachedMeta;
            return {
              id: g.gameId, title: g.title, genres: g.genres,
              themes: g.themes, modes: g.gameModes, developer: g.developer,
              publisher: g.publisher,
              playerPerspectives: g.perspectives,
              summary: meta?.summary,
              description: meta?.longDescription,
              similarGames: meta?.similarGames,
              userNotes: lib?.publicReviews || undefined,
            };
          }),
          ...candidates.map(g => ({
            id: g.gameId, title: g.title, genres: g.genres,
            themes: g.themes, modes: g.gameModes, developer: g.developer,
            publisher: g.publisher,
            playerPerspectives: g.perspectives,
            similarGames: g.similarGameTitles?.length
              ? g.similarGameTitles.map(t => ({ name: t }))
              : undefined,
          })),
        ];

        const generated = await embeddingGenerator(embeddingInput);

        if (generated > 0) {
          // Re-attach embeddings from the now-populated cache
          for (const ug of userGames) {
            ug.embedding ??= embeddingCache.get(ug.gameId);
          }
          for (const c of candidates) {
            c.embedding ??= embeddingCache.get(c.gameId);
          }
        }
      }

      // 2.7. Enrich candidates with catalog embeddings
      this.state = { ...this.state, progress: { stage: 'Enriching catalog embeddings...', percent: 12 } };
      this.notify();
      if (catalogEmbeddingEnricher) {
        const catalogCandidateIds = new Set(
          candidates.filter(c => !c.embedding && c.gameId.startsWith('steam-')).map(c => c.gameId),
        );
        if (catalogCandidateIds.size > 0) {
          const enriched = await catalogEmbeddingEnricher(catalogCandidateIds);
          if (enriched > 0) {
            for (const c of candidates) {
              c.embedding ??= embeddingCache.get(c.gameId);
            }
          }
        }
      }

      // 2.9. ML model scoring — Kaggle-trained LightGBM
      this.state = { ...this.state, progress: { stage: 'ML model scoring...', percent: 14 } };
      this.notify();
      await this.applyMLScores(userGames, candidates);

      // 3. Compute taste centroid & embedding coverage
      this.state = { ...this.state, progress: { stage: 'Preparing scoring engine...', percent: 16 } };
      this.notify();

      // 3.5. Precompute taste centroid for the worker
      const userEmbs = userGames
        .filter(ug => ug.embedding && ug.embedding.length > 0)
        .map(ug => ({ embedding: ug.embedding!, weight: this.computeEngagementWeight(ug) }));
      const tasteCentroid = embeddingService.computeTasteCentroid(userEmbs);

      // Embedding coverage: only meaningful when we CAN produce semantic scores
      // (i.e., tasteCentroid exists). Otherwise the weight budget would be allocated
      // to a signal that always returns 0, diluting all other scoring layers.
      const candidatesWithEmbeddings = tasteCentroid
        ? candidates.filter(c => c.embedding && c.embedding.length > 0).length
        : 0;
      const embeddingCoverage = (tasteCentroid && candidates.length > 0)
        ? candidatesWithEmbeddings / candidates.length
        : 0;

      // 3.6. Precompute per-candidate semantic similarity & strip candidate embeddings.
      // The taste centroid cosine is the expensive part; we compute it here to avoid
      // sending ~25K × 1024-dim embedding arrays through structured clone.
      let precomputedSemanticScores: Record<string, number> | undefined;
      if (tasteCentroid) {
        const scores: Record<string, number> = {};
        const dim = tasteCentroid.length;
        let centroidMag = 0;
        for (let i = 0; i < dim; i++) centroidMag += tasteCentroid[i] * tasteCentroid[i];
        centroidMag = Math.sqrt(centroidMag);

        for (const c of candidates) {
          if (c.embedding && c.embedding.length === dim) {
            let dot = 0, magB = 0;
            for (let i = 0; i < dim; i++) {
              dot += tasteCentroid[i] * c.embedding[i];
              magB += c.embedding[i] * c.embedding[i];
            }
            scores[c.gameId] = centroidMag > 0 && magB > 0
              ? dot / (centroidMag * Math.sqrt(magB))
              : 0;
          }
          delete c.embedding;
        }
        precomputedSemanticScores = scores;
      } else {
        for (const c of candidates) delete c.embedding;
      }

      // 4. Get dismissed game IDs
      const dismissedGameIds = recoHistoryStore.getDismissedIds();

      // 5. Dispatch to worker
      const input: RecoWorkerInput = {
        userGames,
        candidates,
        now: Date.now(),
        currentHour: new Date().getHours(),
        embeddingCoverage,
        dismissedGameIds,
        tasteCentroid: tasteCentroid ? Array.from(tasteCentroid) : undefined,
        precomputedSemanticScores,
      };

      this.runWorker(input);
    } catch (err) {
      console.error('[RecoStore] compute failed:', err);
      this.state = {
        ...this.state,
        status: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      };
      this.notify();
    }
  }

  private buildUserGameSnapshots(): UserGameSnapshot[] {
    const journeyEntries = journeyStore.getAllEntries();
    const allSessions = sessionStore.getAll();
    const allStatusChanges = statusHistoryStore.getAll();

    // Group sessions by gameId
    const sessionsByGame = new Map<string, GameSession[]>();
    for (const s of allSessions) {
      if (!sessionsByGame.has(s.gameId)) sessionsByGame.set(s.gameId, []);
      sessionsByGame.get(s.gameId)!.push(s);
    }

    // Group status changes by gameId
    const statusByGame = new Map<string, StatusChangeEntry[]>();
    for (const s of allStatusChanges) {
      if (!statusByGame.has(s.gameId)) statusByGame.set(s.gameId, []);
      statusByGame.get(s.gameId)!.push(s);
    }

    const snapshots: UserGameSnapshot[] = [];
    const snapshotIds = new Set<string>();

    for (const entry of journeyEntries) {
      const libEntry = libraryStore.getEntry(entry.gameId);
      const meta = libEntry?.cachedMeta;
      const sessions = sessionsByGame.get(entry.gameId) || [];
      const statusChanges = statusByGame.get(entry.gameId) || [];

      // Session pattern analysis
      const totalDuration = sessions.reduce((s, ses) => s + ses.durationMinutes, 0);
      const totalIdle = sessions.reduce((s, ses) => s + ses.idleMinutes, 0);
      const avgSessionMinutes = sessions.length > 0 ? totalDuration / sessions.length : 0;
      const lastSession = sessions.length > 0
        ? sessions.sort((a, b) => new Date(b.endTime).getTime() - new Date(a.endTime).getTime())[0]
        : null;

      // Status trajectory
      const trajectory = statusChanges
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .map(sc => sc.newStatus);

      // Session timestamps and durations for engagement curve analysis
      const sortedSessions = [...sessions].sort(
        (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
      );
      const sessionTimestamps = sortedSessions.map(s => new Date(s.startTime).getTime());
      const sessionDurations = sortedSessions.map(s => s.durationMinutes);

      // Classify engagement pattern
      const engagementPattern = this.classifyEngagement(sessionTimestamps, sessionDurations, sessions.length);

      // Attach embedding if available
      const embedding = embeddingCache.get(entry.gameId);

      // Resolve similar game titles from cachedMeta
      const similarGameTitles = meta?.similarGames
        ? meta.similarGames.map(sg => sg.name).filter(Boolean)
        : [];

      snapshotIds.add(entry.gameId);
      snapshots.push({
        gameId: entry.gameId,
        title: entry.title,
        genres: meta?.genre || entry.genre || [],
        themes: meta?.themes || [],
        gameModes: meta?.gameModes || [],
        perspectives: meta?.playerPerspectives || [],
        developer: meta?.developer || '',
        publisher: meta?.publisher || '',
        releaseDate: meta?.releaseDate || entry.releaseDate || '',
        status: libEntry?.status || entry.status,
        hoursPlayed: libEntry?.hoursPlayed ?? entry.hoursPlayed,
        rating: libEntry?.rating ?? entry.rating,
        addedAt: entry.addedAt,
        removedAt: entry.removedAt,
        sessionCount: sessions.length,
        avgSessionMinutes,
        lastSessionDate: lastSession?.endTime || null,
        activeToIdleRatio: totalDuration > 0 ? totalDuration / (totalDuration + totalIdle) : 1,
        statusTrajectory: trajectory,
        similarGameTitles,
        engagementPattern,
        sessionTimestamps,
        sessionDurations,
        ...(embedding ? { embedding } : {}),
      });
    }

    // Include library entries that have no journey entry yet (e.g. "Want to Play"
    // games added via addToLibrary, which doesn't create a journey record).
    // This ensures the recommendation engine sees wishlist intent as a signal and
    // excludes these games from candidates.
    for (const libEntry of libraryStore.getAllEntries()) {
      if (snapshotIds.has(libEntry.gameId)) continue;
      const meta = libEntry.cachedMeta;
      const embedding = embeddingCache.get(libEntry.gameId);
      const addedAt = libEntry.addedAt instanceof Date
        ? libEntry.addedAt.toISOString()
        : String(libEntry.addedAt);

      snapshotIds.add(libEntry.gameId);
      snapshots.push({
        gameId: libEntry.gameId,
        title: meta?.title ?? `Game ${libEntry.gameId}`,
        genres: meta?.genre ?? [],
        themes: meta?.themes ?? [],
        gameModes: meta?.gameModes ?? [],
        perspectives: meta?.playerPerspectives ?? [],
        developer: meta?.developer ?? '',
        publisher: meta?.publisher ?? '',
        releaseDate: meta?.releaseDate ?? '',
        status: libEntry.status,
        hoursPlayed: libEntry.hoursPlayed ?? 0,
        rating: libEntry.rating ?? 0,
        addedAt,
        removedAt: undefined,
        sessionCount: 0,
        avgSessionMinutes: 0,
        lastSessionDate: null,
        activeToIdleRatio: 1,
        statusTrajectory: [libEntry.status],
        similarGameTitles: meta?.similarGames?.map(sg => sg.name).filter(Boolean) ?? [],
        engagementPattern: 'unknown',
        sessionTimestamps: [],
        sessionDurations: [],
        ...(embedding ? { embedding } : {}),
      });
    }

    return snapshots;
  }

  /** Classify engagement pattern on the main thread (before posting to worker). */
  private classifyEngagement(
    timestamps: number[],
    durations: number[],
    sessionCount: number,
  ): EngagementPattern {
    if (sessionCount < 3) return 'unknown';

    const firstTime = Math.min(...timestamps);
    const lastTime = Math.max(...timestamps);
    const spanDays = (lastTime - firstTime) / (1000 * 60 * 60 * 24);

    if (spanDays <= 3 && sessionCount >= 3) return 'binge-drop';

    const isSpread = spanDays >= 14;

    if (durations.length >= 4) {
      const firstHalf = durations.slice(0, Math.floor(durations.length / 2));
      const secondHalf = durations.slice(Math.floor(durations.length / 2));
      const avgFirst = firstHalf.reduce((s, d) => s + d, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((s, d) => s + d, 0) / secondHalf.length;

      if (avgSecond > avgFirst * 1.2 && isSpread) return 'slow-burn';
    }

    if (durations.length >= 5) {
      const firstThree = durations.slice(0, 3);
      const rest = durations.slice(3);
      const avgFirstThree = firstThree.reduce((s, d) => s + d, 0) / firstThree.length;
      const avgRest = rest.reduce((s, d) => s + d, 0) / rest.length;
      if (avgFirstThree > avgRest * 1.5) return 'honeymoon';
    }

    if (isSpread) return 'long-tail';
    return 'unknown';
  }

  /**
   * Read the browse cache from `ark-browse-cache` IndexedDB (the same DB the
   * idb-cache worker writes to).  We open it directly here rather than going
   * through the shared worker so we don't interfere with in-flight save/load
   * operations from the prefetch store.
   */
  private async buildCandidatePool(userGames: UserGameSnapshot[]): Promise<CandidateGame[]> {
    // Exclude both journey-derived snapshots AND all library entries (covers
    // "Want to Play" and other statuses that may not yet have journey records).
    const userGameIds = new Set(userGames.map(g => g.gameId));
    for (const id of libraryStore.getAllGameIds()) userGameIds.add(id);

    const candidates: CandidateGame[] = [];
    const seenIds = new Set<string>();

    // ── Source 1: Browse cache (existing path — 3K–6K games) ──
    let rawGames: Record<string, any>[] = [];
    try {
      rawGames = await this.loadBrowseCacheGames();
    } catch (err) {
      console.warn('[RecoStore] Failed to read browse cache for candidates:', err);
    }

    for (const g of rawGames) {
      const id = String(g.id ?? '');
      if (!id || userGameIds.has(id) || seenIds.has(id)) continue;
      const secId = g.secondaryId ? String(g.secondaryId) : '';
      if (secId && (userGameIds.has(secId) || seenIds.has(secId))) continue;
      seenIds.add(id);
      if (secId) seenIds.add(secId);

      const embedding = embeddingCache.get(id);

      candidates.push({
        gameId: id,
        title: g.title || '',
        coverUrl: g.coverUrl,
        headerImage: g.headerImage,
        developer: g.developer || '',
        publisher: g.publisher || '',
        genres: Array.isArray(g.genre) ? g.genre : [],
        themes: Array.isArray(g.themes) ? g.themes : [],
        gameModes: Array.isArray(g.gameModes) ? g.gameModes : [],
        perspectives: Array.isArray(g.playerPerspectives) ? g.playerPerspectives : [],
        platforms: Array.isArray(g.platform) ? g.platform : [],
        metacriticScore: typeof g.metacriticScore === 'number' ? g.metacriticScore : null,
        playerCount: typeof g.playerCount === 'number' ? g.playerCount : null,
        releaseDate: g.releaseDate || '',
        similarGameTitles: Array.isArray(g.similarGames)
          ? g.similarGames.map((sg: any) => sg.name || '').filter(Boolean)
          : [],
        recommendations: typeof g.recommendations === 'number' ? g.recommendations : undefined,
        achievements: typeof g.achievements === 'number' ? g.achievements : undefined,
        comingSoon: g.comingSoon === true,
        reviewPositivity: typeof g.reviewPositivity === 'number' ? g.reviewPositivity
          : (typeof g.totalPositive === 'number' && typeof g.totalReviews === 'number' && g.totalReviews > 0)
            ? g.totalPositive / g.totalReviews
            : undefined,
        reviewVolume: typeof g.reviewVolume === 'number' ? g.reviewVolume
          : typeof g.totalReviews === 'number' ? g.totalReviews
          : undefined,
        price: g.price ? {
          isFree: g.price.isFree === true || g.price.final === 0,
          finalFormatted: g.price.finalFormatted || undefined,
          discountPercent: typeof g.price.discountPercent === 'number' ? g.price.discountPercent : undefined,
        } : (g.isFree === true ? { isFree: true } : undefined),
        ...(embedding ? { embedding } : {}),
      });
    }

    // ── Source 2: Full Steam catalog (pre-filtered to ~5–8K) ──
    const browseCount = candidates.length;
    try {
      const catalogCandidates = await this.loadCatalogCandidates(userGames, userGameIds, seenIds);
      candidates.push(...catalogCandidates);
    } catch (err) {
      console.warn('[RecoStore] Catalog candidate loading failed (non-fatal):', err);
    }
    const catalogCount = candidates.length - browseCount;

    // ── Source 2b: Epic catalog (genre/developer match) ──
    let epicCatalogCount = 0;
    try {
      const epicCandidates = await this.loadEpicCatalogCandidates(userGames, userGameIds, seenIds);
      candidates.push(...epicCandidates);
      epicCatalogCount = epicCandidates.length;
    } catch (err) {
      console.warn('[RecoStore] Epic catalog candidate loading failed (non-fatal):', err);
    }

    // ── Source 3: ANN embedding retrieval (top 5K by taste centroid) ──
    let annCount = 0;
    try {
      if (annIndex.isReady) {
        const annCandidates = await this.retrieveByANN(userGames, userGameIds, seenIds);
        candidates.push(...annCandidates);
        annCount = annCandidates.length;
      }
    } catch (err) {
      console.warn('[RecoStore] ANN retrieval failed (non-fatal):', err);
    }

    console.log(`[RecoStore] Candidate pool: ${candidates.length} (browse: ${browseCount}, catalog: ${catalogCount}, epicCatalog: ${epicCatalogCount}, ann: ${annCount})`);
    return candidates;
  }

  /**
   * Pre-filter the full Steam catalog down to a manageable candidate set.
   * Criteria: genre overlap with user profile, developer loyalty, or popularity.
   */
  private async loadCatalogCandidates(
    userGames: UserGameSnapshot[],
    userGameIds: Set<string>,
    seenIds: Set<string>,
  ): Promise<CandidateGame[]> {
    const entryCount = await catalogStore.getEntryCount();
    if (entryCount === 0) return [];

    // Build filter criteria from user library
    const genreCounts = new Map<string, number>();
    const devSet = new Set<string>();
    const pubSet = new Set<string>();
    for (const ug of userGames) {
      for (const g of ug.genres) {
        genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
      }
      if (ug.developer && ug.rating >= 3.5) {
        devSet.add(ug.developer);
      }
      if (ug.publisher && ug.rating >= 3.5) {
        pubSet.add(ug.publisher);
      }
    }
    const topGenres = [...genreCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([g]) => g);

    const catalogEntries = await catalogStore.queryForCandidates({
      topGenres,
      loyalDevelopers: [...devSet],
      loyalPublishers: [...pubSet],
      excludeIds: userGameIds,
      minReviews: 10,
      minPositivity: 0.5,
      maxResults: 25_000,
    });

    const results: CandidateGame[] = [];
    for (const entry of catalogEntries) {
      const id = `steam-${entry.appid}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const embedding = embeddingCache.get(id);
      const releaseStr = entry.releaseDate
        ? new Date(entry.releaseDate * 1000).toISOString().slice(0, 10)
        : '';

      results.push({
        gameId: id,
        title: entry.name,
        coverUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${entry.appid}/library_600x900.jpg`,
        headerImage: `https://cdn.akamai.steamstatic.com/steam/apps/${entry.appid}/header.jpg`,
        developer: entry.developer,
        publisher: entry.publisher,
        genres: entry.genres || [],
        themes: entry.themes || [],
        gameModes: entry.modes || [],
        perspectives: [],
        platforms: [
          ...(entry.windows ? ['Windows'] : []),
          ...(entry.mac ? ['Mac'] : []),
          ...(entry.linux ? ['Linux'] : []),
        ],
        metacriticScore: null,
        playerCount: null,
        releaseDate: releaseStr,
        similarGameTitles: [],
        reviewPositivity: entry.reviewPositivity,
        reviewVolume: entry.reviewCount,
        price: {
          isFree: entry.isFree,
          finalFormatted: entry.priceFormatted,
          discountPercent: entry.discountPercent,
        },
        ...(embedding ? { embedding } : {}),
      });
    }

    console.log(`[RecoStore] Catalog pre-filter: ${entryCount} total → ${catalogEntries.length} matched → ${results.length} new candidates`);
    return results;
  }

  /**
   * Load Epic catalog candidates matching the user's genre/developer profile.
   * Simpler filtering than Steam (no review scores), but includes Epic's
   * richer descriptions in the candidate pool.
   */
  private async loadEpicCatalogCandidates(
    userGames: UserGameSnapshot[],
    userGameIds: Set<string>,
    seenIds: Set<string>,
  ): Promise<CandidateGame[]> {
    const entryCount = await epicCatalogStore.getEntryCount();
    if (entryCount === 0) return [];

    const genreSet = new Set<string>();
    const devSet = new Set<string>();
    for (const ug of userGames) {
      for (const g of ug.genres) genreSet.add(g.toLowerCase());
      if (ug.developer && ug.rating >= 3.5) devSet.add(ug.developer.toLowerCase());
    }

    const results: CandidateGame[] = [];
    await epicCatalogStore.getAllEntries((batch) => {
      for (const entry of batch) {
        const id = `epic-${entry.epicId}`;
        if (userGameIds.has(id) || seenIds.has(id)) continue;

        const hasGenreMatch = entry.genres.some(g => genreSet.has(g.toLowerCase()));
        const hasDevMatch = entry.developer && devSet.has(entry.developer.toLowerCase());
        if (!hasGenreMatch && !hasDevMatch) continue;

        seenIds.add(id);
        const embedding = embeddingCache.get(id);
        const releaseStr = entry.releaseDate
          ? new Date(entry.releaseDate).toISOString().slice(0, 10)
          : '';

        results.push({
          gameId: id,
          title: entry.name,
          coverUrl: entry.coverUrl || undefined,
          developer: entry.developer,
          publisher: entry.publisher,
          genres: entry.genres || [],
          themes: entry.themes || [],
          gameModes: entry.modes || [],
          perspectives: [],
          platforms: ['Windows'],
          metacriticScore: null,
          playerCount: null,
          releaseDate: releaseStr,
          similarGameTitles: [],
          price: {
            isFree: entry.isFree,
            finalFormatted: entry.priceFormatted,
            discountPercent: entry.discountPercent,
          },
          ...(embedding ? { embedding } : {}),
        });
      }
    });

    console.log(`[RecoStore] Epic catalog pre-filter: ${entryCount} total → ${results.length} matched`);
    return results;
  }

  /**
   * Retrieve semantically similar games from the ANN index using a
   * weighted taste centroid derived from the user's library embeddings.
   */
  private async retrieveByANN(
    userGames: UserGameSnapshot[],
    userGameIds: Set<string>,
    seenIds: Set<string>,
  ): Promise<CandidateGame[]> {
    const userEmbs = userGames
      .filter(ug => ug.embedding && ug.embedding.length > 0)
      .map(ug => ({
        embedding: ug.embedding!,
        weight: this.computeEngagementWeight(ug),
      }));

    const centroid = embeddingService.computeTasteCentroid(userEmbs);
    if (!centroid) return [];

    const TOP_K = 5_000;
    const nearestIds = await annIndex.query(centroid, TOP_K);

    const newSteamAppIds: number[] = [];
    const newEpicIds: string[] = [];
    const newIdSet = new Set<string>();
    for (const id of nearestIds) {
      if (userGameIds.has(id) || seenIds.has(id)) continue;
      if (id.startsWith('steam-')) {
        const appid = parseInt(id.slice(6), 10);
        if (!isNaN(appid)) {
          newSteamAppIds.push(appid);
          newIdSet.add(id);
          seenIds.add(id);
        }
      } else if (id.startsWith('epic-')) {
        newEpicIds.push(id);
        newIdSet.add(id);
        seenIds.add(id);
      }
    }

    if (newSteamAppIds.length === 0 && newEpicIds.length === 0) return [];

    const results: CandidateGame[] = [];

    // Steam catalog entries
    if (newSteamAppIds.length > 0) {
      const entries = await catalogStore.getEntries(newSteamAppIds);
      for (const entry of entries) {
        const id = `steam-${entry.appid}`;
        if (!newIdSet.has(id)) continue;
        const embedding = embeddingCache.get(id);
        const releaseStr = entry.releaseDate
          ? new Date(entry.releaseDate * 1000).toISOString().slice(0, 10)
          : '';
        results.push({
          gameId: id,
          title: entry.name,
          coverUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${entry.appid}/library_600x900.jpg`,
          headerImage: `https://cdn.akamai.steamstatic.com/steam/apps/${entry.appid}/header.jpg`,
          developer: entry.developer,
          publisher: entry.publisher,
          genres: entry.genres || [],
          themes: entry.themes || [],
          gameModes: entry.modes || [],
          perspectives: [],
          platforms: [
            ...(entry.windows ? ['Windows'] : []),
            ...(entry.mac ? ['Mac'] : []),
            ...(entry.linux ? ['Linux'] : []),
          ],
          metacriticScore: null,
          playerCount: null,
          releaseDate: releaseStr,
          similarGameTitles: [],
          reviewPositivity: entry.reviewPositivity,
          reviewVolume: entry.reviewCount,
          price: {
            isFree: entry.isFree,
            finalFormatted: entry.priceFormatted,
            discountPercent: entry.discountPercent,
          },
          semanticRetrieved: true,
          ...(embedding ? { embedding } : {}),
        });
      }
    }

    // Epic catalog entries — stream all and match by ID
    if (newEpicIds.length > 0) {
      const epicIdSet = new Set(newEpicIds.map(id => id.slice(5))); // strip "epic-" prefix
      await epicCatalogStore.getAllEntries((batch) => {
        for (const entry of batch) {
          if (!epicIdSet.has(entry.epicId)) continue;
          const id = `epic-${entry.epicId}`;
          const embedding = embeddingCache.get(id);
          const releaseStr = entry.releaseDate
            ? new Date(entry.releaseDate).toISOString().slice(0, 10)
            : '';
          results.push({
            gameId: id,
            title: entry.name,
            coverUrl: entry.coverUrl || undefined,
            developer: entry.developer,
            publisher: entry.publisher,
            genres: entry.genres || [],
            themes: entry.themes || [],
            gameModes: entry.modes || [],
            perspectives: [],
            platforms: ['Windows'],
            metacriticScore: null,
            playerCount: null,
            releaseDate: releaseStr,
            similarGameTitles: [],
            price: {
              isFree: entry.isFree,
              finalFormatted: entry.priceFormatted,
              discountPercent: entry.discountPercent,
            },
            semanticRetrieved: true,
            ...(embedding ? { embedding } : {}),
          });
        }
      });
    }

    console.log(`[RecoStore] ANN retrieval: ${nearestIds.length} queried → ${newSteamAppIds.length} Steam + ${newEpicIds.length} Epic new → ${results.length} loaded`);
    return results;
  }

  private computeEngagementWeight(ug: UserGameSnapshot): number {
    let w = 1;
    w += Math.min(ug.hoursPlayed / 20, 3);
    w += (ug.rating / 5) * 2;
    if (ug.status === 'Completed') w += 1;
    if (ug.status === 'Want to Play') w = Math.max(w, 1.5);
    return w;
  }

  /**
   * Pre-filter candidates using shelf-aware quotas so the expensive worker
   * pipeline only processes ~3K games instead of 25K+.
   *
   * Quotas ensure every shelf type can still populate:
   *  - Genre overlap (main shelves, deep-in-genre, mood, trending)
   *  - Franchise name match (complete-the-series, upcoming-sequels)
   *  - Studio match (from-studios-you-love)
   *  - High metacritic (hidden-gems, critics-choice)
   *  - Zero-genre-overlap + good reviews (stretch-picks)
   *  - Random wildcard (catches combinatorial edge cases)
   */
  private preFilterCandidates(
    candidates: CandidateGame[],
    userGames: UserGameSnapshot[],
  ): CandidateGame[] {
    const MAX_POOL = 3000;
    if (candidates.length <= MAX_POOL) return candidates;

    // Build user profile signals for scoring
    const genreWeights = new Map<string, number>();
    const devSet = new Set<string>();
    const pubSet = new Set<string>();
    const franchiseBases = new Set<string>();

    for (const ug of userGames) {
      const weight = this.computeEngagementWeight(ug);
      for (const g of ug.genres) {
        const key = g.toLowerCase();
        genreWeights.set(key, (genreWeights.get(key) ?? 0) + weight);
      }
      if (ug.developer) devSet.add(ug.developer.toLowerCase());
      if (ug.publisher) pubSet.add(ug.publisher.toLowerCase());
      // Simplified franchise base: first 2-3 significant words of the title
      const base = this.extractSimpleFranchiseBase(ug.title);
      if (base) franchiseBases.add(base);
    }

    // Score every candidate cheaply
    const scored: Array<{
      candidate: CandidateGame;
      genreScore: number;
      isFranchise: boolean;
      isStudio: boolean;
      metacritic: number;
      isStretchCandidate: boolean;
    }> = [];

    for (const c of candidates) {
      let genreScore = 0;
      let hasGenreOverlap = false;
      for (const g of c.genres) {
        const w = genreWeights.get(g.toLowerCase());
        if (w !== undefined) {
          genreScore += w;
          hasGenreOverlap = true;
        }
      }
      if (c.genres.length > 0) genreScore /= c.genres.length;

      const isFranchise = franchiseBases.has(this.extractSimpleFranchiseBase(c.title));
      const isStudio = (c.developer ? devSet.has(c.developer.toLowerCase()) : false) ||
                       (c.publisher ? pubSet.has(c.publisher.toLowerCase()) : false);
      const metacritic = c.metacriticScore ?? 0;
      const isStretchCandidate = !hasGenreOverlap &&
        (c.reviewPositivity ?? 0) >= 0.7 &&
        (c.reviewVolume ?? 0) >= 50;

      scored.push({ candidate: c, genreScore, isFranchise, isStudio, metacritic, isStretchCandidate });
    }

    // Fill quotas
    const selected = new Set<CandidateGame>();
    const QUOTA_SEMANTIC    = 500;
    const QUOTA_GENRE       = 2000;
    const QUOTA_FRANCHISE   = 300;
    const QUOTA_STUDIO      = 200;
    const QUOTA_METACRITIC  = 200;
    const QUOTA_STRETCH     = 300;
    const QUOTA_WILDCARD    = 200;

    // 0. ANN-retrieved candidates — these were found specifically because they're
    // semantically similar to the user's taste. They may have zero genre overlap
    // and would be dropped by all other quotas. Preserve them unconditionally.
    for (const s of scored) {
      if (selected.size >= QUOTA_SEMANTIC) break;
      if (s.candidate.semanticRetrieved && !selected.has(s.candidate)) {
        selected.add(s.candidate);
      }
    }

    // 1. Genre overlap — top N by engagement-weighted genre score
    scored.sort((a, b) => b.genreScore - a.genreScore);
    let count = 0;
    for (const s of scored) {
      if (count >= QUOTA_GENRE) break;
      if (s.genreScore > 0 && !selected.has(s.candidate)) {
        selected.add(s.candidate);
        count++;
      }
    }

    // 2. Franchise name match
    count = 0;
    for (const s of scored) {
      if (count >= QUOTA_FRANCHISE) break;
      if (s.isFranchise && !selected.has(s.candidate)) {
        selected.add(s.candidate);
        count++;
      }
    }

    // 3. Studio match
    count = 0;
    for (const s of scored) {
      if (count >= QUOTA_STUDIO) break;
      if (s.isStudio && !selected.has(s.candidate)) {
        selected.add(s.candidate);
        count++;
      }
    }

    // 4. High metacritic (genre-agnostic — feeds hidden gems + critics' choice)
    scored.sort((a, b) => b.metacritic - a.metacritic);
    count = 0;
    for (const s of scored) {
      if (count >= QUOTA_METACRITIC) break;
      if (s.metacritic >= 75 && !selected.has(s.candidate)) {
        selected.add(s.candidate);
        count++;
      }
    }

    // 5. Stretch picks — zero genre overlap but well-reviewed
    count = 0;
    for (const s of scored) {
      if (count >= QUOTA_STRETCH) break;
      if (s.isStretchCandidate && !selected.has(s.candidate)) {
        selected.add(s.candidate);
        count++;
      }
    }

    // 6. Random wildcard via partial Fisher-Yates shuffle (O(K) not O(K*N))
    const remaining = scored.filter(s => !selected.has(s.candidate));
    const wildcardCount = Math.min(QUOTA_WILDCARD, remaining.length);
    for (let i = 0; i < wildcardCount; i++) {
      const j = i + Math.floor(Math.random() * (remaining.length - i));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
      selected.add(remaining[i].candidate);
    }

    return [...selected];
  }

  /**
   * Simplified franchise base extraction for pre-filtering.
   * Strips trailing numbers, subtitles, and edition suffixes to get
   * a rough franchise key. Doesn't need to be as precise as the worker's
   * full detection — false positives are harmless (just increase the pool).
   */
  private extractSimpleFranchiseBase(title: string): string {
    let base = title.trim();
    // Strip parentheticals
    base = base.replace(/\s*\([^)]*\)$/g, '').trim();
    // Strip " - subtitle" and ": subtitle"
    base = base.replace(/\s*[:\-–]\s+.*$/, '').trim();
    // Strip trailing Roman/Arabic numerals
    base = base.replace(/\s+[\dIVXLCivxlc]+$/, '').trim();
    // Strip common edition suffixes
    base = base.replace(/\s+(remastered|remake|definitive|enhanced|anniversary|hd|complete|ultimate|deluxe|goty|gold|premium|special|digital|standard)(\s+edition)?$/i, '').trim();
    base = base.replace(/\s+edition$/i, '').trim();
    return base.length >= 3 ? base.toLowerCase() : '';
  }

  /**
   * Apply ML model scores to candidates via the Kaggle-trained LightGBM model.
   * Runs inference in the main process (ONNX runtime) and attaches P(recommended)
   * to each candidate for use as a scoring layer in the worker.
   */
  private async applyMLScores(
    userGames: UserGameSnapshot[],
    candidates: CandidateGame[],
  ): Promise<void> {
    if (!window.ml) return;

    try {
      const mlStatus = await window.ml.status();
      if (!mlStatus.loaded) {
        const loaded = await window.ml.load();
        if (!loaded) {
          console.warn('[RecoStore] ML model not available, skipping ML scoring');
          return;
        }
      }

      // Build user profile from library data
      const profileGames = userGames.map(ug => ({
        gameId: ug.gameId,
        hoursPlayed: ug.hoursPlayed,
        rating: ug.rating,
        status: ug.status,
      }));
      const userProfile = await window.ml.buildUserProfile(profileGames);
      if (!userProfile) return;

      // Build O(1) lookup map for candidate indices
      const idToIdx = new Map<string, number>();
      for (let i = 0; i < candidates.length; i++) {
        idToIdx.set(candidates[i].gameId, i);
      }

      // Score all candidates in batches (avoid oversized IPC messages)
      const BATCH_SIZE = 2000;
      const gameIds = candidates.map(c => c.gameId);

      for (let start = 0; start < gameIds.length; start += BATCH_SIZE) {
        const batchIds = gameIds.slice(start, start + BATCH_SIZE);
        const scores = await window.ml.scoreGames(userProfile, batchIds);

        for (const result of scores) {
          const idx = idToIdx.get(result.gameId);
          if (idx !== undefined) {
            candidates[idx].mlScore = result.score;
          }
        }
      }

      const scored = candidates.filter(c => c.mlScore != null).length;
      console.log(`[RecoStore] ML scoring: ${scored}/${candidates.length} candidates scored`);
    } catch (err) {
      console.warn('[RecoStore] ML scoring failed (non-fatal):', err);
    }
  }

  /**
   * Open the `ark-browse-cache` IndexedDB directly and read the `browse-games`
   * entry.  This is the same database the idb-cache worker writes to when the
   * user browses the catalog — it typically contains 3 000–6 000+ game objects.
   *
   * We use the 7-day stale TTL (same as the worker) so we still get candidates
   * even if the data hasn't been refreshed recently.
   */
  private loadBrowseCacheGames(): Promise<Record<string, any>[]> {
    const DB_NAME = 'ark-browse-cache';
    const DB_VERSION = 1;
    const STORE_NAME = 'data';
    const CACHE_KEY = 'browse-games';
    const STALE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
    const IDB_TIMEOUT_MS = 8000; // 8 second safety timeout

    return new Promise<Record<string, any>[]>((resolve) => {
      // Safety timeout: if IDB hangs (blocked, version conflict), resolve empty
      const timer = setTimeout(() => {
        console.warn('[RecoStore] IDB read timed out — continuing without browse cache');
        resolve([]);
      }, IDB_TIMEOUT_MS);

      const done = (result: Record<string, any>[]) => {
        clearTimeout(timer);
        resolve(result);
      };

      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        return done([]);
      }

      req.onerror = () => done([]);

      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };

      // IDB can fire 'blocked' when another connection holds a version lock
      req.onblocked = () => {
        console.warn('[RecoStore] IDB blocked by another connection');
        done([]);
      };

      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const getReq = store.get(CACHE_KEY);

          getReq.onerror = () => {
            db.close();
            done([]);
          };

          getReq.onsuccess = () => {
            db.close();
            const entry = getReq.result;
            if (!entry?.games || !Array.isArray(entry.games) || entry.games.length === 0) {
              done([]);
              return;
            }
            const age = Date.now() - (entry.timestamp ?? 0);
            if (age > STALE_TTL) {
              done([]);
              return;
            }
            done(entry.games);
          };
        } catch {
          db.close();
          done([]);
        }
      };
    });
  }

  private workerTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly WORKER_IDLE_TIMEOUT_MS = 600_000; // 10 min — large catalog pools can take several minutes

  private resetWorkerTimeout() {
    if (this.workerTimeout) clearTimeout(this.workerTimeout);
    this.workerTimeout = setTimeout(() => {
      console.error('[RecoStore] Worker idle for 10 min — killing');
      this.killWorker();
      this.state = {
        ...this.state,
        status: 'error',
        error: 'Recommendation engine stalled — try again',
      };
      this.notify();
    }, RecoStore.WORKER_IDLE_TIMEOUT_MS);
  }

  private runWorker(input: RecoWorkerInput) {
    this.killWorker();

    try {
      this.worker = new Worker(
        new URL('../workers/reco.worker.ts', import.meta.url),
        { type: 'module', name: 'Ark Oracle Worker' },
      );

      this.resetWorkerTimeout();

      this.worker.onmessage = (e: MessageEvent<RecoWorkerMessage>) => {
        const msg = e.data;

        if (msg.type === 'progress') {
          this.resetWorkerTimeout();
          this.state = {
            ...this.state,
            progress: { stage: msg.stage, percent: msg.percent },
          };
          this.notify();
          return;
        }

        if (msg.type === 'error') {
          if (this.workerTimeout) { clearTimeout(this.workerTimeout); this.workerTimeout = null; }
          console.error('[RecoStore] Worker pipeline error:', msg.error);
          this.state = {
            ...this.state,
            status: 'error',
            error: `Recommendation engine failed: ${msg.error}`,
          };
          this.notify();
          this.worker?.terminate();
          this.worker = null;
          return;
        }

        if (msg.type === 'result') {
          if (this.workerTimeout) { clearTimeout(this.workerTimeout); this.workerTimeout = null; }
          this.state = {
            ...this.state,
            status: 'done',
            progress: { stage: 'Complete', percent: 100 },
            tasteProfile: msg.tasteProfile,
            shelves: msg.shelves,
            computeTimeMs: msg.computeTimeMs,
            lastComputed: Date.now(),
          };
          this.notify();
          this.saveResultsToCache();
          this.worker?.terminate();
          this.worker = null;
        }
      };

      this.worker.onerror = (err) => {
        console.error('[RecoStore] Worker error:', err);
        if (this.workerTimeout) { clearTimeout(this.workerTimeout); this.workerTimeout = null; }
        this.state = {
          ...this.state,
          status: 'error',
          error: 'Worker failed — falling back',
        };
        this.notify();
        this.worker?.terminate();
        this.worker = null;
      };

      this.worker.postMessage(input);
    } catch (err) {
      console.error('[RecoStore] Worker creation failed:', err);
      if (this.workerTimeout) { clearTimeout(this.workerTimeout); this.workerTimeout = null; }
      this.state = {
        ...this.state,
        status: 'error',
        error: 'Could not start recommendation engine',
      };
      this.notify();
    }
  }

  /** Cleanly tear down any running worker and pending timeout. */
  private killWorker() {
    if (this.workerTimeout) {
      clearTimeout(this.workerTimeout);
      this.workerTimeout = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  /**
   * Force a recompute, even if results already exist.
   * Kills any running worker, resets state to idle, and re-runs the full
   * pipeline (embedding reload + compute). Safe to call at any time.
   */
  refresh() {
    this.killWorker();
    this.clearResultsCache();
    this.state = { ...INITIAL_STATE };
    this.notify();
    // Don't call compute() directly — let the OracleView useEffect
    // re-trigger it so embeddings are reloaded too.
    // If called outside the UI, kick it off directly as fallback.
    if (this.listeners.size === 0) {
      this.compute();
    }
  }

  /** Reset to initial state without computing. */
  reset() {
    this.killWorker();
    this.state = { ...INITIAL_STATE };
    this.notify();
  }
}

// Singleton
export const recoStore = new RecoStore();
