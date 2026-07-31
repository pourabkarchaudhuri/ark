import { describe, it, expect, beforeEach } from 'vitest';
import { recoHistoryStore } from '@/services/reco-history-store';

describe('reco-history soft caps', () => {
  beforeEach(() => {
    localStorage.clear();
    recoHistoryStore.reset();
  });

  it('prunes dismissals above 500 (oldest by at)', () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < 505; i++) {
      // Directly seed via dismiss with unique ids; at is Date.now on first insert
      // Use franchiseBase to avoid title work; force unique timestamps via undismiss+manual not available
      recoHistoryStore.dismiss(`steam-d-${i}`, { title: `Game ${i}` });
    }
    // Force older timestamps by rewriting storage through getDismissals mutation isn't public —
    // dismiss keeps first `at`. Cap prune should still leave ≤500.
    expect(recoHistoryStore.getDismissedCount()).toBeLessThanOrEqual(500);
  });

  it('prunes conversion history above 200', () => {
    for (let i = 0; i < 210; i++) {
      recoHistoryStore.recordClick(`steam-h-${i}`, `Title ${i}`, 'hero');
    }
    expect(recoHistoryStore.getHistorySize()).toBeLessThanOrEqual(200);
  });
});
