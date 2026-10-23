/**
 * Embedding batch-size slider + VRAM status classification.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import {
  classifyVramStatus,
  vramAdvice,
  sliderIndexToBatchSize,
  batchSizeToSliderIndex,
  BATCH_SIZE_STEPS,
  VramMeter,
  type GpuStats,
} from '@/components/settings/embedding-batch-size';

function stats(over: Partial<GpuStats> = {}): GpuStats {
  return {
    source: 'nvidia-smi',
    gpuName: 'NVIDIA GeForce RTX 4070',
    vramTotalMB: 12288,
    vramUsedMB: 4000,
    modelLoaded: true,
    modelVramMB: 700,
    modelPartialOffload: false,
    oomStepDowns: 0,
    ...over,
  };
}

describe('classifyVramStatus', () => {
  it('is OK with plenty free', () => {
    const s = classifyVramStatus(stats());
    expect(s).toEqual({ level: 'ok', reason: 'ok', freeMB: 8288 });
  });

  it('is Tight under 1536 MB free', () => {
    expect(classifyVramStatus(stats({ vramUsedMB: 12288 - 1535 })).level).toBe('tight');
    expect(classifyVramStatus(stats({ vramUsedMB: 12288 - 1536 })).level).toBe('ok');
  });

  it('is Too high under 512 MB free', () => {
    const s = classifyVramStatus(stats({ vramUsedMB: 12288 - 511 }));
    expect(s.level).toBe('too-high');
    expect(s.reason).toBe('low-free');
    expect(classifyVramStatus(stats({ vramUsedMB: 12288 - 512 })).level).toBe('tight');
  });

  it('is Too high after an out-of-memory step-down, even with free memory', () => {
    expect(classifyVramStatus(stats({ oomStepDowns: 1 }))).toMatchObject({ level: 'too-high', reason: 'oom' });
  });

  it('is Too high when the model is partially offloaded', () => {
    expect(classifyVramStatus(stats({ modelPartialOffload: true }))).toMatchObject({ level: 'too-high', reason: 'offload' });
  });

  it('is unknown without totals (non-NVIDIA) unless a hard signal fires', () => {
    const none = stats({ source: 'none', vramTotalMB: null, vramUsedMB: null });
    expect(classifyVramStatus(none)).toEqual({ level: 'unknown', reason: 'unknown', freeMB: null });
    expect(classifyVramStatus({ ...none, oomStepDowns: 2 }).level).toBe('too-high');
    expect(classifyVramStatus({ ...none, modelPartialOffload: true }).level).toBe('too-high');
  });

  it('never reports negative free memory', () => {
    expect(classifyVramStatus(stats({ vramUsedMB: 99999 })).freeMB).toBe(0);
  });

  it('gives plain-language advice for problem states', () => {
    expect(vramAdvice(classifyVramStatus(stats({ oomStepDowns: 1 })))).toMatch(/lower the batch size/i);
    expect(vramAdvice(classifyVramStatus(stats({ vramUsedMB: 12000 })))).toMatch(/lower the batch size/i);
  });
});

describe('batch size slider mapping', () => {
  it('maps index 0 to Auto and the rest to the snap steps', () => {
    expect(sliderIndexToBatchSize(0)).toBe(0);
    BATCH_SIZE_STEPS.forEach((v, i) => expect(sliderIndexToBatchSize(i + 1)).toBe(v));
    expect(sliderIndexToBatchSize(99)).toBe(512);
  });

  it('snaps stored values to the nearest step and round-trips', () => {
    expect(batchSizeToSliderIndex(0)).toBe(0);
    expect(batchSizeToSliderIndex(-5)).toBe(0);
    expect(sliderIndexToBatchSize(batchSizeToSliderIndex(100))).toBe(128);
    expect(sliderIndexToBatchSize(batchSizeToSliderIndex(300))).toBe(256);
    expect(sliderIndexToBatchSize(batchSizeToSliderIndex(500))).toBe(512);
    BATCH_SIZE_STEPS.forEach((v) => expect(sliderIndexToBatchSize(batchSizeToSliderIndex(v))).toBe(v));
  });
});

describe('VramMeter', () => {
  const win = window as unknown as { ollama?: unknown };
  const original = win.ollama;
  afterEach(() => {
    win.ollama = original;
    vi.useRealTimers();
  });

  it('asks the user to start Ollama when there is no reading', async () => {
    win.ollama = { gpuStats: vi.fn().mockResolvedValue(null) };
    render(<VramMeter />);
    await waitFor(() => expect(screen.getByText(/start ollama to see graphics memory/i)).toBeInTheDocument());
  });

  it('shows status and polls every 2s until unmounted', async () => {
    vi.useFakeTimers();
    const gpuStats = vi.fn().mockResolvedValue(stats({ vramUsedMB: 12000 }));
    win.ollama = { gpuStats };
    const { unmount } = render(<VramMeter />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('Too high')).toBeInTheDocument();
    expect(gpuStats).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(2000); await Promise.resolve(); });
    expect(gpuStats).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => { vi.advanceTimersByTime(6000); await Promise.resolve(); });
    expect(gpuStats).toHaveBeenCalledTimes(2);
  });

  it('explains when total memory cannot be read', async () => {
    win.ollama = { gpuStats: vi.fn().mockResolvedValue(stats({ source: 'none', vramTotalMB: null, vramUsedMB: null })) };
    render(<VramMeter />);
    await waitFor(() => expect(screen.getByText(/can't be read on this graphics card/i)).toBeInTheDocument());
  });
});
