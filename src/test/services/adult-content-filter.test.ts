import { describe, it, expect, beforeEach } from 'vitest';
import { isAdultContentByDescription } from '@/services/adult-content-filter';

function game(id: string, title: string, summary = '', longDescription = '') {
  return { id, title, summary, longDescription };
}

describe('adult-content-filter', () => {
  beforeEach(() => {
    try {
      localStorage.removeItem('ark-adult-classification-cache');
      localStorage.removeItem('ark-adult-classification-cache-version');
    } catch {
      /* ignore */
    }
  });

  it('classifies "Lusty Bubbles Animated Edition" as adult (title signal)', () => {
    expect(isAdultContentByDescription(game('steam-1', 'Lusty Bubbles Animated Edition'))).toBe(true);
  });

  it('classifies "Femboy Futa Mania" as adult (title signals)', () => {
    expect(isAdultContentByDescription(game('steam-2', 'Femboy Futa Mania'))).toBe(true);
  });

  it('classifies game with explicit phrase in description as adult', () => {
    expect(
      isAdultContentByDescription(
        game('steam-3', 'Detox My Heart', 'A dating sim with sexual content and romance.'),
      ),
    ).toBe(true);
  });

  it('does not classify mainstream title without explicit signals as adult', () => {
    expect(
      isAdultContentByDescription(
        game('steam-4', 'Black Myth: Wukong', 'Action RPG inspired by Journey to the West.'),
      ),
    ).toBe(false);
  });

  it('does not classify "assassin" as adult (word boundary)', () => {
    expect(
      isAdultContentByDescription(
        game('steam-5', 'Assassin Creed', 'An assassin in ancient Greece.'),
      ),
    ).toBe(false);
  });
});
