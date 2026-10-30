import { describe, it, expect } from 'vitest';
import { epicStoreUrl, parseSteamLanguages, isGameLive } from '@/lib/game-details-helpers';

describe('epicStoreUrl', () => {
  it('uses the product slug when present', () => {
    expect(epicStoreUrl('hades', 'Hades')).toBe('https://store.epicgames.com/en-US/p/hades');
  });

  it('falls back to a title search without a slug', () => {
    expect(epicStoreUrl(undefined, 'Death Stranding: Director’s Cut'))
      .toBe(`https://store.epicgames.com/en-US/browse?q=${encodeURIComponent('Death Stranding: Director’s Cut')}`);
  });

  it('never builds a /p/ link from a namespace-only item', () => {
    // Callers pass the slug field; a hex namespace is not a slug and must not be passed through.
    const url = epicStoreUrl(null, 'Some Game');
    expect(url).not.toContain('/p/');
    expect(url).toContain('browse?q=Some%20Game');
  });

  it('returns null with neither slug nor title', () => {
    expect(epicStoreUrl('', '')).toBeNull();
  });
});

describe('parseSteamLanguages', () => {
  it('parses the real Steam format and drops the audio footnote', () => {
    const html = 'English<strong>*</strong>, French<strong>*</strong>, German<strong>*</strong><br><strong>*</strong>languages with full audio support';
    expect(parseSteamLanguages(html)).toEqual([
      { name: 'English', fullAudio: true },
      { name: 'French', fullAudio: true },
      { name: 'German', fullAudio: true },
    ]);
  });

  it('parses a plain list', () => {
    expect(parseSteamLanguages('English, French')).toEqual([
      { name: 'English', fullAudio: false },
      { name: 'French', fullAudio: false },
    ]);
  });

  it('de-duplicates and drops empties', () => {
    expect(parseSteamLanguages('English, , English<strong>*</strong>').map(l => l.name)).toEqual(['English']);
    expect(parseSteamLanguages('')).toEqual([]);
  });
});

describe('isGameLive', () => {
  it('matches by own id', () => {
    expect(isGameLive({ id: 'steam-1' }, new Set(['steam-1']))).toBe(true);
  });

  it('matches an epic- entry through its steamAppId', () => {
    expect(isGameLive({ id: 'epic-ns:offer', steamAppId: 42 }, new Set(['steam-42']))).toBe(true);
  });

  it('matches an epic- entry with a steamAppId by its own id too', () => {
    expect(isGameLive({ id: 'epic-ns:offer', steamAppId: 42 }, new Set(['epic-ns:offer']))).toBe(true);
  });

  it('is false otherwise', () => {
    expect(isGameLive({ id: 'epic-ns:offer' }, new Set(['steam-42']))).toBe(false);
    expect(isGameLive({ id: 'steam-1' }, undefined)).toBe(false);
  });
});
