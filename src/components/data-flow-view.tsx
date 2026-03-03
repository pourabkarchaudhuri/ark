/**
 * Ark Data Flow — Real-time pipeline monitoring dashboard
 *
 * 5-column architecture diagram: Sources → Ingestion → AI/ML → Storage → Screens
 * with live status from SystemStatus, structured "cable-managed" edges, and
 * Ark-themed terminal node cards (CRT scanlines, monospace, lore labels).
 *
 * Performance: throttled updates (4/s), stable nodeTypes, structural equality
 * short-circuits, status-only edge recalc.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
  BackgroundVariant,
  Panel,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowLeft, Database, Globe, Cpu, Brain, Monitor,
  Workflow, Zap, HardDrive, Gauge, Activity,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { systemStatus, type SystemStatusSnapshot, type SyncStatus } from '@/services/system-status';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

type NodeCategory = 'source' | 'process' | 'ai' | 'storage' | 'screen';
type IconKey = 'globe' | 'database' | 'cpu' | 'workflow' | 'zap' | 'brain' | 'gauge' | 'hdd' | 'monitor';
type NodeStatus = 'idle' | 'running' | 'done' | 'error';

interface FlowNodeData {
  label: string;
  category: NodeCategory;
  iconKey: IconKey;
  status: NodeStatus;
  detail: string;
  percent: number;
  itemsDone?: number;
  itemsTotal?: number;
  loreTag?: string;
  [key: string]: unknown;
}

type FlowNode = Node<FlowNodeData>;

// ─── Ark color system ─────────────────────────────────────────────────────────

const CAT: Record<NodeCategory, {
  border: string; glow: string; icon: string; bar: string;
  tag: string; accent: string; edge: string;
}> = {
  source:  { border: 'border-sky-500/25',     glow: 'shadow-sky-500/20',     icon: 'text-sky-400',     bar: 'bg-sky-500',     tag: 'text-sky-500/70',     accent: 'bg-sky-500',     edge: '#38bdf8' },
  process: { border: 'border-violet-500/25',  glow: 'shadow-violet-500/20',  icon: 'text-violet-400',  bar: 'bg-violet-500',  tag: 'text-violet-500/70',  accent: 'bg-violet-500',  edge: '#8b5cf6' },
  ai:      { border: 'border-fuchsia-500/25', glow: 'shadow-fuchsia-500/20', icon: 'text-fuchsia-400', bar: 'bg-fuchsia-500', tag: 'text-fuchsia-500/70', accent: 'bg-fuchsia-500', edge: '#d946ef' },
  storage: { border: 'border-amber-500/25',   glow: 'shadow-amber-500/20',   icon: 'text-amber-400',   bar: 'bg-amber-500',   tag: 'text-amber-500/70',   accent: 'bg-amber-500',   edge: '#f59e0b' },
  screen:  { border: 'border-emerald-500/25', glow: 'shadow-emerald-500/20', icon: 'text-emerald-400', bar: 'bg-emerald-500', tag: 'text-emerald-500/70', accent: 'bg-emerald-500', edge: '#10b981' },
};

// ─── Icon renderer ───────────────────────────────────────────────────────────

const SZ = 'h-3.5 w-3.5';
function Icon({ k }: { k: IconKey }) {
  switch (k) {
    case 'globe':    return <Globe className={SZ} />;
    case 'database': return <Database className={SZ} />;
    case 'cpu':      return <Cpu className={SZ} />;
    case 'workflow': return <Workflow className={SZ} />;
    case 'zap':      return <Zap className={SZ} />;
    case 'brain':    return <Brain className={SZ} />;
    case 'gauge':    return <Gauge className={SZ} />;
    case 'hdd':      return <HardDrive className={SZ} />;
    case 'monitor':  return <Monitor className={SZ} />;
  }
}

// ─── Ark Terminal Node ────────────────────────────────────────────────────────

const STATUS_PREFIX: Record<NodeStatus, string> = {
  idle:    'STBY',
  running: 'SYNC',
  done:    ' OK ',
  error:   'FAIL',
};

const DataFlowNode = memo(function DataFlowNode({ data }: NodeProps<FlowNode>) {
  const d = data as FlowNodeData;
  const c = CAT[d.category];
  const active = d.status === 'running';
  const done = d.status === 'done';
  const err = d.status === 'error';

  return (
    <div
      className={cn(
        'group relative w-[280px] border bg-[#08080e]/95 transition-shadow duration-500',
        'rounded-sm',
        c.border,
        active && `shadow-lg ${c.glow}`,
      )}
    >
      <Handle type="target" position={Position.Left}
        className="!w-1.5 !h-3 !rounded-[1px] !bg-white/15 !border-0 !-left-[3px]" />
      <Handle type="source" position={Position.Right}
        className="!w-1.5 !h-3 !rounded-[1px] !bg-white/15 !border-0 !-right-[3px]" />

      {/* CRT scanline overlay */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-sm opacity-[0.03]"
        style={{ backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.4) 2px, rgba(255,255,255,0.4) 3px)', backgroundSize: '100% 3px' }}
      />

      {/* Top accent bar */}
      <div className={cn(
        'h-[1.5px]',
        active ? c.accent : done ? c.accent + ' opacity-30' : 'bg-white/[0.06]',
        active && 'animate-pulse',
      )} />

      <div className="px-4 py-3.5 relative z-10">
        {/* Terminal header: [STATUS] LABEL */}
        <div className="flex items-center gap-2.5 mb-2">
          <div className={cn('p-1.5 rounded-[3px]', active ? 'bg-white/10' : 'bg-white/[0.03]', c.icon)}>
            <Icon k={d.iconKey} />
          </div>

          <div className="flex-1 min-w-0 flex items-center gap-1.5">
            <span className={cn(
              'font-mono text-[11px] font-bold px-1.5 py-[2px] rounded-[2px] leading-none flex-shrink-0',
              active ? 'bg-green-500/20 text-green-400' :
              done    ? 'bg-emerald-500/10 text-emerald-500/60' :
              err     ? 'bg-red-500/20 text-red-400' :
                        'bg-white/[0.04] text-white/25',
            )}>
              {STATUS_PREFIX[d.status]}
            </span>
            <span className="font-mono text-[13px] font-semibold text-white/80 leading-tight truncate">
              {d.label}
            </span>
          </div>

          {active && <Loader2 className="h-3.5 w-3.5 text-green-400 animate-spin flex-shrink-0" />}
        </div>

        {/* Detail / lore line — reserve 2 lines */}
        <div className={cn(
          'font-mono text-[11px] leading-snug mb-2 pl-0.5 min-h-[2.5em] line-clamp-2',
          active ? 'text-white/50' : 'text-white/30',
        )}>
          {d.detail || d.loreTag || '\u00A0'}
        </div>

        {/* Progress bar */}
        {(d.percent > 0 || active) && (
          <div className="h-[3px] rounded-[1px] bg-white/[0.04] overflow-hidden">
            <div
              className={cn(
                'h-full rounded-[1px] transition-[width] duration-700 ease-out',
                c.bar,
                active && d.percent === 0 && 'w-1/4 animate-pulse',
              )}
              style={d.percent > 0 ? { width: `${Math.min(d.percent, 100)}%` } : undefined}
            />
          </div>
        )}

        {/* Telemetry counts */}
        {d.itemsTotal != null && d.itemsTotal > 0 && (
          <div className="flex items-center justify-between mt-2">
            <span className="font-mono text-[11px] text-white/25 tabular-nums">
              {(d.itemsDone ?? 0).toLocaleString()} / {d.itemsTotal.toLocaleString()}
            </span>
            {d.percent > 0 && d.percent < 100 && (
              <span className="font-mono text-[11px] text-white/35 tabular-nums">
                {d.percent}%
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// ─── Layout — Cable-managed grid ─────────────────────────────────────────────
//
// 5 columns with consistent row spacing. Nodes within each column are placed
// on integer "lane" rows so that smoothstep edges route cleanly through the
// gaps between columns without crossing.
//
// Column X positions include generous inter-column space for edge routing.

const COL_W = 310;
const COL_GAP = 120;
const colX = (i: number) => i * (COL_W + COL_GAP);

const X = { src: colX(0), ing: colX(1), ai: colX(2), sto: colX(3), scr: colX(4) } as const;
const LANE = 150;

function nd(id: string, label: string, cat: NodeCategory, icon: IconKey, x: number, lane: number, loreTag?: string): FlowNode {
  return {
    id,
    type: 'dataflow',
    position: { x, y: lane * LANE },
    data: { label, category: cat, iconKey: icon, status: 'idle' as NodeStatus, detail: '', percent: 0, loreTag },
  };
}

const NODES: FlowNode[] = [
  // ── Sources (col 0 — lanes aligned with ingestion partners) ──
  nd('steam-api',     'Steam Web API',     'source',  'globe',    X.src, 0, 'Beacon signal'),
  nd('igdb-api',      'IGDB / Twitch API', 'source',  'globe',    X.src, 1, 'Relay uplink'),
  nd('epic-api',      'Epic Games Store',  'source',  'globe',    X.src, 2, 'Subspace channel'),
  nd('kaggle-data',   'Kaggle Dataset',    'source',  'database', X.src, 3, 'Frozen archive'),
  nd('ollama-server', 'Ollama Server',     'source',  'cpu',      X.src, 5, 'Neural substrate'),

  // ── Ingestion (col 1 — integer lanes, no fractional overlap) ──
  nd('steam-browse',      'Steam Browse Sync',  'process', 'workflow', X.ing, 0, 'Orbital sweep'),
  nd('steam-catalog',     'Steam Catalog Sync', 'process', 'workflow', X.ing, 1, 'Deep-space scan'),
  nd('epic-sync',         'Epic Game Sync',     'process', 'workflow', X.ing, 2, 'Gateway sync'),
  nd('epic-catalog-sync', 'Epic Catalog Sync',  'process', 'workflow', X.ing, 3, 'Subspace archive'),
  nd('catalog-embed',     'Embedding Pipeline', 'process', 'zap',      X.ing, 4, 'Vectorisation core'),
  nd('ollama-setup',      'Ollama Model Setup', 'process', 'cpu',      X.ing, 5, 'Model bootstrap'),

  // ── AI / ML (col 2 — vertically centred, horizontal with key sources) ──
  nd('reco-engine',  'Recommendation Engine', 'ai', 'brain', X.ai, 2, 'Oracle v3 core'),
  nd('ml-model',     'ML Rec Model',          'ai', 'brain', X.ai, 3, 'LightGBM cortex'),
  nd('ann-index',    'ANN Index (HNSW)',      'ai', 'gauge', X.ai, 4, 'Proximity scanner'),
  nd('galaxy-build', 'Galaxy Map Builder',    'ai', 'zap',   X.ai, 5, 'Star-chart renderer'),

  // ── Storage (col 3 — aligned with ingestion/AI outputs) ──
  nd('idb-browse',        'Browse Cache',        'storage', 'hdd', X.sto, 0, 'Proximity buffer'),
  nd('idb-catalog',       'Steam Catalog Store', 'storage', 'hdd', X.sto, 1, 'Archive core'),
  nd('idb-epic-catalog',  'Epic Catalog Store',  'storage', 'hdd', X.sto, 2, 'Subspace vault'),
  nd('idb-embeddings',    'Embedding Store',     'storage', 'hdd', X.sto, 4, 'Cryo vault'),
  nd('idb-galaxy',        'Galaxy Cache',        'storage', 'hdd', X.sto, 5, 'Star-map cache'),

  // ── Screens (col 4 — aligned with storage feeds) ──
  nd('screen-library', 'Library',         'screen', 'monitor', X.scr, 0, 'Main deck'),
  nd('screen-medals',  'Medals & Stats',  'screen', 'monitor', X.scr, 1, 'Trophy chamber'),
  nd('screen-oracle',  'Oracle',          'screen', 'monitor', X.scr, 2, 'Command bridge'),
  nd('screen-buzz',    'Buzz News',       'screen', 'monitor', X.scr, 4, 'Comms array'),
  nd('screen-galaxy',  'Embedding Space', 'screen', 'monitor', X.scr, 5, 'Observation dome'),
];

// ─── Edges — category-colored cable routing ───────────────────────────────────
//
// Each edge is tinted by the source node's category color — like colored cables
// running from each subsystem. Smoothstep routing gives right-angle "conduit"
// paths through the generous column gaps.

const SRC_CAT: Record<string, NodeCategory> = {};
for (const n of NODES) SRC_CAT[n.id] = (n.data as FlowNodeData).category;

function cableStyle(cat: NodeCategory, active: boolean): React.CSSProperties {
  const color = CAT[cat].edge;
  return active
    ? { stroke: color, strokeWidth: 1.5, filter: `drop-shadow(0 0 5px ${color}55)` }
    : { stroke: color, strokeWidth: 1, opacity: 0.15 };
}

function eg(id: string, src: string, tgt: string): Edge {
  const cat = SRC_CAT[src] ?? 'process';
  return { id, source: src, target: tgt, animated: false, style: cableStyle(cat, false), type: 'smoothstep' };
}

const EDGES: Edge[] = [
  // Sources → Ingestion (horizontal lanes)
  eg('e1',  'steam-api',     'steam-browse'),
  eg('e2',  'steam-api',     'steam-catalog'),
  eg('e3',  'igdb-api',      'steam-catalog'),
  eg('e4',  'epic-api',      'epic-sync'),
  eg('e27', 'epic-api',      'epic-catalog-sync'),
  eg('e5',  'kaggle-data',   'ml-model'),
  eg('e6',  'ollama-server', 'ollama-setup'),

  // Ingestion → Storage
  eg('e7',  'steam-browse',       'idb-browse'),
  eg('e8',  'steam-catalog',      'idb-catalog'),
  eg('e9',  'epic-sync',          'idb-browse'),
  eg('e28', 'epic-catalog-sync',  'idb-epic-catalog'),
  eg('e10', 'ollama-setup',       'catalog-embed'),
  eg('e11', 'idb-catalog',        'catalog-embed'),
  eg('e29', 'idb-epic-catalog',   'catalog-embed'),
  eg('e12', 'catalog-embed',      'idb-embeddings'),

  // Storage → AI / ML
  eg('e13', 'idb-embeddings','ann-index'),
  eg('e14', 'idb-embeddings','galaxy-build'),
  eg('e15', 'ann-index',     'galaxy-build'),
  eg('e16', 'galaxy-build',  'idb-galaxy'),
  eg('e17', 'idb-browse',    'reco-engine'),
  eg('e18', 'idb-embeddings','reco-engine'),
  eg('e19', 'ml-model',      'reco-engine'),
  eg('e20', 'ann-index',     'reco-engine'),

  // Storage → Screens
  eg('e21', 'idb-browse',    'screen-library'),
  eg('e22', 'reco-engine',   'screen-oracle'),
  eg('e23', 'idb-galaxy',    'screen-galaxy'),
  eg('e24', 'idb-browse',    'screen-medals'),
  eg('e25', 'idb-browse',    'screen-buzz'),
  eg('e26', 'idb-catalog',   'screen-buzz'),
];

// ─── Status mapping ──────────────────────────────────────────────────────────

function toPartial(s: SyncStatus): Partial<FlowNodeData> {
  return { status: s.stage, detail: s.detail, percent: s.percent, itemsDone: s.itemsDone, itemsTotal: s.itemsTotal };
}

function buildUpdates(snap: SystemStatusSnapshot): Record<string, Partial<FlowNodeData>> {
  const u: Record<string, Partial<FlowNodeData>> = {
    'steam-browse':       toPartial(snap.steamBrowseSync),
    'epic-sync':          toPartial(snap.epicSync),
    'epic-catalog-sync':  toPartial(snap.epicCatalogSync),
    'steam-catalog':      toPartial(snap.steamCatalogSync),
    'reco-engine':        toPartial(snap.recoPipeline),
    'catalog-embed':      toPartial(snap.catalogEmbeddings),
    'ann-index':          toPartial(snap.annIndexStatus),
    'galaxy-build':       toPartial(snap.galaxyBuild),
    'ollama-setup':       toPartial(snap.ollamaSetup),
  };

  if (snap.embeddingModel) {
    u['ollama-server'] = {
      status: snap.embeddingModel.installed ? 'done' : 'idle',
      detail: snap.embeddingModel.installed
        ? `${snap.embeddingModel.name} (${snap.embeddingModel.parameterSize})`
        : 'Not installed',
      percent: snap.embeddingModel.installed ? 100 : 0,
    };
  }
  if (snap.mlModel) {
    u['ml-model'] = {
      status: snap.mlModel.loaded ? 'done' : 'idle',
      detail: snap.mlModel.loaded
        ? `${snap.mlModel.modelCount} folds · ${snap.mlModel.gameProfileCount.toLocaleString()} profiles`
        : 'Not loaded',
      percent: snap.mlModel.loaded ? 100 : 0,
    };
  }

  const sMap: Record<string, string> = { 'Embeddings': 'idb-embeddings', 'Steam Catalog': 'idb-catalog', 'Epic Catalog': 'idb-epic-catalog', 'Galaxy Cache': 'idb-galaxy', 'Browse Cache': 'idb-browse' };
  for (const m of snap.storage) {
    const nid = sMap[m.label];
    if (nid) u[nid] = { status: m.entryCount > 0 ? 'done' : 'idle', detail: m.entryCount > 0 ? `${m.entryCount.toLocaleString()} entries · ${fmtB(m.sizeBytes)}` : 'Empty', percent: m.entryCount > 0 ? 100 : 0 };
  }

  const sA = snap.steamBrowseSync.stage === 'running' || snap.steamCatalogSync.stage === 'running';
  const sD = snap.steamBrowseSync.stage === 'done' || snap.steamCatalogSync.stage === 'done';
  u['steam-api'] = { status: sA ? 'running' : sD ? 'done' : 'idle', detail: sA ? 'Serving' : sD ? 'Connected' : '', percent: sD ? 100 : sA ? 50 : 0 };
  const epicActive = snap.epicSync.stage === 'running' || snap.epicCatalogSync.stage === 'running';
  const epicDone = snap.epicSync.stage === 'done' || snap.epicCatalogSync.stage === 'done';
  u['epic-api']  = { status: epicActive ? 'running' : epicDone ? 'done' : 'idle', detail: epicDone ? 'Connected' : '', percent: epicDone ? 100 : epicActive ? 50 : 0 };
  u['igdb-api']  = { status: snap.steamCatalogSync.stage === 'running' ? 'running' : snap.steamCatalogSync.stage === 'done' ? 'done' : 'idle', detail: snap.steamCatalogSync.stage === 'done' ? 'Connected' : '', percent: snap.steamCatalogSync.stage === 'done' ? 100 : 0 };
  if (snap.mlModel?.loaded) u['kaggle-data'] = { status: 'done', detail: '41M reviews · 92.6% acc', percent: 100 };

  const lib = snap.steamBrowseSync.stage === 'done' || snap.epicSync.stage === 'done';
  u['screen-library'] = { status: lib ? 'done' : 'idle', detail: lib ? 'Ready' : 'Waiting', percent: lib ? 100 : 0 };
  u['screen-oracle']  = { status: snap.recoPipeline.stage === 'done' ? 'done' : 'idle', detail: snap.recoPipeline.stage === 'done' ? 'Ready' : 'Waiting', percent: snap.recoPipeline.stage === 'done' ? 100 : 0 };
  u['screen-galaxy']  = { status: snap.galaxyBuild.stage === 'done' ? 'done' : 'idle', detail: snap.galaxyBuild.stage === 'done' ? 'Ready' : 'Waiting', percent: snap.galaxyBuild.stage === 'done' ? 100 : 0 };
  u['screen-medals']  = { status: lib ? 'done' : 'idle', detail: lib ? 'Ready' : 'Waiting', percent: lib ? 100 : 0 };
  u['screen-buzz']    = { status: 'done', detail: 'Live', percent: 100 };

  return u;
}

function applyUpdates(nodes: FlowNode[], u: Record<string, Partial<FlowNodeData>>): FlowNode[] {
  let changed = false;
  const next = nodes.map(n => {
    const p = u[n.id];
    if (!p) return n;
    const d = n.data as FlowNodeData;
    if (d.status === p.status && d.detail === p.detail && d.percent === p.percent
      && d.itemsDone === p.itemsDone && d.itemsTotal === p.itemsTotal) return n;
    changed = true;
    return { ...n, data: { ...d, ...p } };
  });
  return changed ? next : nodes;
}

function syncEdges(edges: Edge[], nodes: FlowNode[]): Edge[] {
  const running = new Set<string>();
  for (const n of nodes) if ((n.data as FlowNodeData).status === 'running') running.add(n.id);
  let changed = false;
  const next = edges.map(e => {
    const a = running.has(e.source) || running.has(e.target);
    if (e.animated === a) return e;
    changed = true;
    const cat = SRC_CAT[e.source] ?? 'process';
    return { ...e, animated: a, style: cableStyle(cat, a) };
  });
  return changed ? next : edges;
}

function fmtB(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(1)} GB`;
}

// ─── Column header nodes ─────────────────────────────────────────────────────

const COL_HEADERS: { label: string; sub: string; cat: NodeCategory; x: number }[] = [
  { label: 'DATA SOURCES',  sub: 'External beacons & archives',  cat: 'source',  x: X.src },
  { label: 'INGESTION',     sub: 'Sync & processing cores',      cat: 'process', x: X.ing },
  { label: 'AI / ML',       sub: 'Neural subsystems',            cat: 'ai',      x: X.ai },
  { label: 'STORAGE',       sub: 'Cryo vault caches',            cat: 'storage', x: X.sto },
  { label: 'SCREENS',       sub: 'Ship deck interfaces',         cat: 'screen',  x: X.scr },
];

const COLUMN_LABEL_NODES: FlowNode[] = COL_HEADERS.map((h, i) => ({
  id: `_col-${i}`,
  type: 'colLabel',
  position: { x: h.x + 20, y: -75 },
  data: { label: h.label, category: h.cat, iconKey: 'globe' as IconKey, status: 'idle' as NodeStatus, detail: h.sub, percent: 0 },
  draggable: false, selectable: false, connectable: false,
}));

const ColLabel = memo(function ColLabel({ data }: NodeProps<FlowNode>) {
  const d = data as FlowNodeData;
  const c = CAT[d.category];
  return (
    <div className="text-center select-none pointer-events-none">
      <div className={cn('font-mono text-[14px] font-bold tracking-[0.2em] mb-1', c.tag)}>{d.label}</div>
      <div className="font-mono text-[11px] text-white/20 tracking-wide">{d.detail}</div>
    </div>
  );
});

const allNodeTypes = { dataflow: DataFlowNode, colLabel: ColLabel } as const;

// ─── Main Component ──────────────────────────────────────────────────────────

interface DataFlowViewProps { onBack: () => void }

export function DataFlowView({ onBack }: DataFlowViewProps) {
  const allNodes = useMemo(() => [...NODES, ...COLUMN_LABEL_NODES], []);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(allNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(EDGES);
  const throttleRef = useRef(0);
  const pendingRef  = useRef(false);
  const prevStatusKey = useRef('');

  const [stats, setStats] = useState({ active: 0, done: 0, error: 0, total: NODES.length });

  useEffect(() => {
    systemStatus.init();

    const flush = () => {
      pendingRef.current = false;
      const snap = systemStatus.getSnapshot();
      const u = buildUpdates(snap);

      const key = JSON.stringify(u);
      if (key === prevStatusKey.current) return;
      prevStatusKey.current = key;

      setNodes(prev => {
        const next = applyUpdates(prev, u);
        if (next === prev) return prev;

        let a = 0, d = 0, e = 0;
        for (const n of next) {
          if (n.id.startsWith('_')) continue;
          const s = (n.data as FlowNodeData).status;
          if (s === 'running') a++;
          else if (s === 'done') d++;
          else if (s === 'error') e++;
        }
        setStats({ active: a, done: d, error: e, total: NODES.length });
        setEdges(prevE => syncEdges(prevE, next));
        return next;
      });
    };

    const schedule = () => {
      const now = Date.now();
      const dt = now - throttleRef.current;
      if (dt >= 250) { throttleRef.current = now; flush(); }
      else if (!pendingRef.current) { pendingRef.current = true; setTimeout(() => { throttleRef.current = Date.now(); flush(); }, 250 - dt); }
    };

    flush();
    const unsub = systemStatus.subscribe(schedule);
    const poll = setInterval(flush, 3000);
    return () => { unsub(); clearInterval(poll); };
  }, [setNodes, setEdges]);

  const onInit = useCallback((rf: any) => {
    setTimeout(() => rf.fitView({ padding: 0.12, maxZoom: 1 }), 80);
  }, []);

  return (
    <div className="fixed inset-0 top-[52px] z-30 bg-black">
      {/* Ambient CRT glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/3 w-[500px] h-[500px] bg-fuchsia-500/[0.015] rounded-full blur-[150px]" />
        <div className="absolute bottom-1/4 right-1/3 w-[400px] h-[400px] bg-sky-500/[0.015] rounded-full blur-[120px]" />
      </div>

      {/* Full-screen subtle scanlines */}
      <div
        className="absolute inset-0 pointer-events-none z-10 opacity-[0.02]"
        style={{ backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(255,255,255,0.3) 3px, rgba(255,255,255,0.3) 4px)', backgroundSize: '100% 4px' }}
      />

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={allNodeTypes}
        onInit={onInit}
        fitView
        minZoom={0.4}
        maxZoom={0.9}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={0.8} color="rgba(255,255,255,0.025)" />

        {/* Controls removed — zoom/drag disabled */}

        {/* Header — Ark terminal style */}
        <Panel position="top-left" className="!m-4">
          <div className="flex items-center gap-3">
            <Button
              onClick={onBack}
              variant="ghost"
              size="sm"
              className="h-8 text-white/40 hover:text-white hover:bg-white/10 border border-white/[0.06] gap-1.5 rounded-sm font-mono text-[11px]"
            >
              <ArrowLeft className="h-3 w-3" />
              <span>ESC</span>
            </Button>

            <div className="flex items-center gap-2.5 px-3.5 py-1.5 rounded-sm bg-black/60 border border-fuchsia-500/20">
              <Activity className="h-3.5 w-3.5 text-fuchsia-400" />
              <span className="font-mono text-[11px] font-bold text-fuchsia-400/90 tracking-wider">ARK DATA FLOW</span>
            </div>

            {/* Status telemetry */}
            <div className="flex items-center gap-2 font-mono text-[11px]">
              {stats.active > 0 && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-sm bg-green-500/10 border border-green-500/20 text-green-400 tabular-nums">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  {stats.active} ACTIVE
                </span>
              )}
              <span className="px-2.5 py-1 rounded-sm bg-white/[0.03] border border-white/[0.06] text-white/30 tabular-nums">
                {stats.done}/{stats.total} ONLINE
              </span>
              {stats.error > 0 && (
                <span className="px-2.5 py-1 rounded-sm bg-red-500/10 border border-red-500/20 text-red-400 tabular-nums">
                  {stats.error} FAULT{stats.error > 1 ? 'S' : ''}
                </span>
              )}
            </div>
          </div>
        </Panel>

        {/* Legend */}
        <Panel position="bottom-left" className="!m-4">
          <div className="flex items-center gap-5 px-4 py-2.5 rounded-sm bg-black/60 border border-white/[0.06] font-mono text-[11px] text-white/30 tracking-wide">
            <span className="flex items-center gap-1.5">
              <span className="font-bold text-white/25 bg-white/[0.04] px-1.5 py-[2px] rounded-[2px]">STBY</span> Idle
            </span>
            <span className="flex items-center gap-1.5">
              <span className="font-bold text-green-400 bg-green-500/20 px-1.5 py-[2px] rounded-[2px]">SYNC</span> Active
            </span>
            <span className="flex items-center gap-1.5">
              <span className="font-bold text-emerald-500/60 bg-emerald-500/10 px-1.5 py-[2px] rounded-[2px]">&nbsp;OK&nbsp;</span> Done
            </span>
            <span className="flex items-center gap-1.5">
              <span className="font-bold text-red-400 bg-red-500/20 px-1.5 py-[2px] rounded-[2px]">FAIL</span> Error
            </span>
            <span className="w-px h-3.5 bg-white/[0.06]" />
            <span className="flex items-center gap-1.5">
              <span className="w-4 h-[1.5px] rounded-full" style={{ background: CAT.source.edge, opacity: 0.6 }} />
              <span className="w-4 h-[1.5px] rounded-full" style={{ background: CAT.process.edge, opacity: 0.6 }} />
              <span className="w-4 h-[1.5px] rounded-full" style={{ background: CAT.ai.edge, opacity: 0.6 }} />
              <span className="w-4 h-[1.5px] rounded-full" style={{ background: CAT.storage.edge, opacity: 0.6 }} />
              Cable bus
            </span>
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}
