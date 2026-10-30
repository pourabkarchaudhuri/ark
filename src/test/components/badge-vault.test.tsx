/**
 * Badge Vault (v1.0.97 B27): rendering a card never writes unlock dates, and
 * search does not reveal locked secret badges (ui-voyage#2, ui-voyage#5).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { BadgeDefinition, BadgeProgress } from '@/data/badge-types';

const tsMock = vi.hoisted(() => ({
  getBadgeUnlockedAt: vi.fn((_id: number): number | undefined => undefined),
  setBadgeUnlockedAt: vi.fn(),
  setBadgeUnlockedAtMany: vi.fn(),
  ensureUnlockedAt: vi.fn(() => 0),
}));
vi.mock('@/services/badge-unlock-timestamps', () => tsMock);

import { BadgeVault, getVisibleSearchText } from '@/components/medals/badge-vault';

function def(over: Partial<BadgeDefinition>): BadgeDefinition {
  return {
    id: 1, name: 'Plain', description: 'Add 1 game', lore: 'Plain lore', shape: 'shield',
    branch: 'voyager', tier: 'bronze', secret: false, condition: { type: 'gameCount', min: 1 },
    ...over,
  };
}
const progress = (badge: BadgeDefinition, unlocked: boolean): BadgeProgress => ({ badge, unlocked, current: unlocked ? 1 : 0, target: 1 });

const secret = def({ id: 2, name: 'Perfectly Average', description: 'Average rating exactly 3.0', lore: 'Perfect mediocrity', branch: 'secret', secret: true });

beforeEach(() => {
  Object.values(tsMock).forEach(fn => fn.mockClear());
});

describe('BadgeCard', () => {
  it('rendering an unlocked card does not write a timestamp and hides Obtained while unknown', () => {
    render(<BadgeVault badges={[progress(def({}), true)]} unlockedCount={1} />);
    expect(screen.getByText('Plain')).toBeInTheDocument();
    expect(tsMock.ensureUnlockedAt).not.toHaveBeenCalled();
    expect(tsMock.setBadgeUnlockedAt).not.toHaveBeenCalled();
    expect(tsMock.setBadgeUnlockedAtMany).not.toHaveBeenCalled();
    expect(screen.queryByText(/Obtained/)).toBeNull();
  });

  it('shows the stored Obtained date when one exists', () => {
    tsMock.getBadgeUnlockedAt.mockReturnValueOnce(new Date(2024, 2, 5, 10, 0).getTime());
    render(<BadgeVault badges={[progress(def({}), true)]} unlockedCount={1} />);
    expect(screen.getByText(/Obtained/)).toBeInTheDocument();
  });
});

describe('vault search and secret badges', () => {
  const search = (q: string) => fireEvent.change(screen.getByPlaceholderText('Search transmissions...'), { target: { value: q } });

  it('a locked secret badge does not match words from its hidden text, but matches "classified"', () => {
    render(<BadgeVault badges={[progress(secret, false)]} unlockedCount={0} />);
    // The empty state renders synchronously (exiting cards animate out).
    const noMatch = () => screen.queryByText('No transmissions match your query.');
    search('mediocrity');
    expect(noMatch()).not.toBeNull();
    search('average');
    expect(noMatch()).not.toBeNull();
    search('classified');
    expect(noMatch()).toBeNull();
    expect(screen.getByText('Classified')).toBeInTheDocument();
    search('secret');
    expect(noMatch()).toBeNull();
  });

  it('once unlocked, the secret badge matches its name', () => {
    render(<BadgeVault badges={[progress(secret, true)]} unlockedCount={1} />);
    search('perfectly');
    expect(screen.queryByText('No transmissions match your query.')).toBeNull();
    expect(screen.getByText('Perfectly Average')).toBeInTheDocument();
  });

  it('getVisibleSearchText only exposes visible text', () => {
    expect(getVisibleSearchText(secret, false)).not.toMatch(/average|mediocrity/);
    expect(getVisibleSearchText(secret, true)).toMatch(/perfectly average/);
    expect(getVisibleSearchText(def({ genre: 'RPG' }), false)).toMatch(/rpg/);
  });
});
