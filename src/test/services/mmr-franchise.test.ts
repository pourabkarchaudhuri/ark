import { describe, it, expect } from 'vitest';
import { mmrMaxSim } from '@/services/mmr-diversity';

describe('mmrMaxSim (F5)', () => {
  it('penalizes same-franchise picks at 1.0 even with different genres', () => {
    const sim = mmrMaxSim(
      { genres: ['Racing'], title: 'Mass Effect 2', developer: 'BioWare' },
      [{ genres: ['Shooter'], title: 'Mass Effect 3', developer: 'BioWare' }],
    );
    expect(sim).toBe(1);
  });

  it('penalizes same developer at 0.8', () => {
    const sim = mmrMaxSim(
      { genres: ['RPG'], title: 'Game A', developer: 'FromSoftware' },
      [{ genres: ['Action'], title: 'Game B', developer: 'FromSoftware' }],
    );
    expect(sim).toBe(0.8);
  });

  it('falls back to genre Jaccard when no franchise/dev match', () => {
    const sim = mmrMaxSim(
      { genres: ['Action', 'RPG'], title: 'Elden Ring', developer: 'FromSoftware' },
      [{ genres: ['Action', 'Adventure'], title: 'Zelda', developer: 'Nintendo' }],
    );
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(0.8);
  });
});
