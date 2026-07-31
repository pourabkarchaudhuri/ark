import { describe, it, expect } from 'vitest';
import {
  expandHardNegativeIds,
  FRANCHISE_MUTE_MS,
  DEVELOPER_MUTE_MS,
} from '@/services/hard-negative';

describe('expandHardNegativeIds (F3)', () => {
  const now = Date.parse('2026-08-01T00:00:00Z');

  const catalog = [
    { gameId: 'steam-1', title: 'Mass Effect 2', developer: 'BioWare' },
    { gameId: 'steam-2', title: 'Mass Effect 3', developer: 'BioWare' },
    { gameId: 'steam-3', title: 'Forza Horizon 5', developer: 'Playground Games' },
    { gameId: 'steam-4', title: 'Unrelated RPG', developer: 'Other Studio' },
  ];

  it('expands same franchise within 14 days', () => {
    const ids = expandHardNegativeIds(
      [{
        gameId: 'steam-1',
        at: now - 2 * 24 * 60 * 60 * 1000,
        franchiseBase: 'mass effect',
        developer: 'BioWare',
        title: 'Mass Effect 2',
      }],
      catalog,
      now,
    );
    expect(ids).toContain('steam-1');
    expect(ids).toContain('steam-2');
    expect(ids).not.toContain('steam-4');
  });

  it('does not expand franchise after mute window', () => {
    const ids = expandHardNegativeIds(
      [{
        gameId: 'steam-1',
        at: now - FRANCHISE_MUTE_MS - 1000,
        franchiseBase: 'mass effect',
        title: 'Mass Effect 2',
      }],
      catalog,
      now,
    );
    expect(ids).toContain('steam-1');
    expect(ids).not.toContain('steam-2');
  });

  it('expands same developer within 7 days', () => {
    const ids = expandHardNegativeIds(
      [{
        gameId: 'steam-99',
        at: now - DEVELOPER_MUTE_MS + 60_000,
        developer: 'Playground Games',
        title: 'Forza Motorsport',
      }],
      catalog,
      now,
    );
    expect(ids).toContain('steam-99');
    expect(ids).toContain('steam-3');
  });
});
