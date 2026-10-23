import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WrappedInputs } from '@/components/year-wrapped/stats';
import type { GameSession, JourneyEntry } from '@/types/game';

vi.mock('canvas-confetti', () => {
  const fire = Object.assign(vi.fn(() => Promise.resolve()), { reset: vi.fn() });
  return { default: Object.assign(vi.fn(), { create: vi.fn(() => fire) }) };
});

// Feed the overlay deterministic data instead of the live stores.
const fixture: { inputs: WrappedInputs } = { inputs: { journey: [], sessions: [], statusChanges: [] } };
vi.mock('@/components/year-wrapped/data', async () => {
  const stats = await vi.importActual<typeof import('@/components/year-wrapped/stats')>('@/components/year-wrapped/stats');
  return {
    readWrappedInputs: () => fixture.inputs,
    computeStats: (year: number, now = new Date()) => stats.computeWrappedStats(year, fixture.inputs, now),
    computeWrappedBundle: (year: number, now = new Date()) => ({
      stats: stats.computeWrappedStats(year, fixture.inputs, now),
      years: stats.getWrappedYears(fixture.inputs, now, year),
    }),
  };
});

import { YearWrapped, WrappedSnackbar } from '@/components/year-wrapped';
import { WRAPPED_FORCE_SEASON_KEY, wrappedNotifiedKey, wrappedSeenKey } from '@/lib/wrapped-season';

const YEAR = new Date().getMonth() === 0 ? new Date().getFullYear() - 1 : new Date().getFullYear();

function richInputs(): WrappedInputs {
  const j = (gameId: string, title: string, month: number): JourneyEntry => ({
    gameId, title, addedAt: new Date(YEAR, month, 3).toISOString(),
    genre: ['RPG', 'Action'], platform: ['PC'], status: 'Playing', hoursPlayed: 10, rating: 4,
  });
  let n = 0;
  const s = (gameId: string, month: number, day: number, minutes: number): GameSession => {
    const start = new Date(YEAR, month, day, 20);
    return {
      id: `s${n++}`, gameId, executablePath: 'g.exe', startTime: start.toISOString(),
      endTime: new Date(start.getTime() + minutes * 60_000).toISOString(), durationMinutes: minutes, idleMinutes: 0,
    };
  };
  return {
    journey: [j('steam-1', 'Alpha Quest', 0), j('steam-2', 'Beta Racer', 1), j('custom-3', 'Gamma Tales', 2)],
    sessions: [s('steam-1', 0, 4, 180), s('steam-1', 0, 5, 120), s('steam-2', 1, 6, 60), s('custom-3', 2, 7, 45), s('steam-1', 0, 6, 30)],
    statusChanges: [{ gameId: 'custom-3', title: 'Gamma Tales', previousStatus: 'Playing', newStatus: 'Completed', timestamp: new Date(YEAR, 2, 8).toISOString() }],
  };
}

beforeEach(() => {
  localStorage.clear();
  fixture.inputs = richInputs();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('YearWrapped overlay', () => {
  it('renders nothing while closed (no stats work)', () => {
    const { container } = render(<YearWrapped isOpen={false} onClose={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('loads stats, navigates with the keyboard and closes on Escape', async () => {
    const onClose = vi.fn();
    const bubbled = vi.fn();
    window.addEventListener('keydown', bubbled);
    render(<YearWrapped isOpen onClose={onClose} />);

    expect(await screen.findByText('Your year in games')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', `Ark Wrapped ${YEAR}`);

    await act(async () => { fireEvent.keyDown(window, { key: 'ArrowRight' }); });
    expect(await screen.findByRole('heading', { name: /your year (so far|at a glance)/i })).toBeInTheDocument();
    // Wrapped owns its keys — the app underneath doesn't see them.
    expect(bubbled).not.toHaveBeenCalled();

    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(onClose).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', bubbled);
  });

  it('reaches the finale and hands off to the Galaxy flythrough', async () => {
    const onClose = vi.fn();
    const onLaunch = vi.fn();
    render(<YearWrapped isOpen onClose={onClose} onLaunchFlythrough={onLaunch} />);
    await screen.findByText('Your year in games');

    await act(async () => { fireEvent.keyDown(window, { key: 'End' }); });
    const btn = await screen.findByRole('button', { name: /fly through your year/i });
    fireEvent.click(btn);

    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    const pending = JSON.parse(localStorage.getItem('ark.flythrough.pending') || '{}');
    expect(pending.year).toBe(YEAR);
    expect(pending.keyframes.length).toBeGreaterThanOrEqual(2);
    expect(pending.keyframes[0]).toEqual(expect.objectContaining({ gameId: expect.any(String), title: expect.any(String), subtitle: expect.any(String) }));
  });

  it('shows a gentle empty state when the year has no activity', async () => {
    fixture.inputs = { journey: [], sessions: [], statusChanges: [] };
    render(<YearWrapped isOpen onClose={() => {}} />);
    await screen.findByText('Your year in games');
    await act(async () => { fireEvent.keyDown(window, { key: 'ArrowRight' }); });
    expect(await screen.findByText('Your story is just getting started')).toBeInTheDocument();
    expect(screen.getAllByRole('tab', { name: /\d\./ })).toHaveLength(3);
  });

  it('switches year from the chips', async () => {
    fixture.inputs.journey.push({
      gameId: 'old', title: 'Older Game', addedAt: new Date(YEAR - 1, 5, 1).toISOString(),
      genre: [], platform: [], status: 'Playing', hoursPlayed: 1, rating: 0,
    });
    render(<YearWrapped isOpen onClose={() => {}} />);
    await screen.findByText('Your year in games');
    const chip = await screen.findByRole('tab', { name: String(YEAR - 1) });
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', `Ark Wrapped ${YEAR - 1}`));
    expect(await screen.findByText(String(YEAR - 1), { selector: 'h1' })).toBeInTheDocument();
  });
});

describe('WrappedSnackbar (seasonal banner + notification)', () => {
  it('shows nothing out of season', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 23, 12));
    render(<WrappedSnackbar onLaunch={() => {}} />);
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(screen.queryByText(/is here/)).toBeNull();
  });

  it('shows the banner in season, opens Wrapped and never nags again that season', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 11, 20, 12));
    const onLaunch = vi.fn();
    const { unmount } = render(<WrappedSnackbar onLaunch={onLaunch} />);
    await act(async () => { vi.advanceTimersByTime(3000); });
    fireEvent.click(screen.getByRole('button', { name: 'Open Wrapped' }));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(wrappedSeenKey(2026))).toBe('1');
    unmount();

    render(<WrappedSnackbar onLaunch={onLaunch} />);
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByRole('button', { name: 'Open Wrapped' })).toBeNull();
  });

  it('can be forced for testing and sends one desktop notification per season', async () => {
    const created: Array<{ title: string; onclick: (() => void) | null; close: () => void }> = [];
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = vi.fn(async () => 'granted');
      onclick: (() => void) | null = null;
      close = vi.fn();
      constructor(public title: string) { created.push(this); }
    }
    const original = (window as unknown as { Notification?: unknown }).Notification;
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 23, 12)); // October — only the override makes it "season"
    localStorage.setItem(WRAPPED_FORCE_SEASON_KEY, '1');
    const onLaunch = vi.fn();
    render(<WrappedSnackbar onLaunch={onLaunch} />);
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText(/is here/)).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(9000); });
    await act(async () => { await Promise.resolve(); });
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('Ark Wrapped 2026 is here');
    expect(localStorage.getItem(wrappedNotifiedKey(2026))).toBe('1');

    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    act(() => { created[0].onclick?.(); });
    expect(focus).toHaveBeenCalled();
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(created[0].close).toHaveBeenCalled();
    focus.mockRestore();

    Object.defineProperty(window, 'Notification', { value: original, configurable: true, writable: true });
  });
});
