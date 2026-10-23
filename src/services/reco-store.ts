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
  RecoWorkerResult,
  RecoTelemetry,
  UserGameSnapshot,
  CandidateGame,
  EngagementPattern,
} from '@/types/reco';
import type { GameSession, StatusChangeEntry } from '@/types/game';
import { ORACLE_ENGINE_VERSION } from '@/services/oracle-engine-version';
import { oracleEventLog } from '@/services/oracle-event-log';
import { TELEMETRY_LAYERS } from '@/services/reco-scoring';
import { libraryStore } from './library-store';
import { customGameStore } from './custom-game-store';
import { journeyStore } from './journey-store';
import { sessionStore } from './session-store';
import { statusHistoryStore } from './status-history-store';
import { recoHistoryStore } from './reco-history-store';
import { catalogStore } from './catalog-store';
import { epicCatalogStore } from './epic-catalog-store';
import { annIndex } from './ann-index';
import { bm25Index } from './bm25-index';
import { embeddingService } from './embedding-service';
import { gameGraphStore } from './game-graph-store';
import {
  buildLexicalTasteQuery,
  getRerankBridge,
  lookupRerankTier,
  rerankPlan,
  rerankStatus,
  ORACLE_RERANK_DEFAULT_BUDGET_MS,
} from '@/services/oracle-rerank';
import type { RerankPlan, RerankStatus } from '@/services/oracle-rerank';
import { computeEngagementWeight, countEvidenceLibrary } from '@/services/engagement-weight';
import {
  buildLinkedExclusionIds,
  expandDismissedWithLinked,
  isLinkedExcluded,
} from '@/services/linked-ids';
import { expandHardNegativeIds } from '@/services/hard-negative';
import { keepAnnNeighborsUnderCeiling } from '@/services/ann-retrieve';
import { getSimilarTitlesForRecoBatch } from '@/services/similar-games';
import { canonicalFranchiseBase } from '@/services/franchise';
import {
  djb2Fingerprint,
  fingerprintDismissals,
  fingerprintThumbsUp,
  hoursPlayedBucket,
} from '@/services/oracle-signature';
import { resolveGraphScores, GRAPH_BUILD_TIMEOUT_MS } from '@/services/resolve-graph-scores';
import type { GraphScoresPack } from '@/services/resolve-graph-scores';
import type { EpicCatalogEntry } from '@/services/epic-catalog-store';

/** ANN cosine-distance ceiling for Oracle taste retrieval (Cos metric). */
const ANN_DISTANCE_CEILING = 0.45;
const ANN_MAX_KEEP = 500;
const ANN_QUERY_K = 2_000;
const QUOTA_COLD = 300;
const SURVIVOR_HYDRATE_CAP = 80;

// ─── Pre-worker time budget ──────────────────────────────────────────────────
//
// The worker has its own 10-min idle watchdog, but everything before it
// (candidate gather, Ollama embedding generation, ML load, graph restore) used
// to be unbounded — on CPU-only Ollama the embedding step alone could sit at
// "Generating semantic embeddings… 10%" for hours. The whole pre-worker phase
// now shares one overall deadline, and each optional step also has its own cap
// so one slow stage cannot starve the rest. A step that overruns resolves to
// its fallback and the pipeline proceeds with what it has.

/** Overall budget for everything before the worker is dispatched. */
export const PRE_WORKER_BUDGET_MS = 120_000;
const RESULT_CACHE_READ_TIMEOUT_MS = 10_000;
const CANDIDATE_POOL_TIMEOUT_MS = 60_000;
const OPTIONAL_SOURCE_TIMEOUT_MS = 20_000;
const SURVIVOR_HYDRATE_TIMEOUT_MS = 15_000;
const SURVIVOR_STEAM_DETAILS_TIMEOUT_MS = 5_000;
const CATALOG_ENRICH_TIMEOUT_MS = 20_000;
const EMBEDDING_GEN_TIMEOUT_MS = 90_000;
const ML_SCORING_TIMEOUT_MS = 30_000;
const GRAPH_SCORES_TIMEOUT_MS = 15_000;
/**
 * Background Oracle rerank budget for the fast tiers (native cross-encoder,
 * cosine) — shelves are already published by then. The Qwen3 tiers get a
 * longer budget and a smaller pool; see `rerankPlan` in oracle-rerank.ts.
 */
export const ORACLE_RERANK_BUDGET_MS = ORACLE_RERANK_DEFAULT_BUDGET_MS;
/** Library / thumbs-up changes coalesce into one recompute after this quiet period. */
export const LIBRARY_REFRESH_DEBOUNCE_MS = 3_000;

const EMPTY_GRAPH_PACK: GraphScoresPack = {
  graphScoresMap: undefined,
  userCommunityCounts: undefined,
  userCommunityTotal: undefined,
};

/**
 * Race `fn` against a deadline and an optional parent abort signal.
 *
 * Resolves `fallback` when the deadline passes or the parent aborts; the child
 * signal handed to `fn` is aborted at that point so cooperative work can stop
 * mutating shared state. A rejection from `fn` before the deadline propagates.
 * `timeoutMs <= 0` (budget exhausted) skips `fn` entirely.
 */
export function runWithDeadline<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  fallback: T,
  parent?: AbortSignal,
  label?: string,
): Promise<T> {
  const ac = new AbortController();
  if (parent?.aborted) {
    ac.abort();
    return Promise.resolve(fallback);
  }
  if (timeoutMs <= 0) {
    if (label) console.warn(`[RecoStore] ${label} skipped — pre-worker budget exhausted`);
    ac.abort();
    return Promise.resolve(fallback);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (apply: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
      apply();
    };
    const onAbort = () => finish(() => { ac.abort(); resolve(fallback); });
    const timer = setTimeout(() => finish(() => {
      if (label) console.warn(`[RecoStore] ${label} exceeded ${timeoutMs}ms — continuing without it`);
      ac.abort();
      resolve(fallback);
    }), timeoutMs);
    parent?.addEventListener('abort', onAbort, { once: true });
    let p: Promise<T>;
    try {
      p = fn(ac.signal);
    } catch (err) {
      finish(() => reject(err));
      return;
    }
    p.then(
      (v) => finish(() => resolve(v)),
      (err) => finish(() => reject(err)),
    );
  });
}

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

/**
 * Stable string over library + custom games + dismiss fingerprint — used for
 * Oracle invalidation and matching persisted reco cache. Includes coarse hours
 * buckets so engagement shifts invalidate restore; dismiss fp so muted franchise
 * siblings cannot resurrect from a 15‑min cache.
 */
export function buildOracleLibrarySignature(): string {
  const libLines = libraryStore
    .getAllGameIds()
    .slice()
    .sort()
    .map((id) => {
      const e = libraryStore.getEntry(id);
      const notes = e?.publicReviews ?? '';
      const hours = hoursPlayedBucket(e?.hoursPlayed);
      return `L:${id}:${e?.status ?? ''}:${e?.priority ?? ''}:${hours}:${djb2Fingerprint(notes)}`;
    });
  const customLines = customGameStore
    .getAllGames()
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => {
      const notes = e.publicReviews ?? '';
      const hours = hoursPlayedBucket(e.hoursPlayed);
      return `C:${e.id}:${e.status}:${e.priority}:${hours}:${djb2Fingerprint(notes)}`;
    });
  const dismissLine = `D:${fingerprintDismissals(recoHistoryStore.getDismissals())}`;
  const thumbsUpLine = `U:${fingerprintThumbsUp(recoHistoryStore.getThumbsUpIds())}`;
  return [...libLines, ...customLines, dismissLine, thumbsUpLine].join('\n');
}

// ─── Cached-result pipeline signature ──────────────────────────────────────────
//
// A cache restore replays only the Oracle rerank pass. BM25 retrieval, ANN
// retrieval, ML scoring and the graph signals are NOT re-run, so a restored
// session can differ from a fresh compute in ways the library signature cannot
// see. Recording which of those stages actually contributed lets the restore
// notice when the machine has since gained a signal the cached shelves never
// saw.
//
// The test is deliberately one-directional. Losing a stage (ANN not loaded yet
// this session) does not invalidate — the cached result was computed with MORE
// signal than a fresh run could produce right now, so keeping it is strictly
// better. Only a stage that is available now and was missing then forces a
// recompute. Without that asymmetry every cold start would invalidate, since
// ANN, BM25 and the graph all come up lazily after boot.

export interface OraclePipelineStages {
  bm25: boolean;
  ann: boolean;
  graph: boolean;
  ml: boolean;
}

/** Set by `applyMLScores` once the ML model has actually scored a pool. */
let _mlScoringAvailable = false;

export function currentOraclePipelineStages(): OraclePipelineStages {
  return {
    bm25: bm25Index.isReady,
    ann: annIndex.isReady,
    graph: gameGraphStore.isReady,
    ml: _mlScoringAvailable,
  };
}

/** True when the pipeline can now contribute a signal the cached result lacks. */
function pipelineGainedStages(cached: OraclePipelineStages, now: OraclePipelineStages): boolean {
  return (Object.keys(now) as Array<keyof OraclePipelineStages>).some((k) => now[k] && !cached[k]);
}

function isPipelineStages(value: unknown): value is OraclePipelineStages {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.bm25 === 'boolean' &&
    typeof v.ann === 'boolean' &&
    typeof v.graph === 'boolean' &&
    typeof v.ml === 'boolean'
  );
}

/** Per-shelf bounds for the `shown-run` outcome-log row (keeps each row a few KB). */
const SHOWN_LOG_PER_SHELF = 8;
const SHOWN_LOG_LAYERS_PER_SHELF = 3;

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
  /** Last Oracle rerank outcome plus the tier that produced it (UI transparency). */
  oracleRerankStatus: RerankStatus;
  /** Bumps when library-derived Oracle results are invalidated (UI resets pipeline). */
  invalidationGeneration: number;
  /** Per-layer coverage diagnostics from the latest worker run (dev panel); null before the first run / on cache restore. */
  telemetry: RecoTelemetry | null;
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
  oracleRerankStatus: rerankStatus('none'),
  invalidationGeneration: 0,
  telemetry: null,
};

// ─── Store ─────────────────────────────────────────────────────────────────────

/**
 * LevelDB migration constants for the Oracle result cache (v1.0.64).
 * Only a single row is stored — the cached shelves + library signature +
 * pipeline stages that let cold starts serve a warm result within TTL.
 * The row key inside the namespace is `RESULT_CACHE_ROW_KEY`.
 */
const RECO_CACHE_LEVEL_NAMESPACE = 'reco-cache';
const RECO_CACHE_ROW_KEY = 'results';
const RECO_CACHE_MIGRATION_MARKER_KEY = 'ark-oracle-results-migrated-v1';

export class RecoStore {
  private state: RecoState = { ...INITIAL_STATE };
  private listeners: Set<() => void> = new Set();
  private worker: Worker | null = null;
  /**
   * Incremented at the very start of every `compute()` and by `refresh()` /
   * `reset()`. Every await in the pipeline re-checks it, so a superseded run
   * (or its worker / background rerank) can never overwrite newer state.
   */
  private computeGeneration = 0;
  /** Bumped by invalidateCacheOnly (dismiss) — background work must not re-save older shelves. */
  private cacheEpoch = 0;
  /** Aborts the in-flight compute's pre-worker steps on refresh/reset. */
  private computeAbort: AbortController | null = null;
  /** Pending debounced `refresh()` from library / thumbs-up changes. */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  // Cold-start result caching — persists across app restarts
  private static readonly RESULT_CACHE_KEY = 'ark-oracle-results';
  private static readonly RESULT_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

  /** LevelDB gate captured lazily (deferred — reco-store has no constructor). */
  private _useLevelDBCached: boolean | null = null;
  private get _useLevelDB(): boolean {
    if (this._useLevelDBCached === null) {
      this._useLevelDBCached =
        typeof window !== 'undefined' && typeof (window as any).store !== 'undefined';
    }
    return this._useLevelDBCached;
  }

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
        librarySignature: buildOracleLibrarySignature(),
        pipelineStages: currentOraclePipelineStages(),
        engineVersion: ORACLE_ENGINE_VERSION,
      };
      if (this._useLevelDB) {
        // Fire-and-forget — same contract as the localStorage path (errors ignored).
        void (async () => {
          try {
            const res = await window.store!.put(
              RECO_CACHE_LEVEL_NAMESPACE,
              RECO_CACHE_ROW_KEY,
              cache,
            );
            if (res.error) console.error('[RecoStore] cache put failed:', res.error);
          } catch (err) {
            console.error('[RecoStore] cache put failed:', err);
          }
        })();
        return;
      }
      localStorage.setItem(RecoStore.RESULT_CACHE_KEY, JSON.stringify(cache));
    } catch {
      // localStorage full or unavailable — ignore
    }
  }

  /**
   * v1.0.64: async — reads from LevelDB when available, falls back to
   * localStorage otherwise. Also folds in the one-shot migration from
   * `ark-oracle-results` (localStorage) to the `reco-cache` LevelDB
   * namespace. Because this is a 15-minute TTL cache, preserving the
   * legacy row across upgrade is optional — but doing it avoids an
   * unnecessary Oracle recompute on the first cold start after upgrade.
   */
  private async loadResultsFromCache(): Promise<Partial<RecoState> | null> {
    try {
      let cache: any = null;
      if (this._useLevelDB) {
        const res = await window.store!.get<any>(
          RECO_CACHE_LEVEL_NAMESPACE,
          RECO_CACHE_ROW_KEY,
        );
        if (res.error) {
          console.error('[RecoStore] cache get failed, falling back:', res.error);
          const raw = localStorage.getItem(RecoStore.RESULT_CACHE_KEY);
          if (raw) cache = JSON.parse(raw);
        } else if (res.value != null) {
          cache = res.value;
        } else {
          // LevelDB row missing — attempt one-shot migration from localStorage.
          if (localStorage.getItem(RECO_CACHE_MIGRATION_MARKER_KEY) !== 'yes') {
            const raw = localStorage.getItem(RecoStore.RESULT_CACHE_KEY);
            if (raw) {
              try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                  const putRes = await window.store!.put(
                    RECO_CACHE_LEVEL_NAMESPACE,
                    RECO_CACHE_ROW_KEY,
                    parsed,
                  );
                  if (!putRes.error) {
                    localStorage.setItem(RECO_CACHE_MIGRATION_MARKER_KEY, 'yes');
                    cache = parsed;
                    console.log('[RecoStore] Migrated Oracle result cache -> LevelDB');
                  }
                } else {
                  localStorage.setItem(RECO_CACHE_MIGRATION_MARKER_KEY, 'yes');
                }
              } catch {
                localStorage.setItem(RECO_CACHE_MIGRATION_MARKER_KEY, 'yes');
              }
            } else {
              localStorage.setItem(RECO_CACHE_MIGRATION_MARKER_KEY, 'yes');
            }
          }
        }
      } else {
        const raw = localStorage.getItem(RecoStore.RESULT_CACHE_KEY);
        if (raw) cache = JSON.parse(raw);
      }
      if (!cache) return null;
      // Results from an older engine (or from before versioning existed) must not be served.
      if (cache.engineVersion !== ORACLE_ENGINE_VERSION) return null;
      if (!cache.lastComputed || Date.now() - cache.lastComputed > RecoStore.RESULT_CACHE_TTL) {
        return null;
      }
      if (!cache.shelves || cache.shelves.length === 0) return null;
      if (
        typeof cache.librarySignature !== 'string' ||
        cache.librarySignature !== buildOracleLibrarySignature()
      ) {
        return null;
      }
      if (!isPipelineStages(cache.pipelineStages)) return null;
      if (pipelineGainedStages(cache.pipelineStages, currentOraclePipelineStages())) {
        console.log('[RecoStore] Dropping cached results — pipeline gained a stage since they were computed');
        return null;
      }
      return cache;
    } catch {
      return null;
    }
  }

  private clearResultsCache() {
    try {
      if (this._useLevelDB) {
        void (async () => {
          try {
            const res = await window.store!.del(
              RECO_CACHE_LEVEL_NAMESPACE,
              RECO_CACHE_ROW_KEY,
            );
            if (res.error) console.error('[RecoStore] cache del failed:', res.error);
          } catch {
            // ignore
          }
        })();
      }
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
   *   to generate missing semantic embeddings via Ollama. Receives the user's
   *   own games only (library + journey) — candidates are never embedded
   *   inline; without a cached/catalog vector they simply score semantic 0.
   *   Should return the number of newly generated embeddings. Keeps reco-store
   *   free of circular deps on embedding-service — the caller wires them.
   *   Bounded by the pre-worker deadline; an overrun proceeds without it.
   */
  async compute(
    embeddingGenerator?: (
      games: Array<{
        id: string; title: string; genres?: string[]; themes?: string[];
        modes?: string[]; developer?: string; publisher?: string;
        playerPerspectives?: string[]; summary?: string; description?: string;
        userNotes?: string; similarGames?: Array<{ name: string }>;
      }>,
      /** Aborted when this compute is superseded or overruns its budget — stop using Ollama. */
      signal?: AbortSignal,
    ) => Promise<number>,
    catalogEmbeddingEnricher?: (candidateIds: Set<string>) => Promise<number>,
  ) {
    if (this.state.status === 'computing') return; // prevent double-fire

    // Claim the run synchronously — before any await — so a second caller
    // (splash + OracleView mount, or a refresh mid-gather) sees 'computing'
    // and bails instead of starting a parallel pipeline.
    const gen = ++this.computeGeneration;
    this.computeAbort?.abort();
    const abort = new AbortController();
    this.computeAbort = abort;
    const signal = abort.signal;
    const isStale = () => signal.aborted || gen !== this.computeGeneration;

    this.state = {
      ...this.state,
      status: 'computing',
      progress: { stage: 'Checking cached results...', percent: 1 },
      error: null,
      oracleRerankStatus: rerankStatus('none'),
    };
    this.notify();

    const setProgress = (stage: string, percent: number) => {
      if (isStale()) return;
      this.state = { ...this.state, progress: { stage, percent } };
      this.notify();
    };

    try {
      // Cold-start optimization: restore recent results from LevelDB (v1.0.64+) / localStorage.
      const cached = await runWithDeadline(
        () => this.loadResultsFromCache(),
        RESULT_CACHE_READ_TIMEOUT_MS, null, signal, 'Result-cache read',
      );
      if (isStale()) return;
      if (cached && cached.shelves && cached.shelves.length > 0) {
        console.log(`[RecoStore] Restored cached results (${cached.shelves.length} shelves, computed ${Math.round((Date.now() - (cached.lastComputed || 0)) / 1000)}s ago)`);
        const tasteProfile = (cached.tasteProfile as RecoState['tasteProfile']) ?? null;
        const shelves = cached.shelves as RecoShelf[];
        this.state = {
          ...this.state,
          status: 'done',
          progress: { stage: 'Complete (cached)', percent: 100 },
          tasteProfile,
          shelves,
          computeTimeMs: (cached.computeTimeMs as number) ?? 0,
          lastComputed: (cached.lastComputed as number) ?? Date.now(),
          libraryCount: (cached.libraryCount as number) ?? 0,
          candidateCount: (cached.candidateCount as number) ?? 0,
          oracleRerankStatus: rerankStatus('none'),
        };
        this.notify();
        // Cache restore used to skip rerank entirely. When Oracle rerank is still
        // enabled, refine shelf order in the background (cross-encoder or embed fallback).
        if (tasteProfile && shelves.length > 0) {
          void this.rerankShelvesInBackground(gen, tasteProfile, shelves, { persist: 'if-applied' });
        }
        return;
      }

      // Every step below draws from one overall budget (see PRE_WORKER_BUDGET_MS).
      const deadline = Date.now() + PRE_WORKER_BUDGET_MS;
      const budget = (capMs: number) => Math.max(0, Math.min(capMs, deadline - Date.now()));

      // 1. Build user game snapshots from library + journey
      setProgress('Building user profile...', 3);
      const userGames = this.buildUserGameSnapshots();

      // 2. Build candidate pool (from cached browse data + similar games).
      // Sources append into `poolSink` as they finish, so a deadline overrun
      // keeps whatever was gathered so far instead of dropping everything.
      setProgress('Loading candidate pool...', 5);
      const poolSink: CandidateGame[] = [];
      await runWithDeadline(
        (s) => this.buildCandidatePool(userGames, poolSink, s),
        budget(CANDIDATE_POOL_TIMEOUT_MS), poolSink, signal, 'Candidate pool',
      );
      if (isStale()) return;
      const candidates = poolSink.slice();

      // Store counts for the UI (before pre-filter, so the user sees the real pool size)
      this.state = {
        ...this.state,
        libraryCount: userGames.length,
        candidateCount: candidates.length,
      };
      this.notify();

      // 2.1. Pre-filter candidates with shelf-aware quotas (25K → ~3K)
      setProgress('Pre-filtering candidates...', 6);
      const poolSizeBefore = candidates.length;
      const filtered = this.preFilterCandidates(candidates, userGames);
      // preFilterCandidates returns the SAME array when the pool is already
      // ≤ MAX_POOL — clearing it in place would then wipe every candidate.
      if (filtered !== candidates) {
        candidates.length = 0;
        candidates.push(...filtered);
      }
      console.log(`[RecoStore] Pre-filter: ${poolSizeBefore.toLocaleString()} → ${candidates.length.toLocaleString()} candidates`);

      // 2.2. Survivor metadata hydrate — ANN neighbor titles + metacritic (F4)
      setProgress('Hydrating ANN neighbor titles + metacritic...', 7);
      await runWithDeadline(
        (s) => this.hydrateSurvivorMetadata(candidates, s),
        budget(SURVIVOR_HYDRATE_TIMEOUT_MS), undefined, signal, 'Survivor hydrate',
      );
      if (isStale()) return;

      // 2.5. Catalog embeddings first — cheap local reads that usually cover
      // most of the pool (and the user's Steam games), so Ollama generation
      // below only has to fill genuine gaps in the user's own library.
      if (catalogEmbeddingEnricher) {
        setProgress('Enriching catalog embeddings...', 9);
        const catalogIds = new Set<string>();
        for (const c of candidates) {
          if (!c.embedding && c.gameId.startsWith('steam-')) catalogIds.add(c.gameId);
        }
        for (const ug of userGames) {
          if (!ug.embedding && ug.gameId.startsWith('steam-')) catalogIds.add(ug.gameId);
        }
        if (catalogIds.size > 0) {
          const enriched = await runWithDeadline(
            () => catalogEmbeddingEnricher(catalogIds),
            budget(CATALOG_ENRICH_TIMEOUT_MS), 0, signal, 'Catalog embedding enrich',
          );
          if (isStale()) return;
          if (enriched > 0) {
            for (const ug of userGames) ug.embedding ??= embeddingCache.get(ug.gameId);
            for (const c of candidates) c.embedding ??= embeddingCache.get(c.gameId);
          }
        }
      }

      // 2.7. Generate missing semantic embeddings — user's own games only.
      // Candidates without a vector score semantic 0 this run; the background
      // catalog pipeline fills them in for next time.
      if (embeddingGenerator) {
        setProgress('Generating semantic embeddings...', 10);
        const embeddingInput = userGames.map(g => {
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
        });

        await runWithDeadline(
          (s) => embeddingGenerator(embeddingInput, s),
          budget(EMBEDDING_GEN_TIMEOUT_MS), 0, signal, 'Library embedding generation',
        );
        if (isStale()) return;

        // Re-attach unconditionally: a generation that overran the deadline may
        // still have populated part of the cache before we moved on.
        for (const ug of userGames) ug.embedding ??= embeddingCache.get(ug.gameId);
        for (const c of candidates) c.embedding ??= embeddingCache.get(c.gameId);
      }

      // 2.9. ML model scoring — Kaggle-trained LightGBM
      setProgress('ML model scoring...', 14);
      await runWithDeadline(
        (s) => this.applyMLScores(userGames, candidates, s),
        budget(ML_SCORING_TIMEOUT_MS), undefined, signal, 'ML scoring',
      );
      if (isStale()) return;

      // 3. Compute taste centroid & embedding coverage
      setProgress('Preparing scoring engine...', 16);

      // 3.5. Precompute taste centroid for the worker
      const userEmbs = userGames
        .filter(ug => ug.embedding && ug.embedding.length > 0)
        .map(ug => ({ embedding: ug.embedding!, weight: computeEngagementWeight(ug) }));
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

      // 4. Dismissed + thumbs-down ids → hard-neg franchise/dev expand → linked twins (F3)
      const linkedEntries = libraryStore.getAllEntries().map(e => ({
        gameId: e.gameId,
        secondaryGameId: e.secondaryGameId,
      }));
      const thumbsDownIds = recoHistoryStore.getThumbsDownIds();
      const thumbsUpIds = recoHistoryStore.getThumbsUpIds();
      const hardNegCatalog = candidates.map(c => ({
        gameId: c.gameId,
        title: c.title,
        developer: c.developer,
      }));
      const hardNegExpanded = expandHardNegativeIds(
        recoHistoryStore.getDismissals(),
        hardNegCatalog,
        Date.now(),
      );
      const dismissedGameIds = expandDismissedWithLinked(
        [...new Set([...hardNegExpanded, ...thumbsDownIds])],
        linkedEntries,
      );

      // 4.5. Graph metrics — prefer restore / single wait; cold build is non-blocking.
      // Only the candidate + user ids are packed (the graph can hold 100K+ nodes).
      const graphPack = await runWithDeadline(
        () => resolveGraphScores(
          userGames,
          Math.min(GRAPH_BUILD_TIMEOUT_MS, budget(GRAPH_SCORES_TIMEOUT_MS)),
          candidates.map(c => c.gameId),
        ),
        budget(GRAPH_SCORES_TIMEOUT_MS), EMPTY_GRAPH_PACK, signal, 'Graph scores',
      );
      if (isStale()) return;
      const { graphScoresMap, userCommunityCounts, userCommunityTotal, graphMaxPageRank } = graphPack;

      // 5. Dispatch to worker
      const input: RecoWorkerInput = {
        userGames,
        candidates,
        now: Date.now(),
        currentHour: new Date().getHours(),
        embeddingCoverage,
        dismissedGameIds,
        thumbsDownIds,
        thumbsUpIds,
        tasteCentroid: tasteCentroid ? Array.from(tasteCentroid) : undefined,
        precomputedSemanticScores,
        graphScores: graphScoresMap,
        graphMaxPageRank,
        userCommunityCounts,
        userCommunityTotal,
      };

      this.runWorker(input, gen);
    } catch (err) {
      if (isStale()) return;
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
        priority: libEntry?.priority,
        userNotes: libEntry?.publicReviews || undefined,
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
        priority: libEntry.priority,
        userNotes: libEntry.publicReviews || undefined,
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
  private async buildCandidatePool(
    userGames: UserGameSnapshot[],
    candidates: CandidateGame[] = [],
    signal?: AbortSignal,
  ): Promise<CandidateGame[]> {
    // Exclude library primaries + secondaryGameId twins across all sources
    const userGameIds = buildLinkedExclusionIds(
      libraryStore.getAllEntries(),
      userGames.map(g => g.gameId),
    );

    const seenIds = new Set<string>();

    // The Epic catalog used to be streamed up to three times per compute
    // (genre match, ANN hydrate, BM25 hydrate). Read it once, lazily, bounded.
    let epicMapPromise: Promise<Map<string, EpicCatalogEntry>> | null = null;
    const getEpicMap = () => {
      epicMapPromise ??= runWithDeadline(
        () => this.loadEpicCatalogMap(),
        OPTIONAL_SOURCE_TIMEOUT_MS, new Map<string, EpicCatalogEntry>(), signal, 'Epic catalog read',
      ).catch(() => new Map<string, EpicCatalogEntry>());
      return epicMapPromise;
    };

    // ── Source 1: Browse cache (existing path — 3K–6K games) ──
    let rawGames: Record<string, any>[] = [];
    try {
      rawGames = await this.loadBrowseCacheGames();
    } catch (err) {
      console.warn('[RecoStore] Failed to read browse cache for candidates:', err);
    }

    for (const g of rawGames) {
      const id = String(g.id ?? '');
      const secId = g.secondaryId ? String(g.secondaryId) : '';
      if (isLinkedExcluded(id, secId || undefined, userGameIds)) continue;
      if (isLinkedExcluded(id, secId || undefined, seenIds)) continue;
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

    if (signal?.aborted) return candidates;

    // ── Source 2: Full Steam catalog (pre-filtered to ~5–8K) ──
    const browseCount = candidates.length;
    try {
      const catalogCandidates = await this.loadCatalogCandidates(userGames, userGameIds, seenIds);
      if (signal?.aborted) return candidates;
      candidates.push(...catalogCandidates);
    } catch (err) {
      console.warn('[RecoStore] Catalog candidate loading failed (non-fatal):', err);
    }
    const catalogCount = candidates.length - browseCount;

    // ── Source 2b: Epic catalog (genre/developer match) ──
    let epicCatalogCount = 0;
    try {
      const epicCandidates = this.loadEpicCatalogCandidates(userGames, userGameIds, seenIds, await getEpicMap());
      if (signal?.aborted) return candidates;
      candidates.push(...epicCandidates);
      epicCatalogCount = epicCandidates.length;
    } catch (err) {
      console.warn('[RecoStore] Epic catalog candidate loading failed (non-fatal):', err);
    }

    // ── Source 3: ANN embedding retrieval (top 5K by taste centroid) ──
    let annCount = 0;
    try {
      if (annIndex.isReady) {
        // Own seen-set, merged only if the source finished in time: a timed-out source keeps
        // running and would otherwise mark ids as taken that never reach `candidates`.
        const annSeen = new Set(seenIds);
        let annFinished = false;
        const annCandidates = await runWithDeadline(
          async () => { const r = await this.retrieveByANN(userGames, userGameIds, annSeen, getEpicMap); annFinished = true; return r; },
          OPTIONAL_SOURCE_TIMEOUT_MS, [] as CandidateGame[], signal, 'ANN retrieval',
        );
        if (signal?.aborted) return candidates;
        if (annFinished) for (const id of annSeen) seenIds.add(id);
        candidates.push(...annCandidates);
        annCount = annCandidates.length;
      }
    } catch (err) {
      console.warn('[RecoStore] ANN retrieval failed (non-fatal):', err);
    }

    // ── Source 4: BM25 lexical retrieval (taste keywords → ~500) ──
    let bm25Count = 0;
    try {
      const bm25Seen = new Set(seenIds);
      let bm25Finished = false;
      const bm25Candidates = await runWithDeadline(
        async () => { const r = await this.retrieveByBM25(userGames, userGameIds, bm25Seen, getEpicMap); bm25Finished = true; return r; },
        OPTIONAL_SOURCE_TIMEOUT_MS, [] as CandidateGame[], signal, 'BM25 retrieval',
      );
      if (signal?.aborted) return candidates;
      if (bm25Finished) for (const id of bm25Seen) seenIds.add(id);
      candidates.push(...bm25Candidates);
      bm25Count = bm25Candidates.length;
    } catch (err) {
      console.warn('[RecoStore] BM25 retrieval failed (non-fatal):', err);
    }

    // ── Source 5: Cold-start — Top Sellers ∩ top genres when evidence < 5 (F9) ──
    let coldCount = 0;
    try {
      const cold = this.seedColdStartCandidates(userGames, rawGames, userGameIds, seenIds);
      candidates.push(...cold);
      coldCount = cold.length;
    } catch (err) {
      console.warn('[RecoStore] Cold-start seed failed (non-fatal):', err);
    }

    console.log(`[RecoStore] Candidate pool: ${candidates.length} (browse: ${browseCount}, catalog: ${catalogCount}, epicCatalog: ${epicCatalogCount}, ann: ${annCount}, bm25: ${bm25Count}, cold: ${coldCount})`);
    return candidates;
  }

  /**
   * F9: when evidence library is thin, seed Top Sellers ∩ user's top genres.
   * Pure sync over already-loaded browse cache rows (category trending / high reviews).
   */
  private seedColdStartCandidates(
    userGames: UserGameSnapshot[],
    rawGames: Record<string, any>[],
    userGameIds: Set<string>,
    seenIds: Set<string>,
  ): CandidateGame[] {
    if (countEvidenceLibrary(userGames) >= 5) return [];

    const genreWeights = new Map<string, number>();
    for (const ug of userGames) {
      const w = computeEngagementWeight(ug);
      for (const g of ug.genres) {
        const key = g.toLowerCase();
        genreWeights.set(key, (genreWeights.get(key) ?? 0) + w);
      }
    }
    const topGenres = [...genreWeights.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([g]) => g);
    // Empty genre set → admit any top-seller (brand-new library)
    const genreSet = new Set(topGenres);

    const scored = rawGames
      .map(g => {
        const id = String(g.id ?? '');
        const genres: string[] = Array.isArray(g.genre) ? g.genre : [];
        const reviews = typeof g.totalReviews === 'number' ? g.totalReviews
          : typeof g.reviewVolume === 'number' ? g.reviewVolume
          : typeof g.recommendations === 'number' ? g.recommendations
          : 0;
        const category = String(g.category ?? g.browseCategory ?? '').toLowerCase();
        const isTopSeller = category.includes('trend') || category.includes('top') || reviews >= 5000;
        const genreHit = genreSet.size === 0
          || genres.some(x => genreSet.has(String(x).toLowerCase()));
        return { g, id, reviews, isTopSeller, genreHit };
      })
      .filter(r => r.id && r.isTopSeller && r.genreHit)
      .sort((a, b) => b.reviews - a.reviews);

    const results: CandidateGame[] = [];
    for (const { g, id } of scored) {
      if (results.length >= QUOTA_COLD) break;
      const secId = g.secondaryId ? String(g.secondaryId) : '';
      if (isLinkedExcluded(id, secId || undefined, userGameIds)) continue;
      if (isLinkedExcluded(id, secId || undefined, seenIds)) continue;
      seenIds.add(id);
      if (secId) seenIds.add(secId);
      const embedding = embeddingCache.get(id);
      results.push({
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
        coldStartSeeded: true,
        ...(embedding ? { embedding } : {}),
      });
    }
    if (results.length > 0) {
      console.log(`[RecoStore] Cold-start seeded ${results.length} Top Sellers ∩ genre`);
    }
    return results;
  }

  /**
   * F4: ANN neighbor titles into similarGameTitles; Steam details for
   * metacritic/studio/comingSoon only (never recommendations.total as fake titles).
   */
  private async hydrateSurvivorMetadata(candidates: CandidateGame[], signal?: AbortSignal): Promise<void> {
    const pri = (c: CandidateGame) =>
      (c.semanticRetrieved ? 2 : 0) + (c.lexicalRetrieved ? 2 : 0) + (c.coldStartSeeded ? 1 : 0);

    // 1) ANN neighbor display titles (cap ≤ 80 survivors missing titles).
    // One batched ANN query using the in-memory vectors — this used to be 80
    // sequential lookups at ~3 IPC round-trips each.
    const needTitles = candidates
      .filter(c => c.similarGameTitles.length === 0 && embeddingCache.has(c.gameId))
      .sort((a, b) => pri(b) - pri(a))
      .slice(0, SURVIVOR_HYDRATE_CAP);

    if (needTitles.length > 0) {
      let annHydrated = 0;
      try {
        const titlesById = await getSimilarTitlesForRecoBatch(
          needTitles.map(c => ({ gameId: c.gameId, vector: embeddingCache.get(c.gameId)! })),
          6,
        );
        if (signal?.aborted) return;
        for (const c of needTitles) {
          const titles = titlesById.get(c.gameId);
          if (titles && titles.length > 0) {
            c.similarGameTitles = titles;
            annHydrated++;
          }
        }
      } catch {
        /* non-fatal */
      }
      if (annHydrated > 0) {
        console.log(`[RecoStore] Survivor ANN titles: ${annHydrated}/${needTitles.length}`);
      }
    }
    if (signal?.aborted) return;

    // 2) Steam details — metacritic / studio / comingSoon / recommendations count only
    if (typeof window === 'undefined' || !window.steam?.getMultipleAppDetails) return;

    const needSteam = candidates
      .filter(c =>
        c.gameId.startsWith('steam-')
        && (c.metacriticScore == null || !c.developer || !c.publisher || c.comingSoon == null),
      )
      .sort((a, b) => pri(b) - pri(a))
      .slice(0, SURVIVOR_HYDRATE_CAP);

    if (needSteam.length === 0) return;

    const appIds = needSteam
      .map(c => parseInt(c.gameId.slice(6), 10))
      .filter(n => !isNaN(n));
    if (appIds.length === 0) return;

    try {
      // Shares the Steam rate limiter with every other details caller — never
      // let it hold the pipeline; a late response still warms the main-process cache.
      const steam = window.steam;
      const detailsArr = await runWithDeadline(
        () => steam.getMultipleAppDetails(appIds),
        SURVIVOR_STEAM_DETAILS_TIMEOUT_MS, [], signal, 'Survivor Steam details',
      );
      if (signal?.aborted) return;
      const byApp = new Map<number, any>();
      for (const { appId, details } of detailsArr || []) {
        if (details) byApp.set(appId, details);
      }
      let hydrated = 0;
      for (const c of needSteam) {
        const appid = parseInt(c.gameId.slice(6), 10);
        const d = byApp.get(appid);
        if (!d) continue;
        if (c.metacriticScore == null && typeof d.metacritic?.score === 'number') {
          c.metacriticScore = d.metacritic.score;
        }
        const recs = d.recommendations?.total;
        if (typeof recs === 'number' && c.recommendations == null) {
          c.recommendations = recs;
        }
        if (d.release_date?.coming_soon === true) c.comingSoon = true;
        if (!c.developer && d.developers?.[0]) c.developer = d.developers[0];
        if (!c.publisher && d.publishers?.[0]) c.publisher = d.publishers[0];
        hydrated++;
      }
      if (hydrated > 0) {
        console.log(`[RecoStore] Survivor Steam meta: ${hydrated}/${needSteam.length} enriched`);
      }
    } catch (err) {
      console.warn('[RecoStore] Survivor hydrate failed (non-fatal):', err);
    }
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
      maxPopularQuota: 200,
    });

    const results: CandidateGame[] = [];
    for (const entry of catalogEntries) {
      const id = `steam-${entry.appid}`;
      if (isLinkedExcluded(id, undefined, seenIds)) continue;
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
  private loadEpicCatalogCandidates(
    userGames: UserGameSnapshot[],
    userGameIds: Set<string>,
    seenIds: Set<string>,
    epicMap: Map<string, EpicCatalogEntry>,
  ): CandidateGame[] {
    if (epicMap.size === 0) return [];

    const genreSet = new Set<string>();
    const devSet = new Set<string>();
    for (const ug of userGames) {
      for (const g of ug.genres) genreSet.add(g.toLowerCase());
      if (ug.developer && ug.rating >= 3.5) devSet.add(ug.developer.toLowerCase());
    }

    const results: CandidateGame[] = [];
    for (const entry of epicMap.values()) {
      const id = `epic-${entry.epicId}`;
      if (isLinkedExcluded(id, undefined, userGameIds) || isLinkedExcluded(id, undefined, seenIds)) continue;

      const hasGenreMatch = entry.genres.some(g => genreSet.has(g.toLowerCase()));
      const hasDevMatch = entry.developer && devSet.has(entry.developer.toLowerCase());
      if (!hasGenreMatch && !hasDevMatch) continue;

      seenIds.add(id);
      results.push(this.epicEntryToCandidate(entry));
    }

    console.log(`[RecoStore] Epic catalog pre-filter: ${epicMap.size} total → ${results.length} matched`);
    return results;
  }

  /** Stream the Epic catalog once per compute into an epicId-keyed map. */
  private async loadEpicCatalogMap(): Promise<Map<string, EpicCatalogEntry>> {
    const map = new Map<string, EpicCatalogEntry>();
    const entryCount = await epicCatalogStore.getEntryCount();
    if (entryCount === 0) return map;
    await epicCatalogStore.getAllEntries((batch) => {
      for (const entry of batch) map.set(entry.epicId, entry);
    });
    return map;
  }

  private epicEntryToCandidate(entry: EpicCatalogEntry, extra?: Partial<CandidateGame>): CandidateGame {
    const id = `epic-${entry.epicId}`;
    const embedding = embeddingCache.get(id);
    const releaseStr = entry.releaseDate
      ? new Date(entry.releaseDate).toISOString().slice(0, 10)
      : '';
    return {
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
      ...extra,
      ...(embedding ? { embedding } : {}),
    };
  }

  /**
   * Retrieve semantically similar games from the ANN index using a
   * weighted taste centroid derived from the user's library embeddings.
   */
  private async retrieveByANN(
    userGames: UserGameSnapshot[],
    userGameIds: Set<string>,
    seenIds: Set<string>,
    getEpicMap: () => Promise<Map<string, EpicCatalogEntry>>,
  ): Promise<CandidateGame[]> {
    const userEmbs = userGames
      .filter(ug => ug.embedding && ug.embedding.length > 0)
      .map(ug => ({
        embedding: ug.embedding!,
        weight: computeEngagementWeight(ug),
      }));

    const centroid = embeddingService.computeTasteCentroid(userEmbs);
    if (!centroid) return [];

    const neighbors = await annIndex.queryWithDistances(centroid, ANN_QUERY_K);
    // Hard ceiling only — no soft fallback to far neighbors when under-ceiling is empty
    const kept = keepAnnNeighborsUnderCeiling(neighbors, ANN_DISTANCE_CEILING, ANN_MAX_KEEP);
    const distanceById = new Map(kept.map(n => [n.id, n.distance]));

    const newSteamAppIds: number[] = [];
    const newEpicIds: string[] = [];
    const newIdSet = new Set<string>();
    for (const { id } of kept) {
      if (isLinkedExcluded(id, undefined, userGameIds) || isLinkedExcluded(id, undefined, seenIds)) continue;
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
          annDistance: distanceById.get(id),
          ...(embedding ? { embedding } : {}),
        });
      }
    }

    // Epic catalog entries — looked up in the once-per-compute Epic map
    if (newEpicIds.length > 0) {
      const epicMap = await getEpicMap();
      for (const id of newEpicIds) {
        const entry = epicMap.get(id.slice(5)); // strip "epic-" prefix
        if (!entry) continue;
        results.push(this.epicEntryToCandidate(entry, {
          semanticRetrieved: true,
          annDistance: distanceById.get(id),
        }));
      }
    }

    console.log(`[RecoStore] ANN retrieval: ${neighbors.length} queried → ${kept.length} kept (ceiling ${ANN_DISTANCE_CEILING} / top ${ANN_MAX_KEEP}) → ${results.length} loaded`);
    return results;
  }

  /**
   * Lexical BM25 retrieval via MiniSearch — covers title/tag exactness ANN misses.
   * Builds a keyword taste query from library signals (no worker taste profile yet).
   */
  private async retrieveByBM25(
    userGames: UserGameSnapshot[],
    userGameIds: Set<string>,
    seenIds: Set<string>,
    getEpicMap: () => Promise<Map<string, EpicCatalogEntry>>,
  ): Promise<CandidateGame[]> {
    // Never build/load MiniSearch inline — a cold build indexes the whole
    // catalog. Use the index only when it is already in memory, and let the
    // idle scheduler load / refresh it (generation check included) for next run.
    bm25Index.scheduleIdleRebuild();
    if (!bm25Index.isReady) {
      console.log('[RecoStore] BM25 index not ready — skipping lexical retrieval this run');
      return [];
    }

    const lexicalQuery = this.buildLexicalQueryFromLibrary(userGames);
    if (!lexicalQuery) return [];

    const TOP_K = 500;
    const hits = bm25Index.search(lexicalQuery, TOP_K);
    if (hits.length === 0) return [];

    const newSteamAppIds: number[] = [];
    const newEpicIds: string[] = [];
    const newIdSet = new Set<string>();
    for (const { id } of hits) {
      if (isLinkedExcluded(id, undefined, userGameIds) || isLinkedExcluded(id, undefined, seenIds)) continue;
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
          lexicalRetrieved: true,
          ...(embedding ? { embedding } : {}),
        });
      }
    }

    if (newEpicIds.length > 0) {
      const epicMap = await getEpicMap();
      for (const id of newEpicIds) {
        const entry = epicMap.get(id.slice(5));
        if (!entry) continue;
        results.push(this.epicEntryToCandidate(entry, { lexicalRetrieved: true }));
      }
    }

    console.log(
      `[RecoStore] BM25 retrieval: query="${lexicalQuery.slice(0, 80)}…" → ${hits.length} hits → ${results.length} new candidates`,
    );
    return results;
  }

  /** Lightweight taste profile + loved titles for BM25 (pre-worker). */
  private buildLexicalQueryFromLibrary(userGames: UserGameSnapshot[]): string {
    const genreCounts = new Map<string, { weight: number; hours: number; ratingSum: number; n: number }>();
    const themeCounts = new Map<string, { weight: number; hours: number; ratingSum: number; n: number }>();
    const devCounts = new Map<string, number>();
    const pubCounts = new Map<string, number>();
    const lovedTitles: string[] = [];

    for (const ug of userGames) {
      const eng = computeEngagementWeight(ug);
      for (const g of ug.genres) {
        const cur = genreCounts.get(g) ?? { weight: 0, hours: 0, ratingSum: 0, n: 0 };
        cur.weight += eng;
        cur.hours += ug.hoursPlayed;
        cur.ratingSum += ug.rating;
        cur.n += 1;
        genreCounts.set(g, cur);
      }
      for (const t of ug.themes) {
        const cur = themeCounts.get(t) ?? { weight: 0, hours: 0, ratingSum: 0, n: 0 };
        cur.weight += eng;
        cur.hours += ug.hoursPlayed;
        cur.ratingSum += ug.rating;
        cur.n += 1;
        themeCounts.set(t, cur);
      }
      if (ug.developer && (ug.rating >= 3.5 || ug.hoursPlayed >= 20)) {
        devCounts.set(ug.developer, (devCounts.get(ug.developer) || 0) + 1);
      }
      if (ug.publisher && (ug.rating >= 3.5 || ug.hoursPlayed >= 20)) {
        pubCounts.set(ug.publisher, (pubCounts.get(ug.publisher) || 0) + 1);
      }
      if (ug.rating >= 4 || ug.status === 'Completed' || ug.hoursPlayed >= 20) {
        lovedTitles.push(ug.title);
      }
    }

    const genres = [...genreCounts.entries()]
      .sort((a, b) => b[1].weight - a[1].weight)
      .slice(0, 10)
      .map(([name, s]) => ({
        name,
        weight: s.weight,
        gameCount: s.n,
        totalHours: s.hours,
        avgRating: s.n > 0 ? s.ratingSum / s.n : 0,
      }));
    const themes = [...themeCounts.entries()]
      .sort((a, b) => b[1].weight - a[1].weight)
      .slice(0, 8)
      .map(([name, s]) => ({
        name,
        weight: s.weight,
        gameCount: s.n,
        totalHours: s.hours,
        avgRating: s.n > 0 ? s.ratingSum / s.n : 0,
      }));
    const loyalDevelopers = [...devCounts.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([d]) => d);
    // Single-game studios still useful for BM25 if highly rated
    if (loyalDevelopers.length < 4) {
      for (const [d] of [...devCounts.entries()].sort((a, b) => b[1] - a[1])) {
        if (loyalDevelopers.includes(d)) continue;
        loyalDevelopers.push(d);
        if (loyalDevelopers.length >= 6) break;
      }
    }
    const loyalPublishers = [...pubCounts.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([p]) => p);

    const profile: TasteProfile = {
      genres,
      themes,
      gameModes: [],
      perspectives: [],
      developers: [],
      publishers: [],
      eras: [],
      totalGames: userGames.length,
      totalHours: userGames.reduce((s, g) => s + g.hoursPlayed, 0),
      avgRating: 0,
      topGenre: genres[0]?.name ?? '',
      topTheme: themes[0]?.name ?? '',
      clusters: [],
      loyalDevelopers,
      loyalPublishers,
    };

    return buildLexicalTasteQuery(profile, { lovedTitles });
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
      const weight = computeEngagementWeight(ug);
      for (const g of ug.genres) {
        const key = g.toLowerCase();
        genreWeights.set(key, (genreWeights.get(key) ?? 0) + weight);
      }
      if (ug.developer) devSet.add(ug.developer.toLowerCase());
      if (ug.publisher) pubSet.add(ug.publisher.toLowerCase());
      const base = canonicalFranchiseBase(ug.title);
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

      const isFranchise = franchiseBases.has(canonicalFranchiseBase(c.title));
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
    const QUOTA_LEXICAL     = 400;
    const QUOTA_COLD_KEEP   = QUOTA_COLD;
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

    // 0b. BM25 lexical hits — title/tag exactness ANN can miss. Keep a dedicated
    // quota so popular-flood / genre fill does not starve them.
    let lexicalCount = 0;
    for (const s of scored) {
      if (lexicalCount >= QUOTA_LEXICAL) break;
      if (s.candidate.lexicalRetrieved && !selected.has(s.candidate)) {
        selected.add(s.candidate);
        lexicalCount++;
      }
    }

    // 0c. Cold-start Top Sellers ∩ genre seeds (F9)
    let coldCount = 0;
    for (const s of scored) {
      if (coldCount >= QUOTA_COLD_KEEP) break;
      if (s.candidate.coldStartSeeded && !selected.has(s.candidate)) {
        selected.add(s.candidate);
        coldCount++;
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
   * Apply ML model scores to candidates via the Kaggle-trained LightGBM model.
   * Runs inference in the main process (ONNX runtime) and attaches P(recommended)
   * to each candidate for use as a scoring layer in the worker.
   */
  private async applyMLScores(
    userGames: UserGameSnapshot[],
    candidates: CandidateGame[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (!window.ml) return;

    try {
      const profileGames = userGames.map(ug => ({
        gameId: ug.gameId,
        hoursPlayed: ug.hoursPlayed,
        rating: ug.rating,
        status: ug.status,
      }));

      // Only score with a real Steam-backed profile — no default/empty ML noise
      const hasSteam = window.ml.hasRealSteamProfile
        ? await window.ml.hasRealSteamProfile(profileGames)
        : profileGames.filter(g => g.gameId.startsWith('steam-')).length >= 3
          && profileGames.some(g =>
            g.gameId.startsWith('steam-')
            && (g.hoursPlayed > 0 || g.rating > 0 || g.status === 'Completed'
              || g.status === 'Playing' || g.status === 'Playing Now'));
      if (!hasSteam) {
        console.log('[RecoStore] ML scoring skipped — no real Steam profile');
        return;
      }

      const mlStatus = await window.ml.status();
      if (!mlStatus.loaded) {
        const loaded = await window.ml.load();
        if (!loaded) {
          console.warn('[RecoStore] ML model not available, skipping ML scoring');
          return;
        }
      }

      const userProfile = await window.ml.buildUserProfile(profileGames);
      if (!userProfile) return;

      const idToIdx = new Map<string, number>();
      for (let i = 0; i < candidates.length; i++) {
        idToIdx.set(candidates[i].gameId, i);
      }

      const BATCH_SIZE = 2000;
      const gameIds = candidates.map(c => c.gameId);

      for (let start = 0; start < gameIds.length; start += BATCH_SIZE) {
        // Deadline passed — stop mutating candidates the pipeline has moved on with.
        if (signal?.aborted) return;
        const batchIds = gameIds.slice(start, start + BATCH_SIZE);
        const scores = await window.ml.scoreGames(userProfile, batchIds);
        if (signal?.aborted) return;

        for (const result of scores) {
          // scoreGames only returns real Kaggle-profile titles (no 0.5 placeholders)
          if (result.score == null || !Number.isFinite(result.score)) continue;
          const idx = idToIdx.get(result.gameId);
          if (idx !== undefined) {
            candidates[idx].mlScore = result.score;
          }
        }
      }

      const scored = candidates.filter(c => c.mlScore != null).length;
      if (scored > 0) _mlScoringAvailable = true;
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

  /**
   * Shared settings + applyOracleRerankShelves path.
   * Used after worker completion and after localStorage cache restore.
   */
  private async prepareOracleRerank(): Promise<{ skip: RerankStatus } | { blend: number; plan: RerankPlan }> {
    let settings: {
      oracleRerankEnabled?: boolean;
      oracleRerankBlend?: number;
    } | null = null;
    if (typeof window !== 'undefined' && window.settings?.getOllamaSettings) {
      settings = await window.settings.getOllamaSettings();
    }
    const enabled = settings?.oracleRerankEnabled !== false;
    const blend =
      typeof settings?.oracleRerankBlend === 'number' && Number.isFinite(settings.oracleRerankBlend)
        ? Math.min(1, Math.max(0, settings.oracleRerankBlend))
        : 1;

    const bridge = getRerankBridge();
    if (!(bridge && enabled && blend > 0)) {
      if (!enabled) return { skip: rerankStatus('skipped_disabled') };
      if (blend <= 0) return { skip: rerankStatus('skipped_blend_zero') };
      return { skip: rerankStatus('skipped_no_client') };
    }
    // Tier-aware budget: a Qwen3 pass costs one generate call per document,
    // so it gets a smaller pool and a longer deadline (shelves are on screen).
    const tier = await lookupRerankTier(bridge);
    return { blend, plan: rerankPlan('oracle', tier) };
  }

  /**
   * Shared applyOracleRerankShelves path, bounded by the plan's budget. The
   * deadline's abort signal is passed through so the main-process loop is
   * cancelled when the budget runs out. Resolves null on timeout.
   */
  private async runOracleRerankPass(
    tasteProfile: TasteProfile,
    shelves: RecoShelf[],
    blend: number,
    plan: RerankPlan,
  ): Promise<{ shelves: RecoShelf[]; status: RerankStatus } | null> {
    const { applyOracleRerankShelves } = await import('@/services/oracle-rerank');
    return runWithDeadline(
      (signal) => applyOracleRerankShelves(tasteProfile, shelves, { enabled: true, blend, plan, signal }),
      plan.budgetMs, null, undefined, 'Oracle rerank',
    );
  }

  /**
   * Refine the published shelf order with the Oracle rerank pass, in the
   * background. Shelves are already on screen (status 'done') when this runs;
   * the main-process rerank cascade can take minutes on CPU, so it gets a
   * tier-aware budget (`rerankPlan`: 15 s for native / cosine, 60 s and a
   * 40-game pool for Qwen3) and the worker order simply stays when it overruns.
   * On overrun the main-process loop is cancelled, not left running.
   *
   * Used after worker completion and after cache restore. The cache-restore
   * path replays only this pass; the heavier retrieval and scoring stages are
   * not re-run, which is safe because `loadResultsFromCache` already refused
   * the cache if any of them became available since it was written.
   */
  private async rerankShelvesInBackground(
    genAtStart: number,
    tasteProfile: TasteProfile,
    shelves: RecoShelf[],
    opts: { persist: 'if-applied' | 'never' },
  ) {
    const cacheEpochAtStart = this.cacheEpoch;
    const isCurrent = () =>
      genAtStart === this.computeGeneration
      && this.state.status === 'done'
      && this.state.shelves === shelves;
    try {
      const prep = await this.prepareOracleRerank();
      if (!isCurrent()) return;
      const out = 'skip' in prep
        ? { shelves, status: prep.skip }
        : await this.runOracleRerankPass(tasteProfile, shelves, prep.blend, prep.plan);
      if (!isCurrent()) return;
      if (!out) {
        this.state = { ...this.state, oracleRerankStatus: rerankStatus('skipped_timeout') };
        this.notify();
        return;
      }
      this.state = {
        ...this.state,
        shelves: out.shelves,
        oracleRerankStatus: out.status,
      };
      this.notify();
      // Persist refined order so the next cold start benefits.
      // Not after a dismiss invalidated the cache meanwhile — that would re-cache the dismissed game.
      if (opts.persist === 'if-applied' && out.status.outcome === 'applied' && this.cacheEpoch === cacheEpochAtStart) {
        this.saveResultsToCache();
      }
    } catch (e) {
      console.warn('[RecoStore] Oracle rerank skipped:', e);
      if (!isCurrent()) return;
      this.state = { ...this.state, oracleRerankStatus: rerankStatus('error') };
      this.notify();
    }
  }

  /**
   * Publish the worker's shelves immediately, then refine their order with
   * the Oracle rerank in the background (bounded by ORACLE_RERANK_BUDGET_MS).
   * Rerank used to run here with status still 'computing' and no timeout,
   * which is what kept Oracle parked at 92% for minutes.
   */
  private finishWorkerResult(msg: RecoWorkerResult, runId: number) {
    if (runId !== this.computeGeneration) return;

    this.state = {
      ...this.state,
      status: 'done',
      progress: { stage: 'Complete', percent: 100 },
      tasteProfile: msg.tasteProfile,
      shelves: msg.shelves,
      computeTimeMs: msg.computeTimeMs,
      lastComputed: Date.now(),
      oracleRerankStatus: rerankStatus('none'),
      telemetry: msg.telemetry ?? null,
    };
    this.notify();
    this.saveResultsToCache();
    this.logShownRun(runId, msg.shelves);

    if (msg.tasteProfile && msg.shelves.length > 0) {
      void this.rerankShelvesInBackground(runId, msg.tasteProfile, msg.shelves, { persist: 'if-applied' });
    }
  }

  /**
   * Record what this compute put on screen (one compact row per run) so
   * outcomes can later be evaluated against exposure. `layers` follows
   * TELEMETRY_LAYERS order. Diagnostic only — never throws.
   */
  private logShownRun(runId: number, shelves: RecoShelf[]) {
    try {
      // Bounded: only the first SHOWN_LOG_PER_SHELF games per shelf (what's visible without
      // scrolling far), with the full layer breakdown for the first SHOWN_LOG_LAYERS_PER_SHELF.
      const items: Array<{ id: string; shelf: string; pos: number; score: number; layers?: number[] }> = [];
      for (const shelf of shelves) {
        shelf.games.slice(0, SHOWN_LOG_PER_SHELF).forEach((g, pos) => {
          const ls = g.layerScores as unknown as Record<string, number>;
          items.push({
            id: g.gameId,
            shelf: shelf.type,
            pos,
            score: Math.round(g.score * 10_000) / 10_000,
            ...(pos < SHOWN_LOG_LAYERS_PER_SHELF
              ? { layers: TELEMETRY_LAYERS.map(k => Math.round((ls[k] ?? 0) * 1_000) / 1_000) }
              : {}),
          });
        });
      }
      oracleEventLog.record({
        type: 'shown-run',
        data: { runId, engineVersion: ORACLE_ENGINE_VERSION, layerOrder: TELEMETRY_LAYERS, items },
      });
    } catch {
      /* diagnostic only */
    }
  }

  private runWorker(input: RecoWorkerInput, runId: number) {
    this.killWorker();
    if (runId !== this.computeGeneration) return;

    try {
      this.worker = new Worker(
        new URL('../workers/reco.worker.ts', import.meta.url),
        { type: 'module', name: 'Ark Oracle Worker' },
      );

      this.resetWorkerTimeout();

      this.worker.onmessage = (e: MessageEvent<RecoWorkerMessage>) => {
        if (runId !== this.computeGeneration) return;
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
          this.worker?.terminate();
          this.worker = null;
          this.finishWorkerResult(msg, runId);
        }
      };

      this.worker.onerror = (err) => {
        if (runId !== this.computeGeneration) return;
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
   * Supersede whatever compute is in flight: bump the generation (every await
   * in compute / worker callbacks / background rerank re-checks it) and abort
   * its pre-worker steps so they stop waiting on Ollama / IPC.
   */
  private abortInFlightCompute() {
    this.computeGeneration++;
    this.computeAbort?.abort();
    this.computeAbort = null;
  }

  private cancelScheduledRefresh() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Drop persisted Oracle result cache without kicking a full recompute.
   * Used after dismiss so a 15‑min restore cannot resurrect muted franchise siblings.
   */
  invalidateCacheOnly() {
    this.cacheEpoch++; // a background rerank still in flight must not re-save the old shelves
    this.clearResultsCache();
  }

  /**
   * Coalesce bursts of invalidations (library notifies, several thumbs-ups in
   * a row) into one `refresh()` after a quiet period.
   */
  scheduleRefresh(delayMs: number = LIBRARY_REFRESH_DEBOUNCE_MS) {
    this.cancelScheduledRefresh();
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, delayMs);
  }

  /**
   * Force a recompute, even if results already exist.
   * Aborts any in-flight compute (pre-worker steps, worker and background
   * rerank), resets status to idle and re-runs the full pipeline (embedding
   * reload + compute). Safe to call at any time.
   *
   * Stale-while-revalidate: the previous shelves / taste profile stay in state
   * while the next compute runs, so the UI keeps showing them instead of
   * blanking to a skeleton on every library change.
   */
  refresh() {
    this.cancelScheduledRefresh();
    this.abortInFlightCompute();
    this.killWorker();
    this.clearResultsCache();
    const prev = this.state;
    this.state = {
      ...INITIAL_STATE,
      tasteProfile: prev.tasteProfile,
      shelves: prev.shelves,
      computeTimeMs: prev.computeTimeMs,
      lastComputed: prev.lastComputed,
      libraryCount: prev.libraryCount,
      candidateCount: prev.candidateCount,
      oracleRerankStatus: prev.oracleRerankStatus,
      invalidationGeneration: prev.invalidationGeneration + 1,
    };
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
    this.cancelScheduledRefresh();
    this.abortInFlightCompute();
    this.killWorker();
    this.state = { ...INITIAL_STATE };
    this.notify();
  }
}

// Singleton
export const recoStore = new RecoStore();

// ── Invalidate Oracle reco when library/custom data used by reco changes ──
// v1.0.41 audit: subscribe via libraryStore.subscribe (the non-hours channel),
// NOT libraryStore.subscribeHours — 15s session ticks must not full-recompute.
// Signature includes log-scale hours buckets + dismiss fingerprint so a later
// cache restore still fails when engagement or mutes changed. Library notify
// bursts (Steam sync, bulk edits) coalesce over LIBRARY_REFRESH_DEBOUNCE_MS.

let oracleLibrarySnapBaseline: string | null = null;
let oracleLibraryInvalidateTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleOracleInvalidateOnLibraryChange() {
  if (typeof window === 'undefined') return;
  if (oracleLibraryInvalidateTimer) clearTimeout(oracleLibraryInvalidateTimer);
  oracleLibraryInvalidateTimer = setTimeout(() => {
    oracleLibraryInvalidateTimer = null;
    const snap = buildOracleLibrarySignature();
    if (oracleLibrarySnapBaseline === null) {
      oracleLibrarySnapBaseline = snap;
      return;
    }
    if (snap === oracleLibrarySnapBaseline) return;
    oracleLibrarySnapBaseline = snap;
    recoStore.refresh();
  }, LIBRARY_REFRESH_DEBOUNCE_MS);
}

if (typeof window !== 'undefined') {
  // Non-hours channel only — see v1.0.41 audit note above.
  libraryStore.subscribe(scheduleOracleInvalidateOnLibraryChange);
  customGameStore.subscribe(scheduleOracleInvalidateOnLibraryChange);
}
