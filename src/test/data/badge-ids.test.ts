/**
 * Badge id freeze (v1.0.97, ui-voyage#4).
 *
 * Badge ids are assigned by declaration order in src/data/badges.ts and the
 * stored "Obtained" timestamps are keyed by those ids. Inserting or removing a
 * b() call shifts every later id and silently re-attaches stored dates to the
 * wrong badges. The snapshot below records id -> (branch, name, occurrence)
 * for every badge, so any shift fails here. Edit badges in place or append;
 * never insert or remove.
 */
import { describe, it, expect } from 'vitest';
import { ALL_BADGES, BADGE_COUNT } from '@/data/badges';

describe('badge id freeze', () => {
  it('has exactly 1000 badges with ids 1..1000 in order', () => {
    expect(BADGE_COUNT).toBe(1000);
    ALL_BADGES.forEach((b, i) => expect(b.id).toBe(i + 1));
  });

  it('keeps the id -> (branch, name, occurrence) mapping stable', () => {
    const seen = new Map<string, number>();
    const mapping = ALL_BADGES.map(b => {
      const key = `${b.branch}|${b.name}`;
      const occurrence = (seen.get(key) ?? 0) + 1;
      seen.set(key, occurrence);
      return `${b.id}|${b.branch}|${b.name}|${occurrence}`;
    });
    expect(mapping).toMatchSnapshot();
  });
});
