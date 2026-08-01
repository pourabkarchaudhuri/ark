import { describe, it, expect } from 'vitest';
import {
  hoursPlayedBucket,
  fingerprintDismissals,
  fingerprintThumbsUp,
} from '@/services/oracle-signature';

describe('oracle library signature fragments', () => {
  it('hours bucket changes when floor(hours) changes', () => {
    expect(hoursPlayedBucket(10.7)).toBe(10);
    expect(hoursPlayedBucket(11.2)).toBe(11);
    expect(hoursPlayedBucket(10.7)).not.toBe(hoursPlayedBucket(11.2));
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
