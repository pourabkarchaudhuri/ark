/**
 * Badge criteria (v1.0.97 B27): release-year badges, the meta-badge fixed
 * point, latched volatile badges, Rapid Deployment and Perfectly Average.
 */
import { describe, it, expect } from 'vitest';
import type { JourneyEntry, GameSession } from '@/types/game';
import type { BadgeDefinition, BadgeCondition } from '@/data/badge-types';
import { ALL_BADGES } from '@/data/badges';
import { computeDerivedStats, computeTasteDna, evaluateBadges } from '@/lib/badge-progress';

let seq = 0;
function entry(over: Partial<JourneyEntry> = {}): JourneyEntry {
  seq++;
  return {
    gameId: `steam-${seq}`,
    title: `Game ${seq}`,
    genre: [],
    platform: [],
    status: 'Want to Play',
    hoursPlayed: 1,
    rating: 0,
    addedAt: new Date(2024, 0, seq).toISOString(),
    ...over,
  } as JourneyEntry;
}

function session(start: Date): GameSession {
  seq++;
  return {
    id: `s-${seq}`,
    gameId: 'steam-1',
    startTime: start.toISOString(),
    endTime: new Date(start.getTime() + 3600_000).toISOString(),
    durationMinutes: 60,
  } as GameSession;
}

const byName = (name: string) => {
  const b = ALL_BADGES.find(x => x.name === name);
  if (!b) throw new Error(`no badge ${name}`);
  return b;
};

function evalAll(entries: JourneyEntry[], opts: { sessions?: GameSession[]; currentStreakDays?: number; isLatched?: (id: number) => boolean } = {}) {
  const stats = computeDerivedStats(entries, [], opts.sessions ?? [], [], { currentStreakDays: opts.currentStreakDays ?? 0 });
  const result = evaluateBadges(stats, computeTasteDna(stats), { isLatched: opts.isLatched });
  const unlocked = (name: string) => result.badges.find(r => r.badge.id === byName(name).id)!.unlocked;
  return { stats, result, unlocked };
}

describe('release-year badges', () => {
  it('counts distinct release years for Cycle and Era Explorer badges', () => {
    const entries = [2018, 2020, 2022, 2024].map(y => entry({ releaseDate: `${y}-06-15` }));
    const { stats, unlocked } = evalAll(entries);
    expect(stats.releaseYearCount).toBe(4);
    expect(unlocked('Cycle Veteran')).toBe(true);
    expect(unlocked('Cycle Master')).toBe(true);
    expect(unlocked('Cycle Legend')).toBe(false);
    expect(unlocked('Era Explorer 3')).toBe(true);
    expect(unlocked('Era Explorer 5')).toBe(false);
    // Same decade window: decade badges stay on the decade span.
    expect(stats.releaseYearSpan).toBe(1);
    expect(unlocked('Decade Span')).toBe(false);
  });

  it('keeps decade badges on the decade span', () => {
    const entries = [1985, 2015].map(y => entry({ releaseDate: `${y}-06-15` }));
    const { stats, unlocked } = evalAll(entries);
    expect(stats.releaseYearSpan).toBe(4);
    expect(unlocked('Time Traveler')).toBe(true);
    expect(unlocked('Retro Signal')).toBe(true);
    expect(stats.releaseYearCount).toBe(2);
    expect(unlocked('Era Explorer 3')).toBe(false);
  });

  it('Retro Signal still needs a known release date', () => {
    const { unlocked } = evalAll([entry()]);
    expect(unlocked('Retro Signal')).toBe(false);
  });
});

describe('meta badges reach a fixed point', () => {
  it('5 non-meta unlocks plus The Void Gazes Back unlock Signal 10 and Hidden Signal 5', () => {
    // Synthetic list: meta badges declared BEFORE the plain ones they depend on.
    let id = 0;
    const mk = (name: string, condition: BadgeCondition, branch: BadgeDefinition['branch'] = 'voyager'): BadgeDefinition => ({
      id: ++id, name, description: '', lore: '', shape: 'shield', branch, tier: 'bronze', secret: false, condition,
    });
    const badges: BadgeDefinition[] = [
      mk('Signal 10', { type: 'totalBadgeCount', min: 10 }, 'legendary'),
      mk('Signal 8', { type: 'totalBadgeCount', min: 8 }, 'legendary'),
      mk('Hidden 7', { type: 'totalBadgeCount', min: 7 }, 'secret'),
      mk('Hidden 7b', { type: 'totalBadgeCount', min: 7 }, 'secret'),
      mk('Hidden 6', { type: 'totalBadgeCount', min: 6 }, 'secret'),
      mk('Bronze 9', { type: 'tierBadgeCount', tier: 'bronze', min: 9 }, 'legendary'),
      ...[1, 2, 3, 4, 5].map(n => mk(`Plain ${n}`, { type: 'gameCount', min: 1 })),
      mk('The Void Gazes Back', { type: 'gameCount', min: 0 }, 'secret'),
      mk('Never', { type: 'gameCount', min: 999 }),
    ];
    const stats = computeDerivedStats([entry()], [], [], [], { currentStreakDays: 0 });
    const result = evaluateBadges(stats, computeTasteDna(stats), { badges });
    const get = (n: string) => result.badges.find(r => r.badge.name === n)!;
    // 6 plain → Hidden 6 (7) → Hidden 7 + 7b (9) → Signal 8, Bronze 9 (11) → Signal 10 (12).
    expect(result.unlockedCount).toBe(12);
    expect(get('Signal 10').unlocked).toBe(true);
    expect(get('Signal 10').current).toBe(12);
    expect(get('Never').unlocked).toBe(false);
  });

  it('every totalBadgeCount badge with min <= final unlockedCount is unlocked (real list)', () => {
    const libs = [
      [entry({ hoursPlayed: 0 })],
      Array.from({ length: 40 }, (_, i) => entry({ status: i % 2 ? 'Completed' : 'Playing', hoursPlayed: i * 3, rating: (i % 5) + 1, genre: ['Action', 'RPG'], platform: ['Windows'], releaseDate: `${1990 + i}-01-01` })),
      Array.from({ length: 220 }, (_, i) => entry({ status: 'Completed', hoursPlayed: 60 + i, rating: 4, genre: [['Action', 'RPG', 'Indie', 'Strategy', 'Puzzle'][i % 5]], platform: ['Windows', 'Mac', 'Linux'], releaseDate: `${1980 + (i % 45)}-01-01` })),
    ];
    for (const entries of libs) {
      const { result } = evalAll(entries);
      const n = result.unlockedCount;
      expect(result.badges.filter(r => r.unlocked).length).toBe(n);
      for (const r of result.badges) {
        if (r.badge.condition.type === 'totalBadgeCount' && r.badge.condition.min <= n) {
          expect(r.unlocked, `${r.badge.name} (min ${r.badge.condition.min}, count ${n})`).toBe(true);
        }
      }
    }
  });
});

describe('latched volatile badges', () => {
  it('streak badges stay unlocked once stamped, even at streak 0', () => {
    const burning = byName('Burning Bright').id;
    const first = evalAll([entry()], { currentStreakDays: 7 });
    expect(first.unlocked('Burning Bright')).toBe(true);
    expect(first.unlocked('Undimmed Flame')).toBe(true);

    const stamped = new Set(first.result.badges.filter(r => r.unlocked).map(r => r.badge.id));
    const later = evalAll([entry()], { currentStreakDays: 0, isLatched: id => stamped.has(id) });
    expect(later.unlocked('Burning Bright')).toBe(true);
    expect(later.result.unlockedCount).toBe(first.result.unlockedCount);
    expect(later.result.totalPoints).toBe(first.result.totalPoints);
    // A never-stamped streak badge does not latch.
    const fresh = evalAll([entry()], { currentStreakDays: 0, isLatched: id => id === burning });
    expect(fresh.unlocked('Burning Bright')).toBe(true);
    expect(fresh.unlocked('Undimmed Flame')).toBe(false);
  });

  it('backlog badges latch; non-volatile badges never latch', () => {
    const backlog = Array.from({ length: 5 }, () => entry({ hoursPlayed: 0 }));
    const first = evalAll(backlog);
    expect(first.unlocked('The Backlog')).toBe(true);
    const all = () => true;
    const played = backlog.map(e => ({ ...e, hoursPlayed: 3 }));
    const later = evalAll(played, { isLatched: all });
    expect(later.unlocked('The Backlog')).toBe(true);
    // gameCount is not volatile: a stamp alone never unlocks it.
    expect(later.unlocked('Cleared for Launch')).toBe(true); // 5 games really
    expect(later.unlocked('Charting the Unknown')).toBe(false);
  });
});

describe('session streaks', () => {
  it('counts consecutive local days', () => {
    const sessions = [new Date(2025, 4, 1, 20), new Date(2025, 4, 2, 9), new Date(2025, 4, 3, 23)].map(session);
    expect(computeDerivedStats([], [], sessions, [], { currentStreakDays: 0 }).longestStreakDays).toBe(3);
  });
});

describe('Rapid Deployment', () => {
  it('needs three games added on the same local day', () => {
    const spread = [1, 2, 3].map(d => entry({ addedAt: new Date(2024, 2, d, 12).toISOString() }));
    expect(evalAll(spread).unlocked('Rapid Deployment')).toBe(false);
    const sameDay = [8, 12, 22].map(h => entry({ addedAt: new Date(2024, 2, 5, h).toISOString() }));
    const { stats, unlocked } = evalAll(sameDay);
    expect(stats.maxEntriesAddedInOneDay).toBe(3);
    expect(unlocked('Rapid Deployment')).toBe(true);
  });

  it('gamesPerYear counts per year, not all time', () => {
    const entries = [
      entry({ addedAt: new Date(2023, 1, 1).toISOString() }),
      entry({ addedAt: new Date(2023, 5, 1).toISOString() }),
      entry({ addedAt: new Date(2024, 1, 1).toISOString() }),
    ];
    const stats = computeDerivedStats(entries, [], [], [], { currentStreakDays: 0, now: new Date(2024, 6, 1) });
    const probe = (cond: BadgeCondition) => evaluateBadges(stats, computeTasteDna(stats), {
      badges: [{ id: 1, name: 'p', description: '', lore: '', shape: 'shield', branch: 'voyager', tier: 'bronze', secret: false, condition: cond }],
    }).badges[0];
    expect(probe({ type: 'gamesPerYear', year: 'any', min: 2 }).unlocked).toBe(true);
    expect(probe({ type: 'gamesPerYear', year: 'current', min: 2 }).unlocked).toBe(false);
    expect(probe({ type: 'gamesPerYear', year: 'current', min: 1 }).current).toBe(1);
  });
});

describe('Perfectly Average', () => {
  const rated = (n: number, r: number) => Array.from({ length: n }, () => entry({ rating: r }));

  it('needs 20 ratings averaging exactly 3.0', () => {
    expect(evalAll(rated(15, 3)).unlocked('Perfectly Average')).toBe(false);
    expect(evalAll(rated(20, 3)).unlocked('Perfectly Average')).toBe(true);
  });

  it('other average-rating badges still unlock at 10 ratings', () => {
    expect(evalAll(rated(10, 3)).unlocked('Fair and Balanced')).toBe(true);
    expect(evalAll(rated(9, 3)).unlocked('Fair and Balanced')).toBe(false);
    expect(evalAll(rated(10, 5)).unlocked('The Optimist')).toBe(true);
  });
});
