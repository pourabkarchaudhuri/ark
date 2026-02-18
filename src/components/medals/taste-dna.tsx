/**
 * Taste DNA — Commander's Genome
 * Two visualizations: an animated DNA double-helix + an 8-axis radar chart.
 * Exported as separate components so the parent can place them in a masonry grid.
 */
import { memo, useMemo, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { TasteDnaAxis } from '@/data/badge-types';

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
// DNA RADAR — 8-axis spider chart
// ═══════════════════════════════════════════════════════════════════════════════

const R_SIZE = 280;
const R_C = R_SIZE / 2;
const R_R = 100;
const R_RINGS = 5;
const R_LABEL = 22;

function polar(angle: number, r: number): [number, number] {
  const rad = (angle - 90) * (Math.PI / 180);
  return [R_C + r * Math.cos(rad), R_C + r * Math.sin(rad)];
}

export const DnaRadar = memo(function DnaRadar({ axes, genomePurity }: { axes: TasteDnaAxis[]; genomePurity: number }) {
  const n = axes.length || 1;
  const step = 360 / n;

  const gridRings = useMemo(() => {
    const rings: React.ReactElement[] = [];
    for (let ring = 0; ring < R_RINGS; ring++) {
      const r = (R_R / R_RINGS) * (ring + 1);
      const pts: string[] = [];
      for (let i = 0; i < n; i++) {
        const [x, y] = polar(i * step, r);
        pts.push(`${x},${y}`);
      }
      const isOuter = ring === R_RINGS - 1;
      rings.push(
        <polygon key={ring} points={pts.join(' ')} fill="none"
          stroke="rgba(255,255,255,0.15)" strokeWidth={isOuter ? 0.8 : 0.4}
          strokeDasharray={isOuter ? undefined : '2 3'} />,
      );
    }
    return rings;
  }, [n, step]);

  const axisLines = useMemo(() =>
    Array.from({ length: n }, (_, i) => {
      const [x, y] = polar(i * step, R_R);
      return (
        <line key={i} x1={R_C} y1={R_C} x2={x} y2={y}
          stroke="rgba(255,255,255,0.1)" strokeWidth={0.5} />
      );
    }),
  [n, step]);

  const dataPoints = useMemo(() =>
    axes.map((a, i) => {
      const val = Math.max(a.value, 2);
      return polar(i * step, (val / 100) * R_R);
    }),
  [axes, step]);

  const dataString = useMemo(
    () => dataPoints.map(([x, y]) => `${x},${y}`).join(' '),
    [dataPoints],
  );

  const labels = useMemo(() =>
    axes.map((a, i) => {
      const [x, y] = polar(i * step, R_R + R_LABEL);
      return (
        <g key={a.key}>
          <text x={x} y={y} textAnchor="middle" dominantBaseline="middle"
            className="fill-white/50 text-xs font-mono uppercase tracking-wider">{a.label}</text>
          <text x={x} y={y + 14} textAnchor="middle" dominantBaseline="middle"
            className="fill-fuchsia-400 text-sm font-bold font-mono">{a.value}%</text>
        </g>
      );
    }),
  [axes, step]);

  return (
    <div className="flex flex-col items-center">
      <svg width={R_SIZE} height={R_SIZE} viewBox={`0 0 ${R_SIZE} ${R_SIZE}`} className="overflow-visible">
        <defs>
          <radialGradient id="rg-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgb(217,70,239)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="rgb(217,70,239)" stopOpacity="0.01" />
          </radialGradient>
          <filter id="rg-blur"><feGaussianBlur in="SourceGraphic" stdDeviation="4" /></filter>
        </defs>

        {/* Grid rings (octagonal web) */}
        {gridRings}

        {/* Axis spokes */}
        {axisLines}

        {/* Glow behind data polygon */}
        <polygon points={dataString} fill="url(#rg-glow)" stroke="none" filter="url(#rg-blur)" />

        {/* Data polygon */}
        <motion.polygon
          points={dataString}
          fill="rgba(217,70,239,0.12)"
          stroke="rgb(217,70,239)"
          strokeWidth={1.8}
          strokeLinejoin="round"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8 }}
        />

        {/* Vertex dots */}
        {dataPoints.map(([x, y], i) => (
          <motion.circle key={i} cx={x} cy={y} r={3}
            fill="rgb(217,70,239)" stroke="white" strokeWidth={1}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            transition={{ delay: 0.3 + i * 0.05 }} />
        ))}

        {/* Axis labels + values */}
        {labels}

        {/* Center purity */}
        <text x={R_C} y={R_C - 6} textAnchor="middle" dominantBaseline="middle"
          className="fill-white text-xl font-black font-mono">{genomePurity}%</text>
        <text x={R_C} y={R_C + 12} textAnchor="middle" dominantBaseline="middle"
          className="fill-white/30 text-[10px] font-mono uppercase tracking-[0.2em]">Purity</text>
      </svg>
    </div>
  );
});
