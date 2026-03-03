import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Flame, Trophy, Calendar } from 'lucide-react';
import { sessionStore } from '@/services/session-store';
import { cn } from '@/lib/utils';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Mon','','Wed','','Fri','','Sun'];

const INTENSITY: [number, string][] = [
  [180, 'bg-emerald-400/80'],
  [90, 'bg-emerald-500/60'],
  [30, 'bg-emerald-500/40'],
  [1, 'bg-emerald-500/20'],
];
const EMPTY_CLASS = 'bg-white/[0.04]';

function intensityClass(minutes: number): string {
  for (const [threshold, cls] of INTENSITY) {
    if (minutes >= threshold) return cls;
  }
  return EMPTY_CLASS;
}

function formatHours(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export const PlayStreakHeatmap = memo(function PlayStreakHeatmap() {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    return sessionStore.subscribe(() => setRevision(r => r + 1));
  }, []);

  const heatmap = useMemo(() => sessionStore.getSessionHeatmap(365), [revision]);
  const currentStreak = useMemo(() => sessionStore.getCurrentStreak(), [revision]);
  const longestStreak = useMemo(() => sessionStore.getLongestStreak(), [revision]);
  const activeDays = useMemo(() => sessionStore.getActiveDaysThisYear(), [revision]);
  const [tooltip, setTooltip] = useState<{ key: string; minutes: number; x: number; y: number } | null>(null);

  const { weeks, monthLabels } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const start = new Date(today);
    start.setDate(start.getDate() - 364);
    const dayOfWeek = start.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    start.setDate(start.getDate() + mondayOffset);

    const weeks: { key: string; minutes: number; date: Date }[][] = [];
    const monthLabels: { label: string; col: number }[] = [];
    let currentWeek: { key: string; minutes: number; date: Date }[] = [];
    let lastMonth = -1;

    const cursor = new Date(start);
    while (cursor <= today) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
      const minutes = heatmap.get(key) || 0;
      currentWeek.push({ key, minutes, date: new Date(cursor) });

      if (cursor.getMonth() !== lastMonth) {
        monthLabels.push({ label: MONTHS[cursor.getMonth()], col: weeks.length });
        lastMonth = cursor.getMonth();
      }

      if (currentWeek.length === 7) {
        weeks.push(currentWeek);
        currentWeek = [];
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    if (currentWeek.length > 0) weeks.push(currentWeek);

    return { weeks, monthLabels };
  }, [heatmap]);

  const totalMinutes = useMemo(() => {
    let sum = 0;
    for (const v of heatmap.values()) sum += v;
    return sum;
  }, [heatmap]);

  const handleCellHover = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const key = el.dataset.key!;
    const minutes = Number(el.dataset.minutes);
    const rect = el.getBoundingClientRect();
    setTooltip({ key, minutes, x: rect.left, y: rect.top - 36 });
  }, []);

  const handleCellLeave = useCallback(() => setTooltip(null), []);

  return (
    <div className="space-y-4">
      {/* ── Streak stats bar ── */}
      <div className="flex flex-wrap gap-4">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-orange-500/20 bg-orange-500/5">
          <Flame className="w-4 h-4 text-orange-400" />
          <div>
            <p className="text-xs font-mono text-white/50">Current Streak</p>
            <p className="text-lg font-black font-mono text-orange-400">{currentStreak} <span className="text-xs text-white/40">days</span></p>
          </div>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-500/5">
          <Trophy className="w-4 h-4 text-amber-400" />
          <div>
            <p className="text-xs font-mono text-white/50">Longest Streak</p>
            <p className="text-lg font-black font-mono text-amber-400">{longestStreak} <span className="text-xs text-white/40">days</span></p>
          </div>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5">
          <Calendar className="w-4 h-4 text-emerald-400" />
          <div>
            <p className="text-xs font-mono text-white/50">Active Days (Year)</p>
            <p className="text-lg font-black font-mono text-emerald-400">{activeDays} <span className="text-xs text-white/40">days</span></p>
          </div>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-cyan-500/20 bg-cyan-500/5">
          <div className="w-4 h-4 flex items-center justify-center text-cyan-400 font-mono text-xs font-black">Σ</div>
          <div>
            <p className="text-xs font-mono text-white/50">Total (Year)</p>
            <p className="text-lg font-black font-mono text-cyan-400">{formatHours(totalMinutes)}</p>
          </div>
        </div>
      </div>

      {/* ── Heatmap grid ── */}
      <div className="relative overflow-x-auto pb-2">
        {/* Month labels */}
        <div className="flex ml-8 mb-1 gap-0" style={{ minWidth: weeks.length * 14 }}>
          {monthLabels.map((m, i) => (
            <span
              key={`${m.label}-${i}`}
              className="text-[9px] font-mono text-white/30 absolute"
              style={{ left: 32 + m.col * 14 }}
            >
              {m.label}
            </span>
          ))}
        </div>

        <div className="flex mt-4">
          {/* Day labels */}
          <div className="flex flex-col gap-[2px] mr-1 pt-0">
            {DAYS.map((d, i) => (
              <span key={i} className="text-[9px] font-mono text-white/25 h-[12px] leading-[12px] w-6 text-right">
                {d}
              </span>
            ))}
          </div>

          {/* Grid — event data piped via data-* attributes to avoid per-cell closures */}
          <div className="flex gap-[2px] relative">
            {weeks.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-[2px]">
                {week.map(day => (
                  <div
                    key={day.key}
                    data-key={day.key}
                    data-minutes={day.minutes}
                    className={cn(
                      'w-[12px] h-[12px] rounded-[2px] transition-colors cursor-default',
                      intensityClass(day.minutes),
                    )}
                    onMouseEnter={handleCellHover}
                    onMouseLeave={handleCellLeave}
                  />
                ))}
                {week.length < 7 && Array.from({ length: 7 - week.length }).map((_, i) => (
                  <div key={`empty-${i}`} className="w-[12px] h-[12px]" />
                ))}
              </div>
            ))}

            {/* Tooltip */}
            {tooltip && (
              <div
                className="fixed z-50 px-2 py-1 rounded bg-black/90 border border-white/10 text-[10px] font-mono text-white/80 pointer-events-none whitespace-nowrap"
                style={{ left: tooltip.x, top: tooltip.y }}
              >
                {tooltip.key}: {tooltip.minutes > 0 ? formatHours(tooltip.minutes) : 'No activity'}
              </div>
            )}
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-1.5 mt-3 ml-8">
          <span className="text-[9px] font-mono text-white/30">Less</span>
          <div className="w-[12px] h-[12px] rounded-[2px] bg-white/[0.04]" />
          <div className="w-[12px] h-[12px] rounded-[2px] bg-emerald-500/20" />
          <div className="w-[12px] h-[12px] rounded-[2px] bg-emerald-500/40" />
          <div className="w-[12px] h-[12px] rounded-[2px] bg-emerald-500/60" />
          <div className="w-[12px] h-[12px] rounded-[2px] bg-emerald-400/80" />
          <span className="text-[9px] font-mono text-white/30">More</span>
        </div>
      </div>
    </div>
  );
});
