/**
 * Embedding batch-size slider + live graphics-memory (VRAM) meter for the
 * Game understanding page (design: Reading → Batch size, and the Graphics memory tile).
 *
 * The slider maps to the `embeddingBatchSize` Ollama setting (0 = Auto; the main
 * process clamps manual values to 16–512). The meter polls `window.ollama.gpuStats()`
 * every ~2s while it is mounted and the window is visible, and classifies how much
 * headroom is left with `classifyVramStatus` (pure — unit tested).
 */

import { useEffect, useRef, useState } from 'react';
import { Chip, Icon, ICON, type Tone } from '@/components/settings/ui';

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

/** Polls the graphics-memory reading while the window is visible. undefined = first read pending; null = no reading. */
export function useGpuStats(): GpuStats | null | undefined {
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

  return stats;
}

const LEVEL_TONE: Record<VramLevel, Tone> = { ok: 'live', tight: 'warn', 'too-high': 'fault', unknown: 'off' };
const LEVEL_COLOR: Record<VramLevel, string> = {
  ok: 'var(--color-live)', tight: 'var(--color-warn)', 'too-high': 'var(--color-fault)', unknown: 'var(--color-live)',
};

/** The two meter segments: all graphics memory in use, and the part that is Ark's AI. */
function vramBars(stats: GpuStats, status: VramStatus) {
  const hasTotals = status.freeMB !== null && typeof stats.vramTotalMB === 'number' && typeof stats.vramUsedMB === 'number';
  const total = stats.vramTotalMB ?? 0;
  const used = stats.vramUsedMB ?? 0;
  const usedPct = hasTotals && total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const modelPct = hasTotals && total > 0 ? Math.min(usedPct, (stats.modelVramMB / total) * 100) : 0;
  return { hasTotals, total, used, usedPct, modelPct };
}

/** The "Graphics memory" status tile. */
export function GraphicsMemoryTile({ stats }: { stats: GpuStats | null | undefined }) {
  if (stats === undefined || stats === null) {
    return (
      <div data-testid="vram-tile">
        <div className="inline" style={{ justifyContent: 'space-between' }}><p className="t">Graphics memory</p><Chip tone="off">{stats === undefined ? 'Reading' : 'No reading'}</Chip></div>
        <p className="d">{stats === undefined ? 'Reading graphics memory…' : 'Shown while the AI is running.'}</p>
      </div>
    );
  }
  const status = classifyVramStatus(stats);
  const bars = vramBars(stats, status);
  return (
    <div data-testid="vram-tile">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <p className="t">Graphics memory</p>
        {status.level !== 'unknown' && <Chip tone={LEVEL_TONE[status.level]}>{LEVEL_LABEL[status.level]}</Chip>}
      </div>
      {bars.hasTotals && (
        <div className="meter" style={{ marginTop: 'var(--space-2)' }} role="meter" aria-label="Graphics memory in use" aria-valuemin={0} aria-valuemax={bars.total} aria-valuenow={bars.used}>
          <i style={{ width: `${bars.usedPct}%`, background: LEVEL_COLOR[status.level] }} />
          {stats.modelVramMB > 0 && <i style={{ width: `${bars.modelPct}%`, background: 'var(--color-accent)' }} />}
        </div>
      )}
      <p className="d" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {stats.gpuName ?? 'Graphics card'}
        {bars.hasTotals ? ` · ${formatMB(bars.used)} of ${formatMB(bars.total)}` : ''}
        {stats.modelVramMB > 0 ? ` · Ark ${formatMB(stats.modelVramMB)}` : ''}
      </p>
    </div>
  );
}

/** Self-polling readout (the page itself shares one poll with its tile through VramReadout). */
export function VramMeter() {
  return <VramReadout stats={useGpuStats()} />;
}

/** The graphics-memory readout under the batch slider, with the tight / too-high advice. */
export function VramReadout({ stats }: { stats: GpuStats | null | undefined }) {
  if (stats === undefined) {
    return <p className="d" data-testid="vram-meter">Reading graphics memory…</p>;
  }
  if (stats === null) {
    return <p className="d" data-testid="vram-meter">No graphics memory reading yet. It appears while the AI is running.</p>;
  }

  const status = classifyVramStatus(stats);
  const bars = vramBars(stats, status);

  return (
    <div className="stack" style={{ gap: 'var(--space-2)' }} data-testid="vram-meter">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <span className="inline"><Icon d={ICON.layers} />{stats.gpuName ?? 'Graphics card'}</span>
        {status.level !== 'unknown' && <Chip tone={LEVEL_TONE[status.level]}>{LEVEL_LABEL[status.level]}</Chip>}
      </div>

      {bars.hasTotals ? (
        <>
          <div className="meter" role="meter" aria-label="Graphics memory used" aria-valuemin={0} aria-valuemax={bars.total} aria-valuenow={bars.used}>
            <i style={{ width: `${bars.usedPct}%`, background: LEVEL_COLOR[status.level] }} />
            {stats.modelVramMB > 0 && <i style={{ width: `${bars.modelPct}%`, background: 'var(--color-accent)' }} />}
          </div>
          <div className="inline d" style={{ justifyContent: 'space-between', margin: 0 }}>
            <span>
              {formatMB(bars.used)} of {formatMB(bars.total)} used
              {stats.modelVramMB > 0 && <> · <span style={{ color: 'var(--color-accent-ink)' }}>Ark&apos;s AI: {formatMB(stats.modelVramMB)}</span></>}
            </span>
            <span>{formatMB(status.freeMB ?? 0)} free</span>
          </div>
        </>
      ) : (
        <p className="d">
          {stats.modelLoaded
            ? <>Ark&apos;s AI is using {formatMB(stats.modelVramMB)} of graphics memory.</>
            : <>Ark&apos;s AI isn&apos;t loaded right now.</>}{' '}
          Total graphics memory can&apos;t be read on this graphics card.
        </p>
      )}

      {status.level !== 'unknown' && (
        <p className="d" style={status.level === 'ok' ? undefined : { color: LEVEL_COLOR[status.level] }}>{vramAdvice(status)}</p>
      )}
      {bars.hasTotals && <p className="d">Includes everything on the graphics card, games too. Updates every 2 seconds.</p>}
    </div>
  );
}

// ─── Slider ───────────────────────────────────────────────────────────────────

export function EmbeddingBatchSizeControl({
  value,
  onChange,
  disabled,
  stats,
}: {
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  /** The page's shared graphics-memory reading (one poll feeds the tile and this readout). */
  stats: GpuStats | null | undefined;
}) {
  const index = batchSizeToSliderIndex(value);
  const current = sliderIndexToBatchSize(index);
  const label = current === 0 ? 'Auto' : `${current} at a time`;

  return (
    <div className="sect" data-testid="embedding-batch-size" data-setting-id="u-batch">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <label htmlFor="embedding-batch-size-slider" className="t">Batch size</label>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-accent-ink)', fontVariantNumeric: 'tabular-nums' }}>{label}</span>
      </div>
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
        style={{ ['--v' as string]: `${Math.round((index / BATCH_SIZE_STEPS.length) * 100)}%` }}
      />
      <div className="scale"><span>Auto</span><span>16</span><span>64</span><span>192</span><span>512</span></div>
      <p className="d">
        How many game descriptions go to the AI at once. Bigger is faster but uses more graphics memory. Background work stays at 64 or fewer.
        {current === 0 ? ' Auto sends 256 at a time on a graphics card, 100 on the processor.' : ' Applies from the next batch, no restart needed.'}
      </p>
      <VramReadout stats={stats} />
    </div>
  );
}
