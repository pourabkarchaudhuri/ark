/**
 * Telemetry tab — zero-session empty state and mid-view session updates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import TelemetryTab from '@/components/telemetry-tab';

const mockGetForGame = vi.fn((): ReturnType<typeof import('@/types/game').GameSession[]> => []);
let subscribeCb: (() => void) | null = null;

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
  });

  afterEach(() => {
    vi.clearAllMocks();
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
});
