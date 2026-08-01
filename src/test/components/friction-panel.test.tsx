/**
 * FrictionPanel — allow live insights with a single in-progress session.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import FrictionPanel from '@/components/telemetry/FrictionPanel';
import { trackerOverheadStore } from '@/services/tracker-overhead-store';

vi.mock('recharts', () => ({
  ScatterChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Scatter: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Cell: () => null,
}));

vi.mock('@/components/ui/chart', () => ({
  ChartContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));

describe('FrictionPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    trackerOverheadStore.clear();
    vi.runOnlyPendingTimers();
  });

  afterEach(() => {
    trackerOverheadStore.clear();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('renders friction stats for a single live session (not a 5-session gate)', () => {
    const start = Date.parse('2026-08-01T10:00:00.000Z');
    // Open sessions use Date.now() as span end — pin "now" after the sample.
    vi.setSystemTime(start + 5 * 60_000);
    trackerOverheadStore.ingest({
      timestamp: start + 60_000,
      gameId: 'steam-730',
      cpuPercent: 3,
      rssMb: 200,
      hookLatencyMs: 650,
    });
    vi.advanceTimersByTime(5000);

    render(
      <FrictionPanel
        gameId="steam-730"
        sessions={[
          {
            id: 'live-steam-730',
            gameId: 'steam-730',
            startTime: '2026-08-01T10:00:00.000Z',
            // No endTime — in-progress; span end is Date.now()
            durationMinutes: 1,
            idleMinutes: 2,
          },
        ]}
      />,
    );

    expect(screen.queryByText(/at least 5 sessions/i)).not.toBeInTheDocument();
    expect(screen.getByText('Friction')).toBeInTheDocument();
    expect(screen.getByText('Anomalies detected')).toBeInTheDocument();
  });
});
