/**
 * Voyage · Audit
 *
 * **Audit grades your records, never your playing.**
 *
 * Every rule below is a question about whether something *stored* is still
 * accurate — "Marked Playing, silent since October, still true?" — and never a
 * verdict about how somebody spends their evenings. GitHub removed streak
 * statistics after documented harm, and a feature descended from something
 * called OCD Mode is at unusual risk of repeating that, so the rules here are
 * held to a hard line:
 *
 *  - the three rings measure data completeness only, which has a correct
 *    target of zero open items; play volume has no correct target and
 *    inventing one would moralize
 *  - no red anywhere, and in particular no red for inactivity
 *  - no backlog debt, no "unplayed" counters, no nagging streaks
 *  - anything can be snoozed or dismissed, and that choice persists
 *
 * Deliberately self-contained: it imports the shared pure layer, the franchise
 * and catalog services and UI primitives, never journey-scenes-view, so
 * retiring the loser of the A/B is one commit.
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts';
import {
  BellOff,
  CheckCircle2,
  ClipboardCheck,
  EyeOff,
  FolderSearch,
  Gauge,
  History,
  Image as ImageIcon,
  Layers,
  LineChart as LineChartIcon,
  Link2,
  ListChecks,
  Play,
  SlidersHorizontal,
  Star,
  Undo2,
} from 'lucide-react';
import type {
  GameSession,
  GameStatus,
  JourneyEntry,
  LibraryGameEntry,
  StatusChangeEntry,
} from '@/types/game';
import {
  DAY_MS,
  buildGameRollups,
  computeAuditQuality,
  computeOpenItemsTrend,
  computeStatusDistribution,
  formatMonthYear,
  formatSpan,
  type AuditQuality,
  type GameRollup,
} from '@/lib/voyage-derive';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { canonicalFranchiseBase, isUmbrellaBrand, passesUmbrellaMembership } from '@/services/franchise';
import { bm25Index } from '@/services/bm25-index';
import { catalogStore } from '@/services/catalog-store';
import { libraryStore } from '@/services/library-store';
import { resolveJourneyDisplayTitle } from '@/lib/journey-display-title';
import { cn } from '@/lib/utils';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface JourneyAuditViewProps {
  journeyEntries: JourneyEntry[];
  libraryEntries: LibraryGameEntry[];
  statusHistory: StatusChangeEntry[];
  sessions: GameSession[];
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export const AUDIT_STORAGE_KEY = 'ark.voyage.audit.v1';
const STORAGE_KEY = AUDIT_STORAGE_KEY;
const TRAIL_LIMIT = 60;

const SNOOZE_OPTIONS: Array<{ label: string; ms: number }> = [
  { label: '7 days', ms: 7 * DAY_MS },
  { label: '30 days', ms: 30 * DAY_MS },
];

type TrailAction = 'resolved' | 'snoozed' | 'dismissed' | 'restored';

interface TrailEntry {
  id: string;
  atMs: number;
  action: TrailAction;
  ruleId: RuleId;
  subject: string;
  detail: string;
}

interface AuditPersistedState {
  version: 1;
  /** findingKey → epoch ms the snooze expires. */
  snoozed: Record<string, number>;
  /** findingKey → epoch ms it was dismissed. */
  dismissed: Record<string, number>;
  disabledRules: RuleId[];
  trail: TrailEntry[];
}

const EMPTY_STATE: AuditPersistedState = {
  version: 1,
  snoozed: {},
  dismissed: {},
  disabledRules: [],
  trail: [],
};

export function loadPersisted(): AuditPersistedState {
  if (typeof localStorage === 'undefined') return EMPTY_STATE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STATE;
    const parsed = JSON.parse(raw) as Partial<AuditPersistedState>;
    return {
      version: 1,
      snoozed: parsed.snoozed ?? {},
      dismissed: parsed.dismissed ?? {},
      disabledRules: Array.isArray(parsed.disabledRules) ? parsed.disabledRules : [],
      trail: Array.isArray(parsed.trail) ? parsed.trail.slice(0, TRAIL_LIMIT) : [],
    };
  } catch {
    return EMPTY_STATE;
  }
}

export function savePersisted(state: AuditPersistedState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota or private mode — the view still works, it just forgets */
  }
}

// ─── Rules ───────────────────────────────────────────────────────────────────

type AuditArea = 'completion' | 'hygiene' | 'accuracy';

type RuleId =
  | 'unrated-completions'
  | 'missing-exe'
  | 'unlinked-duplicates'
  | 'series-gaps'
  | 'default-status'
  | 'stalled-run'
  | 'no-playtime';

type ResolutionKind = 'status' | 'rating' | 'link' | 'exe' | 'launch' | 'none';

interface RuleDef {
  id: RuleId;
  area: AuditArea;
  /** Always a question about the stored record, never a verdict. */
  label: string;
  help: string;
  weight: number;
}

const RULES: RuleDef[] = [
  {
    id: 'unrated-completions',
    area: 'completion',
    label: 'Completed without a rating',
    help: 'A finished game with no score stored — the record is missing your verdict.',
    weight: 2,
  },
  {
    id: 'missing-exe',
    area: 'completion',
    label: 'No executable on record',
    help: 'Without a path stored, session tracking has nothing to watch.',
    weight: 1,
  },
  {
    id: 'unlinked-duplicates',
    area: 'hygiene',
    label: 'Two records, possibly one game',
    help: 'The same title on two stores, stored as unrelated rows.',
    weight: 2,
  },
  {
    id: 'series-gaps',
    area: 'hygiene',
    label: 'Series listed incompletely',
    help: 'The catalog knows entries in a series your library only partly lists.',
    weight: 1,
  },
  {
    id: 'default-status',
    area: 'accuracy',
    label: 'Status may be out of date',
    help: 'Sessions are on record but the stored status never moved off the default.',
    weight: 3,
  },
  {
    id: 'stalled-run',
    area: 'accuracy',
    label: 'Still marked as in progress',
    help: 'Nothing has been recorded for a while — asking whether the stored status is current.',
    weight: 3,
  },
  {
    id: 'no-playtime',
    area: 'accuracy',
    label: 'No hours on record',
    help: 'Nothing stored about time played. Fine if true, worth correcting if not.',
    weight: 1,
  },
];

const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r]));

const AREA_META: Record<
  AuditArea,
  { label: string; blurb: string; color: string; text: string; radius: number }
> = {
  completion: {
    label: 'Completion',
    blurb: 'Fields filled in',
    color: '#00d4ff',
    text: 'text-cyan-300',
    radius: 62,
  },
  hygiene: {
    label: 'Hygiene',
    blurb: 'One row per thing',
    color: '#d946ef',
    text: 'text-fuchsia-300',
    radius: 48,
  },
  accuracy: {
    label: 'Accuracy',
    blurb: 'Still true today',
    color: '#34d399',
    text: 'text-emerald-300',
    radius: 34,
  },
};

const AREA_ORDER: AuditArea[] = ['completion', 'hygiene', 'accuracy'];

/**
 * Bands describe how much of an area we could confirm. A thinner band lifts the
 * severity of that area's findings so the queue leads with the records we know
 * least about — not with whoever has played least.
 */
type Band = 'solid' | 'good' | 'partial' | 'thin';

function bandFor(score: number): Band {
  if (score >= 0.95) return 'solid';
  if (score >= 0.8) return 'good';
  if (score >= 0.55) return 'partial';
  return 'thin';
}

const BAND_LABEL: Record<Band, string> = {
  solid: 'Solid',
  good: 'Good',
  partial: 'Partly filled',
  thin: 'Sparse',
};

const BAND_WEIGHT: Record<Band, number> = {
  solid: 1,
  good: 1.15,
  partial: 1.35,
  thin: 1.6,
};

// ─── Findings ────────────────────────────────────────────────────────────────

interface Finding {
  key: string;
  ruleId: RuleId;
  area: AuditArea;
  subjectId: string;
  title: string;
  /** The record-accuracy question shown to the user. */
  question: string;
  detail: string;
  resolution: ResolutionKind;
  /** Duplicate-link partner, when the resolution is a link. */
  partnerId?: string;
  /** Catalog titles we can see but the library does not list. */
  missingTitles?: string[];
}

interface SeriesGapFinding {
  base: string;
  displayName: string;
  ownedCount: number;
  missing: Array<{ gameId: string; title: string }>;
  missingTotal: number;
}

const STALLED_AFTER_MS = 90 * DAY_MS;
const QUIET_AFTER_MS = 60 * DAY_MS;
const MAX_SERIES_BASES = 8;
const BM25_HITS_PER_BASE = 60;

function normalizeTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function storeOf(gameId: string): string {
  const dash = gameId.indexOf('-');
  return dash > 0 ? gameId.slice(0, dash) : gameId;
}

function steamAppIdOf(gameId: string): number | null {
  if (!gameId.startsWith('steam-')) return null;
  const n = Number(gameId.slice(6));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Rule evaluation over the shared rollups. Returns findings *and* the number of
 * records each rule was able to look at, which is what the rings divide by.
 */
export function evaluateRules(
  rollups: GameRollup[],
  enabled: Set<RuleId>,
  seriesGaps: SeriesGapFinding[],
  nowMs: number,
): { findings: Finding[]; checkable: Record<RuleId, number> } {
  const inLibrary = rollups.filter((r) => r.inLibrary);
  const findings: Finding[] = [];
  const checkable = {
    'unrated-completions': 0,
    'missing-exe': 0,
    'unlinked-duplicates': 0,
    'series-gaps': 0,
    'default-status': 0,
    'stalled-run': 0,
    'no-playtime': 0,
  } as Record<RuleId, number>;

  for (const r of inLibrary) {
    // ── Completion ──
    if (r.status === 'Completed') {
      if (enabled.has('unrated-completions')) {
        checkable['unrated-completions'] += 1;
        if (!(r.rating > 0)) {
          findings.push({
            key: `unrated-completions:${r.gameId}`,
            ruleId: 'unrated-completions',
            area: 'completion',
            subjectId: r.gameId,
            title: r.title,
            question: 'Marked Completed with no rating stored — what would you give it?',
            detail: r.hoursPlayed > 0 ? `${Math.round(r.hoursPlayed)} h on record` : 'No hours on record',
            resolution: 'rating',
          });
        }
      }
    }

    if (enabled.has('missing-exe')) {
      checkable['missing-exe'] += 1;
      if (!r.executablePath) {
        findings.push({
          key: `missing-exe:${r.gameId}`,
          ruleId: 'missing-exe',
          area: 'completion',
          subjectId: r.gameId,
          title: r.title,
          question: 'No executable path stored — point the tracker at it?',
          detail: 'Optional. Sessions simply are not recorded without one.',
          resolution: 'exe',
        });
      }
    }

    // ── Accuracy ──
    if (enabled.has('default-status') && r.status === 'Want to Play' && r.sessionCount > 0) {
      checkable['default-status'] += 1;
      findings.push({
        key: `default-status:${r.gameId}`,
        ruleId: 'default-status',
        area: 'accuracy',
        subjectId: r.gameId,
        title: r.title,
        question: `Filed as Want to Play, but ${r.sessionCount} session${
          r.sessionCount === 1 ? ' is' : 's are'
        } on record — is that still the right label?`,
        detail: r.lastPlayedMs ? `Last recorded ${formatMonthYear(r.lastPlayedMs)}` : '',
        resolution: 'status',
      });
    } else if (enabled.has('default-status') && r.status === 'Want to Play') {
      checkable['default-status'] += 1;
    }

    if (enabled.has('stalled-run') && (r.status === 'Playing' || r.status === 'Playing Now')) {
      checkable['stalled-run'] += 1;
      const lastSignal = r.lastPlayedMs ?? r.statusSinceMs;
      if (lastSignal !== null && lastSignal !== undefined && nowMs - lastSignal > STALLED_AFTER_MS) {
        findings.push({
          key: `stalled-run:${r.gameId}`,
          ruleId: 'stalled-run',
          area: 'accuracy',
          subjectId: r.gameId,
          title: r.title,
          question: `Marked ${r.status}, nothing recorded since ${formatMonthYear(
            lastSignal,
          )} — still true?`,
          detail: `The label has been ${r.status} for ${formatSpan(
            nowMs - (r.statusSinceMs ?? lastSignal),
          )}.`,
          resolution: 'status',
        });
      }
    }

    if (enabled.has('no-playtime')) {
      const settled = r.addedAtMs !== null && nowMs - r.addedAtMs > QUIET_AFTER_MS;
      if (settled && r.status !== 'Want to Play') {
        checkable['no-playtime'] += 1;
        if (r.sessionCount === 0 && !(r.hoursPlayed > 0)) {
          findings.push({
            key: `no-playtime:${r.gameId}`,
            ruleId: 'no-playtime',
            area: 'accuracy',
            subjectId: r.gameId,
            title: r.title,
            question: `Listed as ${r.status} since ${formatMonthYear(
              r.addedAtMs!,
            )} with no hours stored — played somewhere the tracker cannot see?`,
            detail: 'Correct the status, open it, or leave the record as it is.',
            resolution: steamAppIdOf(r.gameId) !== null ? 'launch' : 'status',
          });
        }
      }
    }
  }

  // ── Hygiene: two rows that may be one game ──
  if (enabled.has('unlinked-duplicates')) {
    const byTitle = new Map<string, GameRollup[]>();
    for (const r of inLibrary) {
      const key = normalizeTitleKey(r.title);
      if (key.length < 3) continue;
      const list = byTitle.get(key);
      if (list) list.push(r);
      else byTitle.set(key, [r]);
    }
    for (const list of byTitle.values()) {
      if (list.length < 2) continue;
      checkable['unlinked-duplicates'] += 1;
      const [a, b] = list;
      if (storeOf(a.gameId) === storeOf(b.gameId)) continue;
      if (a.secondaryGameId === b.gameId || b.secondaryGameId === a.gameId) continue;
      findings.push({
        key: `unlinked-duplicates:${a.gameId}`,
        ruleId: 'unlinked-duplicates',
        area: 'hygiene',
        subjectId: a.gameId,
        title: a.title,
        question: `Stored twice — ${storeOf(a.gameId)} and ${storeOf(
          b.gameId,
        )} — with no link between the rows. Same game?`,
        detail: 'Linking keeps hours and status in step across both records.',
        resolution: 'link',
        partnerId: b.gameId,
      });
    }
  }

  // ── Hygiene: series the catalog knows more about than the library ──
  if (enabled.has('series-gaps')) {
    checkable['series-gaps'] += seriesGaps.length;
    for (const gap of seriesGaps) {
      findings.push({
        key: `series-gaps:${gap.base}`,
        ruleId: 'series-gaps',
        area: 'hygiene',
        subjectId: gap.base,
        title: gap.displayName,
        question: `Your library lists ${gap.ownedCount} of this series; the catalog shows ${
          gap.missingTotal
        } more. Missing rows, or just not yours?`,
        detail: '',
        resolution: 'none',
        missingTitles: gap.missing.map((m) => m.title),
      });
    }
  }

  return { findings, checkable };
}

/**
 * Series gaps, the one rule that reaches past the library: canonical franchise
 * base plus BM25 over the catalog already built for Oracle. Bounded to the
 * largest few series so this never becomes a catalog scan.
 */
async function computeSeriesGaps(rollups: GameRollup[]): Promise<SeriesGapFinding[]> {
  const owned = rollups.filter((r) => r.inLibrary);
  if (owned.length === 0) return [];

  const byBase = new Map<string, GameRollup[]>();
  for (const r of owned) {
    const base = canonicalFranchiseBase(r.title);
    if (!base || base.length < 3) continue;
    const list = byBase.get(base);
    if (list) list.push(r);
    else byBase.set(base, [r]);
  }

  const ownedIds = new Set(owned.map((r) => r.gameId));
  const bases = [...byBase.entries()]
    .filter(([, list]) => list.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_SERIES_BASES);

  const out: SeriesGapFinding[] = [];

  for (const [base, list] of bases) {
    const hits = bm25Index.search(base, BM25_HITS_PER_BASE);
    const appIds: number[] = [];
    for (const hit of hits) {
      const appId = steamAppIdOf(hit.id);
      if (appId !== null && !ownedIds.has(hit.id)) appIds.push(appId);
    }
    if (appIds.length === 0) continue;

    const entries = await catalogStore.getEntries(appIds);
    const ownedFields = list.map((r) => ({ title: r.title }));
    const missing: Array<{ gameId: string; title: string }> = [];

    for (const entry of entries) {
      const gameId = `steam-${entry.appid}`;
      if (ownedIds.has(gameId)) continue;
      if (canonicalFranchiseBase(entry.name) !== base) continue;
      if (
        isUmbrellaBrand(base) &&
        !passesUmbrellaMembership(
          { title: entry.name, developer: entry.developer, publisher: entry.publisher },
          ownedFields,
          base,
        )
      ) {
        continue;
      }
      missing.push({ gameId, title: entry.name });
    }

    if (missing.length === 0) continue;
    out.push({
      base,
      displayName: list[0].title.split(/[:\-–]/)[0].trim() || base,
      ownedCount: list.length,
      missing: missing.slice(0, 4),
      missingTotal: missing.length,
    });
  }

  return out;
}

// ─── Rings ───────────────────────────────────────────────────────────────────

interface AreaScore {
  area: AuditArea;
  score: number;
  checked: number;
  open: number;
  band: Band;
}

function AuditRings({ scores }: { scores: AreaScore[] }) {
  const size = 150;
  const center = size / 2;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Record quality">
        <g transform={`rotate(-90 ${center} ${center})`}>
          {scores.map(({ area, score, checked }) => {
            const meta = AREA_META[area];
            const circumference = 2 * Math.PI * meta.radius;
            const complete = checked > 0 && score >= 1;
            return (
              <g key={area}>
                <circle
                  cx={center}
                  cy={center}
                  r={meta.radius}
                  fill="none"
                  stroke="rgba(255,255,255,0.07)"
                  strokeWidth={7}
                />
                {complete && (
                  <motion.circle
                    cx={center}
                    cy={center}
                    r={meta.radius}
                    fill="none"
                    stroke={meta.color}
                    strokeWidth={7}
                    strokeLinecap="round"
                    style={{ filter: 'blur(5px)' }}
                    initial={{ opacity: 0.25 }}
                    animate={{ opacity: [0.25, 0.7, 0.25] }}
                    transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
                  />
                )}
                <motion.circle
                  cx={center}
                  cy={center}
                  r={meta.radius}
                  fill="none"
                  stroke={meta.color}
                  strokeWidth={7}
                  strokeLinecap="round"
                  strokeDasharray={`${circumference * Math.max(0.001, score)} ${circumference}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: checked > 0 ? 0.95 : 0.25 }}
                  transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                />
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

// ─── Data-quality dashboard ──────────────────────────────────────────────────
//
// The aggregate view of record health. Like the rings, everything here scores
// how filled-in and current the *records* are — never how much anyone plays.

const QUALITY_CONFIG: ChartConfig = {
  count: { label: 'Records', color: '#00d4ff' },
  open: { label: 'To review', color: '#d946ef' },
  added: { label: 'Added', color: '#34d399' },
};

interface GaugeSpec {
  key: string;
  label: string;
  blurb: string;
  score: number;
  color: string;
  icon: typeof Gauge;
  detail: string;
}

function QualityGauge({ spec }: { spec: GaugeSpec }) {
  const size = 92;
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, spec.score));
  const Icon = spec.icon;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-3">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={spec.label}>
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke="rgba(255,255,255,0.07)"
              strokeWidth={stroke}
            />
            <motion.circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={spec.color}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${c * Math.max(0.001, pct)} ${c}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.95 }}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            />
          </g>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-lg font-black text-white">
            {Math.round(pct * 100)}%
          </span>
        </div>
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5" style={{ color: spec.color }} />
          <span className="font-mono text-[10px] uppercase tracking-wider text-white/55">
            {spec.label}
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-tight text-white/45">{spec.detail}</p>
        <p className="text-[10px] leading-tight text-white/25">{spec.blurb}</p>
      </div>
    </div>
  );
}

function DashPanel({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Gauge;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
      <div className="mb-3 flex items-center gap-1.5 text-white/45">
        <Icon className="h-3.5 w-3.5" />
        <span className="font-mono text-[10px] uppercase tracking-wider">{title}</span>
      </div>
      {children}
    </div>
  );
}

interface RuleBar {
  id: RuleId;
  label: string;
  count: number;
  color: string;
}

const DataQualityDashboard = memo(function DataQualityDashboard({
  quality,
  statusDist,
  debtTrend,
  issuesByRule,
}: {
  quality: AuditQuality;
  statusDist: Array<{ status: GameStatus | 'Unset'; count: number }>;
  debtTrend: Array<{ key: string; label: string; added: number; decided: number; open: number }>;
  issuesByRule: RuleBar[];
}) {
  const gauges: GaugeSpec[] = [
    {
      key: 'coverage',
      label: 'Coverage',
      blurb: 'Artwork & metadata filled',
      score: quality.coverageScore,
      color: '#00d4ff',
      icon: ImageIcon,
      detail: `${quality.artwork.filled}/${quality.artwork.total} art · ${quality.metadata.filled}/${quality.metadata.total} meta`,
    },
    {
      key: 'completion',
      label: 'Completion verdicts',
      blurb: 'Ratings on finished games',
      score: quality.completionScore,
      color: '#34d399',
      icon: Star,
      detail:
        quality.completionVerdict.total > 0
          ? `${quality.completionVerdict.filled}/${quality.completionVerdict.total} completed rated`
          : `${quality.rating.filled}/${quality.rating.total} rated`,
    },
    {
      key: 'trackable',
      label: 'Session-ready',
      blurb: 'Executable on file to track',
      score: quality.sessionScore,
      color: '#d946ef',
      icon: Gauge,
      detail: `${quality.trackable.filled}/${quality.trackable.total} have an exe`,
    },
  ];

  const totalIssues = issuesByRule.reduce((s, r) => s + r.count, 0);
  const hasTrend = debtTrend.some((m) => m.added > 0 || m.decided > 0 || m.open > 0);

  return (
    <div className="mb-6 space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        {gauges.map((g) => (
          <QualityGauge key={g.key} spec={g} />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <DashPanel title="Open items by rule" icon={ListChecks}>
          {totalIssues > 0 ? (
            <ChartContainer config={QUALITY_CONFIG} className="aspect-[3/1] w-full">
              <BarChart
                data={issuesByRule}
                layout="vertical"
                margin={{ top: 4, right: 12, left: 4, bottom: 4 }}
              >
                <CartesianGrid horizontal={false} stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  type="number"
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                  tick={{ fontSize: 8, fill: 'rgba(255,255,255,0.3)', fontFamily: 'JetBrains Mono, monospace' }}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={128}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.5)', fontFamily: 'JetBrains Mono, monospace' }}
                />
                <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel={false} />} />
                <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                  {issuesByRule.map((r) => (
                    <Cell key={r.id} fill={r.color} />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>
          ) : (
            <p className="py-8 text-center text-xs text-white/35">
              No open items — every checked record is filled in.
            </p>
          )}
        </DashPanel>

        <DashPanel title="Status distribution" icon={Layers}>
          {statusDist.length > 0 ? (
            <ChartContainer config={QUALITY_CONFIG} className="aspect-[3/1] w-full">
              <BarChart data={statusDist} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  dataKey="status"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={4}
                  tick={{ fontSize: 8, fill: 'rgba(255,255,255,0.3)', fontFamily: 'JetBrains Mono, monospace' }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={22}
                  allowDecimals={false}
                  tick={{ fontSize: 8, fill: 'rgba(255,255,255,0.3)', fontFamily: 'JetBrains Mono, monospace' }}
                />
                <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel={false} />} />
                <Bar dataKey="count" fill="#00d4ff" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ChartContainer>
          ) : (
            <p className="py-8 text-center text-xs text-white/35">No records to distribute.</p>
          )}
        </DashPanel>
      </div>

      <DashPanel title="Records to review over time" icon={LineChartIcon}>
        {hasTrend ? (
          <ChartContainer config={QUALITY_CONFIG} className="aspect-[4/1] w-full">
            <AreaChart data={debtTrend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="fillOpen" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-open)" stopOpacity={0.5} />
                  <stop offset="95%" stopColor="var(--color-open)" stopOpacity={0.03} />
                </linearGradient>
                <linearGradient id="fillAddedAudit" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-added)" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="var(--color-added)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.04)" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={4}
                tick={{ fontSize: 8, fill: 'rgba(255,255,255,0.3)', fontFamily: 'JetBrains Mono, monospace' }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={22}
                allowDecimals={false}
                tick={{ fontSize: 8, fill: 'rgba(255,255,255,0.3)', fontFamily: 'JetBrains Mono, monospace' }}
              />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
              <Area
                dataKey="added"
                type="natural"
                fill="url(#fillAddedAudit)"
                stroke="var(--color-added)"
                strokeWidth={1.25}
              />
              <Area
                dataKey="open"
                type="natural"
                fill="url(#fillOpen)"
                stroke="var(--color-open)"
                strokeWidth={1.5}
              />
            </AreaChart>
          </ChartContainer>
        ) : (
          <p className="py-8 text-center text-xs text-white/35">
            Not enough history to chart record curation yet.
          </p>
        )}
        <p className="mt-2 text-[10px] leading-relaxed text-white/30">
          A record counts as “to review” from when it was added until its status first moves off the
          default. This tracks record curation — never how much you play.
        </p>
      </DashPanel>
    </div>
  );
});

// ─── Inline resolution controls ──────────────────────────────────────────────

const STATUS_CHOICES: GameStatus[] = [
  'Want to Play',
  'Playing',
  'Playing Now',
  'On Hold',
  'Completed',
];

function StatusPicker({
  current,
  onPick,
}: {
  current: GameStatus | null;
  onPick: (status: GameStatus) => void;
}) {
  return (
    <select
      value={current ?? ''}
      onChange={(e) => onPick(e.target.value as GameStatus)}
      className="rounded-md border border-white/15 bg-black/50 px-2 py-1 text-xs text-white/80 outline-none transition-colors hover:border-white/30 focus:border-fuchsia-500/60"
      aria-label="Update stored status"
    >
      {current === null && <option value="">Set status…</option>}
      {STATUS_CHOICES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

function RatingPicker({ current, onPick }: { current: number; onPick: (rating: number) => void }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={() => onPick(star)}
          className="p-0.5 transition-transform hover:scale-110"
          aria-label={`Store a ${star} star rating`}
        >
          <Star
            className={cn(
              'h-4 w-4 transition-colors',
              current >= star ? 'fill-yellow-400 text-yellow-400' : 'text-white/25 hover:text-white/50',
            )}
          />
        </button>
      ))}
    </div>
  );
}

// ─── Finding card ────────────────────────────────────────────────────────────

const FindingCard = memo(function FindingCard({
  finding,
  rollup,
  onResolve,
  onSnooze,
  onDismiss,
}: {
  finding: Finding;
  rollup: GameRollup | undefined;
  onResolve: (finding: Finding, detail: string) => void;
  onSnooze: (finding: Finding, ms: number, label: string) => void;
  onDismiss: (finding: Finding) => void;
}) {
  const rule = RULES_BY_ID.get(finding.ruleId)!;
  const meta = AREA_META[finding.area];

  const applyStatus = useCallback(
    (status: GameStatus) => {
      libraryStore.updateEntry(finding.subjectId, { status });
      onResolve(finding, `Status set to ${status}`);
    },
    [finding, onResolve],
  );

  const applyRating = useCallback(
    (rating: number) => {
      libraryStore.updateEntry(finding.subjectId, { rating });
      onResolve(finding, `Rated ${rating}/5`);
    },
    [finding, onResolve],
  );

  const applyLink = useCallback(() => {
    if (!finding.partnerId) return;
    libraryStore.updateEntry(finding.subjectId, { secondaryGameId: finding.partnerId });
    libraryStore.updateEntry(finding.partnerId, { secondaryGameId: finding.subjectId });
    onResolve(finding, 'Records linked');
  }, [finding, onResolve]);

  const applyExe = useCallback(async () => {
    const picker = window.fileDialog?.selectExecutable;
    if (!picker) return;
    const result = await window.fileDialog!.selectExecutable();
    if (result.success && result.filePath) {
      libraryStore.updateEntry(finding.subjectId, { executablePath: result.filePath });
      onResolve(finding, 'Executable path stored');
    }
  }, [finding, onResolve]);

  const applyLaunch = useCallback(() => {
    const appId = steamAppIdOf(finding.subjectId);
    if (appId === null) return;
    window.electron?.openExternal(`steam://rungameid/${appId}`);
  }, [finding.subjectId]);

  return (
    <motion.div
      className="rounded-xl border border-white/[0.07] bg-white/[0.015] px-4 py-3 transition-colors hover:border-white/15"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={cn('font-mono text-[10px] uppercase tracking-wider', meta.text)}>
          {rule.label}
        </span>
        <span className="truncate text-sm font-semibold text-white">{finding.title}</span>
      </div>

      <p className="mt-1 text-sm leading-snug text-white/65">{finding.question}</p>
      {finding.detail && <p className="mt-0.5 text-[11px] text-white/35">{finding.detail}</p>}

      {finding.missingTitles && finding.missingTitles.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {finding.missingTitles.map((t) => (
            <li key={t} className="flex items-center gap-1.5 text-[11px] text-white/45">
              <Layers className="h-3 w-3 shrink-0 text-white/25" />
              <span className="truncate">{t}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {finding.resolution === 'status' && (
          <StatusPicker current={rollup?.status ?? null} onPick={applyStatus} />
        )}
        {finding.resolution === 'rating' && (
          <RatingPicker current={rollup?.rating ?? 0} onPick={applyRating} />
        )}
        {finding.resolution === 'link' && (
          <button
            type="button"
            onClick={applyLink}
            className="flex items-center gap-1.5 rounded-md border border-fuchsia-500/30 bg-fuchsia-500/10 px-2.5 py-1 text-xs text-fuchsia-200 transition-colors hover:bg-fuchsia-500/20"
          >
            <Link2 className="h-3 w-3" />
            Link the two rows
          </button>
        )}
        {finding.resolution === 'exe' && (
          <button
            type="button"
            onClick={() => void applyExe()}
            className="flex items-center gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-xs text-cyan-200 transition-colors hover:bg-cyan-500/20"
          >
            <FolderSearch className="h-3 w-3" />
            Choose executable
          </button>
        )}
        {finding.resolution === 'launch' && (
          <>
            <button
              type="button"
              onClick={applyLaunch}
              className="flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-200 transition-colors hover:bg-emerald-500/20"
            >
              <Play className="h-3 w-3" />
              Open it
            </button>
            <StatusPicker current={rollup?.status ?? null} onPick={applyStatus} />
          </>
        )}

        <div className="ml-auto flex items-center gap-1">
          {SNOOZE_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              type="button"
              onClick={() => onSnooze(finding, opt.ms, opt.label)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-white/40 transition-colors hover:bg-white/5 hover:text-white/70"
            >
              <BellOff className="h-3 w-3" />
              {opt.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => onDismiss(finding)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-white/40 transition-colors hover:bg-white/5 hover:text-white/70"
          >
            <EyeOff className="h-3 w-3" />
            Not an issue
          </button>
        </div>
      </div>
    </motion.div>
  );
});

// ─── Main view ───────────────────────────────────────────────────────────────

type AuditTab = 'queue' | 'rules' | 'trail';

export const JourneyAuditView = memo(function JourneyAuditView({
  journeyEntries,
  libraryEntries,
  statusHistory,
  sessions,
}: JourneyAuditViewProps) {
  const [tab, setTab] = useState<AuditTab>('queue');
  const [persisted, setPersisted] = useState<AuditPersistedState>(loadPersisted);
  const [seriesGaps, setSeriesGaps] = useState<SeriesGapFinding[]>([]);

  const update = useCallback((mutate: (prev: AuditPersistedState) => AuditPersistedState) => {
    setPersisted((prev) => {
      const next = mutate(prev);
      savePersisted(next);
      return next;
    });
  }, []);

  const rollups = useMemo(() => {
    const raw = buildGameRollups({ journeyEntries, libraryEntries, statusHistory, sessions });
    return raw.map((r) => ({ ...r, title: resolveJourneyDisplayTitle(r.gameId, r.title) }));
  }, [journeyEntries, libraryEntries, statusHistory, sessions]);

  const rollupById = useMemo(() => new Map(rollups.map((r) => [r.gameId, r])), [rollups]);

  const enabledRules = useMemo(() => {
    const disabled = new Set(persisted.disabledRules);
    return new Set(RULES.filter((r) => !disabled.has(r.id)).map((r) => r.id));
  }, [persisted.disabledRules]);

  const seriesEnabled = enabledRules.has('series-gaps');
  const libraryKey = useMemo(
    () =>
      rollups
        .filter((r) => r.inLibrary)
        .map((r) => r.gameId)
        .sort()
        .join(','),
    [rollups],
  );

  // The only asynchronous rule. If the catalog has never been synced, BM25 is
  // not ready and the rule simply yields nothing rather than blocking the view.
  useEffect(() => {
    if (!seriesEnabled || libraryKey === '') {
      setSeriesGaps([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const ready = await bm25Index.ensureReady();
        if (cancelled || !ready) return;
        const gaps = await computeSeriesGaps(rollups);
        if (!cancelled) setSeriesGaps(gaps);
      } catch {
        if (!cancelled) setSeriesGaps([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // rollups changes identity with libraryKey; keying on the id list keeps the
    // catalog work off every session tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryKey, seriesEnabled]);

  const nowMs = useMemo(() => Date.now(), [rollups, seriesGaps]);

  const { findings, checkable } = useMemo(
    () => evaluateRules(rollups, enabledRules, seriesGaps, nowMs),
    [rollups, enabledRules, seriesGaps, nowMs],
  );

  const { open, snoozedCount, dismissedCount } = useMemo(() => {
    const openList: Finding[] = [];
    let snoozed = 0;
    let dismissed = 0;
    for (const f of findings) {
      if (persisted.dismissed[f.key]) {
        dismissed += 1;
        continue;
      }
      const until = persisted.snoozed[f.key];
      if (until && until > nowMs) {
        snoozed += 1;
        continue;
      }
      openList.push(f);
    }
    return { open: openList, snoozedCount: snoozed, dismissedCount: dismissed };
  }, [findings, persisted, nowMs]);

  const scores = useMemo<AreaScore[]>(() => {
    return AREA_ORDER.map((area) => {
      let checked = 0;
      for (const rule of RULES) {
        if (rule.area !== area || !enabledRules.has(rule.id)) continue;
        checked += checkable[rule.id];
      }
      const openHere = open.filter((f) => f.area === area).length;
      const score = checked > 0 ? Math.max(0, 1 - openHere / checked) : 1;
      return { area, score, checked, open: openHere, band: bandFor(score) };
    });
  }, [checkable, open, enabledRules]);

  const bandByArea = useMemo(() => {
    const map = {} as Record<AuditArea, Band>;
    for (const s of scores) map[s.area] = s.band;
    return map;
  }, [scores]);

  const queue = useMemo(() => {
    return [...open].sort((a, b) => {
      const wa = (RULES_BY_ID.get(a.ruleId)?.weight ?? 1) * BAND_WEIGHT[bandByArea[a.area]];
      const wb = (RULES_BY_ID.get(b.ruleId)?.weight ?? 1) * BAND_WEIGHT[bandByArea[b.area]];
      if (wb !== wa) return wb - wa;
      return a.title.localeCompare(b.title);
    });
  }, [open, bandByArea]);

  // ── Data-quality dashboard inputs — all pure, all record-scoped ──
  const quality = useMemo(
    () => computeAuditQuality({ rollups, libraryEntries, journeyEntries }),
    [rollups, libraryEntries, journeyEntries],
  );
  const statusDist = useMemo(() => computeStatusDistribution(rollups), [rollups]);
  const debtTrend = useMemo(
    () => computeOpenItemsTrend(rollups, statusHistory, nowMs, 12),
    [rollups, statusHistory, nowMs],
  );
  const issuesByRule = useMemo(() => {
    const counts = new Map<RuleId, number>();
    for (const f of open) counts.set(f.ruleId, (counts.get(f.ruleId) ?? 0) + 1);
    return [...counts.entries()]
      .map(([id, count]) => {
        const rule = RULES_BY_ID.get(id);
        return {
          id,
          label: rule?.label ?? id,
          count,
          color: rule ? AREA_META[rule.area].color : '#d946ef',
        };
      })
      .sort((a, b) => b.count - a.count);
  }, [open]);

  const pushTrail = useCallback(
    (action: TrailAction, finding: Finding, detail: string) => {
      update((prev) => ({
        ...prev,
        trail: [
          {
            id: `${finding.key}:${Date.now()}`,
            atMs: Date.now(),
            action,
            ruleId: finding.ruleId,
            subject: finding.title,
            detail,
          },
          ...prev.trail,
        ].slice(0, TRAIL_LIMIT),
      }));
    },
    [update],
  );

  const handleResolve = useCallback(
    (finding: Finding, detail: string) => pushTrail('resolved', finding, detail),
    [pushTrail],
  );

  const handleSnooze = useCallback(
    (finding: Finding, ms: number, label: string) => {
      update((prev) => ({
        ...prev,
        snoozed: { ...prev.snoozed, [finding.key]: Date.now() + ms },
        trail: [
          {
            id: `${finding.key}:${Date.now()}`,
            atMs: Date.now(),
            action: 'snoozed' as TrailAction,
            ruleId: finding.ruleId,
            subject: finding.title,
            detail: `Hidden for ${label}`,
          },
          ...prev.trail,
        ].slice(0, TRAIL_LIMIT),
      }));
    },
    [update],
  );

  const handleDismiss = useCallback(
    (finding: Finding) => {
      update((prev) => ({
        ...prev,
        dismissed: { ...prev.dismissed, [finding.key]: Date.now() },
        trail: [
          {
            id: `${finding.key}:${Date.now()}`,
            atMs: Date.now(),
            action: 'dismissed' as TrailAction,
            ruleId: finding.ruleId,
            subject: finding.title,
            detail: 'Marked not an issue',
          },
          ...prev.trail,
        ].slice(0, TRAIL_LIMIT),
      }));
    },
    [update],
  );

  const restoreHidden = useCallback(() => {
    update((prev) => ({ ...prev, snoozed: {}, dismissed: {} }));
  }, [update]);

  const toggleRule = useCallback(
    (id: RuleId) => {
      update((prev) => {
        const disabled = new Set(prev.disabledRules);
        if (disabled.has(id)) disabled.delete(id);
        else disabled.add(id);
        return { ...prev, disabledRules: [...disabled] };
      });
    },
    [update],
  );

  const libraryCount = useMemo(() => rollups.filter((r) => r.inLibrary).length, [rollups]);
  const hiddenTotal = snoozedCount + dismissedCount;

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 md:px-8 lg:px-10">
      {/* Rings — data completeness only. Play volume is not scored here, and
          deliberately never will be. */}
      <div className="mb-6 flex flex-col items-center gap-6 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6 sm:flex-row">
        <AuditRings scores={scores} />

        <div className="min-w-0 flex-1">
          <div className="grid gap-2 sm:grid-cols-3">
            {scores.map((s) => {
              const meta = AREA_META[s.area];
              return (
                <div
                  key={s.area}
                  className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2"
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: meta.color }}
                      aria-hidden
                    />
                    <span className="font-mono text-[10px] uppercase tracking-wider text-white/50">
                      {meta.label}
                    </span>
                  </div>
                  <p className={cn('mt-0.5 font-mono text-xl font-black', meta.text)}>
                    {s.checked > 0 ? `${Math.round(s.score * 100)}%` : '—'}
                  </p>
                  <p className="text-[11px] text-white/35">
                    {s.checked > 0
                      ? `${BAND_LABEL[s.band]} · ${s.open} open of ${s.checked} checked`
                      : 'Nothing to check yet'}
                  </p>
                  <p className="text-[10px] text-white/25">{meta.blurb}</p>
                </div>
              );
            })}
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-white/35">
            These rings score your <span className="text-white/60">records</span> — how much of
            each one is filled in and whether it still matches reality. They never score how much
            you play, because there is no correct amount.
          </p>
        </div>
      </div>

      {/* Data-quality dashboard — scored coverage gauges plus the aggregate
          charts. Same hard line as the rings: it grades records, not playing. */}
      {libraryCount > 0 && (
        <DataQualityDashboard
          quality={quality}
          statusDist={statusDist}
          debtTrend={debtTrend}
          issuesByRule={issuesByRule}
        />
      )}

      {/* Section switcher */}
      <div className="mb-4 flex items-center gap-2">
        <div className="flex items-center rounded-xl border border-white/[0.06] bg-white/[0.04] p-1">
          {(
            [
              ['queue', 'Queue', ListChecks],
              ['rules', 'Rules', SlidersHorizontal],
              ['trail', 'Trail', History],
            ] as Array<[AuditTab, string, typeof ListChecks]>
          ).map(([id, label, TabIcon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-medium transition-colors',
                tab === id
                  ? 'bg-fuchsia-500 text-white shadow-md shadow-fuchsia-500/20'
                  : 'text-white/50 hover:text-white/80',
              )}
            >
              <TabIcon className="h-3.5 w-3.5" />
              {label}
              {id === 'queue' && queue.length > 0 && (
                <span className="rounded-full bg-black/25 px-1.5 font-mono text-[10px]">
                  {queue.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {hiddenTotal > 0 && (
          <button
            type="button"
            onClick={restoreHidden}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-white/45 transition-colors hover:text-white/80"
          >
            <Undo2 className="h-3 w-3" />
            Bring back {hiddenTotal} hidden
          </button>
        )}
      </div>

      {tab === 'queue' && (
        <div className="space-y-2">
          {libraryCount === 0 ? (
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] p-10 text-center">
              <ClipboardCheck className="mx-auto mb-3 h-8 w-8 text-white/25" />
              <h3 className="mb-1 font-['Orbitron'] text-base font-bold text-white">
                No records to check yet
              </h3>
              <p className="mx-auto max-w-sm text-sm text-white/50">
                Audit reads the library. Once there are entries in it, this is where anything
                incomplete or out of date shows up.
              </p>
            </div>
          ) : queue.length === 0 ? (
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.04] p-10 text-center">
              <CheckCircle2 className="mx-auto mb-3 h-8 w-8 text-emerald-300" />
              <h3 className="mb-1 font-['Orbitron'] text-base font-bold text-white">
                Everything checks out
              </h3>
              <p className="mx-auto max-w-sm text-sm text-white/50">
                {hiddenTotal > 0
                  ? `Nothing open across ${libraryCount} records. ${hiddenTotal} item${
                      hiddenTotal === 1 ? ' is' : 's are'
                    } hidden by you.`
                  : `Nothing open across ${libraryCount} records.`}
              </p>
            </div>
          ) : (
            queue.map((finding) => (
              <FindingCard
                key={finding.key}
                finding={finding}
                rollup={rollupById.get(finding.subjectId)}
                onResolve={handleResolve}
                onSnooze={handleSnooze}
                onDismiss={handleDismiss}
              />
            ))
          )}
        </div>
      )}

      {tab === 'rules' && (
        <div className="grid gap-2 sm:grid-cols-2">
          {RULES.map((rule) => {
            const meta = AREA_META[rule.area];
            const on = enabledRules.has(rule.id);
            return (
              <label
                key={rule.id}
                className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.015] px-4 py-3 transition-colors hover:border-white/15"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleRule(rule.id)}
                  className="mt-1 h-3.5 w-3.5 accent-fuchsia-500"
                />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium text-white/85">{rule.label}</span>
                    <span
                      className={cn('font-mono text-[10px] uppercase tracking-wider', meta.text)}
                    >
                      {meta.label}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-tight text-white/40">
                    {rule.help}
                  </span>
                  <span className="mt-1 block font-mono text-[10px] text-white/25">
                    {checkable[rule.id]} record{checkable[rule.id] === 1 ? '' : 's'} checked
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}

      {tab === 'trail' && (
        <div className="space-y-1.5">
          {persisted.trail.length === 0 ? (
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] p-10 text-center">
              <History className="mx-auto mb-3 h-8 w-8 text-white/25" />
              <p className="text-sm text-white/50">
                Resolutions, snoozes and dismissals are recorded here as you make them.
              </p>
            </div>
          ) : (
            persisted.trail.map((t) => (
              <div
                key={t.id}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg border border-white/[0.05] bg-white/[0.015] px-3 py-2"
              >
                <span className="font-mono text-[10px] uppercase tracking-wider text-white/35">
                  {new Date(t.atMs).toLocaleDateString('en-US', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </span>
                <span className="text-xs font-medium text-white/80">{t.subject}</span>
                <span className="text-[11px] text-white/40">{t.detail}</span>
                <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-white/25">
                  {RULES_BY_ID.get(t.ruleId)?.label ?? t.ruleId}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
});
