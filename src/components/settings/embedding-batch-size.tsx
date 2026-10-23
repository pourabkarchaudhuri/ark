/**
 * Embedding batch-size slider + live graphics-memory (VRAM) meter for the
 * AI Models settings tab.
 *
 * The slider maps to the `embeddingBatchSize` Ollama setting (0 = Auto; the main
 * process clamps manual values to 16–512). The meter polls `window.ollama.gpuStats()`
 * every ~2s while it is mounted and the window is visible, and classifies how much
 * headroom is left with `classifyVramStatus` (pure — unit tested).
 */

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Cpu, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Mirror of `GpuStats` in electron/gpu-stats.ts (renderer can't import electron/*). */
export interface GpuStats {
  source: 'nvidia-smi' | 'none';
  gpuName: string | null;
  vramTotalMB: number | null;
  vramUsedMB: number | null;
  modelLoaded: boolean;
  modelVramMB: number;
  modelPartialOffload: boolean;
  oomStepDowns: number;
}

export type VramLevel = 'ok' | 'tight' | 'too-high' | 'unknown';
export type VramReason = 'oom' | 'offload' | 'low-free' | 'tight' | 'ok' | 'unknown';

export interface VramStatus {
  level: VramLevel;
  reason: VramReason;
  /** Free VRAM in MB when total + used are known, else null. */
  freeMB: number | null;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Manual batch sizes the slider snaps to (index 0 on the slider is Auto). */
export const BATCH_SIZE_STEPS = [16, 32, 64, 128, 192, 256, 384, 512] as const;

export const VRAM_TOO_HIGH_FREE_MB = 512;
export const VRAM_TIGHT_FREE_MB = 1536;

/** Slider position → setting value (0 = Auto). */
export function sliderIndexToBatchSize(index: number): number {
  if (!Number.isFinite(index) || index <= 0) return 0;
  const i = Math.min(BATCH_SIZE_STEPS.length, Math.round(index));
  return BATCH_SIZE_STEPS[i - 1];
}

/** Setting value → slider position, snapping a stored value to the nearest step. */
export function batchSizeToSliderIndex(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  let best = 0;
  for (let i = 1; i < BATCH_SIZE_STEPS.length; i++) {
    if (Math.abs(BATCH_SIZE_STEPS[i] - value) < Math.abs(BATCH_SIZE_STEPS[best] - value)) best = i;
  }
  return best + 1;
}

/**
 * How comfortable the graphics memory situation is.
 * Too high: Ollama had to step down after running out of memory, part of the model
 * spilled to system RAM, or less than 512 MB is free. Tight: less than 1.5 GB free.
 * When total/used can't be read (non-NVIDIA), only the first two signals apply.
 */
export function classifyVramStatus(stats: GpuStats): VramStatus {
  const total = stats.vramTotalMB;
  const used = stats.vramUsedMB;
  const freeMB =
    stats.source === 'nvidia-smi' && typeof total === 'number' && typeof used === 'number' &&
    Number.isFinite(total) && Number.isFinite(used)
      ? Math.max(0, total - used)
      : null;

  if (stats.oomStepDowns > 0) return { level: 'too-high', reason: 'oom', freeMB };
  if (stats.modelPartialOffload) return { level: 'too-high', reason: 'offload', freeMB };
  if (freeMB === null) return { level: 'unknown', reason: 'unknown', freeMB };
  if (freeMB < VRAM_TOO_HIGH_FREE_MB) return { level: 'too-high', reason: 'low-free', freeMB };
  if (freeMB < VRAM_TIGHT_FREE_MB) return { level: 'tight', reason: 'tight', freeMB };
  return { level: 'ok', reason: 'ok', freeMB };
}

/** Plain-language advice for a status. */
export function vramAdvice(status: VramStatus): string {
  switch (status.reason) {
    case 'oom':
      return 'The AI ran out of graphics memory and had to slow down. Lower the batch size.';
    case 'offload':
      return 'Part of the AI spilled into regular memory, which is much slower. Lower the batch size or close other graphics-heavy apps.';
    case 'low-free':
      return 'Graphics memory is almost full. Lower the batch size or close other graphics-heavy apps.';
    case 'tight':
      return 'Graphics memory is getting full. If games stutter while Ark is working, lower the batch size.';
    case 'ok':
      return 'Plenty of graphics memory free. This batch size is fine.';
    default:
      return '';
  }
}

const LEVEL_LABEL: Record<VramLevel, string> = {
  ok: 'OK',
  tight: 'Tight',
  'too-high': 'Too high',
  unknown: 'Unknown',
};

function formatMB(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// ─── Live VRAM meter ──────────────────────────────────────────────────────────

const POLL_MS = 2000;

type GpuStatsFn = () => Promise<GpuStats | null>;

function getGpuStatsFn(): GpuStatsFn | undefined {
  // `window.ollama` is typed in src/services/embedding-service.ts; gpuStats is
  // reached through a narrow cast so this component doesn't depend on that file.
  return (window.ollama as unknown as { gpuStats?: GpuStatsFn } | undefined)?.gpuStats;
}

export function VramMeter() {
  // undefined = first read pending; null = Ollama not running / no readout.
  const [stats, setStats] = useState<GpuStats | null | undefined>(undefined);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (inFlight.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const fn = getGpuStatsFn();
      if (!fn) { setStats(null); return; }
      inFlight.current = true;
      try {
        const s = await fn();
        if (!cancelled) setStats(s ?? null);
      } catch {
        if (!cancelled) setStats(null);
      } finally {
        inFlight.current = false;
      }
    };
    void poll();
    const id = setInterval(() => { void poll(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void poll(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (stats === undefined) {
    return <p className="text-[11px] text-white/25" data-testid="vram-meter">Reading graphics memory…</p>;
  }
  if (stats === null) {
    return <p className="text-[11px] text-white/25" data-testid="vram-meter">Start Ollama to see graphics memory</p>;
  }

  const status = classifyVramStatus(stats);
  const hasTotals = status.freeMB !== null && typeof stats.vramTotalMB === 'number' && typeof stats.vramUsedMB === 'number';
  const total = stats.vramTotalMB ?? 0;
  const used = stats.vramUsedMB ?? 0;
  const usedPct = hasTotals && total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const modelPct = hasTotals && total > 0 ? Math.min(usedPct, (stats.modelVramMB / total) * 100) : 0;

  const tone =
    status.level === 'too-high' ? 'text-red-400/80'
      : status.level === 'tight' ? 'text-amber-400/80'
        : status.level === 'ok' ? 'text-emerald-400/80'
          : 'text-white/40';
  const barTone =
    status.level === 'too-high' ? 'bg-red-400/50'
      : status.level === 'tight' ? 'bg-amber-400/50'
        : 'bg-emerald-400/40';
  const StatusIcon = status.level === 'too-high' ? AlertCircle : status.level === 'tight' ? AlertTriangle : CheckCircle2;

  return (
    <div className="rounded-lg bg-white/[0.02] border border-white/[0.05] p-3 space-y-2" data-testid="vram-meter">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Cpu className="h-3.5 w-3.5 text-white/40 shrink-0" />
          <span className="text-xs text-white/60 truncate">{stats.gpuName ?? 'Graphics card'}</span>
        </div>
        {status.level !== 'unknown' && (
          <span className={cn('flex items-center gap-1 text-[11px] font-medium shrink-0', tone)}>
            <StatusIcon className="h-3 w-3" />
            {LEVEL_LABEL[status.level]}
          </span>
        )}
      </div>

      {hasTotals ? (
        <>
          <div
            className="relative h-2 w-full rounded-full bg-white/[0.06] overflow-hidden"
            role="meter"
            aria-label="Graphics memory used"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={used}
          >
            <div className={cn('absolute inset-y-0 left-0 rounded-full', barTone)} style={{ width: `${usedPct}%` }} />
            {stats.modelVramMB > 0 && (
              <div className="absolute inset-y-0 left-0 rounded-full bg-fuchsia-400/60" style={{ width: `${modelPct}%` }} />
            )}
          </div>
          <div className="flex items-center justify-between text-[11px] text-white/35">
            <span>
              {formatMB(used)} of {formatMB(total)} used
              {stats.modelVramMB > 0 && <> · <span className="text-fuchsia-300/70">Ark&apos;s AI: {formatMB(stats.modelVramMB)}</span></>}
            </span>
            <span>{formatMB(status.freeMB ?? 0)} free</span>
          </div>
        </>
      ) : (
        <p className="text-[11px] text-white/35">
          {stats.modelLoaded
            ? <>Ark&apos;s AI is using {formatMB(stats.modelVramMB)} of graphics memory.</>
            : <>Ark&apos;s AI isn&apos;t loaded right now.</>}{' '}
          Total graphics memory can&apos;t be read on this graphics card.
        </p>
      )}

      {status.level !== 'unknown' && (
        <p className={cn('text-[11px]', status.level === 'ok' ? 'text-white/30' : tone)}>{vramAdvice(status)}</p>
      )}
      {hasTotals && (
        <p className="text-[10px] text-white/20">Includes everything on the graphics card, games too. Updates every 2 seconds.</p>
      )}
    </div>
  );
}

// ─── Slider ───────────────────────────────────────────────────────────────────

export function EmbeddingBatchSizeControl({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
}) {
  const index = batchSizeToSliderIndex(value);
  const current = sliderIndexToBatchSize(index);
  const label = current === 0 ? 'Auto' : `${current} at a time`;

  return (
    <div className="space-y-2" data-testid="embedding-batch-size">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="embedding-batch-size-slider" className="text-sm text-white/70">Embedding batch size</label>
        <span className="text-xs font-mono text-white/50">{label}</span>
      </div>
      <p className="text-[11px] text-white/30">
        How many game descriptions are sent to the AI at once. Bigger is faster but uses more graphics memory.
      </p>
      <input
        id="embedding-batch-size-slider"
        type="range"
        min={0}
        max={BATCH_SIZE_STEPS.length}
        step={1}
        value={index}
        disabled={disabled}
        onChange={(e) => onChange(sliderIndexToBatchSize(Number(e.target.value)))}
        aria-valuetext={label}
        className="w-full accent-fuchsia-500 disabled:opacity-40"
      />
      <div className="flex justify-between text-[10px] text-white/20 font-mono">
        <span>Auto</span>
        {BATCH_SIZE_STEPS.map((s) => <span key={s}>{s}</span>)}
      </div>
      <p className="text-[11px] text-white/25">
        {current === 0
          ? 'Auto sends 256 at a time on a graphics card, 100 on the processor. Background work always uses 64 or fewer.'
          : 'Background work always uses 64 or fewer. Applies from the next batch, no restart needed.'}
      </p>
      <VramMeter />
    </div>
  );
}
