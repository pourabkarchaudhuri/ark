/**
 * Journey Analytics View Component
 *
 * A streamlined dashboard of contextually grouped analytics derived from
 * journey entries, status-change history, play sessions, and library entries.
 *
 * 6 cohesive sections:
 *  1. Overview — Total games, total hours, and status donut
 *  2. Activity & Streaks — Monthly area chart with streak counters
 *  3. Sessions — Session count, avg length, idle ratio, histogram
 *  4. Library — Top games by hours + platform breakdown
 *  5. Discovery — Genre radar + recommendation sources
 *  6. Recent Activity — Status change feed
 */
import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import {
  motion,
  useMotionValue,
  animate as fmAnimate,
  useInView,
} from 'framer-motion';
import {
  Gamepad2,
  Clock,
  Trophy,
  TrendingUp,
  Activity,
  History,
  Flame,
  Share2,
  Tag,
} from 'lucide-react';
import {
  JourneyEntry,
  StatusChangeEntry,
  GameStatus,
  GameSession,
  LibraryGameEntry,
} from '@/types/game';
import { cn, formatHours, buildGameImageChain } from '@/lib/utils';

// ─── Fallback cover image ────────────────────────────────────────────────────

function FallbackImg({
  gameId, title, coverUrl, alt, className,
}: {
  gameId: string; title: string; coverUrl?: string;
  alt?: string; className?: string;
}) {
  const chain = useMemo(() => buildGameImageChain(gameId, title, coverUrl), [gameId, title, coverUrl]);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);

  const handleError = useCallback(() => {
    const next = attempt + 1;
    if (next < chain.length) setAttempt(next);
    else setFailed(true);
  }, [attempt, chain.length]);

  if (failed || chain.length === 0) return null;
  return (
    <img
      src={chain[attempt]}
      alt={alt ?? title}
      className={className}
      loading="lazy"
      decoding="async"
      onError={handleError}
    />
  );
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface JourneyAnalyticsViewProps {
  journeyEntries: JourneyEntry[];
  statusHistory: StatusChangeEntry[];
  sessions: GameSession[];
  libraryEntries: LibraryGameEntry[];
}

// ─── Status colours ──────────────────────────────────────────────────────────

const statusStrokeColors: Record<GameStatus, string> = {
  'Playing':      '#3b82f6',
  'Playing Now':  '#10b981',
  'Completed':    '#22c55e',
  'On Hold':      '#f59e0b',
  'Want to Play': 'rgba(255,255,255,0.3)',
};

const statusTextColors: Record<GameStatus, string> = {
  'Playing':      'text-blue-400',
  'Playing Now':  'text-emerald-400',
  'Completed':    'text-green-400',
  'On Hold':      'text-amber-400',
  'Want to Play': 'text-white/50',
};

const statusBadgeColors: Record<GameStatus, string> = {
  'Playing':      'bg-blue-500/20 text-blue-400',
  'Playing Now':  'bg-emerald-500/20 text-emerald-400',
  'Completed':    'bg-green-500/20 text-green-400',
  'On Hold':      'bg-amber-500/20 text-amber-400',
  'Want to Play': 'bg-white/10 text-white/50',
};


// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (days > 365) return `${Math.floor(days / 365)}y ago`;
  if (days > 30) return `${Math.floor(days / 30)}mo ago`;
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

// ─── Animated Value (count-up) ──────────────────────────────────────────────

const AnimatedValue = React.memo(function AnimatedValue({
  value,
  formatFn,
  className,
  delay = 0,
}: {
  value: number;
  formatFn: (n: number) => string;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const motionVal = useMotionValue(0);
  const isInView = useInView(ref, { once: true });
  const formatRef = useRef(formatFn);
  formatRef.current = formatFn;

  useEffect(() => {
    if (isInView) {
      const controls = fmAnimate(motionVal, value, {
        duration: 1.2,
        ease: 'easeOut',
        delay,
      });
      return controls.stop;
    }
  }, [isInView, value, motionVal, delay]);

  useEffect(() => {
    return motionVal.on('change', (v) => {
      if (ref.current) {
        ref.current.textContent = formatRef.current(Math.round(v));
      }
    });
  }, [motionVal]);

  return (
    <span ref={ref} className={className}>
      {formatFn(0)}
    </span>
  );
});

// ─── SVG Donut Chart ────────────────────────────────────────────────────────

function DonutChart({
  segments,
  size = 140,
  strokeWidth = 14,
  centerLabel,
  centerSub,
}: {
  segments: { value: number; color: string; label?: string }[];
  size?: number;
  strokeWidth?: number;
  centerLabel?: string;
  centerSub?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  if (total === 0) return null;

  const segmentLayout = segments
    .filter((s) => s.value > 0)
    .map((seg, i, arr) => {
      const pct = seg.value / total;
      const dashLength = pct * circumference;
      const prevLength = arr
        .slice(0, i)
        .reduce((sum, s) => sum + (s.value / total) * circumference, 0);
      return { ...seg, dashLength, prevLength, pct };
    });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="rgba(255,255,255,0.05)"
        strokeWidth={strokeWidth}
      />
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        {segmentLayout.map((seg, i) => (
          <motion.circle
            key={i}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={seg.color}
            strokeWidth={strokeWidth}
            strokeDashoffset={-seg.prevLength}
            initial={{ strokeDasharray: `0 ${circumference}` }}
            animate={{
              strokeDasharray: `${seg.dashLength} ${circumference - seg.dashLength}`,
            }}
            transition={{ duration: 0.8, delay: 0.3 + i * 0.15, ease: 'easeOut' }}
          >
            {seg.label && (
              <title>{`${seg.label}: ${seg.value} (${Math.round(seg.pct * 100)}%)`}</title>
            )}
          </motion.circle>
        ))}
      </g>
      {centerLabel && (
        <>
          <text
            x={size / 2}
            y={size / 2 - (centerSub ? 6 : 0)}
            textAnchor="middle"
            dominantBaseline="central"
            fill="white"
            fontSize="20"
            fontWeight="bold"
            fontFamily="'Orbitron', sans-serif"
          >
            {centerLabel}
          </text>
          {centerSub && (
            <text
              x={size / 2}
              y={size / 2 + 14}
              textAnchor="middle"
              dominantBaseline="central"
              fill="rgba(255,255,255,0.4)"
              fontSize="10"
            >
              {centerSub}
            </text>
          )}
        </>
      )}
    </svg>
  );
}

// ─── SVG Area Chart ─────────────────────────────────────────────────────────

function AreaChartSVG({
  data,
  data2,
}: {
  data: { label: string; count: number }[];
  data2?: { label: string; count: number }[];
}) {
  const width = 400;
  const height = 160;
  const px = 10;
  const ptop = 12;
  const pb = 20;
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
  const lastPt1 = pts1Points[pts1Points.length - 1];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
      <defs>
        <linearGradient id="analytics-area-grad-1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d946ef" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#d946ef" stopOpacity="0.05" />
        </linearGradient>
        <linearGradient id="analytics-area-grad-2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22c55e" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#22c55e" stopOpacity="0.05" />
        </linearGradient>
      </defs>

      {/* Horizontal grid lines */}
      {[0.25, 0.5, 0.75].map((pct) => (
        <line
          key={pct}
          x1={px}
          y1={ptop + chartH * (1 - pct)}
          x2={px + chartW}
          y2={ptop + chartH * (1 - pct)}
          stroke="rgba(255,255,255,0.04)"
          strokeWidth="0.5"
        />
      ))}

      {/* Baseline */}
      <line
        x1={px}
        y1={ptop + chartH}
        x2={px + chartW}
        y2={ptop + chartH}
        stroke="rgba(255,255,255,0.06)"
        strokeWidth="0.5"
      />

      {/* ── Added (primary): filled area + stroke + dots ── */}
      <path d={areaPath(pts1)} fill="url(#analytics-area-grad-1)" />
      <path d={smoothPath(pts1Points)} fill="none" stroke="#d946ef" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />

      {/* Vertical drop lines + data dots for "Added" */}
      {pts1Points.map((p, i) => {
        const baseY = ptop + chartH;
        const val = pts1[i];
        return (
          <g key={`added-${i}`}>
            {val > 0 && (
              <line x1={p.x} y1={p.y} x2={p.x} y2={baseY} stroke="#d946ef" strokeWidth="0.5" strokeDasharray="2 2" opacity="0.25" />
            )}
            <circle cx={p.x} cy={p.y} r={val > 0 ? 2.5 : 1.5} fill={val > 0 ? '#d946ef' : 'rgba(255,255,255,0.15)'} stroke={val > 0 ? '#fff' : 'none'} strokeWidth="0.5" />
            <circle cx={p.x} cy={p.y} r="6" fill="transparent">
              <title>{`${data[i].label}: ${val} added`}</title>
            </circle>
          </g>
        );
      })}

      {/* Glow on last point */}
      {lastPt1 && pts1[pts1.length - 1] > 0 && (
        <circle cx={lastPt1.x} cy={lastPt1.y} r="4" fill="#d946ef" opacity="0.3" />
      )}

      {/* ── Completed (secondary): filled area + dashed stroke + dots ── */}
      {pts2 && (() => {
        const pts2Points = toPoints(pts2);
        return (
          <>
            <path d={areaPath(pts2)} fill="url(#analytics-area-grad-2)" />
            <path d={smoothPath(pts2Points)} fill="none" stroke="#22c55e" strokeWidth="0.8" strokeDasharray="3 2" strokeLinecap="round" strokeLinejoin="round" />
            {pts2Points.map((p, i) => {
              const val = pts2[i];
              return (
                <g key={`comp-${i}`}>
                  {val > 0 && (
                    <circle cx={p.x} cy={p.y} r="2" fill="#22c55e" stroke="#fff" strokeWidth="0.5" />
                  )}
                  <circle cx={p.x} cy={p.y} r="6" fill="transparent">
                    <title>{`${data[i].label}: ${val} completed`}</title>
                  </circle>
                </g>
              );
            })}
          </>
        );
      })()}

      {/* X-axis month labels */}
      {data.map((d, i) => {
        const showLabel = data.length <= 7 || i % 2 === 0;
        return showLabel ? (
          <text
            key={i}
            x={px + (i / Math.max(data.length - 1, 1)) * chartW}
            y={height - 4}
            textAnchor="middle"
            fill="rgba(255,255,255,0.25)"
            fontSize="4.5"
          >
            {d.label}
          </text>
        ) : null;
      })}

      {/* Y-axis value labels (left side) */}
      {maxVal > 1 && [0.5, 1].map((pct) => (
        <text
          key={pct}
          x={px - 1}
          y={ptop + chartH * (1 - pct) + 1.5}
          textAnchor="end"
          fill="rgba(255,255,255,0.15)"
          fontSize="4.5"
        >
          {Math.round(maxVal * pct)}
        </text>
      ))}
    </svg>
  );
}

// ─── SVG Radar Chart ────────────────────────────────────────────────────────

function RadarChart({
  data,
  size = 220,
  levels = 4,
  color = '#d946ef',
}: {
  data: { label: string; value: number }[];
  size?: number;
  levels?: number;
  color?: string;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const radius = (size - 50) / 2;
  const n = data.length;

  if (n < 3) return null;

  function getPoint(index: number, r: number): { x: number; y: number } {
    const angle = (index * 2 * Math.PI) / n - Math.PI / 2;
    return {
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    };
  }

  const gridRings = Array.from({ length: levels }, (_, i) => {
    const r = (radius * (i + 1)) / levels;
    return Array.from({ length: n }, (_, j) => getPoint(j, r))
      .map((p) => `${p.x},${p.y}`)
      .join(' ');
  });

  const dataPoints = data.map((d, i) => getPoint(i, Math.max(d.value, 0.05) * radius));
  const dataPolygon = dataPoints.map((p) => `${p.x},${p.y}`).join(' ');
  const axisEndpoints = Array.from({ length: n }, (_, i) => getPoint(i, radius));
  const labelPositions = data.map((d, i) => {
    const angle = (i * 2 * Math.PI) / n - Math.PI / 2;
    const labelR = radius + 20;
    return {
      x: cx + labelR * Math.cos(angle),
      y: cy + labelR * Math.sin(angle),
      label: d.label,
      value: d.value,
    };
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <defs>
        <radialGradient id={`radar-glow-${color.replace('#', '')}`}>
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

      <polygon
        points={dataPolygon}
        fill={`url(#radar-glow-${color.replace('#', '')})`}
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        opacity="0.9"
      />

      {dataPoints.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r="3"
          fill={color}
          stroke="rgba(0,0,0,0.3)"
          strokeWidth="0.6"
        >
          <title>{`${data[i].label}: ${Math.round(data[i].value * 100)}%`}</title>
        </circle>
      ))}

      {labelPositions.map((lp, i) => (
        <text
          key={i}
          x={lp.x}
          y={lp.y}
          textAnchor="middle"
          dominantBaseline="central"
          fill="rgba(255,255,255,0.5)"
          fontSize="9"
          fontWeight="500"
        >
          {lp.label}
        </text>
      ))}
    </svg>
  );
}

// ─── Animated Radial Gauge ──────────────────────────────────────────────────

function AnimatedRadialGauge({
  value,
  max = 100,
  size = 56,
  strokeWidth = 5,
  color = '#22c55e',
  label,
}: {
  value: number;
  max?: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
  label?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.min(value / max, 1);
  const dashLength = pct * circumference;

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={strokeWidth} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          initial={{ strokeDasharray: `0 ${circumference}` }}
          whileInView={{ strokeDasharray: `${dashLength} ${circumference - dashLength}` }}
          viewport={{ once: true }}
          transition={{ duration: 1, ease: 'easeOut', delay: 0.4 }}
        />
      </svg>
      {label && <span className="absolute text-[9px] font-bold text-white/70">{label}</span>}
    </div>
  );
}

// ─── Glassmorphic card wrapper ──────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  children,
  className,
  delay = 0,
}: {
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.5, delay, ease: 'easeOut' }}
      className={cn(
        'relative rounded-xl bg-white/[0.04] backdrop-blur-sm border border-white/10 p-5 overflow-hidden',
        'hover:border-white/20 hover:bg-white/[0.06] transition-all duration-300 group',
        className,
      )}
    >
      <div className="absolute -top-10 -right-10 w-24 h-24 rounded-full bg-fuchsia-500/5 blur-2xl group-hover:bg-fuchsia-500/10 transition-all" />
      <div className="flex items-center gap-2 mb-3 text-white/50 text-xs font-medium uppercase tracking-wider">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      {children}
    </motion.div>
  );
}

// ─── All statuses for display ───────────────────────────────────────────────

const ALL_STATUSES: GameStatus[] = ['Playing Now', 'Playing', 'Completed', 'On Hold', 'Want to Play'];

// ─── Main component ──────────────────────────────────────────────────────────

export function JourneyAnalyticsView({
  journeyEntries,
  statusHistory,
  sessions,
  libraryEntries,
}: JourneyAnalyticsViewProps) {
  const analytics = useMemo(() => {
    const now = new Date();
    const totalGames = journeyEntries.length;
    const totalHours = journeyEntries.reduce((sum, e) => sum + (e.hoursPlayed ?? 0), 0);

    // ── Status breakdown ─────────────────────────────────────────────────
    const statusCounts: Record<string, number> = {};
    for (const entry of journeyEntries) {
      statusCounts[entry.status] = (statusCounts[entry.status] || 0) + 1;
    }
    const completedCount = statusCounts['Completed'] || 0;

    // ── Top games by hours ───────────────────────────────────────────────
    const topGames = [...journeyEntries].sort((a, b) => b.hoursPlayed - a.hoursPlayed).slice(0, 5);
    const maxHours = topGames.length > 0 ? topGames[0].hoursPlayed : 1;

    // ── Monthly activity (last 12 months) ────────────────────────────────
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

    // ── Genre distribution (needed for genre radar) ─────────────────────
    const genreCounts: Record<string, number> = {};
    for (const entry of journeyEntries) {
      for (const g of entry.genre) {
        genreCounts[g] = (genreCounts[g] || 0) + 1;
      }
    }
    const topGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

    // ── Session stats ────────────────────────────────────────────────────
    const totalSessions = sessions.length;
    const totalSessionMinutes = sessions.reduce((s, ses) => s + ses.durationMinutes, 0);
    const totalIdleMinutes = sessions.reduce((s, ses) => s + ses.idleMinutes, 0);
    const avgSessionLength = totalSessions > 0 ? Math.round(totalSessionMinutes / totalSessions) : 0;
    const idleRatio =
      totalSessionMinutes + totalIdleMinutes > 0
        ? Math.round((totalIdleMinutes / (totalSessionMinutes + totalIdleMinutes)) * 100)
        : 0;

    // ── Monthly completions (last 12 months) ─────────────────────────────
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

    // ── Recent activity ──────────────────────────────────────────────────
    const recentActivity = [...statusHistory]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 10);

    // ── Genre radar (top 6) ──────────────────────────────────────────────
    const genreRadarRaw = topGenres.slice(0, 6);
    const maxGenreCount = Math.max(1, ...genreRadarRaw.map(([, c]) => c));
    const genreRadar = genreRadarRaw.map(([genre, count]) => ({
      label: genre,
      value: count / maxGenreCount,
    }));

    // ── Streak tracking ─────────────────────────────────────────────────
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
          } else {
            break;
          }
        }
      }

      let streak = 1;
      for (let i = 1; i < sortedDays.length; i++) {
        const diff = (sortedDays[i].getTime() - sortedDays[i - 1].getTime()) / 86_400_000;
        if (Math.round(diff) === 1) {
          streak++;
        } else {
          longestStreak = Math.max(longestStreak, streak);
          streak = 1;
        }
      }
      longestStreak = Math.max(longestStreak, streak);
    }

    // ── Session length distribution ─────────────────────────────────────
    const sessionBuckets = [
      { label: '<15m', min: 0, max: 15, count: 0 },
      { label: '15-30m', min: 15, max: 30, count: 0 },
      { label: '30m-1h', min: 30, max: 60, count: 0 },
      { label: '1-2h', min: 60, max: 120, count: 0 },
      { label: '2-4h', min: 120, max: 240, count: 0 },
      { label: '4h+', min: 240, max: Infinity, count: 0 },
    ];
    for (const ses of sessions) {
      const b = sessionBuckets.find((bk) => ses.durationMinutes >= bk.min && ses.durationMinutes < bk.max);
      if (b) b.count++;
    }

    // ── Recommendation source analysis ──────────────────────────────────
    const recSourceMap: Record<string, { count: number; totalRating: number; ratedCount: number }> = {};
    for (const le of libraryEntries) {
      const src = le.recommendationSource || 'Unknown';
      if (!recSourceMap[src]) recSourceMap[src] = { count: 0, totalRating: 0, ratedCount: 0 };
      recSourceMap[src].count++;
      if (le.rating > 0) {
        recSourceMap[src].totalRating += le.rating;
        recSourceMap[src].ratedCount++;
      }
    }
    const recSources = Object.entries(recSourceMap)
      .map(([source, data]) => ({
        source,
        count: data.count,
        avgRating: data.ratedCount > 0 ? Math.round((data.totalRating / data.ratedCount) * 10) / 10 : 0,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      totalGames,
      totalHours,
      completedCount,
      statusCounts,
      topGames,
      maxHours,
      monthlyActivity,
      totalSessions,
      avgSessionLength,
      idleRatio,
      monthlyCompletions,
      recentActivity,
      genreRadar,
      currentStreak,
      longestStreak,
      sessionBuckets,
      recSources,
    };
  }, [journeyEntries, statusHistory, sessions, libraryEntries]);

  // ── Empty state ────────────────────────────────────────────────────────────

  if (journeyEntries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Gamepad2 className="w-10 h-10 text-fuchsia-500 mb-4" />
        <p className="text-white/60">No journey data to analyse yet.</p>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-8 lg:px-10 pb-10 space-y-5">

      {/* ═══ Section 1: Overview ═══════════════════════════════════════════ */}
      <StatCard icon={Gamepad2} label="Overview" delay={0}>
        <div className="flex flex-col md:flex-row md:items-center gap-6">
          {/* Big numbers */}
          <div className="flex items-center gap-6 md:gap-8">
            <div>
              <AnimatedValue
                value={analytics.totalGames}
                formatFn={formatNumber}
                className="text-3xl font-bold text-fuchsia-400 font-['Orbitron']"
                delay={0.2}
              />
              <p className="text-[10px] text-white/40 mt-0.5">games tracked</p>
            </div>
            <div className="w-px h-10 bg-white/10" />
            <div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-3xl font-bold text-cyan-400 font-['Orbitron']">
                  {formatHours(analytics.totalHours)}
                </span>
                <Clock className="w-3 h-3 text-cyan-400/50" />
              </div>
              <p className="text-[10px] text-white/40 mt-0.5">played</p>
            </div>
          </div>

          {/* Divider */}
          <div className="hidden md:block w-px h-24 bg-white/[0.06]" />

          {/* Status donut + legend */}
          <div className="flex items-center gap-5 flex-1">
            <DonutChart
              segments={ALL_STATUSES.map((s) => ({
                value: analytics.statusCounts[s] || 0,
                color: statusStrokeColors[s],
                label: s,
              }))}
              centerLabel={String(analytics.totalGames)}
              centerSub="games"
            />
            <div className="space-y-2">
              {ALL_STATUSES.map((status) => {
                const count = analytics.statusCounts[status] || 0;
                if (count === 0) return null;
                return (
                  <div key={status} className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: statusStrokeColors[status] }} />
                    <span className={cn('text-xs font-medium', statusTextColors[status])}>{status}</span>
                    <span className="text-xs text-white/30">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </StatCard>

      {/* ═══ Section 2: Activity & Streaks ═════════════════════════════════ */}
      <StatCard icon={TrendingUp} label="Activity" delay={0.05}>
        {/* Streak bar */}
        {analytics.totalSessions > 0 && (
          <div className="flex items-center gap-6 mb-4 pb-3 border-b border-white/[0.06]">
            <div className="flex items-center gap-2">
              <Flame className="w-4 h-4 text-orange-400" />
              <span className="text-sm font-bold text-orange-400 font-['Orbitron']">
                {analytics.currentStreak}
              </span>
              <span className="text-xs text-white/40">day streak</span>
            </div>
            <div className="w-px h-4 bg-white/10" />
            <div className="flex items-center gap-2">
              <Trophy className="w-4 h-4 text-amber-400" />
              <span className="text-sm font-bold text-amber-400 font-['Orbitron']">
                {analytics.longestStreak}
              </span>
              <span className="text-xs text-white/40">best streak</span>
            </div>
          </div>
        )}

        {/* Chart legend */}
        <div className="flex items-center gap-4 mb-2">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-sm bg-fuchsia-500/60" />
            <span className="text-[10px] text-white/40">Added</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-sm bg-green-500/60" />
            <span className="text-[10px] text-white/40">Completed</span>
          </div>
        </div>
        <AreaChartSVG data={analytics.monthlyActivity} data2={analytics.monthlyCompletions} />
      </StatCard>

      {/* ═══ Section 3: Sessions ═══════════════════════════════════════════ */}
      <StatCard icon={Activity} label="Sessions" delay={0.1}>
        {analytics.totalSessions === 0 ? (
          <p className="text-xs text-white/40">
            No session data yet. Set an executable path on a game to start tracking.
          </p>
        ) : (
          <div className="space-y-4">
            {/* Top row: inline metrics */}
            <div className="flex items-center gap-4">
              <div className="grid grid-cols-2 gap-3 flex-1">
                <div>
                  <AnimatedValue value={analytics.totalSessions} formatFn={String} className="text-xl font-bold text-violet-400 font-['Orbitron']" delay={0.3} />
                  <p className="text-[10px] text-white/40 mt-0.5">total sessions</p>
                </div>
                <div>
                  <AnimatedValue value={analytics.avgSessionLength} formatFn={(n) => { const h = Math.floor(n / 60); const m = n % 60; const hrL = h === 1 ? 'Hr' : 'Hrs'; const minL = m === 1 ? 'Min' : 'Mins'; return h > 0 ? (m > 0 ? `${h} ${hrL} ${m} ${minL}` : `${h} ${hrL}`) : `${n} ${minL}`; }} className="text-xl font-bold text-cyan-400 font-['Orbitron']" delay={0.4} />
                  <p className="text-[10px] text-white/40 mt-0.5">avg length</p>
                </div>
              </div>
              <div className="flex flex-col items-center gap-1">
                <AnimatedRadialGauge value={analytics.idleRatio} color="#f59e0b" label={`${analytics.idleRatio}%`} />
                <span className="text-[9px] text-white/30">idle</span>
              </div>
            </div>
            {/* Session length histogram */}
            <div>
              <p className="text-[10px] text-white/30 mb-2 uppercase tracking-wider">Session Length</p>
              <div className="flex items-end gap-1.5 h-20">
                {analytics.sessionBuckets.map((bucket, i) => {
                  const maxBucket = Math.max(1, ...analytics.sessionBuckets.map((b) => b.count));
                  const pct = (bucket.count / maxBucket) * 100;
                  return (
                    <div key={bucket.label} className="flex-1 flex flex-col items-center gap-0.5 group/bar">
                      <span className="text-[9px] text-white/30 opacity-0 group-hover/bar:opacity-100 transition-opacity">
                        {bucket.count}
                      </span>
                      <motion.div
                        className={cn(
                          'w-full rounded-t-sm',
                          bucket.count > 0
                            ? 'bg-gradient-to-t from-emerald-600/80 to-emerald-400/60'
                            : 'bg-white/5',
                        )}
                        initial={{ height: '2%' }}
                        whileInView={{ height: `${Math.max(bucket.count > 0 ? 8 : 2, pct)}%` }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.6, delay: i * 0.08, ease: 'easeOut' }}
                      />
                      <span className="text-[8px] text-white/25 text-center leading-tight">{bucket.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </StatCard>

      {/* ═══ Section 4: Top Games ═════════════════════════════════════════ */}
      <StatCard icon={TrendingUp} label="Top Games by Hours" delay={0}>
        {analytics.topGames.length === 0 ? (
          <p className="text-xs text-white/40">No hours recorded yet</p>
        ) : (
          <div className="space-y-2">
            {analytics.topGames.map((game, i) => {
              const pct = analytics.maxHours > 0 ? (game.hoursPlayed / analytics.maxHours) * 100 : 0;
              return (
                <div key={game.gameId} className="flex items-center gap-2">
                  <span className="text-[10px] text-white/30 w-3 text-right font-mono">{i + 1}</span>
                  <div className="w-5 h-7 rounded-sm overflow-hidden bg-white/5 flex-shrink-0">
                    <FallbackImg
                      gameId={game.gameId}
                      title={game.title}
                      coverUrl={game.coverUrl}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-xs text-white/80 truncate font-medium">{game.title}</span>
                      <span className="text-[10px] text-cyan-400 flex-shrink-0 ml-2">{formatHours(game.hoursPlayed)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                      <motion.div
                        className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-400"
                        initial={{ width: '0%' }}
                        whileInView={{ width: `${pct}%` }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.6, delay: i * 0.08, ease: 'easeOut' }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </StatCard>

      {/* ═══ Section 5: Discovery (two columns) ═══════════════════════════ */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Genre Radar */}
        <StatCard icon={Tag} label="Genre Radar" delay={0}>
          {analytics.genreRadar.length < 3 ? (
            <p className="text-xs text-white/40">Add more games with varied genres to see your radar</p>
          ) : (
            <>
              <div className="flex justify-center">
                <RadarChart data={analytics.genreRadar} color="#06b6d4" size={220} />
              </div>
              <p className="text-[10px] text-white/30 text-center mt-2">
                Top {analytics.genreRadar.length} genres by game count
              </p>
            </>
          )}
        </StatCard>

        {/* Recommendation Sources */}
        <StatCard icon={Share2} label="Recommendation Source" delay={0.1}>
          {analytics.recSources.length === 0 ? (
            <p className="text-xs text-white/40">No recommendation data</p>
          ) : (
            <div className="space-y-1.5">
              {analytics.recSources.slice(0, 7).map((src, i) => {
                const maxSrcCount = Math.max(1, ...analytics.recSources.map((s) => s.count));
                const pct = (src.count / maxSrcCount) * 100;
                return (
                  <div key={src.source} className="flex items-center gap-2">
                    <span className="text-[10px] text-white/50 w-20 text-right truncate">{src.source}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                      <motion.div
                        className="h-full rounded-full bg-gradient-to-r from-blue-500/70 to-violet-400/60"
                        initial={{ width: '0%' }}
                        whileInView={{ width: `${Math.max(pct, 4)}%` }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.6, delay: i * 0.08, ease: 'easeOut' }}
                      />
                    </div>
                    <span className="text-[10px] text-white/30 w-3 text-right">{src.count}</span>
                    {src.avgRating > 0 && (
                      <span className="text-[9px] text-yellow-400/60 w-7 text-right">{src.avgRating}&#x2605;</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </StatCard>
      </div>

      {/* ═══ Section 6: Recent Activity ════════════════════════════════════ */}
      <StatCard icon={History} label="Recent Activity" delay={0}>
        {analytics.recentActivity.length === 0 ? (
          <p className="text-xs text-white/40">No status changes recorded yet</p>
        ) : (
          <div className="relative">
            <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
              {analytics.recentActivity.map((entry, i) => (
                <motion.div
                  key={`${entry.gameId}-${entry.timestamp}-${i}`}
                  className="flex items-center gap-2"
                  initial={{ opacity: 0, x: -10 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.3, delay: i * 0.05 }}
                >
                  <div className="w-1 h-1 rounded-full bg-white/20 flex-shrink-0" />
                  <span className="text-xs text-white/70 truncate flex-1">{entry.title}</span>
                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0', statusBadgeColors[entry.newStatus])}>
                    {entry.newStatus}
                  </span>
                  <span className="text-[10px] text-white/25 flex-shrink-0">{timeAgo(entry.timestamp)}</span>
                </motion.div>
              ))}
            </div>
            {/* Fade-out gradient at the bottom of the scrollable list */}
            <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-[rgba(255,255,255,0.04)] to-transparent rounded-b-xl" />
          </div>
        )}
      </StatCard>
    </div>
  );
}
