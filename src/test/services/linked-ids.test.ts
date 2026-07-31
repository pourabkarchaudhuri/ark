import { describe, it, expect } from 'vitest';
import {
  buildLinkedExclusionIds,
  expandDismissedWithLinked,
  isLinkedExcluded,
} from '@/services/linked-ids';

describe('linked-ids', () => {
  it('excludes library secondaryGameId twins', () => {
    const excl = buildLinkedExclusionIds([
      { gameId: 'steam-1', secondaryGameId: 'epic-ns:one' },
    ]);
    expect(excl.has('steam-1')).toBe(true);
    expect(excl.has('epic-ns:one')).toBe(true);
    expect(isLinkedExcluded('epic-ns:one', undefined, excl)).toBe(true);
    expect(isLinkedExcluded('steam-99', 'epic-ns:one', excl)).toBe(true);
  });

  it('expands dismiss with secondary twin', () => {
    const expanded = expandDismissedWithLinked(
      ['steam-1'],
      [{ gameId: 'steam-1', secondaryGameId: 'epic-ns:one' }],
    );
    expect(expanded).toContain('steam-1');
    expect(expanded).toContain('epic-ns:one');
  });
});
