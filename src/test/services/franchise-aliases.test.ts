import { describe, it, expect } from 'vitest';
import {
  extractFranchiseBase,
  canonicalFranchiseBase,
} from '@/services/franchise';
import { expandHardNegativeIds } from '@/services/hard-negative';
import { mmrMaxSim } from '@/services/mmr-diversity';

describe('canonicalFranchiseBase aliases', () => {
  it('maps Halo Infinite → halo (matches Halo CE)', () => {
    expect(canonicalFranchiseBase('Halo Infinite')).toBe('halo');
    expect(canonicalFranchiseBase('Halo: Combat Evolved')).toBe('halo');
    expect(canonicalFranchiseBase('Halo Infinite')).toBe(
      canonicalFranchiseBase('Halo: Combat Evolved'),
    );
  });

  it('leaves Halo Wars as its own base', () => {
    expect(canonicalFranchiseBase('Halo Wars')).toBe('halo wars');
    expect(canonicalFranchiseBase('Halo Wars 2')).toBe('halo wars');
  });

  it('maps DOOM Eternal / DOOM 2016 → doom', () => {
    expect(canonicalFranchiseBase('DOOM Eternal')).toBe('doom');
    expect(canonicalFranchiseBase('Doom 2016')).toBe('doom');
  });

  it('maps RE Village / biohazard patterns → resident evil', () => {
    expect(canonicalFranchiseBase('Resident Evil Village')).toBe('resident evil');
    expect(canonicalFranchiseBase('Resident Evil 7')).toBe('resident evil');
    expect(canonicalFranchiseBase('Biohazard')).toBe('resident evil');
  });

  it('maps Far Cry Primal / numbered Far Cry → far cry', () => {
    expect(canonicalFranchiseBase('Far Cry Primal')).toBe('far cry');
    expect(canonicalFranchiseBase('Far Cry 6')).toBe('far cry');
  });

  it('keeps Star Wars umbrella base gated (no alias collapse to bare brand only)', () => {
    const jedi = extractFranchiseBase('Star Wars Jedi: Survivor');
    const canonical = canonicalFranchiseBase('Star Wars Jedi: Survivor');
    // Alias must not invent a different base than strip+alias would; umbrella stays usable
    expect(canonical).toBe(jedi);
    expect(canonical.includes('star wars')).toBe(true);
  });
});

describe('hard-neg expand uses canonical franchise base', () => {
  const now = Date.parse('2026-08-01T00:00:00Z');

  it('Halo Infinite dismiss mutes Halo CE sibling', () => {
    const catalog = [
      { gameId: 'steam-hi', title: 'Halo Infinite', developer: '343' },
      { gameId: 'steam-ce', title: 'Halo: Combat Evolved', developer: 'Bungie' },
      { gameId: 'steam-ok', title: 'Hades', developer: 'Supergiant' },
    ];
    const ids = expandHardNegativeIds(
      [{
        gameId: 'steam-hi',
        at: now - 1000,
        title: 'Halo Infinite',
        franchiseBase: canonicalFranchiseBase('Halo Infinite'),
        developer: '343',
      }],
      catalog,
      now,
    );
    expect(ids).toContain('steam-hi');
    expect(ids).toContain('steam-ce');
    expect(ids).not.toContain('steam-ok');
  });
});

describe('MMR uses canonical franchise base', () => {
  it('Halo Infinite vs Halo CE is maximal franchise sim', () => {
    expect(
      mmrMaxSim(
        { genres: ['Shooter'], title: 'Halo Infinite', developer: '343' },
        [{ genres: ['Action'], title: 'Halo: Combat Evolved', developer: 'Bungie' }],
      ),
    ).toBe(1);
  });
});
