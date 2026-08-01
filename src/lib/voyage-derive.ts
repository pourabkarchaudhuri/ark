/**
 * Voyage derivation — the pure layer shared by the two competing Voyage views
 * (Scenes and Audit).
 *
 * Everything here is a pure function over store snapshots: no React, no DOM, no
 * store singletons. The two views import from here and never from each other,
 * so whichever one loses the A/B can be deleted in a single commit.
 *
 * Cost discipline: every function below is O(sessions + transitions + games).
 * Nothing iterates calendar time, so a library with a decade of history costs
 * the same as one with a month of it.
 */

import type {
  GameSession,
  GameStatus,
  JourneyEntry,
  LibraryGameEntry,
  StatusChangeEntry,
} from '@/types/game';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Parse an ISO timestamp to epoch ms, or null when missing or corrupt. */
export function parseIsoMs(iso: string | Date | undefined | null): number | null {
  if (iso == null) return null;
  if (iso instanceof Date) {
    const t = iso.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (String(iso).trim() === '') return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Median of a numeric list. Returns 0 for an empty list. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Local calendar-day key, used only to count distinct days inside an episode. */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// ─── Scenes: session clustering ──────────────────────────────────────────────

/**
 * The shape of a play episode. Deliberately not a calendar bucket — a scene is
 * a run of sessions on one game with no long silence inside it.
 */
export type SceneType =
  | 'binge'
  | 'drip'
  | 'marathon'
  | 'false-start'
  | 'return'
  | 'drift';

export interface PlayScene {
  id: string;
  gameId: string;
  title: string;
  startMs: number;
  endMs: number;
  /** Wall-clock span from first session start to last session end. */
  spanMs: number;
  /** Active play minutes summed across the episode's sessions. */
  minutes: number;
  sessionCount: number;
  /** Distinct local calendar days the episode touches. */
  dayCount: number;
  longestSessionMinutes: number;
  /** Silence before this episode on the same game; null for the game's first. */
  sincePreviousMs: number | null;
  isFirstForGame: boolean;
  isLastForGame: boolean;
  /** A single short launch that never turned into anything. */
  isMicroLaunch: boolean;
  type: SceneType;
}

export interface ClusterOptions {
  /** Silence longer than this splits one episode into two. Default 3 days. */
  breakMs?: number;
  /** A lone session shorter than this is a micro launch. Default 30 minutes. */
  microLaunchMinutes?: number;
  /** Silence this long before an episode makes it a return. Default 60 days. */
  returnIdleMs?: number;
  /** A single sitting this long makes the episode a marathon. Default 4 hours. */
  marathonMinutes?: number;
}

const DEFAULT_CLUSTER: Required<ClusterOptions> = {
  breakMs: 3 * DAY_MS,
  microLaunchMinutes: 30,
  returnIdleMs: 60 * DAY_MS,
  marathonMinutes: 240,
};

interface RawScene {
  gameId: string;
  startMs: number;
  endMs: number;
  minutes: number;
  sessionCount: number;
  dayCount: number;
  longestSessionMinutes: number;
}

/**
 * Group sessions into per-game episodes, then label each one.
 *
 * `titleFor` keeps this pure: sessions carry only a gameId, and the caller owns
 * the journey/library lookup that resolves a display title.
 *
 * Returned newest-first, which is the order both the stream and the spine want.
 */
export function clusterSessionsIntoScenes(
  sessions: GameSession[],
  titleFor: (gameId: string) => string,
  options?: ClusterOptions,
): PlayScene[] {
  const opts = { ...DEFAULT_CLUSTER, ...options };

  const byGame = new Map<string, GameSession[]>();
  for (const s of sessions) {
    if (!s?.gameId) continue;
    if (parseIsoMs(s.startTime) === null) continue;
    let list = byGame.get(s.gameId);
    if (!list) byGame.set(s.gameId, (list = []));
    list.push(s);
  }

  const scenes: PlayScene[] = [];
  const allMinutes: number[] = [];

  for (const [gameId, list] of byGame) {
    list.sort((a, b) => (parseIsoMs(a.startTime) ?? 0) - (parseIsoMs(b.startTime) ?? 0));

    const raw: RawScene[] = [];
    let current: RawScene | null = null;
    let days: Set<string> | null = null;

    for (const s of list) {
      const startMs = parseIsoMs(s.startTime)!;
      const rawEnd = parseIsoMs(s.endTime);
      const minutes = Math.max(0, s.durationMinutes ?? 0);
      const endMs = rawEnd !== null && rawEnd > startMs ? rawEnd : startMs + minutes * MINUTE_MS;

      if (current && days && startMs - current.endMs <= opts.breakMs) {
        current.endMs = Math.max(current.endMs, endMs);
        current.minutes += minutes;
        current.sessionCount += 1;
        current.longestSessionMinutes = Math.max(current.longestSessionMinutes, minutes);
        days.add(dayKey(startMs));
        current.dayCount = days.size;
      } else {
        if (current) raw.push(current);
        days = new Set([dayKey(startMs)]);
        current = {
          gameId,
          startMs,
          endMs,
          minutes,
          sessionCount: 1,
          dayCount: 1,
          longestSessionMinutes: minutes,
        };
      }
    }
    if (current) raw.push(current);

    const title = titleFor(gameId);
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      const sincePreviousMs = i === 0 ? null : r.startMs - raw[i - 1].endMs;
      allMinutes.push(r.minutes);
      scenes.push({
        id: `${gameId}:${r.startMs}`,
        gameId,
        title,
        startMs: r.startMs,
        endMs: r.endMs,
        spanMs: Math.max(0, r.endMs - r.startMs),
        minutes: r.minutes,
        sessionCount: r.sessionCount,
        dayCount: r.dayCount,
        longestSessionMinutes: r.longestSessionMinutes,
        sincePreviousMs,
        isFirstForGame: i === 0,
        isLastForGame: i === raw.length - 1,
        isMicroLaunch: r.sessionCount === 1 && r.minutes < opts.microLaunchMinutes,
        type: 'drip',
      });
    }
  }

  const medianMinutes = median(allMinutes);
  for (const scene of scenes) {
    scene.type = classifyScene(scene, medianMinutes, opts);
  }

  scenes.sort((a, b) => b.startMs - a.startMs);
  return scenes;
}

/**
 * Label an episode. Ordering is deliberate: the earliest matching rule wins, so
 * "you came back after a long silence" outranks "this was a big week".
 */
export function classifyScene(
  scene: Pick<
    PlayScene,
    | 'minutes'
    | 'sessionCount'
    | 'dayCount'
    | 'longestSessionMinutes'
    | 'sincePreviousMs'
    | 'isFirstForGame'
    | 'isLastForGame'
  >,
  medianSceneMinutes: number,
  options?: ClusterOptions,
): SceneType {
  const opts = { ...DEFAULT_CLUSTER, ...options };

  if (scene.isFirstForGame && scene.sessionCount <= 2 && scene.minutes < 45) {
    return 'false-start';
  }
  if (scene.sincePreviousMs !== null && scene.sincePreviousMs >= opts.returnIdleMs) {
    return 'return';
  }
  if (scene.longestSessionMinutes >= opts.marathonMinutes) {
    return 'marathon';
  }
  const bingeFloor = Math.max(180, medianSceneMinutes * 2);
  if (scene.minutes >= bingeFloor && scene.dayCount <= 10) {
    return 'binge';
  }
  if (scene.isLastForGame && !scene.isFirstForGame && scene.minutes < medianSceneMinutes * 0.5) {
    return 'drift';
  }
  return 'drip';
}

/** Human label for a scene type. Non-completion endings are named neutrally. */
export const SCENE_TYPE_LABEL: Record<SceneType, string> = {
  binge: 'Binge',
  drip: 'Steady',
  marathon: 'Marathon',
  'false-start': 'Brief look',
  return: 'Return',
  drift: 'Wound down',
};

// ─── Scenes: magnitude ───────────────────────────────────────────────────────

/**
 * Log-scaled magnitude in 0..1. Log rather than linear so a 200-hour epic does
 * not squash every other episode to a hairline.
 */
export function sceneMagnitude(minutes: number, maxMinutes: number): number {
  if (!(minutes > 0) || !(maxMinutes > 0)) return 0;
  const m = Math.log1p(minutes) / Math.log1p(maxMinutes);
  return Math.max(0, Math.min(1, m));
}

/**
 * Convert a magnitude to a linear dimension so the rendered *area* — not the
 * width — is proportional to the magnitude.
 */
export function magnitudeToAreaScale(magnitude: number): number {
  return Math.sqrt(Math.max(0, Math.min(1, magnitude)));
}

/** Ratio of a scene against the corpus median, for the comparative headline. */
export function magnitudeVsMedian(minutes: number, medianMinutes: number): number {
  if (!(medianMinutes > 0)) return 1;
  return minutes / medianMinutes;
}

// ─── Scenes: gaps between episodes ───────────────────────────────────────────

export interface SceneGap {
  id: string;
  startMs: number;
  endMs: number;
  ms: number;
  /** The episode that broke the silence. */
  nextSceneId: string;
  nextGameId: string;
  nextTitle: string;
  /** True for the single longest gap in the stream. */
  isLongest: boolean;
}

/**
 * Silences between consecutive episodes anywhere in the library. Gaps are
 * content in Scenes, so they are returned as first-class rows rather than being
 * implied by whitespace.
 */
export function computeSceneGaps(
  scenesNewestFirst: PlayScene[],
  minGapMs: number = 14 * DAY_MS,
): SceneGap[] {
  const gaps: SceneGap[] = [];
  let longestIdx = -1;
  let longestMs = 0;

  for (let i = 0; i < scenesNewestFirst.length - 1; i++) {
    const newer = scenesNewestFirst[i];
    const older = scenesNewestFirst[i + 1];
    const ms = newer.startMs - older.endMs;
    if (ms < minGapMs) continue;
    if (ms > longestMs) {
      longestMs = ms;
      longestIdx = gaps.length;
    }
    gaps.push({
      id: `gap:${older.id}->${newer.id}`,
      startMs: older.endMs,
      endMs: newer.startMs,
      ms,
      nextSceneId: newer.id,
      nextGameId: newer.gameId,
      nextTitle: newer.title,
      isLongest: false,
    });
  }

  if (longestIdx >= 0) gaps[longestIdx].isLongest = true;
  return gaps;
}

// ─── Scenes: ordinal milestones ──────────────────────────────────────────────

export type MilestoneKind = 'titles' | 'completions' | 'sessions' | 'hours';

export interface Milestone {
  id: string;
  kind: MilestoneKind;
  atMs: number;
  ordinal: number;
  label: string;
  detail: string;
  gameId?: string;
}

const ORDINAL_STEPS = [1, 5, 10, 25, 50, 100, 250, 500, 1000];
const HOUR_STEPS = [10, 50, 100, 250, 500, 1000, 2500];

function ordinalSuffix(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/**
 * Ordinal markers read straight off the append-only transition log and the
 * session log. These are counts of things you recorded, so they are stable —
 * nothing here depends on how recently you played.
 */
export function deriveMilestones(
  statusHistory: StatusChangeEntry[],
  sessions: GameSession[],
): Milestone[] {
  const milestones: Milestone[] = [];

  const sortedHistory = [...statusHistory]
    .filter((e) => parseIsoMs(e.timestamp) !== null)
    .sort((a, b) => parseIsoMs(a.timestamp)! - parseIsoMs(b.timestamp)!);

  const seenTitles = new Set<string>();
  const seenCompletions = new Set<string>();
  let titleCount = 0;
  let completionCount = 0;

  for (const e of sortedHistory) {
    const atMs = parseIsoMs(e.timestamp)!;

    if (!seenTitles.has(e.gameId)) {
      seenTitles.add(e.gameId);
      titleCount += 1;
      if (ORDINAL_STEPS.includes(titleCount)) {
        milestones.push({
          id: `titles:${titleCount}`,
          kind: 'titles',
          atMs,
          ordinal: titleCount,
          label: `${ordinalSuffix(titleCount)} title logged`,
          detail: e.title,
          gameId: e.gameId,
        });
      }
    }

    if (e.newStatus === 'Completed' && !seenCompletions.has(e.gameId)) {
      seenCompletions.add(e.gameId);
      completionCount += 1;
      if (ORDINAL_STEPS.includes(completionCount)) {
        milestones.push({
          id: `completions:${completionCount}`,
          kind: 'completions',
          atMs,
          ordinal: completionCount,
          label: `${ordinalSuffix(completionCount)} completion recorded`,
          detail: e.title,
          gameId: e.gameId,
        });
      }
    }
  }

  const sortedSessions = [...sessions]
    .filter((s) => parseIsoMs(s.startTime) !== null)
    .sort((a, b) => parseIsoMs(a.startTime)! - parseIsoMs(b.startTime)!);

  let sessionCount = 0;
  let cumulativeHours = 0;
  let hourStepIdx = 0;

  for (const s of sortedSessions) {
    const atMs = parseIsoMs(s.startTime)!;
    sessionCount += 1;
    if (ORDINAL_STEPS.includes(sessionCount)) {
      milestones.push({
        id: `sessions:${sessionCount}`,
        kind: 'sessions',
        atMs,
        ordinal: sessionCount,
        label: `${ordinalSuffix(sessionCount)} tracked session`,
        detail: '',
        gameId: s.gameId,
      });
    }

    cumulativeHours += Math.max(0, s.durationMinutes ?? 0) / 60;
    while (hourStepIdx < HOUR_STEPS.length && cumulativeHours >= HOUR_STEPS[hourStepIdx]) {
      const step = HOUR_STEPS[hourStepIdx];
      milestones.push({
        id: `hours:${step}`,
        kind: 'hours',
        atMs,
        ordinal: step,
        label: `${step.toLocaleString()} tracked hours`,
        detail: '',
        gameId: s.gameId,
      });
      hourStepIdx += 1;
    }
  }

  milestones.sort((a, b) => b.atMs - a.atMs);
  return milestones;
}

// ─── Curation ────────────────────────────────────────────────────────────────

export interface BulkImportOptions {
  /** Entries added inside this window belong to the same burst. Default 10 min. */
  windowMs?: number;
  /** A burst this large is an import rather than a decision. Default 8. */
  minSize?: number;
}

/**
 * Games that arrived in a burst — a Steam sync or a restore — rather than one
 * at a time. Their `addedAt` says nothing about intent, so Scenes collapses
 * them by default.
 */
export function detectBulkImportGameIds(
  entries: Array<{ gameId: string; addedAt?: string }>,
  options?: BulkImportOptions,
): Set<string> {
  const windowMs = options?.windowMs ?? 10 * MINUTE_MS;
  const minSize = options?.minSize ?? 8;

  const dated = entries
    .map((e) => ({ gameId: e.gameId, ms: parseIsoMs(e.addedAt) }))
    .filter((e): e is { gameId: string; ms: number } => e.ms !== null)
    .sort((a, b) => a.ms - b.ms);

  const flagged = new Set<string>();
  let burst: typeof dated = [];

  const flush = () => {
    if (burst.length >= minSize) for (const b of burst) flagged.add(b.gameId);
    burst = [];
  };

  for (const item of dated) {
    if (burst.length === 0 || item.ms - burst[burst.length - 1].ms <= windowMs) {
      burst.push(item);
    } else {
      flush();
      burst = [item];
    }
  }
  flush();

  return flagged;
}

export interface StatusChurnOptions {
  /** Transitions inside this window count toward the churn threshold. Default 1 h. */
  windowMs?: number;
  /** This many transitions inside the window is churn. Default 4. */
  minTransitions?: number;
}

/**
 * Games whose status was flipped back and forth in a short burst. The
 * transitions are real, but they describe a moment of tidying rather than
 * anything that happened in the game.
 */
export function detectStatusChurnGameIds(
  statusHistory: StatusChangeEntry[],
  options?: StatusChurnOptions,
): Set<string> {
  const windowMs = options?.windowMs ?? HOUR_MS;
  const minTransitions = options?.minTransitions ?? 4;

  const byGame = new Map<string, number[]>();
  for (const e of statusHistory) {
    const ms = parseIsoMs(e.timestamp);
    if (ms === null) continue;
    let list = byGame.get(e.gameId);
    if (!list) byGame.set(e.gameId, (list = []));
    list.push(ms);
  }

  const flagged = new Set<string>();
  for (const [gameId, stamps] of byGame) {
    if (stamps.length < minTransitions) continue;
    stamps.sort((a, b) => a - b);
    for (let i = minTransitions - 1; i < stamps.length; i++) {
      if (stamps[i] - stamps[i - (minTransitions - 1)] <= windowMs) {
        flagged.add(gameId);
        break;
      }
    }
  }
  return flagged;
}

// ─── Status segments ─────────────────────────────────────────────────────────

export interface StatusSegment {
  gameId: string;
  status: GameStatus;
  startMs: number;
  /**
   * null while the status is still the current one. States like `Want to Play`
   * genuinely have no end, and inventing one is what made the old Gantt lie.
   */
  endMs: number | null;
}

/** Per-game status segments straight off the append-only transition log. */
export function buildStatusSegments(
  statusHistory: StatusChangeEntry[],
): Map<string, StatusSegment[]> {
  const byGame = new Map<string, StatusChangeEntry[]>();
  for (const e of statusHistory) {
    if (parseIsoMs(e.timestamp) === null) continue;
    let list = byGame.get(e.gameId);
    if (!list) byGame.set(e.gameId, (list = []));
    list.push(e);
  }

  const out = new Map<string, StatusSegment[]>();
  for (const [gameId, list] of byGame) {
    list.sort((a, b) => parseIsoMs(a.timestamp)! - parseIsoMs(b.timestamp)!);
    const segments: StatusSegment[] = list.map((e, i) => ({
      gameId,
      status: e.newStatus,
      startMs: parseIsoMs(e.timestamp)!,
      endMs: i < list.length - 1 ? parseIsoMs(list[i + 1].timestamp)! : null,
    }));
    out.set(gameId, segments);
  }
  return out;
}

/**
 * When the game's current status was set, walking back through any repeated
 * writes of the same value. Returns null when the log's latest entry disagrees
 * with the live status, because then we genuinely do not know.
 */
export function currentStatusSinceMs(
  segments: Map<string, StatusSegment[]>,
  gameId: string,
  status: GameStatus,
): number | null {
  const list = segments.get(gameId);
  if (!list?.length) return null;
  if (list[list.length - 1].status !== status) return null;
  let start = list[list.length - 1].startMs;
  for (let i = list.length - 2; i >= 0; i--) {
    if (list[i].status !== status) break;
    start = list[i].startMs;
  }
  return start;
}

// ─── Per-game rollups ────────────────────────────────────────────────────────

export interface GameRollup {
  gameId: string;
  title: string;
  status: GameStatus | null;
  hoursPlayed: number;
  rating: number;
  addedAtMs: number | null;
  removedAtMs: number | null;
  firstPlayedMs: number | null;
  lastPlayedMs: number | null;
  sessionCount: number;
  totalMinutes: number;
  /** When the current status was last set, from the transition log. */
  statusSinceMs: number | null;
  inLibrary: boolean;
  executablePath?: string;
  secondaryGameId?: string;
  launcherDetected?: boolean;
}

export interface RollupInput {
  journeyEntries: JourneyEntry[];
  libraryEntries: LibraryGameEntry[];
  statusHistory: StatusChangeEntry[];
  sessions: GameSession[];
}

/**
 * One row per game the app knows about, merging the journey snapshot, the live
 * library entry, the transition log and the session log. Both views rank off
 * this, so the merge rules live in one place.
 */
export function buildGameRollups(input: RollupInput): GameRollup[] {
  const { journeyEntries, libraryEntries, statusHistory, sessions } = input;

  const sessionAgg = new Map<
    string,
    { count: number; minutes: number; firstMs: number; lastMs: number }
  >();
  for (const s of sessions) {
    const startMs = parseIsoMs(s.startTime);
    if (startMs === null) continue;
    const endMs = parseIsoMs(s.endTime) ?? startMs;
    const agg = sessionAgg.get(s.gameId);
    if (agg) {
      agg.count += 1;
      agg.minutes += Math.max(0, s.durationMinutes ?? 0);
      agg.firstMs = Math.min(agg.firstMs, startMs);
      agg.lastMs = Math.max(agg.lastMs, endMs);
    } else {
      sessionAgg.set(s.gameId, {
        count: 1,
        minutes: Math.max(0, s.durationMinutes ?? 0),
        firstMs: startMs,
        lastMs: endMs,
      });
    }
  }

  const segments = buildStatusSegments(statusHistory);
  const journeyById = new Map(journeyEntries.map((e) => [e.gameId, e]));
  const libraryById = new Map(libraryEntries.map((e) => [e.gameId, e]));

  const ids = new Set<string>([...journeyById.keys(), ...libraryById.keys()]);
  const rollups: GameRollup[] = [];

  for (const gameId of ids) {
    const je = journeyById.get(gameId);
    const le = libraryById.get(gameId);
    const agg = sessionAgg.get(gameId);
    const status = le?.status ?? je?.status ?? null;

    rollups.push({
      gameId,
      title: je?.title ?? le?.cachedMeta?.title ?? gameId,
      status,
      hoursPlayed: le?.hoursPlayed ?? je?.hoursPlayed ?? 0,
      rating: le?.rating ?? je?.rating ?? 0,
      addedAtMs: parseIsoMs(le?.addedAt) ?? parseIsoMs(je?.addedAt),
      removedAtMs: parseIsoMs(je?.removedAt),
      firstPlayedMs: agg?.firstMs ?? parseIsoMs(je?.firstPlayedAt),
      lastPlayedMs:
        agg?.lastMs ?? parseIsoMs(le?.lastPlayedAt) ?? parseIsoMs(je?.lastPlayedAt),
      sessionCount: agg?.count ?? 0,
      totalMinutes: agg?.minutes ?? 0,
      statusSinceMs: status ? currentStatusSinceMs(segments, gameId, status) : null,
      inLibrary: !!le,
      executablePath: le?.executablePath,
      secondaryGameId: le?.secondaryGameId,
      launcherDetected: le?.launcherDetected,
    });
  }

  return rollups;
}

// ─── Shared formatting ───────────────────────────────────────────────────────

/** Compact duration for a span of silence or an episode: "3 days", "8 months". */
export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'moments';
  const days = ms / DAY_MS;
  if (days < 1) {
    const hours = Math.max(1, Math.round(ms / HOUR_MS));
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (days < 14) {
    const d = Math.round(days);
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  if (days < 60) {
    const w = Math.round(days / 7);
    return `${w} week${w === 1 ? '' : 's'}`;
  }
  if (days < 365) {
    const m = Math.round(days / 30.44);
    return `${m} month${m === 1 ? '' : 's'}`;
  }
  const y = Math.round((days / 365.25) * 10) / 10;
  return `${y} year${y === 1 ? '' : 's'}`;
}

/** Play time inside an episode: "40 min", "2h 15m", "18 hrs". */
export function formatPlayMinutes(minutes: number): string {
  const m = Math.round(Math.max(0, minutes));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h >= 10) return `${h} hrs`;
  return rem === 0 ? `${h} hr${h === 1 ? '' : 's'}` : `${h}h ${rem}m`;
}

/** "March 2024" — used for record-accuracy prompts that name a month. */
export function formatMonthYear(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/** "12 Mar 2024" */
export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
