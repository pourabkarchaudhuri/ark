/**
 * The Constellation — Full Achievement Skill Tree
 *
 * Every badge in the 8 core branches renders as a node.
 * Progression chains (same condition type, increasing threshold) are connected.
 * Chains radiate outward from branch nodes as spokes.
 * Click a branch to illuminate its sub-tree; everything else dims.
 * Nodes are NOT draggable — pan/zoom only.
 */
import { memo, useMemo, useState, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { motion, AnimatePresence } from 'framer-motion';
import type { BadgeBranch, BadgeCondition, BadgeProgress } from '@/data/badge-types';
import { BRANCH_META, TIER_GRADIENTS, BRANCH_MOTIFS, TIER_NEON } from '@/data/badge-types';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SkillTreeProps {
  branchProgress: Map<BadgeBranch, { unlocked: number; total: number }>;
  totalPoints: number;
  commanderLevel: number;
  badges: BadgeProgress[];
}

const CORE_BRANCHES: BadgeBranch[] = [
  'voyager', 'conqueror', 'sentinel', 'timekeeper',
  'scholar', 'chronicler', 'pioneer', 'stargazer',
];

type NodeState = 'locked' | 'unlocked' | 'mastered';

// ─── Node data interfaces ───────────────────────────────────────────────────

interface HexData extends Record<string, unknown> {
  label: string;
  subLabel?: string;
  state: NodeState;
  nodeKind: 'commander' | 'branch';
  branch?: BadgeBranch;
  dimmed: boolean;
  motifPath?: string;
}

interface DotData extends Record<string, unknown> {
  name: string;
  state: NodeState;
  dimmed: boolean;
  neonColor: string;
  neonGlow: string;
}

// ─── Chain detection ────────────────────────────────────────────────────────

function conditionKey(cond: BadgeCondition): string {
  switch (cond.type) {
    case 'storeGameCount':    return `${cond.type}:${cond.store}`;
    case 'platformGameCount': return `${cond.type}:${cond.platform}`;
    case 'genreGameCount':    return `${cond.type}:${cond.genre}`;
    case 'genreHours':        return `${cond.type}:${cond.genre}`;
    case 'genreCompletions':  return `${cond.type}:${cond.genre}`;
    case 'gamesInStatus':     return `${cond.type}:${cond.status}`;
    case 'metacriticAbove':   return `${cond.type}:${cond.score}`;
    case 'gamesPerYear':      return `${cond.type}:${cond.year}`;
    case 'tierBadgeCount':    return `${cond.type}:${cond.tier}`;
    case 'averageRating':     return `${cond.type}:${cond.min}:${cond.max}`;
    default:                  return cond.type;
  }
}

function conditionMin(cond: BadgeCondition): number {
  if ('min' in cond) return (cond as { min: number }).min;
  if ('minPerBranch' in cond) return (cond as { minPerBranch: number }).minPerBranch;
  return 0;
}

function detectChains(branchBadges: BadgeProgress[]): BadgeProgress[][] {
  const groups = new Map<string, BadgeProgress[]>();
  for (const bp of branchBadges) {
    const key = conditionKey(bp.badge.condition);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(bp);
  }
  const chains: BadgeProgress[][] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => conditionMin(a.badge.condition) - conditionMin(b.badge.condition));
    chains.push(group);
  }
  chains.sort((a, b) => b.length - a.length);
  return chains;
}

// ─── Hex helpers ────────────────────────────────────────────────────────────

function hexPoints(half: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (60 * i - 30) * (Math.PI / 180);
    pts.push(`${half + half * Math.cos(angle)},${half + half * Math.sin(angle)}`);
  }
  return pts.join(' ');
}

// ─── HexNode (commander + branch) ───────────────────────────────────────────

function HexNodeComponent({ data }: NodeProps<Node<HexData>>) {
  const { label, subLabel, state, nodeKind, dimmed, motifPath } = data;
  const size = nodeKind === 'commander' ? 90 : 72;
  const half = size / 2;
  const hex = useMemo(() => hexPoints(half), [half]);

  const borderColor = state === 'mastered' ? 'rgba(217,70,239,1)'
    : state === 'unlocked' ? 'rgba(168,85,247,0.7)' : 'rgba(255,255,255,0.12)';
  const fillColor = state === 'mastered' ? 'rgba(217,70,239,0.18)'
    : state === 'unlocked' ? 'rgba(168,85,247,0.1)' : 'rgba(255,255,255,0.03)';
  const textColor = state === 'mastered' ? 'text-white'
    : state === 'unlocked' ? 'text-fuchsia-300' : 'text-white/30';

  return (
    <div className="relative" style={{ width: size, height: size, opacity: dimmed ? 0.2 : 1, transition: 'opacity 0.35s ease' }}>
      <Handle type="target" position={Position.Top} className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-0 !w-0 !h-0" />
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0">
        {state !== 'locked' && !dimmed && (
          <polygon points={hex} fill="none" stroke={borderColor} strokeWidth={3} opacity={0.25} filter="url(#node-glow)" />
        )}
        <polygon points={hex} fill={fillColor} stroke={borderColor} strokeWidth={1.5} strokeLinejoin="round" />
        {state === 'mastered' && nodeKind === 'branch' && !dimmed && (
          <motion.polygon points={hex} fill="none" stroke="rgba(217,70,239,0.5)" strokeWidth={1}
            initial={{ opacity: 0.6 }} animate={{ opacity: 0 }}
            transition={{ repeat: Infinity, duration: 2.5, ease: 'easeOut' }} />
        )}
        {motifPath && nodeKind === 'branch' && (
          <g transform={`translate(${half - 15},${half - 15}) scale(1.25)`} opacity={state === 'locked' ? 0.08 : 0.2}>
            <path d={motifPath} fill="none" stroke="white" strokeWidth={0.8} />
          </g>
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className={cn('font-bold font-mono uppercase tracking-wider leading-tight text-center px-1', textColor,
          nodeKind === 'commander' ? 'text-[10px]' : 'text-[8px]')}>{label}</span>
        {subLabel && <span className={cn('text-[7px] font-mono mt-0.5', state !== 'locked' ? 'text-white/40' : 'text-white/15')}>{subLabel}</span>}
      </div>
    </div>
  );
}

// ─── DotNode (individual badge) ─────────────────────────────────────────────

function DotNodeComponent({ data }: NodeProps<Node<DotData>>) {
  const { name, state, dimmed, neonColor } = data;
  const isLit = state !== 'locked';

  return (
    <div className="relative" style={{ width: 22, height: 22, opacity: dimmed ? 0.1 : 1, transition: 'opacity 0.35s ease' }} title={name}>
      <Handle type="target" position={Position.Top} className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-0 !w-0 !h-0" />
      <svg width={22} height={22} viewBox="0 0 22 22">
        {isLit && !dimmed && (
          <circle cx={11} cy={11} r={10} fill="none" stroke={neonColor} strokeWidth={2} opacity={0.3} filter="url(#node-glow)" />
        )}
        <circle cx={11} cy={11} r={7}
          fill={isLit ? `${neonColor}20` : 'rgba(255,255,255,0.02)'}
          stroke={isLit ? neonColor : 'rgba(255,255,255,0.1)'}
          strokeWidth={isLit ? 1.2 : 0.5} />
        {isLit && <circle cx={11} cy={11} r={2.5} fill={neonColor} opacity={0.8} />}
      </svg>
    </div>
  );
}

const nodeTypes = { hex: HexNodeComponent, dot: DotNodeComponent };

// ─── Edge defaults ──────────────────────────────────────────────────────────

const DIM_STROKE = 'rgba(255,255,255,0.07)';
const DIM_WIDTH = 0.7;
const DIMMED_OPACITY = 0.15;

// ─── Layout builder ─────────────────────────────────────────────────────────

function buildLayout(
  branchProgress: Map<BadgeBranch, { unlocked: number; total: number }>,
  badges: BadgeProgress[],
  totalPoints: number,
  commanderLevel: number,
  selectedBranch: BadgeBranch | null,
) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const RING_B = 280;

  // Commander
  nodes.push({
    id: 'commander', type: 'hex',
    position: { x: -45, y: -45 },
    data: {
      label: `LVL ${commanderLevel}`,
      subLabel: `${totalPoints.toLocaleString()} XP`,
      state: 'mastered', nodeKind: 'commander', dimmed: false,
    } satisfies HexData,
    draggable: false, selectable: false,
  });

  // Per-branch badge index
  const badgesByBranch = new Map<BadgeBranch, BadgeProgress[]>();
  for (const bp of badges) {
    if (!CORE_BRANCHES.includes(bp.badge.branch)) continue;
    const branch = bp.badge.branch;
    if (!badgesByBranch.has(branch)) badgesByBranch.set(branch, []);
    badgesByBranch.get(branch)!.push(bp);
  }

  CORE_BRANCHES.forEach((branch, i) => {
    const angle = (i * 45 - 90) * (Math.PI / 180);
    const prog = branchProgress.get(branch) || { unlocked: 0, total: 0 };
    const pct = prog.total > 0 ? Math.round((prog.unlocked / prog.total) * 100) : 0;
    const bState: NodeState = pct >= 90 ? 'mastered' : pct > 0 ? 'unlocked' : 'locked';
    const meta = BRANCH_META[branch];
    const isSel = selectedBranch === branch;
    const brDimmed = selectedBranch !== null && !isSel;

    const bx = RING_B * Math.cos(angle);
    const by = RING_B * Math.sin(angle);
    const branchId = `b-${branch}`;

    nodes.push({
      id: branchId, type: 'hex',
      position: { x: bx - 36, y: by - 36 },
      data: {
        label: meta.label.replace('The ', ''),
        subLabel: `${pct}%`,
        state: bState, nodeKind: 'branch', branch, dimmed: brDimmed,
        motifPath: BRANCH_MOTIFS[branch],
      } satisfies HexData,
      draggable: false, selectable: false,
    });

    const brLit = bState !== 'locked' && !brDimmed;
    edges.push({
      id: `e-cmd-${branch}`, source: 'commander', target: branchId,
      animated: brLit && isSel,
      style: {
        stroke: brLit ? 'rgba(168,85,247,0.4)' : DIM_STROKE,
        strokeWidth: brLit ? 2 : DIM_WIDTH,
        opacity: brDimmed ? DIMMED_OPACITY : 1,
        transition: 'opacity 0.35s ease',
      },
    });

    // Individual badge nodes
    const branchBadges = badgesByBranch.get(branch) || [];
    const chains = detectChains(branchBadges);
    const chainCount = chains.length;
    const ARC_HALF = 0.32; // radians (~18°) half-spread per branch

    chains.forEach((chain, ci) => {
      const spokeAngle = chainCount > 1
        ? angle + (ci / (chainCount - 1) - 0.5) * ARC_HALF * 2
        : angle;

      const step = Math.min(42, Math.max(18, 520 / chain.length));

      chain.forEach((bp, bi) => {
        const neon = TIER_NEON[bp.badge.tier];
        const radius = RING_B + 80 + bi * step;
        const nx = radius * Math.cos(spokeAngle);
        const ny = radius * Math.sin(spokeAngle);
        const nodeId = `d-${bp.badge.id}`;
        const badgeDimmed = selectedBranch !== null && !isSel;
        const badgeState: NodeState = bp.unlocked ? 'unlocked' : 'locked';

        nodes.push({
          id: nodeId, type: 'dot',
          position: { x: nx - 11, y: ny - 11 },
          data: {
            name: bp.badge.name,
            state: badgeState,
            dimmed: badgeDimmed,
            neonColor: neon.color,
            neonGlow: neon.glow,
          } satisfies DotData,
          draggable: false, selectable: false,
        });

        // Edge: branch → first in chain, or prev → current within chain
        const sourceId = bi === 0 ? branchId : `d-${chain[bi - 1].badge.id}`;
        const edgeLit = bp.unlocked && !badgeDimmed;
        const tierColor = TIER_GRADIENTS[bp.badge.tier][1];

        edges.push({
          id: `e-${sourceId}-${nodeId}`,
          source: sourceId, target: nodeId,
          animated: false,
          style: {
            stroke: edgeLit ? `${tierColor}55` : DIM_STROKE,
            strokeWidth: edgeLit ? 1 : DIM_WIDTH,
            opacity: badgeDimmed ? DIMMED_OPACITY : 1,
            transition: 'opacity 0.35s ease',
          },
        });
      });
    });
  });

  return { nodes, edges };
}

// ─── Main Component ─────────────────────────────────────────────────────────

export const SkillTree = memo(function SkillTree({
  branchProgress, totalPoints, commanderLevel, badges,
}: SkillTreeProps) {
  const [selectedBranch, setSelectedBranch] = useState<BadgeBranch | null>(null);

  const { nodes, edges } = useMemo(
    () => buildLayout(branchProgress, badges, totalPoints, commanderLevel, selectedBranch),
    [branchProgress, badges, totalPoints, commanderLevel, selectedBranch],
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    const d = node.data as Record<string, unknown>;
    if (d.nodeKind === 'branch' && d.branch) {
      setSelectedBranch(prev => prev === d.branch ? null : d.branch as BadgeBranch);
    }
  }, []);

  const selMeta = selectedBranch ? BRANCH_META[selectedBranch] : null;
  const selProg = selectedBranch ? branchProgress.get(selectedBranch) : null;

  const selBadges = useMemo(() => {
    if (!selectedBranch) return [];
    return badges
      .filter(bp => bp.badge.branch === selectedBranch)
      .sort((a, b) => {
        if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
        return conditionMin(a.badge.condition) - conditionMin(b.badge.condition);
      });
  }, [selectedBranch, badges]);

  return (
    <div className="flex flex-col gap-3">
      <div className="w-full h-[700px] rounded-xl border border-white/5 overflow-hidden bg-black/40">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.15}
          maxZoom={3}
          proOptions={{ hideAttribution: true }}
          className="[&_.react-flow__attribution]:!hidden"
          style={{ background: 'transparent' }}
        >
          <Background color="rgba(168,85,247,0.025)" gap={36} size={1} />
          <svg width={0} height={0}>
            <defs>
              <filter id="node-glow"><feGaussianBlur in="SourceGraphic" stdDeviation="4" /></filter>
            </defs>
          </svg>
        </ReactFlow>
      </div>

      {/* Branch detail panel */}
      <AnimatePresence mode="wait">
        {selectedBranch && selMeta && selProg && (
          <motion.div
            key={selectedBranch}
            className="rounded-xl border border-white/5 bg-white/[0.02] p-4 max-h-[300px] overflow-y-auto"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            <div className="flex items-start justify-between mb-3">
              <div>
                <p className="text-sm font-bold text-fuchsia-400 tracking-wide">{selMeta.label}</p>
                <p className="text-[11px] text-white/30 italic font-mono mt-0.5">&ldquo;{selMeta.motto}&rdquo;</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-white/60 font-mono font-bold">{selProg.unlocked} / {selProg.total}</p>
                <div className="w-28 h-1.5 bg-white/5 rounded-full overflow-hidden mt-1">
                  <div className="h-full bg-fuchsia-500/60 rounded-full transition-all"
                    style={{ width: `${selProg.total > 0 ? (selProg.unlocked / selProg.total) * 100 : 0}%` }} />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-1.5">
              {selBadges.map(bp => {
                const neon = TIER_NEON[bp.badge.tier];
                return (
                  <div key={bp.badge.id} className="flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[10px]"
                    style={{
                      borderColor: bp.unlocked ? `${neon.color}30` : 'rgba(255,255,255,0.04)',
                      backgroundColor: bp.unlocked ? `${neon.color}08` : 'rgba(255,255,255,0.01)',
                      color: bp.unlocked ? neon.color : 'rgba(255,255,255,0.2)',
                    }}>
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: bp.unlocked ? neon.color : '#333' }} />
                    <span className="truncate font-mono">{bp.badge.name}</span>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
