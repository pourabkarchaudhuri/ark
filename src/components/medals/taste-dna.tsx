/**
 * Taste DNA — Commander's Genome
 * Two visualizations: an animated DNA double-helix + an 8-axis radar chart.
 * Exported as separate components so the parent can place them in a masonry grid.
 */
import { memo, useMemo, useEffect, useRef, useState } from 'react';
import { PolarAngleAxis, PolarGrid, Radar, RadarChart } from 'recharts';
import type { TasteDnaAxis } from '@/data/badge-types';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';

// ═══════════════════════════════════════════════════════════════════════════════
// DNA HELIX — animated double-strand with rungs per axis
// ═══════════════════════════════════════════════════════════════════════════════

const H_W = 460;
const H_H = 200;
const H_CY = H_H / 2;
const H_AMP = 40;
const H_MX = 50;
const H_START = H_MX;
const H_END = H_W - H_MX;
const H_LEN = H_END - H_START;
const H_FREQ = 1.6;
const H_RES = 80;

function buildHelixPath(phase: number): string {
  const pts: string[] = [];
  for (let i = 0; i <= H_RES; i++) {
    const t = i / H_RES;
    const x = H_START + t * H_LEN;
    const y = H_CY + Math.sin(t * Math.PI * 2 * H_FREQ + phase) * H_AMP;
    pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(' ');
}

function getRungEndpoints(index: number, total: number, phase: number) {
  const t = (index + 0.5) / total;
  const x = H_START + t * H_LEN;
  const yA = H_CY + Math.sin(t * Math.PI * 2 * H_FREQ + phase) * H_AMP;
  const yB = H_CY + Math.sin(t * Math.PI * 2 * H_FREQ + phase + Math.PI) * H_AMP;
  return { x, yA, yB };
}

export const DnaHelix = memo(function DnaHelix({ axes }: { axes: TasteDnaAxis[] }) {
  const [phase, setPhase] = useState(0);
  const rafRef = useRef(0);

  useEffect(() => {
    let start: number | null = null;
    const animate = (ts: number) => {
      if (!start) start = ts;
      setPhase(((ts - start) / 5000) * Math.PI * 2);
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const strandA = useMemo(() => buildHelixPath(phase), [phase]);
  const strandB = useMemo(() => buildHelixPath(phase + Math.PI), [phase]);

  const rungs = useMemo(() =>
    axes.map((axis, i) => {
      const { x, yA, yB } = getRungEndpoints(i, axes.length, phase);
      const opacity = 0.3 + (axis.value / 100) * 0.7;
      const thickness = 1 + (axis.value / 100) * 2;
      return { axis, x, yA, yB, opacity, thickness };
    }),
  [axes, phase]);

  return (
    <svg width="100%" viewBox={`0 0 ${H_W} ${H_H}`} className="overflow-visible max-h-[200px]">
      <defs>
        <linearGradient id="ha-g" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="rgb(168,85,247)" stopOpacity="0.7" />
          <stop offset="50%" stopColor="rgb(217,70,239)" stopOpacity="1" />
          <stop offset="100%" stopColor="rgb(168,85,247)" stopOpacity="0.7" />
        </linearGradient>
        <linearGradient id="hb-g" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="rgb(6,182,212)" stopOpacity="0.5" />
          <stop offset="50%" stopColor="rgb(103,232,249)" stopOpacity="0.8" />
          <stop offset="100%" stopColor="rgb(6,182,212)" stopOpacity="0.5" />
        </linearGradient>
        <filter id="hg"><feGaussianBlur in="SourceGraphic" stdDeviation="3" /></filter>
      </defs>

      {/* Glow layers */}
      <path d={strandA} fill="none" stroke="url(#ha-g)" strokeWidth={4} opacity={0.25} filter="url(#hg)" />
      <path d={strandB} fill="none" stroke="url(#hb-g)" strokeWidth={4} opacity={0.25} filter="url(#hg)" />

      {/* Rungs */}
      {rungs.map(({ axis, x, yA, yB, opacity, thickness }) => (
        <g key={axis.key}>
          <line x1={x} y1={yA} x2={x} y2={yB}
            stroke="rgba(217,70,239,0.35)" strokeWidth={thickness} opacity={opacity} />
          <line x1={x} y1={yA} x2={x} y2={yB}
            stroke="white" strokeWidth={thickness * 0.5} opacity={opacity * 0.4} />
          <text x={x} y={Math.min(yA, yB) - 8} textAnchor="middle"
            className="fill-white/40 text-[7px] font-mono uppercase tracking-wider">{axis.label}</text>
          <text x={x} y={Math.max(yA, yB) + 14} textAnchor="middle"
            className="fill-fuchsia-400 text-[8px] font-bold font-mono">{axis.value}%</text>
          <circle cx={x} cy={yA} r={2} fill="rgb(168,85,247)" opacity={opacity} />
          <circle cx={x} cy={yB} r={2} fill="rgb(6,182,212)" opacity={opacity} />
        </g>
      ))}

      {/* Main strands */}
      <path d={strandA} fill="none" stroke="url(#ha-g)" strokeWidth={1.5} strokeLinecap="round" />
      <path d={strandB} fill="none" stroke="url(#hb-g)" strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// DNA RADAR — recharts-based spider chart
// ═══════════════════════════════════════════════════════════════════════════════

const dnaRadarConfig = {
  value: {
    label: 'Affinity',
    color: 'hsl(292, 84%, 61%)',
  },
} satisfies ChartConfig;

export const DnaRadar = memo(function DnaRadar({ axes, genomePurity }: { axes: TasteDnaAxis[]; genomePurity: number }) {
  const chartData = useMemo(
    () => axes.map((a) => ({ label: a.label, value: a.value })),
    [axes],
  );

  if (axes.length < 3) return null;

  return (
    <div className="flex flex-col items-center w-full h-full min-h-0">
      <ChartContainer config={dnaRadarConfig} className="mx-auto aspect-square h-full w-full">
        <RadarChart data={chartData}>
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent hideLabel />}
          />
          <PolarGrid gridType="circle" stroke="rgba(255,255,255,0.1)" />
          <PolarAngleAxis
            dataKey="label"
            tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.55)', fontFamily: 'JetBrains Mono, monospace' }}
          />
          <Radar
            dataKey="value"
            fill="hsl(292, 84%, 61%)"
            fillOpacity={0.45}
            stroke="hsl(292, 84%, 61%)"
            strokeWidth={1.8}
            dot={{ r: 3, fillOpacity: 1 }}
          />
        </RadarChart>
      </ChartContainer>
      <div className="mt-0.5 text-center">
        <span className="text-sm font-black font-mono text-white">{genomePurity}%</span>
        <span className="text-[8px] font-mono uppercase tracking-widest text-white/30 ml-1.5">Purity</span>
      </div>
    </div>
  );
});
