/**
 * R8 feedback loop: bandit rewards, history store correctness, feedback strength, graph signature.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildNegativeProfile, DISMISS_NEGATIVE_WEIGHT, feedbackStrength } from '@/services/reco-scoring';
import { buildPositiveProfile } from '@/services/reco-feedback-profiles';
import { annGraphSignature } from '@/services/graph-signature';
import { FIXTURE_NOW, makeCandidate, makeUser } from '../oracle/fixtures';

async function freshBandit() {
  vi.resetModules();
  const mod = await import('@/services/shelf-bandit-store');
  return mod;
}
async function freshHistory() {
  vi.resetModules();
  const mod = await import('@/services/reco-history-store');
  return mod.recoHistoryStore;
}

describe('shelf bandit (R8)', () => {
  beforeEach(() => { localStorage.clear(); delete (window as unknown as { store?: unknown }).store; });
  afterEach(() => { vi.useRealTimers(); });

  it('impressions are idempotent per shelf instance', async () => {
    const { shelfBanditStore: b } = await freshBandit();
    b.recordImpression('hidden-gems', 'run1|hidden-gems');
    b.recordImpression('hidden-gems', 'run1|hidden-gems');
    b.recordImpression('hidden-gems', 'run1|hidden-gems');
    expect(b.snapshotArms()['hidden-gems'].beta).toBeCloseTo(2, 6); // prior 1 + exactly one failure
  });

  it('the first click turns its own impression into a success; further clicks add nothing', async () => {
    const { shelfBanditStore: b } = await freshBandit();
    b.recordImpression('trending-now', 'run1|t');
    b.recordClick('trending-now', 'run1|t');
    const a1 = b.snapshotArms()['trending-now'];
    expect(a1.alpha).toBeCloseTo(2, 6);
    expect(a1.beta).toBeCloseTo(1, 6);
    b.recordClick('trending-now', 'run1|t');
    b.recordClick('trending-now', 'run1|t');
    const a2 = b.snapshotArms()['trending-now'];
    expect(a2.alpha).toBeCloseTo(a1.alpha, 6);
    expect(a2.beta).toBeCloseTo(a1.beta, 6);
  });

  it('a click never steals failures recorded by other shelf instances', async () => {
    const { shelfBanditStore: b } = await freshBandit();
    b.recordImpression('deals-for-you', 'run1|d');
    b.recordImpression('deals-for-you', 'run2|d');
    b.recordImpression('deals-for-you', 'run3|d'); // beta = 4
    b.recordClick('deals-for-you', 'run2|d');       // only run2's own failure is reversed
    const a = b.snapshotArms()['deals-for-you'];
    expect(a.beta).toBeCloseTo(3, 6);
    expect(a.alpha).toBeCloseTo(2, 6);
  });

  it('legacy un-keyed clicks never push beta below its prior', async () => {
    const { shelfBanditStore: b } = await freshBandit();
    b.recordClick('free-for-you');
    expect(b.snapshotArms()['free-for-you'].beta).toBeGreaterThanOrEqual(1);
  });

  it('below-the-fold shelves count less as failures', async () => {
    const { shelfBanditStore: b, impressionWeight } = await freshBandit();
    expect(impressionWeight(0)).toBe(1);
    expect(impressionWeight(8)).toBeLessThan(impressionWeight(1));
    b.recordImpression('a', 'run|a', 0);
    b.recordImpression('b', 'run|b', 10);
    expect(b.snapshotArms()['b'].beta).toBeLessThan(b.snapshotArms()['a'].beta);
  });

  it('position weighting scales the whole observation: a click at the bottom is not worth more per impression', async () => {
    const { shelfBanditStore: b, impressionWeight } = await freshBandit();
    const w = impressionWeight(10);
    b.recordImpression('low', 'run|low', 10);
    b.recordClick('low', 'run|low');
    const a = b.snapshotArms()['low'];
    expect(a.alpha).toBeCloseTo(1 + w, 6);   // success scaled by the same weight as the failure it replaced
    expect(a.beta).toBeCloseTo(1, 6);
  });

  it('pre-hydrate READS (a render) do not overwrite persisted arms', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    (window as unknown as { store: unknown }).store = {
      getAll: async () => { await gate; return { rows: [{ key: 'hidden-gems', value: { alpha: 9, beta: 2, impressions: 5, clicks: 8 } }] }; },
      batch: async () => ({}),
      clearNamespace: async () => ({}),
    };
    const { shelfBanditStore: b } = await freshBandit();
    b.reorderShelves([
      { type: 'hero', title: 'h', games: [] }, { type: 'hidden-gems', title: 'g', games: [] },
      { type: 'trending-now', title: 't', games: [] }, { type: 'deals-for-you', title: 'd', games: [] },
    ] as never);
    release();
    await b.ready;
    expect(b.snapshotArms()['hidden-gems'].alpha).toBeGreaterThan(8); // persisted evidence kept, not reset to the prior
  });

  it('evidence decays toward the prior with a 30-day half-life', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { shelfBanditStore: b, BANDIT_HALF_LIFE_MS } = await freshBandit();
    for (let i = 0; i < 8; i++) b.recordImpression('critics-choice', `run${i}|c`);
    expect(b.snapshotArms()['critics-choice'].beta).toBeCloseTo(9, 6);
    vi.setSystemTime(new Date(Date.parse('2026-01-01T00:00:00Z') + BANDIT_HALF_LIFE_MS));
    expect(b.snapshotArms()['critics-choice'].beta).toBeCloseTo(1 + 8 / 2, 4);
  });

  it('writes made before the async LevelDB hydrate finishes survive it', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    (window as unknown as { store: unknown }).store = {
      getAll: async () => { await gate; return { rows: [{ key: 'old-shelf', value: { alpha: 5, beta: 2, impressions: 3, clicks: 4 } }] }; },
      batch: async () => ({}),
      clearNamespace: async () => ({}),
    };
    const { shelfBanditStore: b } = await freshBandit();
    b.recordImpression('hidden-gems', 'run1|h'); // before hydrate
    release();
    await b.ready;
    const arms = b.snapshotArms();
    expect(arms['old-shelf'].alpha).toBeCloseTo(5, 3);          // persisted row kept
    expect(arms['hidden-gems'].beta).toBeGreaterThan(1.5);       // pre-hydrate write kept
  });
});

describe('reco history store (R8)', () => {
  beforeEach(() => { localStorage.clear(); delete (window as unknown as { store?: unknown }).store; });
  afterEach(() => { vi.useRealTimers(); });

  it('undoing a dismissal also clears a thumbs-down', async () => {
    const h = await freshHistory();
    h.recordThumbs('steam-1', -1, 'Bad Game');
    expect(h.getThumbsDownIds()).toContain('steam-1');
    expect(h.isDismissed('steam-1')).toBe(true);
    h.undismiss('steam-1');
    expect(h.isDismissed('steam-1')).toBe(false);
    expect(h.getThumbsDownIds()).not.toContain('steam-1');
    expect(h.getThumbs('steam-1')).toBeUndefined();
  });

  it('thumbs-down marks a strong dismissal; a plain dismiss does not', async () => {
    const h = await freshHistory();
    h.recordThumbs('steam-1', -1, 'Bad Game');
    h.dismiss('steam-2', { title: 'Meh Game' });
    const byId = new Map(h.getDismissals().map(d => [d.gameId, d]));
    expect(byId.get('steam-1')?.strong).toBe(true);
    expect(byId.get('steam-2')?.strong).toBeUndefined();
    // A later plain dismiss of the same game must not downgrade it.
    h.dismiss('steam-1', { title: 'Bad Game' });
    expect(h.getDismissals().find(d => d.gameId === 'steam-1')?.strong).toBe(true);
  });

  it('legacy dismissals backed by a thumbs-down row are treated as strong', async () => {
    localStorage.setItem('ark-reco-dismissed-v1', JSON.stringify([{ gameId: 'steam-9', at: 123, title: 'Old Dislike' }]));
    localStorage.setItem('ark-reco-history-v1', JSON.stringify([{ gameId: 'steam-9', title: 'Old Dislike', shelfType: '', clickedAt: 1, converted: false, thumbs: -1 }]));
    const h = await freshHistory();
    expect(h.getDismissals().find(d => d.gameId === 'steam-9')?.strong).toBe(true);
  });

  it('thumbs feedback survives a flood of plain clicks (not evicted by the 200 cap)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const h = await freshHistory();
    h.recordThumbs('steam-keep', 1, 'Loved');
    for (let i = 0; i < 260; i++) {
      vi.setSystemTime(new Date(Date.parse('2026-01-01T00:00:00Z') + (i + 1) * 1000));
      h.recordClick(`steam-${i}`, `Game ${i}`, 'trending-now');
    }
    expect(h.getThumbs('steam-keep')).toBe(1);
    expect(h.getHistorySize()).toBeLessThanOrEqual(201); // 200 plain rows + the thumbs row
  });

  it('writes made before the async LevelDB hydrate finishes survive it', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    (window as unknown as { store: unknown }).store = {
      getAll: async () => {
        await gate;
        return { rows: [{ key: 'd:steam-old', value: { gameId: 'steam-old', at: 5 } }] };
      },
      batch: async () => ({}),
      clearNamespace: async () => ({}),
    };
    const h = await freshHistory();
    h.dismiss('steam-new', { title: 'New' }); // before hydrate
    release();
    await h.ready;
    expect(h.isDismissed('steam-old')).toBe(true);
    expect(h.isDismissed('steam-new')).toBe(true);
  });
});

describe('feedback strength (R8)', () => {
  it('feedbackStrength depends on how much explicit feedback exists, not on library size', () => {
    expect(feedbackStrength(0)).toBe(0);
    expect(feedbackStrength(1)).toBeCloseTo(0.25, 6);
    expect(feedbackStrength(5)).toBeCloseTo(0.45, 6);
    expect(feedbackStrength(100)).toBe(0.6);
  });

  it('one thumbs-down in a 300-game library has a real effect (it was 0.003)', () => {
    const lib = Array.from({ length: 300 }, (_, i) => makeUser(`steam-${i}`));
    const neg = buildNegativeProfile(lib, FIXTURE_NOW, [makeCandidate('steam-x', { genres: ['Shooter'] })]);
    expect(neg.strength).toBeGreaterThanOrEqual(0.25);
    const pos = buildPositiveProfile(lib, [makeCandidate('steam-y', { genres: ['RPG'] })]);
    expect(pos.strength).toBeGreaterThanOrEqual(0.25);
  });

  it('dismissed cards feed the negative profile, decaying with age and weaker than a thumbs-down', () => {
    const lib = [makeUser('steam-1')];
    const day = 86_400_000;
    const cand = makeCandidate('steam-d', { genres: ['Shooter'], themes: ['Multiplayer'] });
    const fresh = buildNegativeProfile(lib, FIXTURE_NOW, [], [{ candidate: cand, at: FIXTURE_NOW - day }]);
    const old = buildNegativeProfile(lib, FIXTURE_NOW, [], [{ candidate: cand, at: FIXTURE_NOW - 400 * day }]);
    expect(fresh.vec.size).toBeGreaterThan(0);
    expect(Math.max(...fresh.vec.values())).toBeLessThan(1); // weaker than a full-weight signal
    expect(fresh.strength).toBeGreaterThan(0);
    expect(old.strength).toBe(0); // faded below the floor
    expect(DISMISS_NEGATIVE_WEIGHT).toBeLessThan(1.5); // thumbs-down weight
  });
});

describe('graph signature (R8)', () => {
  it('includes the embedding layout versions, not just the vector count', () => {
    const sig = annGraphSignature(1234);
    expect(sig.startsWith('ann-1234-')).toBe(true);
    expect(sig).toMatch(/-c\d+-p\d+$/);
    expect(annGraphSignature(1234)).not.toBe(annGraphSignature(1235));
  });
});
