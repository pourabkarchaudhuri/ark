/**
 * Journey Analytics View Component
 *
 * A dashboard of stat cards and visualisations derived from journey entries,
 * status-change history, play sessions, and library entries. Features animated
 * SVG charts (radar, donut, area, radial gauge, funnel, heatmap, histograms)
 * powered by framer-motion.
 */
import { useMemo, useRef, useEffect } from 'react';
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
  CalendarDays,
  Timer,
  Tag,
  Star,
  Monitor,
  Activity,
  History,
  Award,
  PieChart,
  Target,
  Hexagon,
  Filter,
  Flame,
  Flag,
  Share2,
  Calendar,
} from 'lucide-react';
import {
  JourneyEntry,
  StatusChangeEntry,
  GameStatus,
  GameSession,
  LibraryGameEntry,
} from '@/types/game';
import { cn, getHardcodedCover } from '@/lib/utils';

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

// ─── Priority colours ────────────────────────────────────────────────────────

const priorityColors: Record<string, string> = {
  High:   '#ef4444',
  Medium: '#f59e0b',
  Low:    '#6b7280',
};

// ─── Platform colours ────────────────────────────────────────────────────────

const platformColorMap: Record<string, string> = {
  Windows: '#3b82f6',
  Mac:     '#a855f7',
  Linux:   '#f97316',
};

function getPlatformColor(platform: string): string {
  return platformColorMap[platform] ?? '#6b7280';
}

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

function AnimatedValue({
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
}

// ─── SVG Helper Components ──────────────────────────────────────────────────

/** Tiny sparkline with draw-on animation */
function Sparkline({
  data,
  color,
  width = 60,
  height = 24,
}: {
  data: number[];
  color: string;
  width?: number;
  height?: number;
}) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;

  const pathD = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${i === 0 ? 'M' : 'L'} ${x},${y}`;
    })
    .join(' ');

  const lastX = width;
  const lastY = height - ((data[data.length - 1] - min) / range) * (height - 4) - 2;

  return (
    <svg width={width} height={height} className="overflow-visible opacity-60">
      <motion.path
        d={pathD}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.8, ease: 'easeOut', delay: 0.4 }}
      />
      <motion.circle
        cx={lastX}
        cy={lastY}
        r="2"
        fill={color}
        initial={{ opacity: 0, scale: 0 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3, delay: 1.2 }}
      />
    </svg>
  );
}

/** "+3 this month" label */
function DeltaLabel({ value, suffix = 'this month' }: { value: number; suffix?: string }) {
  if (value === 0) return <p className="text-[10px] text-white/30 mt-0.5">none {suffix}</p>;
  return (
    <p
      className={cn(
        'text-[10px] font-medium mt-0.5',
        value > 0 ? 'text-green-400' : 'text-red-400',
      )}
    >
      {value > 0 ? '+' : ''}
      {value} {suffix}
    </p>
  );
}

/** Star rating (small) */
function MiniStars({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-px">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className={cn(
            'w-2.5 h-2.5',
            i < rating ? 'text-yellow-400 fill-yellow-400' : 'text-white/10',
          )}
        />
      ))}
    </div>
  );
}

/** SVG donut ring with sweep-in animation and tooltips */
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
            fontSize="22"
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
              fontSize="9"
            >
              {centerSub}
            </text>
          )}
        </>
      )}
    </svg>
  );
}

/** SVG area chart with draw-on path animation and hover tooltips */
function AreaChartSVG({
  data,
  data2,
}: {
  data: { label: string; count: number }[];
  data2?: { label: string; count: number }[];
}) {
  const width = 400;
  const height = 130;
  const px = 8;
  const pt = 12;
  const pb = 18;
  const chartW = width - px * 2;
  const chartH = height - pt - pb;

  const allValues = [...data.map((d) => d.count), ...(data2?.map((d) => d.count) ?? [])];
  const maxVal = Math.max(1, ...allValues);

  function toPoints(values: number[]): { x: number; y: number }[] {
    return values.map((v, i) => ({
      x: px + (i / Math.max(values.length - 1, 1)) * chartW,
      y: pt + chartH - (v / maxVal) * chartH,
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
    const baseY = pt + chartH;
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
          <stop offset="0%" stopColor="#d946ef" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#d946ef" stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id="analytics-area-grad-2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22c55e" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#22c55e" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {[0.25, 0.5, 0.75].map((pct) => (
        <line
          key={pct}
          x1={px}
          y1={pt + chartH * (1 - pct)}
          x2={px + chartW}
          y2={pt + chartH * (1 - pct)}
          stroke="rgba(255,255,255,0.04)"
          strokeWidth="1"
        />
      ))}

      {/* Series 1 area */}
      <motion.path
        d={areaPath(pts1)}
        fill="url(#analytics-area-grad-1)"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.8, delay: 0.5 }}
      />
      {/* Series 1 line */}
      <motion.path
        d={smoothPath(pts1Points)}
        fill="none"
        stroke="#d946ef"
        strokeWidth="2"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 1.5, ease: 'easeInOut' }}
      />

      {/* Series 2 */}
      {pts2 &&
        (() => {
          const pts2Points = toPoints(pts2);
          const lastPt2 = pts2Points[pts2Points.length - 1];
          return (
            <>
              <motion.path
                d={areaPath(pts2)}
                fill="url(#analytics-area-grad-2)"
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 0.8, delay: 0.8 }}
              />
              <motion.path
                d={smoothPath(pts2Points)}
                fill="none"
                stroke="#22c55e"
                strokeWidth="1.5"
                strokeDasharray="4 3"
                strokeLinecap="round"
                initial={{ pathLength: 0 }}
                whileInView={{ pathLength: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 1.5, ease: 'easeInOut', delay: 0.3 }}
              />
              {lastPt2 && (
                <motion.circle
                  cx={lastPt2.x}
                  cy={lastPt2.y}
                  r="2.5"
                  fill="#22c55e"
                  initial={{ opacity: 0, scale: 0 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.3, delay: 1.8 }}
                />
              )}
            </>
          );
        })()}

      {lastPt1 && (
        <motion.circle
          cx={lastPt1.x}
          cy={lastPt1.y}
          r="3"
          fill="#d946ef"
          initial={{ opacity: 0, scale: 0 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.3, delay: 1.5 }}
        />
      )}

      {/* Hover tooltip targets for series 1 */}
      {data.map((d, i) => {
        const pt2 = pts1Points[i];
        return (
          <circle key={`tip-${i}`} cx={pt2.x} cy={pt2.y} r="8" fill="transparent">
            <title>{`${d.label}: ${d.count} added`}</title>
          </circle>
        );
      })}

      {data.map((d, i) => {
        const showLabel = data.length <= 7 || i % 2 === 0;
        return showLabel ? (
          <text
            key={i}
            x={px + (i / Math.max(data.length - 1, 1)) * chartW}
            y={height - 2}
            textAnchor="middle"
            fill="rgba(255,255,255,0.25)"
            fontSize="8"
          >
            {d.label}
          </text>
        ) : null;
      })}
    </svg>
  );
}

// ─── Radar / Spider Chart ───────────────────────────────────────────────────

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
  const centerPolygon = data
    .map((_, i) => getPoint(i, 0))
    .map((p) => `${p.x},${p.y}`)
    .join(' ');
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
          <stop offset="0%" stopColor={color} stopOpacity="0.15" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </radialGradient>
      </defs>

      {gridRings.map((points, i) => (
        <polygon key={i} points={points} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
      ))}

      {axisEndpoints.map((pt, i) => (
        <line key={i} x1={cx} y1={cy} x2={pt.x} y2={pt.y} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
      ))}

      <motion.polygon
        fill={`url(#radar-glow-${color.replace('#', '')})`}
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
        initial={{ points: centerPolygon, opacity: 0 }}
        whileInView={{ points: dataPolygon, opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 1, ease: 'easeOut', delay: 0.2 }}
      />

      {dataPoints.map((p, i) => (
        <motion.circle
          key={i}
          cx={p.x}
          cy={p.y}
          r="3.5"
          fill={color}
          stroke="rgba(0,0,0,0.3)"
          strokeWidth="1"
          initial={{ opacity: 0, scale: 0 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.3, delay: 0.8 + i * 0.08 }}
        >
          <title>{`${data[i].label}: ${Math.round(data[i].value * 100)}%`}</title>
        </motion.circle>
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

// ─── Completion Funnel ──────────────────────────────────────────────────────

function CompletionFunnel({
  stages,
}: {
  stages: { label: string; count: number; color: string; pct?: number }[];
}) {
  const maxCount = Math.max(1, ...stages.map((s) => s.count));

  return (
    <div className="space-y-1">
      {stages.map((stage, i) => {
        const widthPct = Math.max(20, (stage.count / maxCount) * 100);
        return (
          <div key={stage.label}>
            {i > 0 && stage.pct !== undefined && (
              <div className="flex justify-center my-0.5">
                <span className="text-[9px] text-white/25">↓ {stage.pct}% conversion</span>
              </div>
            )}
            <div className="flex flex-col items-center">
              <motion.div
                className="h-9 rounded-lg flex items-center justify-between px-3 overflow-hidden"
                style={{ backgroundColor: `${stage.color}12`, border: `1px solid ${stage.color}30` }}
                initial={{ width: '0%', opacity: 0 }}
                whileInView={{ width: `${widthPct}%`, opacity: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 0.7, delay: i * 0.2, ease: 'easeOut' }}
              >
                <span className="text-[10px] text-white/60 truncate whitespace-nowrap">{stage.label}</span>
                <span className="text-[11px] font-bold ml-2 whitespace-nowrap" style={{ color: stage.color }}>
                  {stage.count}
                </span>
              </motion.div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Play Schedule Heatmap (7 days x 24 hours) ─────────────────────────────

function PlayScheduleHeatmap({
  matrix,
  maxVal,
}: {
  matrix: number[][];
  maxVal: number;
}) {
  const cellSize = 13;
  const gap = 2;
  const labelW = 28;
  const labelH = 16;
  const width = labelW + 24 * (cellSize + gap);
  const height = labelH + 7 * (cellSize + gap);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
      {/* Hour labels */}
      {Array.from({ length: 24 }, (_, h) =>
        h % 3 === 0 ? (
          <text
            key={h}
            x={labelW + h * (cellSize + gap) + cellSize / 2}
            y={labelH - 4}
            textAnchor="middle"
            fill="rgba(255,255,255,0.2)"
            fontSize="7"
          >
            {h}
          </text>
        ) : null,
      )}
      {/* Day rows */}
      {days.map((day, d) => (
        <g key={day}>
          <text
            x={labelW - 4}
            y={labelH + d * (cellSize + gap) + cellSize / 2 + 3}
            textAnchor="end"
            fill="rgba(255,255,255,0.25)"
            fontSize="8"
          >
            {day}
          </text>
          {Array.from({ length: 24 }, (_, h) => {
            const val = matrix[d][h];
            const intensity = maxVal > 0 ? val / maxVal : 0;
            return (
              <motion.rect
                key={h}
                x={labelW + h * (cellSize + gap)}
                y={labelH + d * (cellSize + gap)}
                width={cellSize}
                height={cellSize}
                rx="2"
                fill={
                  intensity === 0
                    ? 'rgba(255,255,255,0.03)'
                    : `rgba(139, 92, 246, ${Math.max(0.12, intensity * 0.85)})`
                }
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 0.15, delay: (d * 24 + h) * 0.002 }}
              >
                <title>{`${day} ${h}:00 — ${val} min`}</title>
              </motion.rect>
            );
          })}
        </g>
      ))}
    </svg>
  );
}

// ─── Glassmorphic card wrapper (animated entry) ─────────────────────────────

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
    const completionRate = totalGames > 0 ? Math.round((completedCount / totalGames) * 100) : 0;

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

    // ── Average time to complete ─────────────────────────────────────────
    let avgDaysToComplete = 0;
    const completedEntries = journeyEntries.filter((e) => e.status === 'Completed');
    if (completedEntries.length > 0) {
      const historyByGame = new Map<number, StatusChangeEntry[]>();
      for (const h of statusHistory) {
        if (!historyByGame.has(h.gameId)) historyByGame.set(h.gameId, []);
        historyByGame.get(h.gameId)!.push(h);
      }
      let totalDays = 0;
      let countWithData = 0;
      for (const entry of completedEntries) {
        const changes = historyByGame.get(entry.gameId) ?? [];
        const completedChange = changes.find((c) => c.newStatus === 'Completed');
        if (completedChange) {
          const addedDate = new Date(entry.addedAt).getTime();
          const completedDate = new Date(completedChange.timestamp).getTime();
          const days = Math.max(1, Math.round((completedDate - addedDate) / 86_400_000));
          totalDays += days;
          countWithData++;
        }
      }
      avgDaysToComplete = countWithData > 0 ? Math.round(totalDays / countWithData) : 0;
    }

    // ── Genre distribution ───────────────────────────────────────────────
    const genreCounts: Record<string, number> = {};
    for (const entry of journeyEntries) {
      for (const g of entry.genre) {
        genreCounts[g] = (genreCounts[g] || 0) + 1;
      }
    }
    const topGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

    // ── Rating distribution ──────────────────────────────────────────────
    const ratingCounts = [0, 0, 0, 0, 0, 0];
    for (const entry of journeyEntries) {
      const r = entry.rating ?? 0;
      ratingCounts[Math.min(Math.max(r, 0), 5)]++;
    }
    const ratedEntries = journeyEntries.filter((e) => e.rating > 0);
    const avgRating =
      ratedEntries.length > 0
        ? Math.round((ratedEntries.reduce((s, e) => s + e.rating, 0) / ratedEntries.length) * 10) / 10
        : 0;

    // ── Platform breakdown ───────────────────────────────────────────────
    const platformCounts: Record<string, number> = {};
    for (const entry of journeyEntries) {
      for (const p of entry.platform) {
        platformCounts[p] = (platformCounts[p] || 0) + 1;
      }
    }
    const topPlatforms = Object.entries(platformCounts).sort((a, b) => b[1] - a[1]);

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

    // ── Top games by rating ──────────────────────────────────────────────
    const topGamesByRating = [...journeyEntries]
      .filter((e) => e.rating > 0)
      .sort((a, b) => b.rating - a.rating || b.hoursPlayed - a.hoursPlayed)
      .slice(0, 5);

    // ── Sparkline / deltas ───────────────────────────────────────────────
    const sparklineGamesAdded = monthlyActivity.slice(-6).map((m) => m.count);
    const deltaGames = monthlyActivity[monthlyActivity.length - 1]?.count ?? 0;
    const deltaCompletions = monthlyCompletions[monthlyCompletions.length - 1]?.count ?? 0;

    // ── Recent activity ──────────────────────────────────────────────────
    const recentActivity = [...statusHistory]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 10);

    // ── Gaming Profile (radar) ───────────────────────────────────────────
    const avgHoursPerGame = totalGames > 0 ? totalHours / totalGames : 0;
    const uniqueGenreCount = Object.keys(genreCounts).length;
    const sessionsPerWeek =
      totalSessions > 0
        ? (() => {
            const firstSession = sessions.reduce((min, s) => {
              const t = new Date(s.startTime).getTime();
              return t < min ? t : min;
            }, Date.now());
            return totalSessions / Math.max(1, (Date.now() - firstSession) / (7 * 86_400_000));
          })()
        : 0;

    const gamingProfile = [
      { label: 'Dedication', value: Math.min(avgHoursPerGame / 100, 1) },
      { label: 'Variety', value: Math.min(uniqueGenreCount / 10, 1) },
      { label: 'Commitment', value: completionRate / 100 },
      { label: 'Speed', value: avgDaysToComplete > 0 ? Math.min(30 / avgDaysToComplete, 1) : 0 },
      { label: 'Consistency', value: Math.min(sessionsPerWeek / 5, 1) },
      { label: 'Quality', value: avgRating / 5 },
    ];

    // ── Genre radar (top 6) ──────────────────────────────────────────────
    const genreRadarRaw = topGenres.slice(0, 6);
    const maxGenreCount = Math.max(1, ...genreRadarRaw.map(([, c]) => c));
    const genreRadar = genreRadarRaw.map(([genre, count]) => ({
      label: genre,
      value: count / maxGenreCount,
    }));

    // ── Funnel ───────────────────────────────────────────────────────────
    const startedCount =
      (statusCounts['Playing'] || 0) +
      (statusCounts['Playing Now'] || 0) +
      (statusCounts['Completed'] || 0) +
      (statusCounts['On Hold'] || 0);
    const startedPct = totalGames > 0 ? Math.round((startedCount / totalGames) * 100) : 0;
    const completedPct = totalGames > 0 ? Math.round((completedCount / totalGames) * 100) : 0;
    const funnelStages = [
      { label: 'In Library', count: totalGames, color: '#8b5cf6' },
      { label: 'Started', count: startedCount, color: '#3b82f6', pct: startedPct },
      { label: 'Completed', count: completedCount, color: '#22c55e', pct: completedPct },
    ];

    // ── Backlog insights ─────────────────────────────────────────────────
    const backlogEntries = journeyEntries.filter((e) => e.status === 'Want to Play');
    const backlogCount = backlogEntries.length;
    const avgBacklogAge =
      backlogCount > 0
        ? Math.round(
            backlogEntries.reduce((sum, e) => sum + (now.getTime() - new Date(e.addedAt).getTime()), 0) /
              backlogCount /
              86_400_000,
          )
        : 0;

    // ── NEW: Play schedule heatmap (7 days x 24 hours) ───────────────────
    const heatmapMatrix: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const ses of sessions) {
      const d = new Date(ses.startTime);
      const dayIdx = d.getDay() === 0 ? 6 : d.getDay() - 1;
      const hour = d.getHours();
      heatmapMatrix[dayIdx][hour] += ses.durationMinutes;
    }
    const heatmapMax = Math.max(1, ...heatmapMatrix.flat());

    // ── NEW: Streak tracking ─────────────────────────────────────────────
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

    // ── NEW: Session length distribution ─────────────────────────────────
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

    // ── NEW: Priority breakdown (from libraryEntries) ────────────────────
    const priorityCounts: Record<string, number> = { High: 0, Medium: 0, Low: 0 };
    const priorityCompletedCounts: Record<string, number> = { High: 0, Medium: 0, Low: 0 };
    for (const le of libraryEntries) {
      priorityCounts[le.priority] = (priorityCounts[le.priority] || 0) + 1;
      if (le.status === 'Completed') {
        priorityCompletedCounts[le.priority] = (priorityCompletedCounts[le.priority] || 0) + 1;
      }
    }

    // ── NEW: Recommendation source analysis (from libraryEntries) ────────
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

    // ── NEW: Release year distribution ───────────────────────────────────
    const releaseYearCounts: Record<number, number> = {};
    for (const entry of journeyEntries) {
      if (entry.releaseDate) {
        const year = new Date(entry.releaseDate).getFullYear();
        if (!isNaN(year) && year > 1970) {
          releaseYearCounts[year] = (releaseYearCounts[year] || 0) + 1;
        }
      }
    }
    const releaseYearsRaw = Object.entries(releaseYearCounts)
      .map(([y, c]) => ({ year: Number(y), count: c }))
      .sort((a, b) => a.year - b.year);

    // Group by decade if too many distinct years
    let releaseYearDisplay: { label: string; count: number }[];
    if (releaseYearsRaw.length > 15) {
      const decadeCounts: Record<string, number> = {};
      for (const ry of releaseYearsRaw) {
        const decade = `${Math.floor(ry.year / 10) * 10}s`;
        decadeCounts[decade] = (decadeCounts[decade] || 0) + ry.count;
      }
      releaseYearDisplay = Object.entries(decadeCounts)
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => a.label.localeCompare(b.label));
    } else {
      releaseYearDisplay = releaseYearsRaw.map((ry) => ({ label: String(ry.year), count: ry.count }));
    }

    return {
      totalGames,
      totalHours,
      completedCount,
      completionRate,
      statusCounts,
      topGames,
      maxHours,
      monthlyActivity,
      avgDaysToComplete,
      topGenres,
      ratingCounts,
      avgRating,
      topPlatforms,
      totalSessions,
      avgSessionLength,
      idleRatio,
      monthlyCompletions,
      topGamesByRating,
      sparklineGamesAdded,
      deltaGames,
      deltaCompletions,
      recentActivity,
      gamingProfile,
      genreRadar,
      funnelStages,
      backlogCount,
      avgBacklogAge,
      heatmapMatrix,
      heatmapMax,
      currentStreak,
      longestStreak,
      sessionBuckets,
      priorityCounts,
      priorityCompletedCounts,
      recSources,
      releaseYearDisplay,
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
    <div className="max-w-7xl mx-auto px-4 md:px-8 lg:px-10 pb-10 space-y-6">
      {/* ─── Row 1: Key metrics ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={Gamepad2} label="Total Games" delay={0}>
          <div className="flex items-start justify-between">
            <div>
              <AnimatedValue
                value={analytics.totalGames}
                formatFn={formatNumber}
                className="text-3xl font-bold text-fuchsia-400 font-['Orbitron']"
                delay={0.3}
              />
              <DeltaLabel value={analytics.deltaGames} suffix="this month" />
            </div>
            <Sparkline data={analytics.sparklineGamesAdded} color="#d946ef" />
          </div>
        </StatCard>

        <StatCard icon={Clock} label="Total Hours" delay={0.08}>
          <AnimatedValue
            value={Math.round(analytics.totalHours)}
            formatFn={formatNumber}
            className="text-3xl font-bold text-cyan-400 font-['Orbitron']"
            delay={0.35}
          />
          <p className="text-xs text-white/40 mt-1">hours played</p>
        </StatCard>

        <StatCard icon={Trophy} label="Completion Rate" delay={0.16}>
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-end gap-2">
                <AnimatedValue
                  value={analytics.completionRate}
                  formatFn={(n) => `${n}%`}
                  className="text-3xl font-bold text-green-400 font-['Orbitron']"
                  delay={0.4}
                />
                <p className="text-xs text-white/40 mb-1">
                  ({analytics.completedCount}/{analytics.totalGames})
                </p>
              </div>
              <DeltaLabel value={analytics.deltaCompletions} suffix="completed this month" />
            </div>
            <AnimatedRadialGauge value={analytics.completionRate} color="#22c55e" label={`${analytics.completionRate}%`} />
          </div>
        </StatCard>

        <StatCard icon={Timer} label="Avg. Time to Complete" delay={0.24}>
          {analytics.avgDaysToComplete > 0 ? (
            <AnimatedValue
              value={analytics.avgDaysToComplete}
              formatFn={(n) => String(n)}
              className="text-3xl font-bold text-amber-400 font-['Orbitron']"
              delay={0.45}
            />
          ) : (
            <p className="text-3xl font-bold text-amber-400 font-['Orbitron']">—</p>
          )}
          <p className="text-xs text-white/40 mt-1">
            {analytics.avgDaysToComplete > 0 ? 'days on average' : 'no data yet'}
          </p>
        </StatCard>
      </div>

      {/* ─── Row 1b: Streak accent bar ──────────────────────────────── */}
      {analytics.totalSessions > 0 && (
        <motion.div
          className="flex items-center justify-center gap-8 py-2 rounded-xl bg-white/[0.02] border border-white/5"
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4 }}
        >
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
        </motion.div>
      )}

      {/* ─── Row 2: Status Donut + Monthly Area Chart ───────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <StatCard icon={PieChart} label="Status Overview" delay={0}>
          <div className="flex items-center gap-6">
            <DonutChart
              segments={[
                { value: analytics.statusCounts['Playing'] || 0, color: statusStrokeColors['Playing'], label: 'Playing' },
                { value: analytics.statusCounts['Completed'] || 0, color: statusStrokeColors['Completed'], label: 'Completed' },
                { value: analytics.statusCounts['On Hold'] || 0, color: statusStrokeColors['On Hold'], label: 'On Hold' },
                { value: analytics.statusCounts['Want to Play'] || 0, color: statusStrokeColors['Want to Play'], label: 'Want to Play' },
              ]}
              centerLabel={`${analytics.completionRate}%`}
              centerSub="completed"
            />
            <div className="space-y-2.5">
              {(['Playing', 'Completed', 'On Hold', 'Want to Play'] as GameStatus[]).map((status) => (
                <div key={status} className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: statusStrokeColors[status] }} />
                  <span className={cn('text-xs font-medium', statusTextColors[status])}>{status}</span>
                  <span className="text-xs text-white/30">{analytics.statusCounts[status] || 0}</span>
                </div>
              ))}
            </div>
          </div>
        </StatCard>

        <StatCard icon={TrendingUp} label="Monthly Activity" delay={0.1}>
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
      </div>

      {/* ─── Row 3: Rating Distribution + Platform Breakdown ────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <StatCard icon={Star} label="Rating Distribution" delay={0}>
          {analytics.avgRating === 0 ? (
            <p className="text-xs text-white/40">No ratings yet</p>
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-lg font-bold text-yellow-400 font-['Orbitron']">{analytics.avgRating}</span>
                <MiniStars rating={Math.round(analytics.avgRating)} />
                <span className="text-xs text-white/30">avg rating</span>
              </div>
              <div className="space-y-1.5">
                {[5, 4, 3, 2, 1].map((star) => {
                  const count = analytics.ratingCounts[star];
                  const maxCount = Math.max(1, ...analytics.ratingCounts.slice(1));
                  const pct = (count / maxCount) * 100;
                  return (
                    <div key={star} className="flex items-center gap-2">
                      <div className="flex items-center gap-0.5 w-10 justify-end">
                        <span className="text-[10px] text-white/50">{star}</span>
                        <Star className="w-2.5 h-2.5 text-yellow-400 fill-yellow-400" />
                      </div>
                      <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                        <motion.div
                          className="h-full rounded-full bg-yellow-400/70"
                          initial={{ width: '0%' }}
                          whileInView={{ width: `${Math.max(pct, count > 0 ? 3 : 0)}%` }}
                          viewport={{ once: true }}
                          transition={{ duration: 0.6, delay: (5 - star) * 0.08, ease: 'easeOut' }}
                        />
                      </div>
                      <span className="text-[10px] text-white/30 w-4 text-right">{count}</span>
                    </div>
                  );
                })}
                {analytics.ratingCounts[0] > 0 && (
                  <div className="flex items-center gap-2 mt-1">
                    <div className="w-10 text-right"><span className="text-[10px] text-white/25">N/A</span></div>
                    <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                      <motion.div
                        className="h-full rounded-full bg-white/10"
                        initial={{ width: '0%' }}
                        whileInView={{ width: `${Math.max((analytics.ratingCounts[0] / Math.max(1, ...analytics.ratingCounts.slice(1))) * 100, 3)}%` }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.6, delay: 0.5 }}
                      />
                    </div>
                    <span className="text-[10px] text-white/25 w-4 text-right">{analytics.ratingCounts[0]}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </StatCard>

        <StatCard icon={Monitor} label="Platform Breakdown" delay={0.1}>
          {analytics.topPlatforms.length === 0 ? (
            <p className="text-xs text-white/40">No platform data</p>
          ) : analytics.topPlatforms.length === 1 ? (
            <div className="flex items-center gap-3">
              <Monitor className="w-8 h-8 text-blue-400" />
              <div>
                <p className="text-lg font-bold text-blue-400">{analytics.topPlatforms[0][0]}</p>
                <p className="text-xs text-white/40">{analytics.topPlatforms[0][1]} games — 100%</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-6">
              <DonutChart
                size={100}
                strokeWidth={10}
                segments={analytics.topPlatforms.map(([p, count]) => ({
                  value: count,
                  color: getPlatformColor(p),
                  label: p,
                }))}
              />
              <div className="space-y-2">
                {analytics.topPlatforms.map(([platform, count]) => {
                  const pct = analytics.totalGames > 0 ? Math.round((count / analytics.totalGames) * 100) : 0;
                  return (
                    <div key={platform} className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: getPlatformColor(platform) }} />
                      <span className="text-xs text-white/70">{platform}</span>
                      <span className="text-xs text-white/30">{count} ({pct}%)</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </StatCard>
      </div>

      {/* ─── Row 4: Top Games by Hours + Top Games by Rating ────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                      {(getHardcodedCover(game.title) || game.coverUrl) ? (
                        <img src={getHardcodedCover(game.title) || game.coverUrl} alt={game.title} className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center"><Gamepad2 className="w-2.5 h-2.5 text-white/20" /></div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-xs text-white/80 truncate font-medium">{game.title}</span>
                        <span className="text-[10px] text-cyan-400 flex-shrink-0 ml-2">{game.hoursPlayed}h</span>
                      </div>
                      <div className="h-1 rounded-full bg-white/5 overflow-hidden">
                        <motion.div
                          className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-400"
                          initial={{ width: '0%' }}
                          whileInView={{ width: `${pct}%` }}
                          viewport={{ once: true }}
                          transition={{ duration: 0.7, delay: i * 0.1, ease: 'easeOut' }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </StatCard>

        <StatCard icon={Award} label="Top Games by Rating" delay={0.1}>
          {analytics.topGamesByRating.length === 0 ? (
            <p className="text-xs text-white/40">No rated games yet</p>
          ) : (
            <div className="space-y-2">
              {analytics.topGamesByRating.map((game, i) => (
                <div key={game.gameId} className="flex items-center gap-2">
                  <span className="text-[10px] text-white/30 w-3 text-right font-mono">{i + 1}</span>
                  <div className="w-5 h-7 rounded-sm overflow-hidden bg-white/5 flex-shrink-0">
                    {(getHardcodedCover(game.title) || game.coverUrl) ? (
                      <img src={getHardcodedCover(game.title) || game.coverUrl} alt={game.title} className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center"><Gamepad2 className="w-2.5 h-2.5 text-white/20" /></div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-xs text-white/80 truncate font-medium">{game.title}</span>
                      <MiniStars rating={game.rating} />
                    </div>
                    <div className="h-1 rounded-full bg-white/5 overflow-hidden">
                      <motion.div
                        className="h-full rounded-full bg-gradient-to-r from-yellow-500 to-amber-400"
                        initial={{ width: '0%' }}
                        whileInView={{ width: `${(game.rating / 5) * 100}%` }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.7, delay: i * 0.1, ease: 'easeOut' }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </StatCard>
      </div>

      {/* ─── Row 5: Session Insights + Play Schedule Heatmap ────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <StatCard icon={Activity} label="Session Insights" delay={0}>
          {analytics.totalSessions === 0 ? (
            <p className="text-xs text-white/40">
              No session data yet. Set an executable path on a game to start tracking.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <div className="grid grid-cols-2 gap-3 flex-1">
                  <div>
                    <AnimatedValue value={analytics.totalSessions} formatFn={String} className="text-xl font-bold text-violet-400 font-['Orbitron']" delay={0.3} />
                    <p className="text-[10px] text-white/40 mt-0.5">total sessions</p>
                  </div>
                  <div>
                    <AnimatedValue value={analytics.avgSessionLength} formatFn={(n) => `${n}m`} className="text-xl font-bold text-cyan-400 font-['Orbitron']" delay={0.4} />
                    <p className="text-[10px] text-white/40 mt-0.5">avg length</p>
                  </div>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <AnimatedRadialGauge value={analytics.idleRatio} color="#f59e0b" label={`${analytics.idleRatio}%`} />
                  <span className="text-[9px] text-white/30">idle</span>
                </div>
              </div>
              {/* Session length distribution */}
              <div>
                <p className="text-[10px] text-white/30 mb-2 uppercase tracking-wider">Session Length</p>
                <div className="flex items-end gap-1.5 h-16">
                  {analytics.sessionBuckets.map((bucket, i) => {
                    const maxBucket = Math.max(1, ...analytics.sessionBuckets.map((b) => b.count));
                    const pct = (bucket.count / maxBucket) * 100;
                    return (
                      <div key={bucket.label} className="flex-1 flex flex-col items-center gap-0.5 group/bar">
                        <span className="text-[8px] text-white/30 opacity-0 group-hover/bar:opacity-100 transition-opacity">
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
                        <span className="text-[7px] text-white/25 text-center leading-tight">{bucket.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </StatCard>

        <StatCard icon={CalendarDays} label="Play Schedule" delay={0.1}>
          {analytics.totalSessions === 0 ? (
            <p className="text-xs text-white/40">No session data yet</p>
          ) : (
            <div>
              <PlayScheduleHeatmap matrix={analytics.heatmapMatrix} maxVal={analytics.heatmapMax} />
              <div className="flex items-center justify-end gap-1 mt-2">
                <span className="text-[8px] text-white/20">less</span>
                {[0.05, 0.2, 0.4, 0.65, 0.85].map((v) => (
                  <div
                    key={v}
                    className="w-2.5 h-2.5 rounded-[2px]"
                    style={{ backgroundColor: `rgba(139, 92, 246, ${v})` }}
                  />
                ))}
                <span className="text-[8px] text-white/20">more</span>
              </div>
            </div>
          )}
        </StatCard>
      </div>

      {/* ─── Row 6: Genre Distribution + Recent Activity Feed ───────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <StatCard icon={Tag} label="Genre Distribution" delay={0}>
          {analytics.topGenres.length === 0 ? (
            <p className="text-xs text-white/40">No genre data available</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {analytics.topGenres.map(([genre, count], i) => (
                <motion.div
                  key={genre}
                  initial={{ opacity: 0, scale: 0.8 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.3, delay: i * 0.04 }}
                  className={cn(
                    'px-2.5 py-1 rounded-full text-[11px] font-medium',
                    'bg-fuchsia-500/10 text-fuchsia-300 border border-fuchsia-500/20',
                    'hover:bg-fuchsia-500/20 hover:border-fuchsia-500/30 transition-colors',
                  )}
                >
                  {genre}
                  <span className="ml-1 text-fuchsia-400/60">{count}</span>
                </motion.div>
              ))}
            </div>
          )}
        </StatCard>

        <StatCard icon={History} label="Recent Activity" delay={0.1}>
          {analytics.recentActivity.length === 0 ? (
            <p className="text-xs text-white/40">No status changes recorded yet</p>
          ) : (
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
          )}
        </StatCard>
      </div>

      {/* ─── Row 7: Gaming Profile Radar + Genre Radar ──────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <StatCard icon={Target} label="Gaming Profile" delay={0}>
          <div className="flex justify-center">
            <RadarChart data={analytics.gamingProfile} color="#d946ef" size={220} />
          </div>
          <p className="text-[10px] text-white/30 text-center mt-2">Your multi-dimensional gaming identity</p>
        </StatCard>

        <StatCard icon={Hexagon} label="Genre Radar" delay={0.1}>
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
      </div>

      {/* ─── Row 8: Completion Funnel + Backlog Insights ────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <StatCard icon={Filter} label="Completion Funnel" delay={0}>
          <CompletionFunnel stages={analytics.funnelStages} />
          <p className="text-[10px] text-white/30 text-center mt-3">How your library flows from added to completed</p>
        </StatCard>

        <StatCard icon={Timer} label="Backlog Insights" delay={0.1}>
          <div className="flex items-center gap-5">
            <AnimatedRadialGauge
              value={analytics.backlogCount}
              max={Math.max(analytics.totalGames, 1)}
              size={80}
              strokeWidth={7}
              color="#f59e0b"
              label={String(analytics.backlogCount)}
            />
            <div className="space-y-3">
              <div>
                <p className="text-lg font-bold text-amber-400 font-['Orbitron']">{analytics.backlogCount}</p>
                <p className="text-[10px] text-white/40">games in backlog</p>
              </div>
              <div>
                <p className="text-lg font-bold text-white/70 font-['Orbitron']">
                  {analytics.avgBacklogAge > 0 ? `${analytics.avgBacklogAge}d` : '—'}
                </p>
                <p className="text-[10px] text-white/40">{analytics.avgBacklogAge > 0 ? 'avg backlog age' : 'no backlog'}</p>
              </div>
            </div>
          </div>
        </StatCard>
      </div>

      {/* ─── Row 9: Priority Breakdown + Recommendation Source ──────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <StatCard icon={Flag} label="Priority Breakdown" delay={0}>
          {libraryEntries.length === 0 ? (
            <p className="text-xs text-white/40">No library data</p>
          ) : (
            <div className="flex items-center gap-6">
              <DonutChart
                size={110}
                strokeWidth={12}
                segments={(['High', 'Medium', 'Low'] as const).map((p) => ({
                  value: analytics.priorityCounts[p] || 0,
                  color: priorityColors[p],
                  label: p,
                }))}
              />
              <div className="space-y-2">
                {(['High', 'Medium', 'Low'] as const).map((priority) => {
                  const count = analytics.priorityCounts[priority] || 0;
                  const completed = analytics.priorityCompletedCounts[priority] || 0;
                  const rate = count > 0 ? Math.round((completed / count) * 100) : 0;
                  return (
                    <div key={priority} className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: priorityColors[priority] }} />
                      <span className="text-xs text-white/70 w-12">{priority}</span>
                      <span className="text-[10px] text-white/30">{count}</span>
                      <span className="text-[9px] text-green-400/60 ml-1">{rate}% done</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </StatCard>

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
                        whileInView={{ width: `${Math.max(pct, 3)}%` }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.6, delay: i * 0.08, ease: 'easeOut' }}
                      />
                    </div>
                    <span className="text-[10px] text-white/30 w-3 text-right">{src.count}</span>
                    {src.avgRating > 0 && (
                      <span className="text-[9px] text-yellow-400/60 w-7 text-right">{src.avgRating}★</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </StatCard>
      </div>

      {/* ─── Row 10: Release Year Distribution ──────────────────────── */}
      {analytics.releaseYearDisplay.length > 0 && (
        <StatCard icon={Calendar} label="Release Year Distribution" delay={0}>
          <div className="space-y-1">
            {analytics.releaseYearDisplay.map((ry, i) => {
              const maxCount = Math.max(1, ...analytics.releaseYearDisplay.map((r) => r.count));
              const pct = (ry.count / maxCount) * 100;
              return (
                <div key={ry.label} className="flex items-center gap-2">
                  <span className="text-[10px] text-white/40 w-9 text-right font-mono">{ry.label}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                    <motion.div
                      className="h-full rounded-full bg-gradient-to-r from-violet-500/70 to-fuchsia-400/50"
                      initial={{ width: '0%' }}
                      whileInView={{ width: `${Math.max(pct, 3)}%` }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.6, delay: i * 0.04, ease: 'easeOut' }}
                    />
                  </div>
                  <span className="text-[10px] text-white/30 w-3 text-right">{ry.count}</span>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-white/30 text-center mt-3">
            {analytics.releaseYearDisplay.length > 10 ? 'Grouped by decade' : 'Games by release year'}
          </p>
        </StatCard>
      )}
    </div>
  );
}
