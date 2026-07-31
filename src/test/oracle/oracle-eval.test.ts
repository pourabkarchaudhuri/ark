/**
 * F1 offline Oracle eval harness — holdout recall, negative suppress, shelf purity.
 * Pure vitest; no network.
 */

import { describe, it, expect } from 'vitest';
import { expandHardNegativeIds } from '@/services/hard-negative';
import { matchesMoodShelf, matchesDeepInGenre, isComingSoonForShelf } from '@/services/reco-shelf-rules';
import { passesUmbrellaMembership, extractFranchiseBase } from '@/services/franchise';
import { heroEvidenceSortKey, computeEngagementWeight, countEvidenceLibrary } from '@/services/engagement-weight';
import { mmrMaxSim } from '@/services/mmr-diversity';

const NOW = Date.parse('2026-08-01T00:00:00Z');

describe('oracle-eval harness (F1)', () => {
  describe('holdout / evidence ranking', () => {
    it('evidence-aligned hero key outranks zero-hour WtP noise', () => {
      const completedScore = 0.55;
      const wtpScore = 0.62; // raw score higher, but no evidence alignment
      const completedKey = heroEvidenceSortKey(completedScore, 0.9);
      const wtpKey = heroEvidenceSortKey(wtpScore, 0.05);
      expect(completedKey).toBeGreaterThan(wtpKey);
    });

    it('thin library counts as cold-start (<5 evidence)', () => {
      const lib = [
        { status: 'Want to Play', hoursPlayed: 0 },
        { status: 'Want to Play', hoursPlayed: 0 },
        { status: 'Completed', hoursPlayed: 10 },
      ];
      expect(countEvidenceLibrary(lib)).toBe(1);
      expect(countEvidenceLibrary(lib) < 5).toBe(true);
    });
  });

  describe('negative holdout', () => {
    it('dismissed franchise mute keeps sequels out of expand set window', () => {
      const suppressed = new Set(
        expandHardNegativeIds(
          [{
            gameId: 'steam-sw-1',
            at: NOW - 1000,
            franchiseBase: extractFranchiseBase('Star Wars Jedi: Survivor'),
            title: 'Star Wars Jedi: Survivor',
            developer: 'Respawn',
          }],
          [
            { gameId: 'steam-sw-1', title: 'Star Wars Jedi: Survivor', developer: 'Respawn' },
            { gameId: 'steam-sw-2', title: 'Star Wars Jedi: Fallen Order', developer: 'Respawn' },
            { gameId: 'steam-ok', title: 'Hades', developer: 'Supergiant' },
          ],
          NOW,
        ),
      );
      expect(suppressed.has('steam-sw-2')).toBe(true);
      expect(suppressed.has('steam-ok')).toBe(false);
    });
  });

  describe('shelf purity', () => {
    it('Star Wars racer does not pass FPS mood shelf', () => {
      expect(matchesMoodShelf(['Racing', 'Action'], 'FPS & Shooter')).toBe(false);
      expect(matchesMoodShelf(['FPS', 'Shooter'], 'FPS & Shooter')).toBe(true);
    });

    it('umbrella brand gate blocks unrelated Star Wars spinoff without studio overlap', () => {
      const owned = [{
        title: 'Star Wars Jedi: Survivor',
        developer: 'Respawn Entertainment',
        publisher: 'EA',
      }];
      const racer = {
        title: 'Star Wars Episode I Racer',
        developer: 'LucasArts',
        publisher: 'LucasArts',
      };
      expect(passesUmbrellaMembership(racer, owned, 'star wars')).toBe(false);
    });

    it('Lost Soul Aside / AC Shadows are not FPS deep-in', () => {
      expect(matchesDeepInGenre(['Action', 'Adventure'], 'FPS & Shooter')).toBe(false);
      expect(matchesDeepInGenre(['Action', "Assassin's Creed"], 'FPS & Shooter')).toBe(false);
      expect(matchesDeepInGenre(['FPS', 'Shooter'], 'FPS & Shooter')).toBe(true);
    });

    it('empty release date is not coming soon', () => {
      expect(isComingSoonForShelf('', false, NOW)).toBe(false);
    });
  });

  describe('engagement + MMR gates', () => {
    it('idle ratio reduces engagement weight', () => {
      const full = computeEngagementWeight({
        hoursPlayed: 40, rating: 5, status: 'Completed', activeToIdleRatio: 1,
      });
      const idle = computeEngagementWeight({
        hoursPlayed: 40, rating: 5, status: 'Completed', activeToIdleRatio: 0.2,
      });
      expect(idle).toBeLessThan(full);
    });

    it('MMR same-franchise similarity is maximal', () => {
      expect(
        mmrMaxSim(
          { genres: ['Action'], title: 'Mass Effect 2', developer: 'BioWare' },
          [{ genres: ['RPG'], title: 'Mass Effect 3', developer: 'BioWare' }],
        ),
      ).toBe(1);
    });
  });
});
