/**
 * HowLongToBeat on the game details header: loading placeholder, the times badge, and hidden when
 * switched off / unmatched / the bridge is missing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HltbChip } from '@/components/hltb-chip';
import { HLTB_ENABLED_LS_KEY, releaseYearOf, useHltbTimes } from '@/hooks/useHltbTimes';

const TIMES = {
  hltbId: 62941, name: 'Hades', year: 2020,
  mainHours: 23.6, mainExtraHours: 48.6, completionistHours: 95.3, allStylesHours: 44.4,
  url: 'https://howlongtobeat.com/game/62941',
};

function Harness({ title, year }: { title?: string; year?: number }) {
  return <HltbChip state={useHltbTimes(title, year)} />;
}

afterEach(() => {
  delete (window as unknown as { hltb?: unknown }).hltb;
  localStorage.removeItem(HLTB_ENABLED_LS_KEY);
});

describe('HowLongToBeat chip', () => {
  it('says it is HowLongToBeat and shows main / +extras / 100% hours, with an explaining tooltip', async () => {
    const getTimes = vi.fn().mockResolvedValue(TIMES);
    (window as unknown as { hltb: unknown }).hltb = { getTimes };
    render(<Harness title="Hades" year={2020} />);
    expect(await screen.findByText('HowLongToBeat')).toBeInTheDocument();
    expect(screen.getByText(/Main 24h/)).toBeInTheDocument();
    expect(screen.getByText(/\+Extras 49h/)).toBeInTheDocument();
    expect(screen.getByText(/100% 95h/)).toBeInTheDocument();
    const badge = screen.getByText('HowLongToBeat').closest('[title]')!;
    expect(badge.getAttribute('title')).toMatch(/Main story: 24h/);
    expect(badge.getAttribute('role')).not.toBe('link');
    expect(getTimes).toHaveBeenCalledWith({ title: 'Hades', year: 2020 });
  });

  it('renders nothing when there is no match', async () => {
    const getTimes = vi.fn().mockResolvedValue(null);
    (window as unknown as { hltb: unknown }).hltb = { getTimes };
    const { container } = render(<Harness title="Unknown" />);
    await waitFor(() => expect(getTimes).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('never asks when switched off or when the bridge is missing', () => {
    const getTimes = vi.fn();
    (window as unknown as { hltb: unknown }).hltb = { getTimes };
    localStorage.setItem(HLTB_ENABLED_LS_KEY, 'false');
    const { container } = render(<Harness title="Hades" />);
    expect(getTimes).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
    delete (window as unknown as { hltb?: unknown }).hltb;
    localStorage.removeItem(HLTB_ENABLED_LS_KEY);
    expect(render(<Harness title="Hades" />).container.textContent).toBe('');
  });

  it('releaseYearOf reads the year from store date formats', () => {
    expect(releaseYearOf('Oct 25, 2019')).toBe(2019);
    expect(releaseYearOf('2020-09-17')).toBe(2020);
    expect(releaseYearOf('Coming soon')).toBeUndefined();
    expect(releaseYearOf(undefined)).toBeUndefined();
  });
});
