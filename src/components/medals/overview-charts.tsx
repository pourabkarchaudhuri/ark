/**
 * Overview charts — recharts-based shadcn activity area chart & genre radar.
 * Uses canonical genres so FPS/Shooter and Sport/Sports etc. merge.
 */
import { memo, useState, useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, PolarAngleAxis, PolarGrid, Radar, RadarChart } from 'recharts';
import type { JourneyEntry, StatusChangeEntry, GameSession, LibraryGameEntry } from '@/types/game';
import { toCanonicalGenre, getCanonicalGenres } from '@/data/canonical-genres';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// ─── Compute analytics for overview sections ─────────────────────────────────

export function computeOverviewAnalytics(
  journeyEntries: JourneyEntry[],
  statusHistory: StatusChangeEntry[],
  sessions: GameSession[],
  libraryEntries: LibraryGameEntry[],
) {
  const now = new Date();

  const monthlyActivity: { date: string; label: string; added: number; completed: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleDateString('en-US', { month: 'short' });
    const year = d.getFullYear();
    const month = d.getMonth();
    const date = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const addedCount = journeyEntries.filter((e) => {
      const added = new Date(e.addedAt);
      return added.getFullYear() === year && added.getMonth() === month;
    }).length;
    const completedCount = statusHistory.filter((h) => {
      if (h.newStatus !== 'Completed') return false;
      const ts = new Date(h.timestamp);
      return ts.getFullYear() === year && ts.getMonth() === month;
    }).length;
    monthlyActivity.push({ date, label, added: addedCount, completed: completedCount });
  }

  const genreCounts: Record<string, number> = {};
  for (const entry of journeyEntries) {
    for (const g of entry.genre) {
      const can = toCanonicalGenre(g);
      if (can) genreCounts[can] = (genreCounts[can] || 0) + 1;
    }
  }
  const canonical = getCanonicalGenres();
  const maxGenreCount = Math.max(1, ...Object.values(genreCounts));
  const genreRadar = canonical.map((genre) => ({
    label: genre,
    value: Math.round(((genreCounts[genre] ?? 0) / maxGenreCount) * 100),
    count: genreCounts[genre] ?? 0,
  }));

  const sessionDays = new Set<string>();
  for (const ses of sessions) {
    const d = new Date(ses.startTime);
    sessionDays.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  }
  const sortedDays = [...sessionDays]
    .map((key) => {
      const [y, m, d] = key.split('-').map(Number);
      return new Date(y, m, d);
    })
    .sort((a, b) => a.getTime() - b.getTime());

  let currentStreak = 0;
  let longestStreak = 0;
  if (sortedDays.length > 0) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = `${yesterday.getFullYear()}-${yesterday.getMonth()}-${yesterday.getDate()}`;
    if (sessionDays.has(todayKey) || sessionDays.has(yesterdayKey)) {
      const startFrom = sessionDays.has(todayKey) ? today : yesterday;
      const check = new Date(startFrom);
      while (true) {
        const key = `${check.getFullYear()}-${check.getMonth()}-${check.getDate()}`;
        if (sessionDays.has(key)) {
          currentStreak++;
          check.setDate(check.getDate() - 1);
        } else break;
      }
    }
    let streak = 1;
    for (let i = 1; i < sortedDays.length; i++) {
      const diff = (sortedDays[i].getTime() - sortedDays[i - 1].getTime()) / 86_400_000;
      if (Math.round(diff) === 1) streak++;
      else {
        longestStreak = Math.max(longestStreak, streak);
        streak = 1;
      }
    }
    longestStreak = Math.max(longestStreak, streak);
  }

  const recSourceMap: Record<string, { count: number }> = {};
  for (const le of libraryEntries) {
    const src = le.recommendationSource || 'Unknown';
    recSourceMap[src] = (recSourceMap[src] || { count: 0 });
    recSourceMap[src].count++;
  }
  const recSources = Object.entries(recSourceMap)
    .map(([source, data]) => ({ source, count: data.count }))
    .sort((a, b) => b.count - a.count);

  const statusCounts: Record<string, number> = {};
  for (const e of journeyEntries) {
    statusCounts[e.status] = (statusCounts[e.status] || 0) + 1;
  }
  const totalGames = journeyEntries.length;
  const totalHours = journeyEntries.reduce((s, e) => s + (e.hoursPlayed ?? 0), 0);

  return {
    monthlyActivity,
    genreRadar,
    currentStreak,
    longestStreak,
    recSources,
    statusCounts,
    totalGames,
    totalHours,
  };
}

// ─── Activity area chart (interactive, recharts) ──────────────────────────────

const activityChartConfig = {
  added: {
    label: 'Added',
    color: 'hsl(292, 84%, 61%)',
  },
  completed: {
    label: 'Completed',
    color: 'hsl(142, 71%, 45%)',
  },
} satisfies ChartConfig;

export const ActivityAreaChart = memo(function ActivityAreaChart({
  data,
}: {
  data: { date: string; label: string; added: number; completed: number }[];
}) {
  const [timeRange, setTimeRange] = useState('12m');

  const filteredData = useMemo(() => {
    if (timeRange === '12m') return data;
    const months = timeRange === '6m' ? 6 : 3;
    return data.slice(-months);
  }, [data, timeRange]);

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex items-center justify-between mb-1 shrink-0">
        <p className="text-[9px] text-white/30 font-mono uppercase tracking-widest">
          Activity
        </p>
        <Select value={timeRange} onValueChange={setTimeRange}>
          <SelectTrigger
            className="h-5 w-[90px] rounded text-[9px] font-mono bg-white/[0.04] border-white/10 text-white/60 px-1.5 py-0"
            aria-label="Select time range"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg bg-black/90 border-white/10 min-w-[90px]">
            <SelectItem value="12m" className="text-[10px] font-mono">12 months</SelectItem>
            <SelectItem value="6m" className="text-[10px] font-mono">6 months</SelectItem>
            <SelectItem value="3m" className="text-[10px] font-mono">3 months</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex-1 min-h-0">
        <ChartContainer config={activityChartConfig} className="h-full w-full aspect-auto">
          <AreaChart data={filteredData}>
            <defs>
              <linearGradient id="fillAdded" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-added)" stopOpacity={0.7} />
                <stop offset="95%" stopColor="var(--color-added)" stopOpacity={0.05} />
              </linearGradient>
              <linearGradient id="fillCompleted" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-completed)" stopOpacity={0.6} />
                <stop offset="95%" stopColor="var(--color-completed)" stopOpacity={0.05} />
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
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => String(value)}
                  indicator="dot"
                />
              }
            />
            <Area
              dataKey="completed"
              type="natural"
              fill="url(#fillCompleted)"
              stroke="var(--color-completed)"
              strokeWidth={1.5}
              stackId="a"
            />
            <Area
              dataKey="added"
              type="natural"
              fill="url(#fillAdded)"
              stroke="var(--color-added)"
              strokeWidth={1.5}
              stackId="a"
            />
            <ChartLegend content={<ChartLegendContent />} />
          </AreaChart>
        </ChartContainer>
      </div>
    </div>
  );
});

// ─── Genre radar chart (recharts) ────────────────────────────────────────────

const genreRadarConfig = {
  value: {
    label: 'Affinity',
    color: 'hsl(187, 96%, 42%)',
  },
} satisfies ChartConfig;

export const GenreRadarChart = memo(function GenreRadarChart({
  data,
}: {
  data: { label: string; value: number; count: number }[];
}) {
  const top = useMemo(() => {
    const sorted = [...data].sort((a, b) => b.value - a.value);
    return sorted.filter(d => d.value > 0).slice(0, 8);
  }, [data]);

  if (top.length < 3) return null;

  return (
    <ChartContainer config={genreRadarConfig} className="mx-auto aspect-square h-full w-full">
      <RadarChart data={top}>
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent hideLabel />}
        />
        <PolarGrid gridType="circle" stroke="rgba(255,255,255,0.08)" />
        <PolarAngleAxis
          dataKey="label"
          tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.55)', fontFamily: 'JetBrains Mono, monospace' }}
        />
        <Radar
          dataKey="value"
          fill="hsl(187, 96%, 42%)"
          fillOpacity={0.4}
          stroke="hsl(187, 96%, 42%)"
          strokeWidth={1.5}
          dot={{ r: 3, fillOpacity: 1 }}
        />
      </RadarChart>
    </ChartContainer>
  );
});

// ─── Data Sources radar chart (recharts) ─────────────────────────────────────

const dataSourcesConfig = {
  count: {
    label: 'Games',
    color: 'hsl(187, 100%, 50%)',
  },
} satisfies ChartConfig;

function TruncatedTick({ x, y, payload, textAnchor }: { x: number; y: number; payload: { value: string }; textAnchor: 'start' | 'middle' | 'end' | 'inherit' }) {
  const label = payload.value.length > 10 ? payload.value.slice(0, 9) + '…' : payload.value;
  return (
    <text x={x} y={y} textAnchor={textAnchor} fontSize={9} fill="rgba(255,255,255,0.55)" fontFamily="JetBrains Mono, monospace">
      {label}
    </text>
  );
}

export const DataSourcesRadar = memo(function DataSourcesRadar({
  data,
}: {
  data: { source: string; count: number }[];
}) {
  const top = useMemo(() => data.slice(0, 8), [data]);

  if (top.length < 3) return null;

  return (
    <ChartContainer config={dataSourcesConfig} className="mx-auto aspect-square h-full w-full">
      <RadarChart data={top} outerRadius="60%">
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent hideLabel />}
        />
        <PolarGrid gridType="circle" stroke="rgba(255,255,255,0.08)" />
        <PolarAngleAxis
          dataKey="source"
          tick={TruncatedTick as never}
        />
        <Radar
          dataKey="count"
          fill="hsl(187, 100%, 50%)"
          fillOpacity={0.4}
          stroke="hsl(187, 100%, 50%)"
          strokeWidth={1.5}
          dot={{ r: 3, fillOpacity: 1 }}
        />
      </RadarChart>
    </ChartContainer>
  );
});
