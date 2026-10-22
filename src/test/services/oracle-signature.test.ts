import { describe, it, expect } from 'vitest';
import {
  hoursPlayedBucket,
  fingerprintDismissals,
  fingerprintThumbsUp,
} from '@/services/oracle-signature';

describe('oracle library signature fragments', () => {
  it('hours bucket is log-scale: stable within a half-octave, changes across one', () => {
    expect(hoursPlayedBucket(0)).toBe(0);
    expect(hoursPlayedBucket(undefined)).toBe(0);
    expect(hoursPlayedBucket(0.5)).toBe(1);
    // Playing an extra hour on a 10h game no longer invalidates the cache…
    expect(hoursPlayedBucket(10.7)).toBe(hoursPlayedBucket(11.2));
    // …but a real engagement shift (≈ +41%) still does.
    expect(hoursPlayedBucket(10.7)).not.toBe(hoursPlayedBucket(16.5));
    expect(hoursPlayedBucket(1)).not.toBe(hoursPlayedBucket(0));
    // Monotonic non-decreasing
    let prev = -1;
    for (const h of [0, 0.2, 1, 1.5, 2, 3, 5, 8, 13, 40, 100, 1000]) {
      const b = hoursPlayedBucket(h);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
  });

  it('dismiss fingerprint changes when ids or meta change', () => {
    const a = fingerprintDismissals([
      { gameId: 'steam-1', at: 100, franchiseBase: 'halo', developer: '343' },
    ]);
    const b = fingerprintDismissals([
      { gameId: 'steam-1', at: 100, franchiseBase: 'halo', developer: '343' },
      { gameId: 'steam-2', at: 200, franchiseBase: 'doom', developer: 'id' },
    ]);
    const c = fingerprintDismissals([
      { gameId: 'steam-1', at: 999, franchiseBase: 'halo', developer: '343' },
    ]);
    expect(b).not.toBe(a);
    expect(c).not.toBe(a);
  });

  it('thumbs-up fingerprint changes when ups change', () => {
    expect(fingerprintThumbsUp(['a'])).not.toBe(fingerprintThumbsUp(['a', 'b']));
  });
});
