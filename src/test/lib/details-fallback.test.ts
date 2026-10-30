/**
 * Game details fallback (1.0.97 B06): stored metadata (library snapshot, else journey entry)
 * fills in for an empty Steam answer, and only a temporary failure gets the retry state.
 */
import { describe, it, expect } from 'vitest';
import { storedGameMeta, isTransientDetailsFailure } from '@/lib/details-fallback';

describe('storedGameMeta', () => {
  it('prefers the library cachedMeta, then the journey entry', () => {
    const meta = storedGameMeta(
      { title: 'Hades', coverUrl: 'c.jpg', developer: 'Supergiant', genre: ['Roguelike'] },
      { title: 'Journey Hades', genre: [], platform: [] },
    );
    expect(meta).toMatchObject({ title: 'Hades', coverUrl: 'c.jpg', developer: 'Supergiant', genre: ['Roguelike'] });
    expect(storedGameMeta(undefined, { title: 'Celeste', coverUrl: 'j.jpg', genre: ['Platformer'], platform: ['PC'] }))
      .toMatchObject({ title: 'Celeste', coverUrl: 'j.jpg', genre: ['Platformer'], platform: ['PC'] });
  });

  it('is null when nothing stored has a title', () => {
    expect(storedGameMeta(undefined, undefined)).toBeNull();
    expect(storedGameMeta({ title: '' }, null)).toBeNull();
  });
});

describe('isTransientDetailsFailure', () => {
  it('rate_limited / error / offline are temporary; not_found online is not', () => {
    expect(isTransientDetailsFailure('rate_limited', true)).toBe(true);
    expect(isTransientDetailsFailure('error', true)).toBe(true);
    expect(isTransientDetailsFailure('not_found', false)).toBe(true);
    expect(isTransientDetailsFailure('not_found', true)).toBe(false);
  });
});
