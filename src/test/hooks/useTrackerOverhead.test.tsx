/**
 * useTrackerOverhead — mounting after a sample must not loop
 * ('Maximum update depth exceeded'), one render per ingested sample (1.0.97 B23).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useTrackerOverhead } from '@/hooks/useTrackerOverhead';
import { trackerOverheadStore, type OverheadSample } from '@/services/tracker-overhead-store';

function sample(i: number, gameId: string | null = 'steam-1'): OverheadSample {
  return { timestamp: 1_000 + i, gameId, cpuPercent: 1, rssMb: 100, hookLatencyMs: 2 };
}

let renders = 0;

function Probe({ gameId }: { gameId?: string }) {
  renders += 1;
  const samples = useTrackerOverhead(gameId);
  return <div data-testid="count">{samples.length}</div>;
}

describe('useTrackerOverhead', () => {
  beforeEach(() => {
    trackerOverheadStore.clear();
    renders = 0;
  });

  it('mounts after one sample without error and renders once', () => {
    trackerOverheadStore.ingest(sample(1));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).not.toThrow();
    expect(screen.getByTestId('count').textContent).toBe('1');
    expect(renders).toBe(1);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('re-renders exactly once per ingested sample', () => {
    trackerOverheadStore.ingest(sample(1));
    render(<Probe gameId="steam-1" />);
    expect(renders).toBe(1);
    act(() => { trackerOverheadStore.ingest(sample(2)); });
    expect(renders).toBe(2);
    act(() => { trackerOverheadStore.ingest(sample(3, 'other')); });
    expect(renders).toBe(3);
    expect(screen.getByTestId('count').textContent).toBe('2');
  });
});
