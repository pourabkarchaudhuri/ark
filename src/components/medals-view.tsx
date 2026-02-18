/**
 * Medals of Honor — Bento + Tabs Layout
 *
 * Overview: 3 vertical portrait cards — Commander XP | Taste DNA | Data Source
 * Bottom: Tabs — Overview | Badge Vault
 */
import { memo, useEffect, useRef, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Shield, Flame, Trophy, Globe } from 'lucide-react';
import type { JourneyEntry } from '@/types/game';
import { statusHistoryStore } from '@/services/status-history-store';
import { sessionStore } from '@/services/session-store';
import { libraryStore } from '@/services/library-store';
import { useBadgeProgress } from '@/hooks/useBadgeProgress';
import { TIER_NEON } from '@/data/badge-types';
import { DnaRadar } from '@/components/medals/taste-dna';
import { BadgeVault } from '@/components/medals/badge-vault';
import { computeOverviewAnalytics, GenreRadarChart, ActivityAreaChart } from '@/components/medals/overview-charts';
import { Icon } from '@/components/ui/evervault-card';
import DatabaseWithRestApi from '@/components/ui/database-with-rest-api';
import { cn } from '@/lib/utils';

interface MedalsViewProps {
  entries: JourneyEntry[];
}

// ─── Animated counter ───────────────────────────────────────────────────────

function AnimNum({ value, className }: { value: number; className?: string }) {
  const [display, setDisplay] = useState(0);
  const ref = useRef(0);
  useEffect(() => {
    const start = ref.current;
    const diff = value - start;
    if (diff === 0) return;
    const duration = 600;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - t0) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = Math.round(start + diff * eased);
      setDisplay(v);
      if (p < 1) requestAnimationFrame(tick);
      else ref.current = value;
    };
    requestAnimationFrame(tick);
  }, [value]);
  return <span className={className}>{display.toLocaleString()}</span>;
}

// ─── Tile wrapper ───────────────────────────────────────────────────────────

function Tile({ children, className, delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div
      className={cn('rounded-2xl border border-white/[0.06] bg-white/[0.015] backdrop-blur-sm overflow-hidden', className)}
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

// ─── Tab type ───────────────────────────────────────────────────────────────

type MedalsTab = 'overview' | 'vault';

// ─── Main View ──────────────────────────────────────────────────────────────

export const MedalsView = memo(function MedalsView({ entries }: MedalsViewProps) {
  const [medalsTab, setMedalsTab] = useState<MedalsTab>('overview');

  const statusHistoryRef = useRef(statusHistoryStore.getAll());
  const sessionsRef = useRef(sessionStore.getAll());
  const libraryEntriesRef = useRef(libraryStore.getAllEntries());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const bump = () => setTick(t => t + 1);
    const unsubs = [
      statusHistoryStore.subscribe(() => { statusHistoryRef.current = statusHistoryStore.getAll(); bump(); }),
      sessionStore.subscribe(() => { sessionsRef.current = sessionStore.getAll(); bump(); }),
      libraryStore.subscribe(() => { libraryEntriesRef.current = libraryStore.getAllEntries(); bump(); }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  const data = useBadgeProgress(
    entries,
    statusHistoryRef.current,
    sessionsRef.current,
    libraryEntriesRef.current,
  );

  const tierSummary = useMemo(() => {
    const counts = { bronze: 0, silver: 0, gold: 0, platinum: 0, diamond: 0 };
    for (const bp of data.badges) {
      if (bp.unlocked) counts[bp.badge.tier]++;
    }
    return counts;
  }, [data.badges]);

  const xpInLevel = data.totalPoints % 100;
  const xpTarget = 100;

  const commanderRank = useMemo(() => {
    const lv = data.commanderLevel;
    if (lv >= 100) return 'VOID WALKER';
    if (lv >= 76) return 'FLEET ADMIRAL';
    if (lv >= 51) return 'ADMIRAL';
    if (lv >= 36) return 'COMMANDER';
    if (lv >= 21) return 'CAPTAIN';
    if (lv >= 11) return 'LIEUTENANT';
    if (lv >= 6) return 'ENSIGN';
    return 'CADET';
  }, [data.commanderLevel]);

  const overviewAnalytics = useMemo(
    () => computeOverviewAnalytics(
      entries,
      statusHistoryRef.current,
      sessionsRef.current,
      libraryEntriesRef.current,
    ),
    [entries, tick],
  );

  const { totalHours, completedCount, topGenre } = useMemo(() => {
    let hours = 0;
    let completed = 0;
    const gc = new Map<string, number>();
    for (const e of entries) {
      hours += e.hoursPlayed ?? 0;
      if (e.status === 'Completed') completed++;
      for (const g of e.genre) gc.set(g, (gc.get(g) || 0) + 1);
    }
    let best = '';
    let bestN = 0;
    for (const [g, n] of gc) { if (n > bestN) { best = g; bestN = n; } }
    return { totalHours: Math.round(hours), completedCount: completed, topGenre: best || '—' };
  }, [entries]);

  const CYAN = '#00d4ff';

  return (
    <div className="flex flex-col gap-4 px-2 md:px-4 lg:px-6 pb-4 min-h-0 flex-1 h-[calc(100vh-6rem)] overflow-hidden">

      {/* ═══════════════════════════════════════════════════════════
       *  TAB SWITCHER — top, 3 views
       * ═══════════════════════════════════════════════════════════ */}
      <div className="flex items-center bg-white/[0.04] rounded-xl p-1 border border-white/[0.06] self-start">
        {([
          { value: 'overview' as MedalsTab, label: 'Overview', icon: Shield },
          { value: 'vault' as MedalsTab, label: 'Badge Vault', icon: Trophy },
        ]).map(tab => {
          const Icon = tab.icon;
          const active = medalsTab === tab.value;
          return (
            <button key={tab.value} onClick={() => setMedalsTab(tab.value)}
              className={cn(
                'px-4 py-2 text-xs font-medium rounded-lg transition-all flex items-center gap-1.5',
                active
                  ? 'bg-fuchsia-500 text-white shadow-md shadow-fuchsia-500/20'
                  : 'text-white/50 hover:text-white/80',
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ═══════════════════════════════════════════════════════════
       *  TAB CONTENT — constrained height so Overview fits without scroll; Vault scrolls inside
       * ═══════════════════════════════════════════════════════════ */}
      <div className="flex-1 min-h-0 overflow-auto">
      <AnimatePresence mode="wait">
        {medalsTab === 'overview' && (
          <motion.div key="overview" className="flex flex-col gap-3 flex-1 min-h-0 max-h-full overflow-hidden"
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
          >
      {/* ═══ Overview — 2 rows: Row1 Commander | Taste DNA | Data sources; Row2 Activity | Genre radar | Stats ─══ */}
      <div className="grid grid-rows-[1fr_1fr] grid-cols-1 md:grid-cols-3 gap-3 flex-1 min-h-0 auto-rows-fr">
        {/* ─── 1. Commander XP — vault-style portrait card ───────── */}
        <Tile className="p-0 overflow-hidden flex-1 min-h-0 flex flex-col" delay={0}>
          <div
            className={cn(
              'relative flex flex-col w-full flex-1 min-h-0 p-4 rounded-xl border',
              'border-black/[0.2] dark:border-white/[0.2] bg-white/[0.02] dark:bg-black/40',
              'hover:shadow-[0_0_20px_rgba(0,212,255,0.12)] hover:border-cyan-500/30 transition-shadow duration-200'
            )}
          >
            <Icon className="absolute top-2 left-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute top-2 right-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute bottom-2 left-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute bottom-2 right-2 h-4 w-4 dark:text-white text-black z-10" />
            <div className="relative z-[2] flex flex-col flex-1 min-h-0">
              <div className="mt-[10px] mb-2">
                <span className="text-[11px] font-mono uppercase tracking-wider text-white/40">// THE ARK</span>
              </div>
              <div className="flex items-center justify-between gap-2 mb-3">
                <span className="text-xs font-bold font-mono uppercase tracking-wider" style={{ color: CYAN }}>COMMANDER</span>
                <span className="text-xs font-mono text-white/70 tabular-nums">
                  <AnimNum value={data.totalPoints} /> / {((data.commanderLevel) * 100).toLocaleString()} XP
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full overflow-hidden bg-white/10 border border-white/10 mb-4">
                <motion.div
                  className="h-full rounded-full"
                  style={{ background: `linear-gradient(90deg, ${CYAN}, #0891b2)` }}
                  initial={{ width: 0 }}
                  animate={{ width: `${(xpInLevel / xpTarget) * 100}%` }}
                  transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
                />
              </div>
              <div className="flex items-end gap-3 mb-4">
                <img
                  src={`${import.meta.env.BASE_URL}spaceman-commander.png`}
                  alt=""
                  className="block object-contain object-bottom w-20 h-24 drop-shadow-lg flex-shrink-0"
                />
                <div className="flex flex-col justify-end pb-0.5">
                  <span className="text-xs font-mono text-white/50">Rank</span>
                  <span className="text-base font-bold font-mono" style={{ color: CYAN }}>{commanderRank}</span>
                </div>
                <div
                  className="ml-auto flex flex-col items-center justify-center px-2 py-1 rounded border"
                  style={{ background: 'linear-gradient(180deg, #fef08a 0%, #eab308 100%)', borderColor: '#facc15' }}
                >
                  <span className="text-[9px] font-black font-mono text-black leading-none">LVL</span>
                  <span className="text-sm font-black font-mono text-black leading-none">{data.commanderLevel}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 mb-3 text-white/50">
                <Globe className="w-4 h-4 flex-shrink-0" style={{ color: CYAN }} />
                <span className="text-xs font-mono uppercase tracking-wider">Location · THE ARK</span>
              </div>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="px-2 py-1.5 rounded-lg border border-cyan-500/25 bg-cyan-500/5">
                  <span className="text-xs font-mono text-white/50 block">Wins</span>
                  <span className="text-base font-black font-mono text-white"><AnimNum value={completedCount} /></span>
                </div>
                <div className="px-2 py-1.5 rounded-lg border border-cyan-500/25 bg-cyan-500/5">
                  <span className="text-xs font-mono text-white/50 block">Games</span>
                  <span className="text-base font-black font-mono text-white"><AnimNum value={entries.length} /></span>
                </div>
              </div>
              <div className="space-y-1 mb-3 text-xs font-mono">
                <div className="flex justify-between"><span className="text-white/50">Favorite Genre</span><span style={{ color: CYAN }}>{topGenre.toUpperCase()}</span></div>
                <div className="flex justify-between"><span className="text-white/50">Total Hours</span><span style={{ color: CYAN }}><AnimNum value={totalHours} /></span></div>
              </div>
              <div className="mt-auto pt-3 border-t border-white/10 flex flex-wrap gap-x-2 gap-y-1">
                {(['bronze', 'silver', 'gold', 'platinum', 'diamond'] as const).map(tier => {
                  const neon = TIER_NEON[tier];
                  return (
                    <div key={tier} className="flex items-center gap-1">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: neon.color }} />
                      <span className="text-xs font-mono font-bold" style={{ color: neon.color }}>{tierSummary[tier]}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </Tile>

        {/* ─── 2. Taste DNA — vault-style portrait card with compact radar ───── */}
        <Tile className="p-0 overflow-hidden flex-1 min-h-0 flex flex-col" delay={0.05}>
          <div
            className={cn(
              'relative flex flex-col w-full flex-1 min-h-0 p-4 rounded-xl border',
              'border-black/[0.2] dark:border-white/[0.2] bg-white/[0.02] dark:bg-black/40',
              'hover:shadow-[0_0_20px_rgba(217,70,239,0.12)] hover:border-fuchsia-500/30 transition-shadow duration-200'
            )}
          >
            <Icon className="absolute top-2 left-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute top-2 right-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute bottom-2 left-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute bottom-2 right-2 h-4 w-4 dark:text-white text-black z-10" />
            <div className="relative z-[2] flex flex-col flex-1 min-h-0">
              <div className="mt-[10px] mb-2 flex items-center gap-1.5">
                <Flame className="w-4 h-4 text-fuchsia-500/80" />
                <span className="text-[11px] font-mono uppercase tracking-wider text-white/40">// TASTE DNA</span>
              </div>
              <p className="text-xs text-white/30 font-mono uppercase tracking-widest mb-2">Genome</p>
              <div className="flex-1 min-h-0 flex flex-col items-center justify-center [&_svg]:max-h-[220px] [&_svg]:w-auto">
                <DnaRadar axes={data.tasteDna} genomePurity={data.genomePurity} />
              </div>
              <div className="mt-2 pt-2 border-t border-white/10 grid grid-cols-2 gap-x-3 gap-y-1">
                {data.tasteDna.slice(0, 4).map(a => (
                  <div key={a.key} className="flex justify-between text-xs font-mono">
                    <span className="text-white/50 truncate">{a.label}</span>
                    <span className="text-fuchsia-400 font-bold tabular-nums">{a.value}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Tile>

        {/* ─── 3. Data Source — vault-style portrait card + DatabaseWithRestApi ───── */}
        <Tile className="p-0 overflow-hidden flex-1 min-h-0 flex flex-col" delay={0.1}>
          <div
            className={cn(
              'relative flex flex-col w-full flex-1 min-h-0 p-4 rounded-xl border overflow-hidden',
              'border-black/[0.2] dark:border-white/[0.2] bg-white/[0.02] dark:bg-black/40',
              'hover:shadow-[0_0_20px_rgba(0,212,255,0.12)] hover:border-cyan-500/30 transition-shadow duration-200'
            )}
          >
            <Icon className="absolute top-2 left-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute top-2 right-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute bottom-2 left-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute bottom-2 right-2 h-4 w-4 dark:text-white text-black z-10" />
            <div className="relative z-[2] flex flex-col flex-1 min-h-0 items-center overflow-hidden">
              <div className="mt-[10px] mb-2 w-full flex-shrink-0">
                <span className="text-[11px] font-mono uppercase tracking-wider text-white/40">// DATA SOURCES</span>
              </div>
              <div className="flex-1 w-full flex items-center justify-center min-h-0 overflow-hidden">
                <DatabaseWithRestApi
                  className="h-full w-full max-w-full"
                  badgeTexts={{
                    first: 'Library',
                    second: 'Sessions',
                    third: 'History',
                    fourth: 'Ratings',
                  }}
                  buttonTexts={{
                    first: data.tasteDna[0]?.label ?? 'Genome',
                    second: 'Taste DNA',
                  }}
                  title="Taste DNA from your activity"
                  lightColor="#00d4ff"
                />
              </div>
            </div>
          </div>
        </Tile>

        {/* ─── 4. Activity graph (below Commander) ───── */}
        <Tile className="p-0 overflow-hidden flex-1 min-h-0 flex flex-col" delay={0.15}>
          <div
            className={cn(
              'relative flex flex-col w-full flex-1 min-h-0 p-4 rounded-xl border',
              'border-black/[0.2] dark:border-white/[0.2] bg-white/[0.02] dark:bg-black/40',
              'hover:shadow-[0_0_20px_rgba(217,70,239,0.1)] hover:border-fuchsia-500/20 transition-shadow duration-200',
            )}
          >
            <Icon className="absolute top-2 left-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute top-2 right-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute bottom-2 left-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute bottom-2 right-2 h-4 w-4 dark:text-white text-black z-10" />
            <div className="relative z-[2] flex flex-col flex-1 min-h-0">
              <div className="mt-[10px] mb-2">
                <span className="text-[11px] font-mono uppercase tracking-wider text-white/40">// ACTIVITY</span>
              </div>
              <p className="text-[10px] text-white/30 font-mono uppercase tracking-widest mb-2">Last 12 months</p>
              <div className="flex-1 min-h-0 flex items-center [&_svg]:max-h-[100px] [&_svg]:w-full">
                <ActivityAreaChart
                  data={overviewAnalytics.monthlyActivity}
                  data2={overviewAnalytics.monthlyCompletions}
                />
              </div>
              <div className="flex gap-4 mt-1.5 text-[10px] font-mono text-white/40">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-fuchsia-500/60" /> Added</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-green-500/60" /> Completed</span>
              </div>
            </div>
          </div>
        </Tile>

        {/* ─── Genre radar (below Taste DNA) ───── */}
        <Tile className="p-0 overflow-hidden flex-1 min-h-0 flex flex-col" delay={0.2}>
          <div
            className={cn(
              'relative flex flex-col w-full flex-1 min-h-0 p-4 rounded-xl border',
              'border-black/[0.2] dark:border-white/[0.2] bg-white/[0.02] dark:bg-black/40',
              'hover:shadow-[0_0_20px_rgba(6,182,212,0.12)] hover:border-cyan-500/20 transition-shadow duration-200',
            )}
          >
            <Icon className="absolute top-2 left-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute top-2 right-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute bottom-2 left-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute bottom-2 right-2 h-4 w-4 dark:text-white text-black z-10" />
            <div className="relative z-[2] flex flex-col flex-1 min-h-0">
              <div className="mt-[10px] mb-2">
                <span className="text-[11px] font-mono uppercase tracking-wider text-white/40">// GENRE RADAR</span>
              </div>
              <p className="text-[10px] text-white/30 font-mono uppercase tracking-widest mb-2">Top genres</p>
              <div className="flex-1 min-h-0 flex flex-col items-center justify-center">
                {overviewAnalytics.genreRadar.length >= 3 ? (
                  <GenreRadarChart data={overviewAnalytics.genreRadar} size={overviewAnalytics.genreRadar.length > 10 ? 200 : 160} color="#06b6d4" />
                ) : (
                  <p className="text-xs text-white/40 text-center py-4">Add more games with genres to see radar</p>
                )}
              </div>
            </div>
          </div>
        </Tile>

        {/* ─── Stats / Analytics (below Data sources) ───── */}
        <Tile className="p-0 overflow-hidden flex-1 min-h-0 flex flex-col" delay={0.25}>
          <div
            className={cn(
              'relative flex flex-col w-full flex-1 min-h-0 p-4 rounded-xl border',
              'border-black/[0.2] dark:border-white/[0.2] bg-white/[0.02] dark:bg-black/40',
              'hover:shadow-[0_0_20px_rgba(0,212,255,0.1)] hover:border-cyan-500/20 transition-shadow duration-200',
            )}
          >
            <Icon className="absolute top-2 left-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute top-2 right-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute bottom-2 left-2 h-4 w-4 dark:text-white text-black z-10" />
            <Icon className="absolute bottom-2 right-2 h-4 w-4 dark:text-white text-black z-10" />
            <div className="relative z-[2] flex flex-col flex-1 min-h-0">
              <div className="mt-[10px] mb-2">
                <span className="text-[11px] font-mono uppercase tracking-wider text-white/40">// STATS</span>
              </div>
              <div className="flex-1 min-h-0 flex flex-col gap-3">
                <div className="flex items-center gap-4">
                  <div>
                    <p className="text-lg font-black font-mono text-cyan-400">{overviewAnalytics.totalGames}</p>
                    <p className="text-[10px] text-white/40">games</p>
                  </div>
                  <div className="w-px h-8 bg-white/10" />
                  <div>
                    <p className="text-lg font-black font-mono text-fuchsia-400">{Math.round(overviewAnalytics.totalHours)}h</p>
                    <p className="text-[10px] text-white/40">played</p>
                  </div>
                </div>
                {(overviewAnalytics.currentStreak > 0 || overviewAnalytics.longestStreak > 0) && (
                  <div className="flex gap-4 text-xs font-mono">
                    <span className="text-orange-400">{overviewAnalytics.currentStreak} day streak</span>
                    <span className="text-amber-400">Best {overviewAnalytics.longestStreak}</span>
                  </div>
                )}
                {overviewAnalytics.recSources.length > 0 && (
                  <div className="mt-auto pt-2 border-t border-white/10">
                    <p className="text-[10px] text-white/40 font-mono uppercase tracking-wider mb-1.5">Top sources</p>
                    <div className="space-y-1">
                      {overviewAnalytics.recSources.slice(0, 4).map(({ source, count }) => (
                        <div key={source} className="flex justify-between text-[10px] font-mono">
                          <span className="text-white/60 truncate max-w-[70%]">{source}</span>
                          <span className="text-white/40">{count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Tile>
      </div>
          </motion.div>
        )}

        {medalsTab === 'vault' && (
          <motion.div key="vault" className="min-h-full"
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
          >
            <Tile className="p-4" delay={0}>
              <BadgeVault badges={data.badges} unlockedCount={data.unlockedCount} />
            </Tile>
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </div>
  );
});
