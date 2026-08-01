/**
 * Telemetry tab — zero-session empty state and mid-view session updates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import TelemetryTab from '@/components/telemetry-tab';
import { trackerOverheadStore } from '@/services/tracker-overhead-store';

const mockGetForGame = vi.fn((): ReturnType<typeof import('@/types/game').GameSession[]> => []);
let subscribeCb: (() => void) | null = null;

const mockGetActiveSessions = vi.fn(async () => [] as Array<{
  gameId: string;
  startTime: string;
  elapsedMinutes: number;
}>);
const liveUpdateCbs: Array<(data: { gameId: string; activeMinutes: number }) => void> = [];

vi.mock('@/services/session-store', () => ({
  sessionStore: {
    getForGame: (...args: unknown[]) => mockGetForGame(...args),
    subscribe: (cb: () => void) => {
      subscribeCb = cb;
      return () => {
        subscribeCb = null;
      };
    },
  },
}));

vi.mock('@/components/telemetry/SessionAnalyticsPanel', () => ({
  default: () => <div data-testid="session-analytics">Session Analytics</div>,
}));
vi.mock('@/components/telemetry/ImmersionPanel', () => ({
  default: () => <div data-testid="immersion">Immersion</div>,
}));
vi.mock('@/components/telemetry/PacingPanel', () => ({
  default: () => <div data-testid="pacing">Pacing</div>,
}));
vi.mock('@/components/telemetry/FatiguePanel', () => ({
  default: () => <div data-testid="fatigue">Fatigue</div>,
}));
vi.mock('@/components/telemetry/OverheadPanel', () => ({
  default: () => <div data-testid="overhead">Overhead</div>,
}));
vi.mock('@/components/telemetry/FrictionPanel', () => ({
  default: () => <div data-testid="friction">Friction</div>,
}));

describe('TelemetryTab', () => {
  beforeEach(() => {
    mockGetForGame.mockReset();
    mockGetForGame.mockReturnValue([]);
    subscribeCb = null;
    mockGetActiveSessions.mockReset();
    mockGetActiveSessions.mockResolvedValue([]);
    liveUpdateCbs.length = 0;
    trackerOverheadStore.clear();

    (window as unknown as { sessionTracker: unknown }).sessionTracker = {
      getActiveSessions: (...args: unknown[]) => mockGetActiveSessions(...args),
      onLiveUpdate: (cb: (data: { gameId: string; activeMinutes: number }) => void) => {
        liveUpdateCbs.push(cb);
        return () => {
          const i = liveUpdateCbs.indexOf(cb);
          if (i >= 0) liveUpdateCbs.splice(i, 1);
        };
      },
      onSessionStarted: () => () => {},
      onSessionEnded: () => () => {},
      onStatusChange: () => () => {},
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
    trackerOverheadStore.clear();
    delete (window as unknown as { sessionTracker?: unknown }).sessionTracker;
  });

  it('renders empty state with zero sessions', () => {
    render(<TelemetryTab gameId="steam-730" gameTitle="Counter-Strike 2" />);

    expect(screen.getByText('Telemetry')).toBeInTheDocument();
    expect(screen.getByText(/Insufficient data/)).toBeInTheDocument();
    expect(screen.queryByTestId('session-analytics')).not.toBeInTheDocument();
  });

  it('populates analytics panels after a session is recorded mid-view', async () => {
    render(<TelemetryTab gameId="steam-730" gameTitle="Counter-Strike 2" />);

    expect(screen.getByText(/Insufficient data/)).toBeInTheDocument();
    expect(subscribeCb).toBeTypeOf('function');

    const session = {
      id: 's1',
      gameId: 'steam-730',
      startTime: '2026-01-01T10:00:00.000Z',
      endTime: '2026-01-01T11:30:00.000Z',
      durationMinutes: 90,
    };
    mockGetForGame.mockReturnValue([session]);
    subscribeCb!();

    await waitFor(() => {
      expect(screen.queryByText(/Insufficient data/)).not.toBeInTheDocument();
    });

    expect(screen.getByText(/Counter-Strike 2 — Telemetry/)).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByTestId('session-analytics')).toBeInTheDocument();
    expect(screen.getByTestId('immersion')).toBeInTheDocument();
    expect(screen.getByTestId('pacing')).toBeInTheDocument();
  });

  it('does not show insufficient data while a live session is active with zero completed sessions', async () => {
    mockGetActiveSessions.mockResolvedValue([
      {
        gameId: 'steam-730',
        startTime: '2026-08-01T09:00:00.000Z',
        elapsedMinutes: 12,
      },
    ]);

    render(<TelemetryTab gameId="steam-730" gameTitle="Counter-Strike 2" />);

    await waitFor(() => {
      expect(screen.queryByText(/Insufficient data/)).not.toBeInTheDocument();
    });

    expect(screen.getByText(/Counter-Strike 2 — Telemetry/)).toBeInTheDocument();
    expect(screen.getByTestId('overhead')).toBeInTheDocument();
    expect(screen.getByTestId('friction')).toBeInTheDocument();
  });

  it('does not show insufficient data when overhead samples exist for the game', async () => {
    trackerOverheadStore.ingest({
      timestamp: Date.now(),
      gameId: 'steam-730',
      cpuPercent: 2,
      rssMb: 180,
      hookLatencyMs: 8,
    });

    render(<TelemetryTab gameId="steam-730" gameTitle="Counter-Strike 2" />);

    await waitFor(() => {
      expect(screen.queryByText(/Insufficient data/)).not.toBeInTheDocument();
    });

    expect(screen.getByTestId('overhead')).toBeInTheDocument();
  });
});
