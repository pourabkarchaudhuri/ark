/**
 * Ark Construction Log — DevLog Timeline
 *
 * Terminal-aesthetic vertical timeline that visualises
 * the daily dev journal (docs/dev-journal.json).
 * Dev-mode only.
 */
import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';

interface DevJournalDay {
  date: string;
  title: string;
  tags: string[];
  narrative: string;
  filesChanged: string[];
  milestones: string[];
  challenges: string[];
  lookingAhead: string | null;
}

interface DevJournalData {
  project: string;
  days: DevJournalDay[];
}
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Terminal,
  RefreshCw,
  Hash,
  Minus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// ─── Constants ────────────────────────────────────────────────────────────────

const TAG_ICONS: Record<string, string> = {
  milestone:   '◆',
  challenge:   '▲',
  progress:    '●',
  decision:    '◇',
  exploration: '◎',
  fix:         '✦',
};

const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

// ─── Date helpers ─────────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

function relativeDay(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T00:00:00');
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const diff = Math.floor((now.getTime() - d.getTime()) / 86400000);
    if (diff === 0) return 'today';
    if (diff === 1) return 'yesterday';
    if (diff < 7) return `${diff}d ago`;
    if (diff < 30) return `${Math.floor(diff / 7)}w ago`;
    const m = Math.floor(diff / 30);
    return `${m}mo ago`;
  } catch {
    return '';
  }
}

function stardate(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T00:00:00');
    const start = new Date(d.getFullYear(), 0, 0);
    const dayOfYear = Math.floor((d.getTime() - start.getTime()) / 86400000);
    return `${d.getFullYear()}.${String(dayOfYear).padStart(3, '0')}`;
  } catch {
    return '0000.000';
  }
}

function constructionAge(days: DevJournalDay[]): string {
  if (days.length === 0) return '';
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const first = new Date(sorted[0].date + 'T00:00:00');
  const last = new Date(sorted[sorted.length - 1].date + 'T00:00:00');
  const span = Math.floor((last.getTime() - first.getTime()) / 86400000) + 1;
  if (span === 1) return '1 day';
  if (span < 30) return `${span} days`;
  const months = Math.floor(span / 30);
  const rem = span % 30;
  return rem > 0 ? `${months}mo ${rem}d` : `${months}mo`;
}

// ─── Typing cursor ────────────────────────────────────────────────────────────

function Cursor() {
  return (
    <span className="inline-block w-[7px] h-[14px] bg-white/50 ml-0.5 align-middle animate-pulse" />
  );
}

// ─── Stats row (terminal style) ───────────────────────────────────────────────

const StatsHeader = memo(function StatsHeader({ days }: { days: DevJournalDay[] }) {
  const totalDays = days.length;
  const totalMilestones = days.reduce((n, d) => n + d.milestones.length, 0);
  const totalChallenges = days.reduce((n, d) => n + d.challenges.length, 0);
  const totalFiles = new Set(days.flatMap(d => d.filesChanged)).size;
  const age = constructionAge(days);

  const stats = [
    { label: 'entries', value: totalDays },
    { label: 'milestones', value: totalMilestones },
    { label: 'challenges', value: totalChallenges },
    { label: 'files', value: totalFiles },
  ];

  return (
    <div className="font-mono text-[13px] text-white/30 flex flex-wrap items-center gap-x-5 gap-y-1.5">
      {stats.map(s => (
        <span key={s.label}>
          <span className="text-white/50 tabular-nums">{s.value}</span>
          <span className="text-white/25 ml-1">{s.label}</span>
        </span>
      ))}
      {age && (
        <span>
          <span className="text-white/50">{age}</span>
          <span className="text-white/25 ml-1">build time</span>
        </span>
      )}
    </div>
  );
});

// ─── Tag Distribution ─────────────────────────────────────────────────────────

const TagBar = memo(function TagBar({ days }: { days: DevJournalDay[] }) {
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of days) for (const t of d.tags) m.set(t.toLowerCase(), (m.get(t.toLowerCase()) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [days]);

  const total = tagCounts.reduce((s, [, c]) => s + c, 0);
  if (total === 0) return null;

  return (
    <div className="flex items-center gap-3 mt-3">
      <div className="flex-1 h-[3px] rounded-full overflow-hidden bg-white/[0.03] flex">
        {tagCounts.map(([tag, count]) => {
          const pct = (count / total) * 100;
          return (
            <div
              key={tag}
              className="h-full bg-white/[0.12] border-r border-black/40 last:border-r-0"
              style={{ width: `${pct}%` }}
              title={`${tag}: ${count}`}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-2.5 shrink-0">
        {tagCounts.slice(0, 4).map(([tag, count]) => (
          <span key={tag} className="font-mono text-[11px] text-white/25">
            <span className="text-white/15 mr-0.5">{TAG_ICONS[tag] ?? '·'}</span>
            {count}
          </span>
        ))}
      </div>
    </div>
  );
});

// ─── Timeline Entry Card ──────────────────────────────────────────────────────

interface DayCardProps {
  day: DevJournalDay;
  index: number;
  isLatest: boolean;
}

const DayCard = memo(function DayCard({ day, index, isLatest }: DayCardProps) {
  const [filesExpanded, setFilesExpanded] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.5, delay: Math.min(index * 0.06, 0.5), ease: EASE_OUT }}
      className="relative pl-8 sm:pl-10"
    >
      {/* Timeline dot */}
      <div className={cn(
        'absolute left-0 top-[22px] w-2.5 h-2.5 rounded-full z-10',
        isLatest
          ? 'bg-fuchsia-500 shadow-[0_0_8px_rgba(217,70,239,0.4)]'
          : 'bg-fuchsia-500/20 border border-fuchsia-500/20',
      )} />

      {/* Connector */}
      <div className="absolute left-[9px] top-[26px] w-3 sm:w-4 h-px bg-fuchsia-500/10" />

      {/* Card — overflow-visible so the terminal readout can float outside */}
      <div className={cn(
        'relative border rounded-lg transition-colors duration-300 overflow-visible',
        'bg-black/40 backdrop-blur-md',
        isLatest ? 'border-white/[0.10]' : 'border-white/[0.05]',
      )}>
        {/* Floating terminal readout — right edge */}
        <div className="absolute left-full top-0 bottom-0 ml-3 hidden xl:flex flex-col justify-start py-4 select-none pointer-events-none" style={{ width: 160 }}>
          <div className="flex flex-col gap-[3px] font-mono text-[10px] leading-none tracking-wider text-fuchsia-400/30">
            <span className="text-fuchsia-400/20">// CONSTRUCTION LOG</span>
            <span className="mt-1.5">DATE::{stardate(day.date)}</span>
            <span className="text-fuchsia-400/50">{formatDate(day.date)}</span>
            <span className="mt-1.5">REL::{relativeDay(day.date).toUpperCase()}</span>
            {day.tags.length > 0 && (
              <>
                <span className="mt-1.5">TAGS::{day.tags.length}</span>
                {day.tags.slice(0, 3).map((t: string) => (
                  <span key={t} className="text-fuchsia-400/40">{TAG_ICONS[t.toLowerCase()] ?? '·'} {t.toUpperCase()}</span>
                ))}
              </>
            )}
            {day.milestones.length > 0 && <span className="mt-1.5 text-emerald-400/40">MILES::{day.milestones.length}</span>}
            {day.challenges.length > 0 && <span className="text-amber-400/40">CHAL::{day.challenges.length}</span>}
            {day.filesChanged.length > 0 && <span className="text-fuchsia-400/20">FILES::{day.filesChanged.length}</span>}
          </div>
        </div>

        {/* Header */}
        <div className="px-5 pt-4 pb-3">
          {/* Date row */}
          <div className="flex items-center gap-2 mb-2">
            <span className="font-mono text-xs text-white/30 tabular-nums tracking-wide">
              {stardate(day.date)}
            </span>
            <span className="text-white/[0.08]">|</span>
            <span className="font-mono text-xs text-white/20">
              {formatDate(day.date)}
            </span>
            <span className="font-mono text-[11px] text-white/15 ml-auto sm:ml-0">
              {relativeDay(day.date)}
            </span>
          </div>

          {/* Title */}
          <h3 className="text-base font-medium leading-snug text-white/80 mb-2.5">
            {day.title}
          </h3>

          {/* Tags */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {day.tags.map((tag: string) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] tracking-wider uppercase text-white/30 border border-white/[0.08] bg-white/[0.02]"
              >
                <span className="text-[9px]">{TAG_ICONS[tag.toLowerCase()] ?? '·'}</span>
                {tag}
              </span>
            ))}
          </div>
        </div>

        {/* Body — always visible, no scroll, fits all content */}
        <div className="px-5 pb-5 space-y-4">
          {/* Divider */}
          <div className="h-px bg-white/[0.04]" />

          {/* Narrative — full height, no scroll */}
          <div className="font-mono text-sm text-white/50 leading-[1.9] whitespace-pre-wrap">
            {day.narrative.split('\n\n').map((para: string, i: number) => (
              <p key={i} className={i > 0 ? 'mt-4' : ''}>
                <span className="text-white/[0.12] select-none mr-2">{'>'}</span>
                {para}
              </p>
            ))}
          </div>

          {/* Milestones */}
          {day.milestones.length > 0 && (
            <div className="space-y-1.5 pl-3 border-l-2 border-emerald-500/20">
              {day.milestones.map((m: string, i: number) => (
                <div key={i} className="flex items-start gap-2.5 py-0.5">
                  <span className="font-mono text-xs text-emerald-400/30 select-none mt-px">◆</span>
                  <span className="font-mono text-[13px] text-white/45 leading-relaxed">{m}</span>
                </div>
              ))}
            </div>
          )}

          {/* Challenges */}
          {day.challenges.length > 0 && (
            <div className="space-y-1.5 pl-3 border-l-2 border-amber-500/20">
              {day.challenges.map((c: string, i: number) => (
                <div key={i} className="flex items-start gap-2.5 py-0.5">
                  <span className="font-mono text-xs text-amber-400/30 select-none mt-px">▲</span>
                  <span className="font-mono text-[13px] text-white/40 leading-relaxed">{c}</span>
                </div>
              ))}
            </div>
          )}

          {/* Looking Ahead */}
          {day.lookingAhead && (
            <div className="flex items-start gap-2.5 px-4 py-3 rounded-md bg-white/[0.02] border border-white/[0.04]">
              <ChevronRight className="h-3.5 w-3.5 text-white/20 mt-0.5 shrink-0" />
              <span className="font-mono text-[13px] text-white/30 italic leading-relaxed">{day.lookingAhead}</span>
            </div>
          )}

          {/* Files Changed */}
          {day.filesChanged.length > 0 && (
            <div>
              <button
                onClick={e => { e.stopPropagation(); setFilesExpanded(v => !v); }}
                className="flex items-center gap-1.5 font-mono text-[11px] text-white/20 hover:text-white/40 transition-colors cursor-pointer"
              >
                <Hash className="h-3 w-3" />
                {day.filesChanged.length} file{day.filesChanged.length !== 1 ? 's' : ''} changed
                {filesExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>

              <AnimatePresence>
                {filesExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-2 rounded bg-black/40 border border-white/[0.03] p-2.5 space-y-px">
                      {day.filesChanged.map((f: string, i: number) => (
                        <div key={i} className="font-mono text-[11px] text-white/25 truncate py-0.5 px-1.5 rounded hover:bg-white/[0.03]" title={f}>
                          <span className="text-white/10 select-none mr-1.5">$</span>{f}
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
});

// ─── Empty State ──────────────────────────────────────────────────────────────

function EmptyJournal({ isElectron }: { isElectron: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[min(60vh,400px)] py-12 text-center px-4">
      <div className="w-14 h-14 rounded-lg bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-6">
        <Terminal className="h-6 w-6 text-white/20" />
      </div>
      <h3 className="font-mono text-sm font-medium text-white/40 tracking-wider mb-2">
        NO ENTRIES LOGGED
      </h3>
      <p className="font-mono text-[13px] text-white/25 max-w-md leading-relaxed">
        {isElectron
          ? 'No entries yet. This log shows development updates when the app is built with Cursor or when a journal file is present.'
          : 'The construction log requires the Electron runtime. Run the app via Electron to view the dev journal.'}
      </p>
      <p className="font-mono text-[11px] text-white/15 mt-4">
        {isElectron ? 'Journal file: docs/dev-journal.json' : 'window.devlog unavailable'}
      </p>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface DevLogViewProps {
  onBack: () => void;
}

export function DevLogView({ onBack }: DevLogViewProps) {
  const [journal, setJournal] = useState<DevJournalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isElectron = typeof window !== 'undefined' && !!window.devlog;
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadJournal = useCallback(async () => {
    if (!window.devlog) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await window.devlog.getJournal();
      setJournal(data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load journal');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadJournal(); }, [loadJournal]);

  const sortedDays = useMemo(() => {
    const days = journal?.days ?? [];
    return [...days].sort((a, b) => b.date.localeCompare(a.date));
  }, [journal]);

  return (
    <div className="flex flex-col max-w-3xl xl:max-w-4xl mx-auto" style={{ height: 'calc(100vh - 11rem)' }}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="shrink-0 pb-5">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <Button
              onClick={onBack}
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-white/30 hover:text-white/60 hover:bg-white/[0.04] border border-white/[0.06] rounded-md font-mono text-[10px] gap-1 cursor-pointer"
            >
              <ArrowLeft className="h-3 w-3" />
              BACK
            </Button>

            <div className="flex items-center gap-2 font-mono text-sm text-white/40">
              <Terminal className="h-4 w-4 text-white/25" />
              <span className="font-medium tracking-wider">construction.log</span>
              {sortedDays.length > 0 && (
                <span className="text-white/20 text-[11px]">({sortedDays.length})</span>
              )}
            </div>
          </div>

          <Button
            onClick={loadJournal}
            variant="ghost"
            size="sm"
            disabled={loading || !isElectron}
            className="h-7 px-2 text-white/20 hover:text-white/40 hover:bg-white/[0.04] border border-white/[0.04] rounded-md font-mono text-[9px] gap-1 cursor-pointer"
          >
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
            RELOAD
          </Button>
        </div>

        {/* Project line */}
        <div className="font-mono text-xs text-white/[0.15] tracking-wider mb-3">
          <span className="text-white/[0.10] select-none mr-1.5">$</span>
          project: {journal?.project ?? '—'}
          <span className="text-white/[0.08] mx-2">|</span>
          vessel: ark
          <Cursor />
        </div>

        {/* Stats */}
        {sortedDays.length > 0 && (
          <>
            <StatsHeader days={sortedDays} />
            <TagBar days={sortedDays} />
          </>
        )}
      </div>

      {/* ── Scrollable Timeline ────────────────────────────────── */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar" style={{ overflowX: 'clip' }}>
        {loading ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div className="w-6 h-6 border border-white/20 border-t-white/50 rounded-full animate-spin" />
            <span className="font-mono text-xs text-white/25 tracking-wider">loading...</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Minus className="h-5 w-5 text-white/20" />
            <span className="font-mono text-xs text-white/35 max-w-md text-center">{error}</span>
            <Button
              onClick={loadJournal}
              variant="ghost"
              size="sm"
              className="h-6 text-white/20 hover:text-white/40 font-mono text-[9px] gap-1 cursor-pointer"
            >
              <RefreshCw className="h-2.5 w-2.5" /> retry
            </Button>
          </div>
        ) : sortedDays.length === 0 ? (
          <EmptyJournal isElectron={isElectron} />
        ) : (
          <div className="relative pb-8">
            {/* Vertical timeline line */}
            <div className="absolute left-[3px] top-4 bottom-4 w-px bg-gradient-to-b from-fuchsia-500/25 via-fuchsia-500/10 to-transparent" />

            {/* Day entries */}
            <div className="space-y-4">
              {sortedDays.map((day, i) => (
                <DayCard
                  key={day.date}
                  day={day}
                  index={i}
                  isLatest={i === 0}
                />
              ))}
            </div>

            {/* Terminus */}
            <div className="relative pl-8 sm:pl-10 pt-6">
              <div className="absolute left-[1px] top-[30px] w-1.5 h-1.5 rounded-full bg-fuchsia-500/15" />
              <span className="font-mono text-[11px] text-white/15 tracking-wider">
                // origin — construction begins
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
