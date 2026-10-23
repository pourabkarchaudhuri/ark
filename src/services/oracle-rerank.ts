/**
 * Ollama /api/rerank pass for Oracle shelves — refines ordering after the reco worker.
 */

import type { TasteProfile, RecoShelf, ScoredGame } from '@/types/reco';

/**
 * Unique games sent per rerank call. Matches `RERANK_MAX_DOCS` in
 * electron/ipc/ollama-handlers.ts — the IPC truncates anything past 100, so a
 * bigger pool only built documents that were never scored.
 */
export const ORACLE_RERANK_POOL = 100;

/**
 * Shelves whose order is taste order (the hero shelf is a single game, so there is nothing to reorder). Everything else keeps the worker's order: Stretch Picks are
 * deliberately far-from-taste-first, Trending is popularity, Critics' Choice is Metacritic, Deals is
 * discount, Hidden Gems/Free/New Releases are catalogue picks, mood/cluster shelves have their own
 * seed, Complete the Series is release order, and Backlog/Unfinished are the user's own games. A
 * taste-query reranker would silently undo those intents.
 */
export const RERANKABLE_SHELF_TYPES: ReadonlySet<string> = new Set([
  'because-you-loved',
  'deep-in-genre',
  'from-studios-you-love',
]);

/** Default share of the final order that comes from the reranker (the rest is the worker's score). */
export const DEFAULT_ORACLE_RERANK_BLEND = 0.6;
/** A yes/no (qwen_binary) pass is coarse: it may only nudge. */
export const QWEN_BINARY_MAX_BLEND = 0.3;
/** Even at "100%" the worker's own score keeps some say: a cross-encoder reads a taste summary, not the whole profile. */
export const ORACLE_RERANK_MAX_BLEND = 0.85;

/**
 * Which reranker tier produced an ordering.
 * Mirrors `RerankTier` in electron/rerank-engine.ts — keep the two in sync.
 */
export type RerankTier = 'native' | 'qwen_graded' | 'qwen_binary' | 'embed_fallback';

/** What happened to a rerank attempt, independent of which tier ran. */
export type RerankOutcome =
  | 'none'
  | 'applied'
  | 'skipped_disabled'
  | 'skipped_no_client'
  | 'skipped_blend_zero'
  | 'skipped_empty_pool'
  /** Rerank overran its renderer-side budget; shelves keep the worker order. */
  | 'skipped_timeout'
  | 'empty_results'
  /**
   * Every scored document got the same score (e.g. a yes/no Qwen3 pass that
   * answered "no" to everything). The "ordering" is just the input order, so
   * it is not applied and not reported as a successful rerank.
   */
  | 'no_signal'
  /**
   * The tier that ran is too weak to reorder shelves (cosine fallback): its order is the embedding
   * cosine the worker already used, so applying it would only re-sort by a worse copy of the signal.
   */
  | 'skipped_degraded_tier'
  | 'error';

/**
 * One status type shared by the Oracle shelf pass and the Embedding Space
 * neighbor pass.
 *
 * The tier is what makes a degraded path visible. Previously the two passes
 * disagreed about the same event: oracle-rerank mapped `embed_fallback` to
 * 'applied' (hiding it) while ollama-rerank mapped it to 'fallback', so cosine
 * ordering looked like a cross-encoder result in Oracle and like something else
 * in Embedding Space.
 */
export interface RerankStatus {
  outcome: RerankOutcome;
  /** Null when no tier ran — every skip, and hard errors. */
  tier: RerankTier | null;
  /** Positions that changed when the rerank was applied (undefined when nothing ran). */
  moved?: number;
  /** Mean |Δposition| over the moved entries. */
  meanAbsDelta?: number;
  /** True when the rerank saw only part of the eligible games (pool/budget cap) — reported, not hidden. */
  truncated?: boolean;
}

export const RERANK_TIER_LABELS: Record<RerankTier, string> = {
  native: 'Native cross-encoder',
  qwen_graded: 'Qwen3 graded',
  qwen_binary: 'Qwen3 binary',
  embed_fallback: 'Cosine fallback',
};

export function rerankTierLabel(tier: RerankTier | null): string {
  return tier ? RERANK_TIER_LABELS[tier] : 'None';
}

export function rerankStatus(outcome: RerankOutcome, tier: RerankTier | null = null): RerankStatus {
  return { outcome, tier };
}

/**
 * True for tiers that ordered the list but with less signal than the ideal
 * path — a hard yes/no instead of graded scores, or embedding cosine instead
 * of a cross-encoder. The UI labels these rather than hiding them.
 */
/**
 * How a reranker tier may be used for Oracle shelves: embed_fallback is never applied (no new signal),
 * qwen_binary is capped to a small blend, the rest use the requested blend.
 */
export function effectiveRerankBlend(tier: RerankTier | null, requested: number): number | null {
  if (tier === 'embed_fallback') return null;
  const capped = Math.min(requested, ORACLE_RERANK_MAX_BLEND);
  if (tier === 'qwen_binary') return Math.min(capped, QWEN_BINARY_MAX_BLEND);
  return capped;
}

export function isDegradedRerankTier(tier: RerankTier | null): boolean {
  return tier === 'qwen_binary' || tier === 'embed_fallback';
}

/** Narrow the IPC `via` field, which is untyped across the preload boundary. */
export function toRerankTier(via: unknown): RerankTier | null {
  return via === 'native' || via === 'qwen_graded' || via === 'qwen_binary' || via === 'embed_fallback'
    ? via
    : null;
}

// ─── IPC bridge ──────────────────────────────────────────────────────────────
// `window.ollama` is declared in embedding-service.ts with the original
// `{ query, documents, topN }` payload. The fields below are additive on both
// sides of the preload boundary, so they are typed here and reached through a
// narrow cast instead of widening the shared declaration.

/** Per-run report from the main process — mirrors `OllamaRerankRunReport` in electron/ipc/ollama-handlers.ts. */
export interface RerankRunReport {
  requestId: string | null;
  tier: RerankTier;
  scored: number;
  requested: number;
  elapsedMs: number;
  scoreMin: number | null;
  scoreMax: number | null;
  scoreStdev: number | null;
  truncated: boolean;
}

export type RerankIpcResult =
  | { results: Array<{ index: number; relevance_score: number }>; via?: RerankTier; report?: RerankRunReport }
  | { error: { code: string; httpStatus?: number; message: string }; report?: RerankRunReport };

export interface RerankRequestPayload {
  query: string;
  documents: string[];
  topN?: number;
  /** Lets `rerankCancel` stop the main-process loop once the renderer gives up. */
  requestId?: string;
  /** Main-process wall-clock ceiling (Qwen3 loop / native request). */
  budgetMs?: number;
}

export interface RerankBridge {
  rerank(payload: RerankRequestPayload): Promise<RerankIpcResult>;
  rerankCancel?(requestId: string): Promise<boolean>;
  rerankTier?(): Promise<{ tier: RerankTier; label?: string; model?: string; ollamaUp: boolean } | null>;
  rerankLog?(line: string): void;
}

export function getRerankBridge(): RerankBridge | null {
  if (typeof window === 'undefined') return null;
  const o = window.ollama as unknown as Partial<RerankBridge> | undefined;
  return o && typeof o.rerank === 'function' ? (o as RerankBridge) : null;
}

let _rerankSeq = 0;
export function newRerankRequestId(source: RerankSource): string {
  _rerankSeq = (_rerankSeq + 1) % 1_000_000;
  return `${source}-${Date.now().toString(36)}-${_rerankSeq}`;
}

/** Best-effort: tell the main process to stop a request the renderer gave up on. */
export function cancelRerankRequest(bridge: RerankBridge | null, requestId: string): void {
  try {
    void bridge?.rerankCancel?.(requestId)?.catch?.(() => {});
  } catch {
    /* preload without cancel support */
  }
}

/** Resolves `fallback` when `p` does not settle within `ms`. Never rejects. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(fallback); },
    );
  });
}

/** How long the renderer waits for the tier lookup before falling back to the default plan. */
export const RERANK_TIER_LOOKUP_TIMEOUT_MS = 8_000;

/** Current reranker tier, or null when the lookup is unavailable / slow. */
export async function lookupRerankTier(
  bridge: RerankBridge | null,
  timeoutMs: number = RERANK_TIER_LOOKUP_TIMEOUT_MS,
): Promise<RerankTier | null> {
  if (!bridge?.rerankTier) return null;
  const info = await within(bridge.rerankTier().catch(() => null), timeoutMs, null);
  return info ? toRerankTier(info.tier) : null;
}

// ─── Budgets ─────────────────────────────────────────────────────────────────
//
// Qwen3 scores with one sequential /api/generate call per document. At 100
// documents that is ~5–15 s on a warm GPU and 30–90 s on CPU, so the old flat
// 15 s Oracle budget meant a CPU Qwen pass ALWAYS timed out (and a cold GPU one
// often did) — the reranker effectively never ran, silently.
//
// Policy: for the Qwen tiers, score fewer documents — the top of the current
// order, which is what the user actually sees first — and allow more time,
// because the shelves / neighbours are already on screen while it runs. The
// main process gets a slightly smaller budget than the renderer's deadline so
// a truncated-but-useful pass still comes back in time to be applied; when the
// renderer deadline passes anyway it cancels the main-process loop.

export type RerankSource = 'oracle' | 'neighbors';

export interface RerankPlan {
  /** Renderer-side deadline for the whole IPC call. */
  budgetMs: number;
  /** Ceiling handed to the main process (Qwen3 loop / native request). */
  mainBudgetMs: number;
  /** Documents sent — the top of the current order. */
  maxDocs: number;
}

/** Oracle background rerank: shelves are already published, so a Qwen pass may take a while. */
export const ORACLE_RERANK_DEFAULT_BUDGET_MS = 15_000;
export const ORACLE_RERANK_QWEN_BUDGET_MS = 60_000;
/** Qwen3 Oracle pool — round-robin order, so roughly the top 4–5 games of every shelf. */
export const ORACLE_RERANK_QWEN_POOL = 40;
/** Embedding Space neighbour rerank: the user is waiting on the links. */
export const NEIGHBOR_RERANK_BUDGET_MS = 8_000;
/** Qwen3 neighbour pool — 2× the 12 links shown, from the top of the heuristic order. */
export const NEIGHBOR_RERANK_QWEN_POOL = 24;
/** Non-Qwen neighbour pool (matches NEIGHBOR_HEURISTIC_POOL). */
export const NEIGHBOR_RERANK_POOL = 72;
/** Gap between the main-process ceiling and the renderer deadline. */
const MAIN_BUDGET_MARGIN_MS = 1_500;

function isQwenTier(tier: RerankTier | null): boolean {
  return tier === 'qwen_graded' || tier === 'qwen_binary';
}

export function rerankPlan(source: RerankSource, tier: RerankTier | null): RerankPlan {
  const make = (budgetMs: number, maxDocs: number): RerankPlan => ({
    budgetMs,
    mainBudgetMs: Math.max(1_000, budgetMs - MAIN_BUDGET_MARGIN_MS),
    maxDocs,
  });
  if (source === 'neighbors') {
    // Unknown tier → assume the expensive one; a smaller pool costs a cheap tier nothing.
    return make(NEIGHBOR_RERANK_BUDGET_MS, isQwenTier(tier) || tier === null ? NEIGHBOR_RERANK_QWEN_POOL : NEIGHBOR_RERANK_POOL);
  }
  if (isQwenTier(tier)) return make(ORACLE_RERANK_QWEN_BUDGET_MS, ORACLE_RERANK_QWEN_POOL);
  // Native / cosine: fast tiers keep the full pool. Unknown tier (lookup failed):
  // default budget with the Qwen-sized pool, so a Qwen tier we could not see
  // still has a chance to finish.
  return make(ORACLE_RERANK_DEFAULT_BUDGET_MS, tier === null ? ORACLE_RERANK_QWEN_POOL : ORACLE_RERANK_POOL);
}

// ─── Run analysis ────────────────────────────────────────────────────────────

/** Scores closer than this are treated as identical — no usable signal. */
const NO_SIGNAL_EPSILON = 1e-6;

/**
 * True when the rerank produced no ordering signal: every scored document got
 * the same score (min == max). Uses the main-process report when present (it
 * covers every scored document, not just the top N returned), else the rows.
 */
export function rerankHasNoSignal(
  report: Pick<RerankRunReport, 'scoreMin' | 'scoreMax' | 'scored'> | undefined | null,
  results: ReadonlyArray<{ relevance_score: number }>,
): boolean {
  let min: number | null = null;
  let max: number | null = null;
  let n = 0;
  if (report && report.scoreMin !== null && report.scoreMax !== null && report.scored > 0) {
    min = report.scoreMin;
    max = report.scoreMax;
    n = report.scored;
  } else {
    for (const r of results) {
      if (!Number.isFinite(r.relevance_score)) continue;
      min = min === null ? r.relevance_score : Math.min(min, r.relevance_score);
      max = max === null ? r.relevance_score : Math.max(max, r.relevance_score);
      n++;
    }
  }
  if (n < 2 || min === null || max === null) return false;
  return max - min < NO_SIGNAL_EPSILON;
}

export interface RerankMovement {
  /** Entries whose position changed. */
  moved: number;
  /** Mean |Δposition| over the moved entries (0 when none moved). */
  meanAbsDelta: number;
  /** Entries compared (present both before and after, per list). */
  compared: number;
}

/**
 * How much a rerank actually changed: count of positions that moved plus the
 * mean |Δ| of the movers. Accepts parallel lists of ids (one per shelf, or a
 * single list); ids are compared within their own list. Ids that exist on only
 * one side are ignored.
 */
export function computeRerankMovement(
  before: ReadonlyArray<ReadonlyArray<string>>,
  after: ReadonlyArray<ReadonlyArray<string>>,
): RerankMovement {
  let moved = 0;
  let deltaSum = 0;
  let compared = 0;
  const lists = Math.min(before.length, after.length);
  for (let l = 0; l < lists; l++) {
    const pos = new Map<string, number>();
    before[l].forEach((id, i) => { if (!pos.has(id)) pos.set(id, i); });
    const seen = new Set<string>();
    after[l].forEach((id, i) => {
      if (seen.has(id)) return;
      seen.add(id);
      const prev = pos.get(id);
      if (prev === undefined) return;
      compared++;
      if (prev !== i) {
        moved++;
        deltaSum += Math.abs(prev - i);
      }
    });
  }
  return { moved, meanAbsDelta: moved > 0 ? deltaSum / moved : 0, compared };
}

// ─── Last-run store (System Status "Last rerank" row) ───────────────────────

export interface RerankRunRecord {
  source: RerankSource;
  outcome: RerankOutcome;
  tier: RerankTier | null;
  /** Date.now() when the run finished. */
  at: number;
  /** Renderer wall-clock for the IPC call (what the user waited). */
  elapsedMs: number;
  scored: number;
  requested: number;
  moved: number | null;
  meanAbsDelta: number | null;
  scoreMin: number | null;
  scoreMax: number | null;
  truncated: boolean;
}

let _lastRerankRun: RerankRunRecord | null = null;
const _rerankRunListeners = new Set<() => void>();

export function getLastRerankRun(): RerankRunRecord | null {
  return _lastRerankRun;
}

export function subscribeRerankRuns(fn: () => void): () => void {
  _rerankRunListeners.add(fn);
  return () => { _rerankRunListeners.delete(fn); };
}

function fmtScore(n: number | null): string {
  return n === null ? '?' : n.toFixed(2);
}

/** e.g. `[Rerank] oracle tier=qwen_graded 40/40 7.2s spread=0.02–0.97 moved=31 (avgΔ3.4)` */
export function formatRerankLogLine(r: RerankRunRecord): string {
  const parts = [`[Rerank] ${r.source}`, `tier=${r.tier ?? 'none'}`];
  if (r.outcome !== 'applied') parts.push(`outcome=${r.outcome}`);
  parts.push(`${r.scored}/${r.requested}`, `${(r.elapsedMs / 1000).toFixed(1)}s`);
  if (r.scoreMin !== null || r.scoreMax !== null) parts.push(`spread=${fmtScore(r.scoreMin)}–${fmtScore(r.scoreMax)}`);
  if (r.moved !== null) parts.push(`moved=${r.moved} (avgΔ${(r.meanAbsDelta ?? 0).toFixed(1)})`);
  if (r.truncated) parts.push('truncated');
  return parts.join(' ');
}

/**
 * Record one rerank run that reached the IPC: updates the "Last rerank" store
 * and writes one summary line to the console and the main-process log.
 * Pure skips (disabled, no client) are not recorded — they would overwrite the
 * last real run with noise.
 */
export function recordRerankRun(r: RerankRunRecord, bridge: RerankBridge | null = getRerankBridge()): void {
  _lastRerankRun = r;
  const line = formatRerankLogLine(r);
  console.log(line);
  try {
    bridge?.rerankLog?.(line);
  } catch {
    /* log bridge is best-effort */
  }
  for (const fn of _rerankRunListeners) {
    try { fn(); } catch { /* listener errors must not break the rerank path */ }
  }
}

/** Test hook. */
export function __resetRerankRunStoreForTests(): void {
  _lastRerankRun = null;
}

/** Build the record for a run from the IPC reply (or its absence). */
export function buildRerankRunRecord(args: {
  source: RerankSource;
  outcome: RerankOutcome;
  tier: RerankTier | null;
  startedAt: number;
  requested: number;
  report?: RerankRunReport | null;
  results?: ReadonlyArray<{ relevance_score: number }>;
  movement?: RerankMovement | null;
}): RerankRunRecord {
  const { report } = args;
  let scoreMin = report?.scoreMin ?? null;
  let scoreMax = report?.scoreMax ?? null;
  if (!report && args.results?.length) {
    const s = args.results.map((r) => r.relevance_score).filter((x) => Number.isFinite(x));
    if (s.length) { scoreMin = Math.min(...s); scoreMax = Math.max(...s); }
  }
  return {
    source: args.source,
    outcome: args.outcome,
    tier: args.tier,
    at: Date.now(),
    elapsedMs: Math.max(0, Date.now() - args.startedAt),
    scored: report?.scored ?? args.results?.length ?? 0,
    requested: report?.requested ?? args.requested,
    moved: args.movement ? args.movement.moved : null,
    meanAbsDelta: args.movement ? args.movement.meanAbsDelta : null,
    scoreMin,
    scoreMax,
    truncated: report?.truncated ?? false,
  };
}

/** Maps an IPC error code to an outcome. A main-side timeout is a timeout, not a failure. */
export function outcomeForRerankError(code: string): RerankOutcome {
  if (code === 'empty_results') return 'empty_results';
  if (code === 'timeout' || code === 'cancelled') return 'skipped_timeout';
  return 'error';
}

export interface TasteQueryExtras {
  /** Titles the user loved (most engaged first) — concrete anchors beat abstract genre lists. */
  lovedTitles?: string[];
}

/**
 * Taste query for the cross-encoder. Genre/theme affinities are listed strongest-first (so the top
 * genre is implied by position, not repeated), and loved titles anchor the query. Names are the same
 * canonical forms the documents use. No "modes" clause: documents describe modes per game, a taste-level
 * modes list only added noise.
 */
export function buildTasteQueryText(profile: TasteProfile, extras?: TasteQueryExtras): string {
  const gTop = profile.genres
    .filter((x) => x.weight > 0)
    .slice(0, 12)
    .map((x) => x.name)
    .join(', ');
  const tTop = profile.themes
    .filter((x) => x.weight > 0)
    .slice(0, 10)
    .map((x) => x.name)
    .join(', ');
  const loved = (extras?.lovedTitles ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 6);
  const parts = [
    'Recommend games for this player.',
    loved.length ? `They love: ${loved.join(', ')}.` : '',
    gTop ? `Genre affinities (strongest first): ${gTop}.` : '',
    tTop ? `Theme affinities (strongest first): ${tTop}.` : '',
    profile.loyalDevelopers?.length
      ? `Likes developers: ${profile.loyalDevelopers.slice(0, 6).join(', ')}.`
      : '',
  ];
  return parts.filter(Boolean).join(' ');
}

/**
 * Keyword-focused taste query for BM25 / MiniSearch retrieval.
 * Prefer concrete tokens (genres, themes, studios, loved titles) over prose.
 */
export function buildLexicalTasteQuery(
  profile: TasteProfile,
  opts?: { lovedTitles?: string[] },
): string {
  const genres = profile.genres
    .filter((x) => x.weight > 0)
    .slice(0, 10)
    .map((x) => x.name);
  if (profile.topGenre && !genres.includes(profile.topGenre)) {
    genres.unshift(profile.topGenre);
  }

  const themes = profile.themes
    .filter((x) => x.weight > 0)
    .slice(0, 8)
    .map((x) => x.name);
  if (profile.topTheme && !themes.includes(profile.topTheme)) {
    themes.unshift(profile.topTheme);
  }

  const studios = [
    ...(profile.loyalDevelopers ?? []).slice(0, 6),
    ...(profile.loyalPublishers ?? []).slice(0, 3),
  ];

  const loved = (opts?.lovedTitles ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);

  return [...genres, ...themes, ...studios, ...loved]
    .filter(Boolean)
    .join(' ')
    .trim();
}

export function scoredGameToRerankDoc(g: ScoredGame): string {
  const year = /^\d{4}/.exec(g.releaseDate ?? '')?.[0];
  const similar = (g.reasons?.similarTo ?? []).filter(Boolean).slice(0, 3);
  return [
    g.title,
    g.genres?.length ? `Genres: ${g.genres.join(', ')}` : '',
    g.themes?.length ? `Themes: ${g.themes.join(', ')}` : '',
    g.gameModes?.length ? `Modes: ${g.gameModes.join(', ')}` : '',
    year ? `Released: ${year}` : '',
    similar.length ? `Similar to: ${similar.join(', ')}` : '',
    g.developer ? `Developer: ${g.developer}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

/**
 * Re-order one shelf: `blend·rerank + (1−blend)·worker`, both on 0–1. The worker term is the game's
 * POSITION in the shelf (1 at the top, 0 at the bottom), not its raw score: shelves are built in MMR order
 * (diverse picks interleaved), and a score-based term would quietly re-sort them by score and put franchise
 * siblings back next to each other. The rerank term is min-max normalised over the games the reranker scored;
 * games it did not see get a neutral 0.5 (no rerank information), so they keep their relative worker position
 * instead of being flung to either end. Ties keep the worker order.
 */
export function blendShelfOrder(
  games: ScoredGame[],
  rerankScore: ReadonlyMap<string, number>,
  blend: number,
): ScoredGame[] {
  const n = games.length;
  if (n <= 1) return [...games];
  const pos = new Map(games.map((g, i) => [g.gameId, i]));
  const ws = (g: ScoredGame) => 1 - (pos.get(g.gameId) ?? 0) / (n - 1);

  let lo = Infinity;
  let hi = -Infinity;
  for (const g of games) {
    const v = rerankScore.get(g.gameId);
    if (v === undefined) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  const rs = (g: ScoredGame) => {
    const v = rerankScore.get(g.gameId);
    if (v === undefined) return 0.5;
    return span > 1e-12 ? (v - lo) / span : 0.5;
  };

  return [...games].sort((a, b) => {
    const ca = blend * rs(a) + (1 - blend) * ws(a);
    const cb = blend * rs(b) + (1 - blend) * ws(b);
    return cb - ca || (pos.get(a.gameId) ?? 0) - (pos.get(b.gameId) ?? 0);
  });
}

export type OracleRerankOptions = {
  /** When false, skip rerank entirely (default true). */
  enabled?: boolean;
  /** 0 = worker order within shelves, 1 = pure rerank order (default DEFAULT_ORACLE_RERANK_BLEND). */
  blend?: number;
  /** Anchors for the taste query (e.g. loved titles). */
  queryExtras?: TasteQueryExtras;
  /**
   * Aborted when the caller's deadline passes. The main-process loop is then
   * cancelled through `ollama:rerankCancel` and the run is recorded as a timeout.
   */
  signal?: AbortSignal;
  /** Budget / pool for this run. Defaults to the plan for an unknown tier. */
  plan?: RerankPlan;
};

/**
 * Rerank up to ORACLE_RERANK_POOL unique games (round-robin across shelves) with the taste query, then reorder games within each shelf.
 */
export async function applyOracleRerankShelves(
  profile: TasteProfile,
  shelves: RecoShelf[],
  opts?: OracleRerankOptions,
): Promise<{ shelves: RecoShelf[]; status: RerankStatus }> {
  if (!shelves.length) return { shelves, status: rerankStatus('none') };

  const enabled = opts?.enabled !== false;
  if (!enabled) return { shelves, status: rerankStatus('skipped_disabled') };

  const blend =
    typeof opts?.blend === 'number' && Number.isFinite(opts.blend)
      ? Math.min(1, Math.max(0, opts.blend))
      : DEFAULT_ORACLE_RERANK_BLEND;
  if (blend <= 0) return { shelves, status: rerankStatus('skipped_blend_zero') };

  const bridge = getRerankBridge();
  if (!bridge) {
    return { shelves, status: rerankStatus('skipped_no_client') };
  }

  const plan = opts?.plan ?? rerankPlan('oracle', null);
  const poolLimit = Math.max(1, Math.min(ORACLE_RERANK_POOL, plan.maxDocs));

  // Round-robin pool building: ensures every shelf is represented in the rerank pool
  // even when earlier shelves are long. Prevents late shelves from being entirely cut.
  // A smaller (Qwen3) pool therefore covers the top few games of EVERY shelf;
  // games outside it keep their worker order after the reranked ones.
  const seen = new Set<string>();
  const pool: ScoredGame[] = [];
  const cursors = shelves.map(() => 0);
  const eligible = shelves.map(sh => RERANKABLE_SHELF_TYPES.has(sh.type));
  const eligibleGames = new Set<string>();
  shelves.forEach((sh, i) => { if (eligible[i]) for (const g of sh.games) eligibleGames.add(g.gameId); });
  let progressed = true;
  while (pool.length < poolLimit && progressed) {
    progressed = false;
    for (let i = 0; i < shelves.length; i++) {
      if (!eligible[i]) continue;
      const games = shelves[i].games;
      while (cursors[i] < games.length) {
        const g = games[cursors[i]++];
        if (seen.has(g.gameId)) continue;
        seen.add(g.gameId);
        pool.push(g);
        progressed = true;
        break;
      }
      if (pool.length >= poolLimit) break;
    }
  }
  if (pool.length === 0) return { shelves, status: rerankStatus('skipped_empty_pool') };

  const query = buildTasteQueryText(profile, opts?.queryExtras);
  const documents = pool.map(scoredGameToRerankDoc);
  const requestId = newRerankRequestId('oracle');
  const startedAt = Date.now();
  const signal = opts?.signal;
  // Once the caller's deadline passed, the result is discarded — stop the
  // main-process loop and record the run as a timeout right away.
  let gaveUp = false;
  const onAbort = () => {
    if (gaveUp) return;
    gaveUp = true;
    cancelRerankRequest(bridge, requestId);
    recordRerankRun(buildRerankRunRecord({
      source: 'oracle', outcome: 'skipped_timeout', tier: null, startedAt, requested: pool.length,
    }), bridge);
  };
  if (signal?.aborted) {
    return { shelves, status: rerankStatus('skipped_timeout') };
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  const finish = (
    status: RerankStatus,
    out: RecoShelf[],
    extra?: { report?: RerankRunReport; results?: ReadonlyArray<{ relevance_score: number }>; movement?: RerankMovement | null },
  ) => {
    signal?.removeEventListener('abort', onAbort);
    if (!gaveUp) {
      recordRerankRun(buildRerankRunRecord({
        source: 'oracle', outcome: status.outcome, tier: status.tier, startedAt, requested: pool.length,
        report: extra?.report, results: extra?.results, movement: extra?.movement,
      }), bridge);
    }
    return { shelves: out, status };
  };

  try {
    const res = await bridge.rerank({
      query, documents, topN: pool.length, requestId, budgetMs: plan.mainBudgetMs,
    });
    // Structured IPC: { results, via, report } success (incl. embed_fallback) or { error }.
    if (!res || 'error' in res || !('results' in res) || !res.results?.length) {
      if (res && 'error' in res) {
        return finish(rerankStatus(outcomeForRerankError(res.error.code), res.report?.tier ?? null), shelves, { report: res.report });
      }
      return finish(rerankStatus('empty_results'), shelves);
    }

    const tier = toRerankTier(res.via) ?? res.report?.tier ?? null;
    // Constant scores (e.g. a yes/no pass that said "no" to everything) carry
    // no ordering — applying them would only report a rerank that did nothing.
    if (rerankHasNoSignal(res.report, res.results)) {
      return finish(rerankStatus('no_signal', tier), shelves, { report: res.report, results: res.results });
    }

    // Tier gating: a cosine fallback is a worse copy of a signal the worker already used, so it is
    // never applied; a yes/no pass may only nudge.
    const effBlend = effectiveRerankBlend(tier, blend);
    if (effBlend === null || effBlend <= 0) {
      return finish(rerankStatus('skipped_degraded_tier', tier), shelves, { report: res.report, results: res.results });
    }

    const scores = new Map<string, number>();
    for (const r of res.results) {
      const g = pool[r.index];
      if (g && Number.isFinite(r.relevance_score) && !scores.has(g.gameId)) scores.set(g.gameId, r.relevance_score);
    }

    const out = shelves.map((sh, i) => (eligible[i]
      ? { ...sh, games: blendShelfOrder(sh.games, scores, effBlend) }
      : sh));
    const movement = computeRerankMovement(
      shelves.map((sh) => sh.games.map((g) => g.gameId)),
      out.map((sh) => sh.games.map((g) => g.gameId)),
    );
    // The ordering was applied either way — the tier is what says how good it
    // is. embed_fallback used to be flattened into a bare 'applied' here, which
    // made cosine ordering indistinguishable from a cross-encoder pass.
    const status: RerankStatus = {
      ...rerankStatus('applied', tier),
      moved: movement.moved,
      meanAbsDelta: movement.meanAbsDelta,
      // Reported, not hidden: part of the eligible games never reached the reranker.
      truncated: (res.report?.truncated ?? false) || scores.size < eligibleGames.size,
    };
    return finish(status, out, { report: res.report, results: res.results, movement });
  } catch {
    return finish(rerankStatus('error'), shelves);
  }
}
