import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity,
  Database,
  HardDrive,
  Check,
  X,
  Loader2,
  ChevronDown,
  Minus,
} from 'lucide-react';
import { systemStatus, type SyncStatus, type SystemStatusSnapshot, type StorageMetric } from '@/services/system-status';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

// ─── Status Dot ─────────────────────────────────────────────────────────────────

function StatusDot({ stage }: { stage: SyncStatus['stage'] }) {
  if (stage === 'done') return <Check className="w-3 h-3 text-emerald-400" />;
  if (stage === 'error') return <X className="w-3 h-3 text-red-400" />;
  if (stage === 'running') return <Loader2 className="w-3 h-3 text-cyan-400 animate-spin" />;
  return <Minus className="w-3 h-3 text-white/20" />;
}

function stageColor(stage: SyncStatus['stage']): string {
  if (stage === 'done') return 'text-emerald-400/70';
  if (stage === 'error') return 'text-red-400/70';
  if (stage === 'running') return 'text-cyan-400/80';
  return 'text-white/30';
}

// ─── Micro progress bar ─────────────────────────────────────────────────────────

function MicroBar({ percent, stage }: { percent: number; stage: SyncStatus['stage'] }) {
  const bg = stage === 'done' ? 'bg-emerald-500'
    : stage === 'error' ? 'bg-red-500'
      : stage === 'running' ? 'bg-cyan-400' : 'bg-white/10';
  return (
    <div className="h-[3px] w-full rounded-full bg-white/5 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${bg}`}
        style={{ width: `${Math.min(percent, 100)}%` }}
      />
    </div>
  );
}

// ─── Single Sync Row ────────────────────────────────────────────────────────────

function SyncRow({ sync }: { sync: SyncStatus }) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <StatusDot stage={sync.stage} />
          <span className={`text-[10px] font-medium truncate ${stageColor(sync.stage)}`}>
            {sync.label}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 min-w-[3.5rem] justify-end">
          {sync.stage === 'running' && sync.percent > 0 && (
            <span className="text-[9px] text-cyan-400/60 tabular-nums text-right">{sync.percent}%</span>
          )}
          {sync.elapsed > 0 && (
            <span className="text-[9px] text-white/25 tabular-nums text-right">{formatDuration(sync.elapsed)}</span>
          )}
        </div>
      </div>
      {sync.stage !== 'idle' && <MicroBar percent={sync.percent} stage={sync.stage} />}
      {sync.detail && sync.stage !== 'idle' && (
        <p className="text-[9px] text-white/25 truncate pl-[18px]">{sync.detail}</p>
      )}
    </div>
  );
}

// ─── Storage Row ────────────────────────────────────────────────────────────────

function StorageRow({ metric }: { metric: StorageMetric }) {
  return (
    <div className="py-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] text-white/30 truncate">{metric.label}</span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[9px] text-white/40 tabular-nums">{metric.entryCount.toLocaleString()}</span>
          <span className="text-[9px] text-white/20 tabular-nums w-14 text-right">{formatBytes(metric.sizeBytes)}</span>
        </div>
      </div>
      {metric.subtitle && (
        <p className="text-[8px] text-white/15 truncate pl-0.5 -mt-px">{metric.subtitle}</p>
      )}
    </div>
  );
}

// ─── Aggregate LED for navbar ───────────────────────────────────────────────────

function AggregateLed({ snap }: { snap: SystemStatusSnapshot }) {
  const syncs = [snap.epicSync, snap.steamBrowseSync, snap.steamCatalogSync, snap.recoPipeline, snap.catalogEmbeddings, snap.annIndexStatus, snap.galaxyBuild];
  const running = syncs.filter(s => s.stage === 'running').length;
  const errors = syncs.filter(s => s.stage === 'error').length;
  const done = syncs.filter(s => s.stage === 'done').length;

  if (errors > 0) return <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-50" /><span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" /></span>;
  if (running > 0) return <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-40" /><span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" /></span>;
  if (done === syncs.length) return <span className="inline-flex rounded-full h-2 w-2 bg-emerald-500" />;
  return <span className="inline-flex rounded-full h-2 w-2 bg-white/20" />;
}

// ─── Main Panel (used in navbar dropdown) ───────────────────────────────────────

function StatusPanelContent({ snap, compact }: { snap: SystemStatusSnapshot; compact?: boolean }) {
  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      {/* Sync pipelines */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 mb-1">
          <Activity className="w-3 h-3 text-white/30" />
          <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">Pipelines</span>
        </div>
        <SyncRow sync={snap.epicSync} />
        <SyncRow sync={snap.steamBrowseSync} />
        <SyncRow sync={snap.steamCatalogSync} />
        <SyncRow sync={snap.recoPipeline} />
        <SyncRow sync={snap.catalogEmbeddings} />
        <SyncRow sync={snap.annIndexStatus} />
        <SyncRow sync={snap.galaxyBuild} />
      </div>

      {/* Storage */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1.5">
            <Database className="w-3 h-3 text-white/30" />
            <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">Storage</span>
          </div>
          <div className="flex items-center gap-1">
            <HardDrive className="w-2.5 h-2.5 text-white/20" />
            <span className="text-[9px] text-white/30 tabular-nums">{formatBytes(snap.totalStorageBytes)}</span>
          </div>
        </div>
        {snap.storage.map(m => <StorageRow key={m.dbName} metric={m} />)}
      </div>
    </div>
  );
}

// ─── Navbar Status Button + Dropdown ────────────────────────────────────────────

export function NavbarStatusIndicator() {
  const [snap, setSnap] = useState<SystemStatusSnapshot>(systemStatus.getSnapshot());
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = systemStatus.subscribe(() => setSnap(systemStatus.getSnapshot()));
    return unsub;
  }, []);

  // Live tick for elapsed time (every 1s while something is running)
  useEffect(() => {
    const syncs = [snap.epicSync, snap.steamBrowseSync, snap.steamCatalogSync, snap.recoPipeline, snap.catalogEmbeddings, snap.annIndexStatus, snap.galaxyBuild];
    const hasRunning = syncs.some(s => s.stage === 'running');
    if (!hasRunning) return;
    const id = setInterval(() => setSnap(systemStatus.getSnapshot()), 1000);
    return () => clearInterval(id);
  }, [snap]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = useCallback(() => {
    setOpen(v => !v);
    if (!open) systemStatus.refreshStorage();
  }, [open]);

  const syncs = [snap.epicSync, snap.steamBrowseSync, snap.steamCatalogSync, snap.recoPipeline, snap.catalogEmbeddings, snap.annIndexStatus, snap.galaxyBuild];
  const running = syncs.filter(s => s.stage === 'running');

  const [cycleIdx, setCycleIdx] = useState(0);

  useEffect(() => {
    if (running.length <= 1) { setCycleIdx(0); return; }
    const id = setInterval(() => setCycleIdx(i => (i + 1) % running.length), 2500);
    return () => clearInterval(id);
  }, [running.length]);

  const safeIdx = running.length > 0 ? cycleIdx % running.length : 0;
  const currentRunning = running[safeIdx];

  return (
    <div ref={ref} className="relative no-drag">
      <button
        onClick={toggle}
        className="flex items-center justify-end gap-1.5 px-2 py-1 rounded-md hover:bg-white/5 transition-colors cursor-pointer w-72"
        title="System Status"
      >
        <AggregateLed snap={snap} />
        {running.length > 0 ? (
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            {running.length > 1 && (
              <span className="text-[9px] text-cyan-400/40 tabular-nums shrink-0">{safeIdx + 1}/{running.length}</span>
            )}
            <AnimatePresence mode="wait">
              <motion.span
                key={currentRunning?.label}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.25 }}
                className="text-[10px] text-cyan-400/60 truncate flex-1 min-w-0"
              >
                {currentRunning?.label}
              </motion.span>
            </AnimatePresence>
            {currentRunning?.percent != null && currentRunning.percent > 0 && (
              <span className="text-[9px] text-cyan-400/50 tabular-nums shrink-0">{currentRunning.percent}%</span>
            )}
          </div>
        ) : (
          <span className="text-[10px] text-white/25">{formatBytes(snap.totalStorageBytes)}</span>
        )}
        <ChevronDown className={`w-3 h-3 text-white/20 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 top-full mt-1 w-72 rounded-lg border border-white/10 bg-black/95 backdrop-blur-xl shadow-2xl shadow-black/60 p-3 z-50"
          >
            <StatusPanelContent snap={snap} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Skeleton shimmer for not-yet-loaded metadata ────────────────────────────────

function SkeletonBar({ width = 'w-16' }: { width?: string }) {
  return (
    <div className={`${width} h-[7px] rounded-full bg-white/[0.04] overflow-hidden`}>
      <div
        className="h-full w-1/2 rounded-full skeleton-shimmer"
        style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.07), transparent)' }}
      />
    </div>
  );
}

function SplashSyncRow({ sync, index }: { sync: SyncStatus; index: number }) {
  const isWaiting = sync.stage === 'idle';

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.35, delay: 1.8 + index * 0.06, ease: [0.16, 1, 0.3, 1] }}
      className="space-y-0.5 min-h-[34px]"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <StatusDot stage={sync.stage} />
          <span className={`text-[10px] font-medium truncate ${stageColor(sync.stage)}`}>
            {sync.label}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 min-w-[3.5rem] justify-end">
          {isWaiting ? (
            <SkeletonBar width="w-10" />
          ) : (
            <>
              {sync.stage === 'running' && sync.percent > 0 && (
                <span className="text-[9px] text-cyan-400/60 tabular-nums text-right">{sync.percent}%</span>
              )}
              {sync.elapsed > 0 && (
                <span className="text-[9px] text-white/25 tabular-nums text-right">{formatDuration(sync.elapsed)}</span>
              )}
            </>
          )}
        </div>
      </div>
      {isWaiting ? (
        <SkeletonBar width="w-full" />
      ) : (
        <>
          {sync.stage !== 'idle' && <MicroBar percent={sync.percent} stage={sync.stage} />}
          {sync.detail && sync.stage !== 'idle' && (
            <p className="text-[9px] text-white/25 truncate pl-[18px]">{sync.detail}</p>
          )}
        </>
      )}
    </motion.div>
  );
}

function SplashStorageRow({ metric, index }: { metric: StorageMetric; index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, delay: 2.2 + index * 0.04, ease: [0.16, 1, 0.3, 1] }}
      className="py-0.5 min-h-[20px]"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] text-white/30 truncate">{metric.label}</span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[9px] text-white/40 tabular-nums">{metric.entryCount.toLocaleString()}</span>
          <span className="text-[9px] text-white/20 tabular-nums w-14 text-right">{formatBytes(metric.sizeBytes)}</span>
        </div>
      </div>
      {metric.subtitle && (
        <p className="text-[8px] text-white/15 truncate pl-0.5 -mt-px">{metric.subtitle}</p>
      )}
    </motion.div>
  );
}

// ─── Splash Screen Status (bottom-right, compact) ───────────────────────────────

export function SplashStatusPanel() {
  const [snap, setSnap] = useState<SystemStatusSnapshot>(systemStatus.getSnapshot());

  useEffect(() => {
    const unsub = systemStatus.subscribe(() => setSnap(systemStatus.getSnapshot()));
    return unsub;
  }, []);

  // Live tick
  useEffect(() => {
    const id = setInterval(() => setSnap(systemStatus.getSnapshot()), 1000);
    return () => clearInterval(id);
  }, []);

  const syncs = [snap.epicSync, snap.steamBrowseSync, snap.steamCatalogSync, snap.recoPipeline, snap.catalogEmbeddings, snap.annIndexStatus, snap.galaxyBuild];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95, filter: 'blur(6px)' }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
      transition={{ duration: 0.8, delay: 1.5, ease: [0.16, 1, 0.3, 1] }}
      className="w-64 min-h-[380px] rounded-lg border border-white/[0.06] bg-black/60 backdrop-blur-md p-2.5 pointer-events-auto"
    >
      <div className="space-y-2">
        {/* Pipelines header */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 1.7 }}
          className="flex items-center gap-1.5 mb-1"
        >
          <Activity className="w-3 h-3 text-white/30" />
          <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">Pipelines</span>
        </motion.div>

        {/* Pipeline rows with stagger + skeletons */}
        <div className="space-y-2">
          {syncs.map((sync, i) => (
            <SplashSyncRow key={sync.label} sync={sync} index={i} />
          ))}
        </div>

        {/* Storage section */}
        <div>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, delay: 2.15 }}
            className="flex items-center justify-between mb-1"
          >
            <div className="flex items-center gap-1.5">
              <Database className="w-3 h-3 text-white/30" />
              <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">Storage</span>
            </div>
            <div className="flex items-center gap-1">
              <HardDrive className="w-2.5 h-2.5 text-white/20" />
              {snap.totalStorageBytes > 0 ? (
                <span className="text-[9px] text-white/30 tabular-nums">{formatBytes(snap.totalStorageBytes)}</span>
              ) : (
                <SkeletonBar width="w-12" />
              )}
            </div>
          </motion.div>
          {snap.storage.length > 0 ? (
            snap.storage.map((m, i) => <SplashStorageRow key={m.dbName} metric={m} index={i} />)
          ) : (
            <div className="space-y-1.5 py-1">
              {[0, 1, 2, 3, 4].map(i => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 2.2 + i * 0.05 }}
                  className="flex items-center justify-between gap-2"
                >
                  <SkeletonBar width="w-20" />
                  <SkeletonBar width="w-14" />
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
