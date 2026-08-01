import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { GameRollup } from '@/lib/voyage-derive';
import {
  AUDIT_STORAGE_KEY,
  evaluateRules,
  loadPersisted,
  savePersisted,
} from '@/components/journey-audit-view';

function rollup(overrides: Partial<GameRollup> & { gameId: string; title: string }): GameRollup {
  return {
    status: 'Want to Play',
    hoursPlayed: 0,
    rating: 0,
    addedAtMs: Date.parse('2023-01-01'),
    removedAtMs: null,
    firstPlayedMs: null,
    lastPlayedMs: null,
    sessionCount: 0,
    totalMinutes: 0,
    statusSinceMs: null,
    inLibrary: true,
    ...overrides,
  };
}

const ALL_RULES = new Set([
  'unrated-completions',
  'missing-exe',
  'unlinked-duplicates',
  'series-gaps',
  'default-status',
  'stalled-run',
  'no-playtime',
] as const);

describe('voyage audit engine', () => {
  const nowMs = Date.parse('2026-08-01T12:00:00Z');

  describe('evaluateRules', () => {
    it('flags completed games without a rating', () => {
      const { findings } = evaluateRules(
        [rollup({ gameId: 'steam-1', title: 'Hades', status: 'Completed', rating: 0 })],
        ALL_RULES,
        [],
        nowMs,
      );
      expect(findings.some((f) => f.ruleId === 'unrated-completions')).toBe(true);
    });

    it('flags missing executable paths', () => {
      const { findings } = evaluateRules(
        [rollup({ gameId: 'steam-2', title: 'Doom', executablePath: undefined })],
        ALL_RULES,
        [],
        nowMs,
      );
      expect(findings.some((f) => f.ruleId === 'missing-exe')).toBe(true);
    });

    it('flags duplicate titles across stores when unlinked', () => {
      const { findings } = evaluateRules(
        [
          rollup({ gameId: 'steam-10', title: 'Control' }),
          rollup({ gameId: 'epic-abc', title: 'Control' }),
        ],
        ALL_RULES,
        [],
        nowMs,
      );
      expect(findings.some((f) => f.ruleId === 'unlinked-duplicates')).toBe(true);
    });

    it('respects disabled rules via the enabled set', () => {
      const enabled = new Set(['missing-exe'] as const);
      const { findings } = evaluateRules(
        [
          rollup({ gameId: 'steam-1', title: 'Hades', status: 'Completed', rating: 0 }),
          rollup({ gameId: 'steam-2', title: 'Doom', executablePath: undefined }),
        ],
        enabled,
        [],
        nowMs,
      );
      expect(findings.every((f) => f.ruleId === 'missing-exe')).toBe(true);
    });
  });

  describe('snooze persistence', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    afterEach(() => {
      localStorage.clear();
    });

    it('round-trips snooze and dismiss maps through localStorage', () => {
      const state = {
        version: 1 as const,
        snoozed: { 'missing-exe:steam-1': nowMs + 7 * 86_400_000 },
        dismissed: { 'missing-exe:steam-2': nowMs },
        disabledRules: ['series-gaps'] as const,
        trail: [],
      };
      savePersisted(state);
      expect(localStorage.getItem(AUDIT_STORAGE_KEY)).toBeTruthy();

      const loaded = loadPersisted();
      expect(loaded.snoozed['missing-exe:steam-1']).toBe(state.snoozed['missing-exe:steam-1']);
      expect(loaded.dismissed['missing-exe:steam-2']).toBe(nowMs);
      expect(loaded.disabledRules).toEqual(['series-gaps']);
    });

    it('returns empty state when storage is missing or corrupt', () => {
      expect(loadPersisted().snoozed).toEqual({});
      localStorage.setItem(AUDIT_STORAGE_KEY, '{not json');
      expect(loadPersisted().snoozed).toEqual({});
    });
  });
});
