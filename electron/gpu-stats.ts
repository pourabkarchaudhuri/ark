/**
 * Live GPU / VRAM readout for the embedding batch-size setting (v1.0.74).
 *
 * Total + used VRAM come from `nvidia-smi` when it's on the machine (NVIDIA only — the
 * reading covers every process on the GPU, games included). The embedding model's own
 * footprint comes from Ollama's /api/ps on any vendor. Both are optional: the result says
 * what it could measure and the UI degrades to what's known.
 */
import { execFile } from 'node:child_process';
import { getEmbedOomStepDowns, readEmbedModelVram } from './ollama-setup.js';

export interface GpuStats {
  /** Where total/used came from; 'none' when no vendor tool answered. */
  source: 'nvidia-smi' | 'none';
  gpuName: string | null;
  vramTotalMB: number | null;
  vramUsedMB: number | null;
  /** Embedding model loaded in Ollama right now, and how much of it sits in VRAM. */
  modelLoaded: boolean;
  modelVramMB: number;
  /** Part of the model spilled to system RAM (slow) — a sign batches are too big. */
  modelPartialOffload: boolean;
  /** Out-of-memory step-downs Ollama reported this session. */
  oomStepDowns: number;
}

const NVIDIA_SMI_CANDIDATES = ['nvidia-smi', 'C:\\Windows\\System32\\nvidia-smi.exe'];
/** After a slow or failed (but present) nvidia-smi, skip it this long before retrying. */
export const NVIDIA_SMI_BACKOFF_MS = 20_000;
/** Latched only when every candidate is absent (ENOENT / EACCES) — the tool really is not there. */
let nvidiaSmiMissing = false;
let nvidiaSmiRetryAt = 0;

/** Test seam: forget the latch and backoff. */
export function resetGpuStatsForTests(): void {
  nvidiaSmiMissing = false;
  nvidiaSmiRetryAt = 0;
}

function isNotInstalledError(err: NodeJS.ErrnoException): boolean {
  return err.code === 'ENOENT' || err.code === 'EACCES';
}

function runNvidiaSmi(): Promise<{ name: string; totalMB: number; usedMB: number } | null> {
  if (nvidiaSmiMissing) return Promise.resolve(null);
  if (Date.now() < nvidiaSmiRetryAt) return Promise.resolve(null);
  const args = ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'];
  // One slow call (a game loading the GPU) or a non-zero exit used to latch
  // "missing" for the whole session; only an absent binary latches now.
  let allMissing = true;
  const tryAt = (i: number): Promise<{ name: string; totalMB: number; usedMB: number } | null> => {
    if (i >= NVIDIA_SMI_CANDIDATES.length) {
      if (allMissing) nvidiaSmiMissing = true;
      else nvidiaSmiRetryAt = Date.now() + NVIDIA_SMI_BACKOFF_MS;
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      execFile(NVIDIA_SMI_CANDIDATES[i], args, { timeout: 2500, windowsHide: true }, (err, stdout) => {
        if (err) {
          if (!isNotInstalledError(err as NodeJS.ErrnoException)) allMissing = false;
          resolve(tryAt(i + 1));
          return;
        }
        // First GPU line: "NVIDIA GeForce RTX 4070, 12282, 3120"
        const line = String(stdout).split(/\r?\n/).find((l) => l.trim());
        const parts = line?.split(',').map((p) => p.trim()) ?? [];
        const totalMB = Number(parts[1]);
        const usedMB = Number(parts[2]);
        resolve(parts.length >= 3 && Number.isFinite(totalMB) && Number.isFinite(usedMB) ? { name: parts[0], totalMB, usedMB } : null);
      });
    });
  };
  return tryAt(0);
}

export async function getGpuStats(): Promise<GpuStats> {
  const [smi, model] = await Promise.all([runNvidiaSmi(), readEmbedModelVram()]);
  return {
    source: smi ? 'nvidia-smi' : 'none',
    gpuName: smi?.name ?? null,
    vramTotalMB: smi?.totalMB ?? null,
    vramUsedMB: smi?.usedMB ?? null,
    modelLoaded: model.loaded,
    modelVramMB: Math.round(model.vramBytes / (1024 * 1024)),
    modelPartialOffload: model.loaded && model.vramBytes > 0 && model.sizeBytes > 0 && model.vramBytes < model.sizeBytes * 0.95,
    oomStepDowns: getEmbedOomStepDowns(),
  };
}
