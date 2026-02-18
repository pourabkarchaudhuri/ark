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

// ─── Embedding cache (populated externally by embedding-service) ────────────

let embeddingCache: Map<string, number[]> = new Map();

/** Called by the embedding service to inject cached vectors. */
export function setEmbeddingCache(cache: Map<string, number[]>) {
  embeddingCache = cache;
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
      games: Array<{ id: string; title: string; genres?: string[]; themes?: string[]; developer?: string }>,
    ) => Promise<number>,
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
      const userGames = this.buildUserGameSnapshots();

      // 2. Build candidate pool (from cached browse data + similar games)
      const candidates = await this.buildCandidatePool(userGames);

      // Store counts for the UI
      this.state = {
        ...this.state,
        libraryCount: userGames.length,
        candidateCount: candidates.length,
      };
      this.notify();

      // 2.5. Generate missing semantic embeddings if a generator was provided
      if (embeddingGenerator) {
        this.state = {
          ...this.state,
          progress: { stage: 'Generating semantic embeddings...', percent: 10 },
        };
        this.notify();

        const embeddingInput = [
          ...userGames.map(g => ({
            id: g.gameId, title: g.title, genres: g.genres,
            themes: g.themes, developer: g.developer,
          })),
          ...candidates.map(g => ({
            id: g.gameId, title: g.title, genres: g.genres,
            themes: g.themes, developer: g.developer,
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

      // 3. Check if we have any embeddings available
      const hasEmbeddings = embeddingCache.size > 0;

      // 4. Get dismissed game IDs
      const dismissedGameIds = recoHistoryStore.getDismissedIds();

      // 5. Dispatch to worker
      const input: RecoWorkerInput = {
        userGames,
        candidates,
        now: Date.now(),
        currentHour: new Date().getHours(),
        hasEmbeddings,
        dismissedGameIds,
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
    const userGameIds = new Set(userGames.map(g => g.gameId));
    const candidates: CandidateGame[] = [];
    const seenIds = new Set<string>();

    // Read raw game array from the browse-cache IDB
    let rawGames: Record<string, any>[] = [];
    try {
      rawGames = await this.loadBrowseCacheGames();
    } catch (err) {
      console.warn('[RecoStore] Failed to read browse cache for candidates:', err);
    }

    for (const g of rawGames) {
      const id = String(g.id ?? '');
      if (!id || userGameIds.has(id) || seenIds.has(id)) continue;
      seenIds.add(id);

      // Attach embedding if available
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
        // v3: review sentiment
        reviewPositivity: typeof g.reviewPositivity === 'number' ? g.reviewPositivity
          : (typeof g.totalPositive === 'number' && typeof g.totalReviews === 'number' && g.totalReviews > 0)
            ? g.totalPositive / g.totalReviews
            : undefined,
        reviewVolume: typeof g.reviewVolume === 'number' ? g.reviewVolume
          : typeof g.totalReviews === 'number' ? g.totalReviews
          : undefined,
        // v3: price info
        price: g.price ? {
          isFree: g.price.isFree === true || g.price.final === 0,
          finalFormatted: g.price.finalFormatted || undefined,
          discountPercent: typeof g.price.discountPercent === 'number' ? g.price.discountPercent : undefined,
        } : (g.isFree === true ? { isFree: true } : undefined),
        ...(embedding ? { embedding } : {}),
      });
    }

    return candidates;
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
  private static readonly WORKER_TIMEOUT_MS = 60_000; // 60s safety net

  private runWorker(input: RecoWorkerInput) {
    // Terminate any existing worker + clear stale timeout
    this.killWorker();

    try {
      this.worker = new Worker(
        new URL('../workers/reco.worker.ts', import.meta.url),
        { type: 'module', name: 'Ark Oracle Worker' },
      );

      // Safety timeout: if the worker hangs for 60s, kill it and error out
      this.workerTimeout = setTimeout(() => {
        console.error('[RecoStore] Worker timed out after 60s');
        this.killWorker();
        this.state = {
          ...this.state,
          status: 'error',
          error: 'Recommendation engine timed out — try again',
        };
        this.notify();
      }, RecoStore.WORKER_TIMEOUT_MS);

      this.worker.onmessage = (e: MessageEvent<RecoWorkerMessage>) => {
        const msg = e.data;

        if (msg.type === 'progress') {
          this.state = {
            ...this.state,
            progress: { stage: msg.stage, percent: msg.percent },
          };
          this.notify();
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
