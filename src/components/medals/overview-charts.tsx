/**
 * Overview charts — genre radar and activity area chart.
 * Logic and visuals inspired by Journey Analytics view.
 * Uses canonical genres so FPS/Shooter and Sport/Sports etc. merge.
 */
import { memo } from 'react';
import type { JourneyEntry, StatusChangeEntry, GameSession, LibraryGameEntry } from '@/types/game';
import { toCanonicalGenre, getCanonicalGenres } from '@/data/canonical-genres';

// ─── Compute analytics for overview sections ─────────────────────────────────

export function computeOverviewAnalytics(
  journeyEntries: JourneyEntry[],
  statusHistory: StatusChangeEntry[],
  sessions: GameSession[],
  libraryEntries: LibraryGameEntry[],
) {
  const now = new Date();

  const monthlyActivity: { label: string; count: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleDateString('en-US', { month: 'short' });
    const year = d.getFullYear();
    const month = d.getMonth();
    const count = journeyEntries.filter((e) => {
      const added = new Date(e.addedAt);
      return added.getFullYear() === year && added.getMonth() === month;
    }).length;
    monthlyActivity.push({ label, count });
  }

  const monthlyCompletions: { label: string; count: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleDateString('en-US', { month: 'short' });
    const year = d.getFullYear();
    const month = d.getMonth();
    const count = statusHistory.filter((h) => {
      if (h.newStatus !== 'Completed') return false;
      const ts = new Date(h.timestamp);
      return ts.getFullYear() === year && ts.getMonth() === month;
    }).length;
    monthlyCompletions.push({ label, count });
  }

  const genreCounts: Record<string, number> = {};
  for (const entry of journeyEntries) {
    for (const g of entry.genre) {
      const can = toCanonicalGenre(g);
      if (can) genreCounts[can] = (genreCounts[can] || 0) + 1;
    }
  }
  // Use all canonical genres for radar (same axes as Taste DNA); 0 for genres with no plays
  const canonical = getCanonicalGenres();
  const maxGenreCount = Math.max(1, ...Object.values(genreCounts));
  const genreRadar = canonical.map((genre) => ({
    label: genre,
    value: (genreCounts[genre] ?? 0) / maxGenreCount,
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
    monthlyCompletions,
    genreRadar,
    currentStreak,
    longestStreak,
    recSources,
    statusCounts,
    totalGames,
    totalHours,
  };
}

// ─── Genre radar chart (SVG) ─────────────────────────────────────────────────

export const GenreRadarChart = memo(function GenreRadarChart({
  data,
  size = 180,
  levels = 4,
  color = '#06b6d4',
}: {
  data: { label: string; value: number }[];
  size?: number;
  levels?: number;
  color?: string;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const radius = (size - 40) / 2;
  const n = data.length;
  if (n < 3) return null;

  function getPoint(index: number, r: number): { x: number; y: number } {
    const angle = (index * 2 * Math.PI) / n - Math.PI / 2;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  }

  const gridRings = Array.from({ length: levels }, (_, i) => {
    const r = (radius * (i + 1)) / levels;
    return Array.from({ length: n }, (_, j) => getPoint(j, r)).map((p) => `${p.x},${p.y}`).join(' ');
  });
  const dataPoints = data.map((d, i) => getPoint(i, d.value * radius));
  const dataPolygon = dataPoints.map((p) => `${p.x},${p.y}`).join(' ');
  const axisEndpoints = Array.from({ length: n }, (_, i) => getPoint(i, radius));
  const labelPositions = data.map((d, i) => {
    const angle = (i * 2 * Math.PI) / n - Math.PI / 2;
    const labelR = radius + 18;
    return { x: cx + labelR * Math.cos(angle), y: cy + labelR * Math.sin(angle), label: d.label };
  });

  const gradId = `overview-radar-${color.replace('#', '')}`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="mx-auto">
      <defs>
        <radialGradient id={gradId}>
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.08" />
        </radialGradient>
      </defs>
      {gridRings.map((points, i) => (
        <polygon key={i} points={points} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
      ))}
      {axisEndpoints.map((pt, i) => (
        <line key={i} x1={cx} y1={cy} x2={pt.x} y2={pt.y} stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
      ))}
      <polygon points={dataPolygon} fill={`url(#${gradId})`} stroke={color} strokeWidth="1.5" strokeLinejoin="round" opacity="0.9" />
      {dataPoints.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="2.5" fill={color} stroke="rgba(0,0,0,0.3)" strokeWidth="0.5" />
      ))}
      {labelPositions.map((lp, i) => (
        <text key={i} x={lp.x} y={lp.y} textAnchor="middle" dominantBaseline="central" fill="rgba(255,255,255,0.6)" fontSize="8" fontWeight="500">
          {lp.label}
        </text>
      ))}
    </svg>
  );
});

// ─── Activity area chart (monthly added + completed) ──────────────────────────

export const ActivityAreaChart = memo(function ActivityAreaChart({
  data,
  data2,
  className,
}: {
  data: { label: string; count: number }[];
  data2?: { label: string; count: number }[];
  className?: string;
}) {
  const width = 380;
  const height = 120;
  const px = 8;
  const ptop = 8;
  const pb = 18;
  const chartW = width - px * 2;
  const chartH = height - ptop - pb;

  const allValues = [...data.map((d) => d.count), ...(data2?.map((d) => d.count) ?? [])];
  const maxVal = Math.max(1, ...allValues);

  function toPoints(values: number[]): { x: number; y: number }[] {
    return values.map((v, i) => ({
      x: px + (i / Math.max(values.length - 1, 1)) * chartW,
      y: ptop + chartH - (v / maxVal) * chartH,
    }));
  }
  function smoothPath(pts: { x: number; y: number }[]): string {
    if (pts.length === 0) return '';
    if (pts.length === 1) return `M ${pts[0].x},${pts[0].y}`;
    let d = `M ${pts[0].x},${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const cpx = (pts[i].x + pts[i + 1].x) / 2;
      d += ` C ${cpx},${pts[i].y} ${cpx},${pts[i + 1].y} ${pts[i + 1].x},${pts[i + 1].y}`;
    }
    return d;
  }
  function areaPath(values: number[]): string {
    const pts = toPoints(values);
    if (pts.length === 0) return '';
    const line = smoothPath(pts);
    const baseY = ptop + chartH;
    return `${line} L ${pts[pts.length - 1].x},${baseY} L ${pts[0].x},${baseY} Z`;
  }

  const pts1 = data.map((d) => d.count);
  const pts2 = data2?.map((d) => d.count);
  const pts1Points = toPoints(pts1);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={className ?? 'w-full h-auto'}>
      <defs>
        <linearGradient id="overview-area-1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d946ef" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#d946ef" stopOpacity="0.05" />
        </linearGradient>
        <linearGradient id="overview-area-2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22c55e" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#22c55e" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((pct) => (
        <line key={pct} x1={px} y1={ptop + chartH * (1 - pct)} x2={px + chartW} y2={ptop + chartH * (1 - pct)} stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" />
      ))}
      <line x1={px} y1={ptop + chartH} x2={px + chartW} y2={ptop + chartH} stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
      <path d={areaPath(pts1)} fill="url(#overview-area-1)" />
      <path d={smoothPath(pts1Points)} fill="none" stroke="#d946ef" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
      {pts1Points.map((p, i) => {
        const baseY = ptop + chartH;
        const val = pts1[i];
        return (
          <g key={`a-${i}`}>
            {val > 0 && <line x1={p.x} y1={p.y} x2={p.x} y2={baseY} stroke="#d946ef" strokeWidth="0.5" strokeDasharray="2 2" opacity="0.25" />}
            <circle cx={p.x} cy={p.y} r={val > 0 ? 2 : 1} fill={val > 0 ? '#d946ef' : 'rgba(255,255,255,0.15)'} />
          </g>
        );
      })}
      {pts2 && (() => {
        const pts2Points = toPoints(pts2);
        return (
          <>
            <path d={areaPath(pts2)} fill="url(#overview-area-2)" />
            <path d={smoothPath(pts2Points)} fill="none" stroke="#22c55e" strokeWidth="0.8" strokeDasharray="3 2" strokeLinecap="round" strokeLinejoin="round" />
            {pts2Points.map((p, i) => pts2[i] > 0 && <circle key={i} cx={p.x} cy={p.y} r="1.5" fill="#22c55e" />)}
          </>
        );
      })()}
      {data.map((d, i) => (i % 2 === 0 ? (
        <text key={i} x={px + (i / Math.max(data.length - 1, 1)) * chartW} y={height - 2} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize="5">
          {d.label}
        </text>
      ) : null))}
    </svg>
  );
});
