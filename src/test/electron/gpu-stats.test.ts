import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * nvidia-smi resilience for the VRAM meter: a slow or failing call backs off
 * and retries instead of latching "missing" for the session; only an absent
 * binary on every candidate path latches.
 */

type ExecCb = (err: (Error & { code?: string; killed?: boolean }) | null, stdout: string) => void;

const smi = vi.hoisted(() => ({
  /** One entry per execFile call, consumed in order. */
  script: [] as Array<{ err?: { code?: string; killed?: boolean; message?: string }; stdout?: string }>,
  calls: [] as string[],
}));

vi.mock('node:child_process', () => {
  const execFile = (file: string, _args: string[], _opts: unknown, cb: ExecCb) => {
    smi.calls.push(file);
    const next = smi.script.shift() ?? { err: { code: 'ENOENT' } };
    setTimeout(() => {
      if (next.err) cb(Object.assign(new Error(next.err.message ?? 'fail'), next.err), '');
      else cb(null, next.stdout ?? '');
    }, 0);
  };
  return { execFile, default: { execFile } };
});

vi.mock('../../../electron/ollama-setup.js', () => ({
  readEmbedModelVram: vi.fn(async () => ({ loaded: false, sizeBytes: 0, vramBytes: 0 })),
  getEmbedOomStepDowns: vi.fn(() => 0),
}));

import { getGpuStats, resetGpuStatsForTests, NVIDIA_SMI_BACKOFF_MS } from '../../../electron/gpu-stats';

const OK = { stdout: 'NVIDIA GeForce RTX 4070, 12282, 3120\n' };
const TIMEOUT = { err: { killed: true, message: 'timed out' } };
const ENOENT = { err: { code: 'ENOENT' } };

beforeEach(() => {
  resetGpuStatsForTests();
  smi.script = [];
  smi.calls = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getGpuStats nvidia-smi handling', () => {
  it('a timeout returns no reading, skips during the backoff, then retries', async () => {
    smi.script = [TIMEOUT, TIMEOUT];
    const first = await getGpuStats();
    expect(first.source).toBe('none');
    expect(smi.calls).toHaveLength(2);

    // Inside the backoff window: nvidia-smi is not spawned at all.
    vi.setSystemTime(Date.now() + 1_000);
    await getGpuStats();
    expect(smi.calls).toHaveLength(2);

    // After the backoff it is tried again and the reading comes back.
    vi.setSystemTime(Date.now() + NVIDIA_SMI_BACKOFF_MS);
    smi.script = [OK];
    const later = await getGpuStats();
    expect(smi.calls).toHaveLength(3);
    expect(later.source).toBe('nvidia-smi');
    expect(later.vramTotalMB).toBe(12282);
    expect(later.vramUsedMB).toBe(3120);
  });

  it('ENOENT on every candidate latches missing for the session', async () => {
    smi.script = [ENOENT, ENOENT];
    expect((await getGpuStats()).source).toBe('none');
    expect(smi.calls).toHaveLength(2);

    vi.setSystemTime(Date.now() + NVIDIA_SMI_BACKOFF_MS * 10);
    smi.script = [OK];
    expect((await getGpuStats()).source).toBe('none');
    expect(smi.calls).toHaveLength(2);
  });

  it('a non-zero exit on one candidate and ENOENT on the other does not latch', async () => {
    smi.script = [{ err: { code: '1' as unknown as string, message: 'exit 9' } }, ENOENT];
    await getGpuStats();
    vi.setSystemTime(Date.now() + NVIDIA_SMI_BACKOFF_MS + 1);
    smi.script = [OK];
    expect((await getGpuStats()).source).toBe('nvidia-smi');
  });

  it('success after a failure on the first candidate returns stats', async () => {
    smi.script = [ENOENT, OK];
    const stats = await getGpuStats();
    expect(stats.source).toBe('nvidia-smi');
    expect(stats.gpuName).toBe('NVIDIA GeForce RTX 4070');
  });
});
