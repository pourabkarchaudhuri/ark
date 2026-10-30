/**
 * v1.0.97 B34 — explanation fixes: a publisher-only loyalty match names the publisher (oracle#15), and the
 * score breakdown never lists the subtracted negative signal as a contributor (oracle#22).
 */
import { describe, it, expect } from 'vitest';
import { explanationHeadline, generateExplanation, normalizeLayerScores } from '@/services/reco-explainer';
import { buildTasteProfile, computeStudioLoyaltyBoost, matchedLoyalStudio } from '@/services/reco-scoring';
import { FIXTURE_NOW, makeCandidate, makeScored } from './fixtures';

const base = makeScored('x', 0);

describe('matchedLoyalStudio (oracle#15)', () => {
  it('matches developers first, then publishers, with the credited spelling', () => {
    expect(matchedLoyalStudio({ developer: 'Big Co, Loyal Studio', publisher: 'Devolver Digital' }, ['loyal studio'], ['devolver digital']))
      .toEqual({ role: 'developer', name: 'Loyal Studio' });
    expect(matchedLoyalStudio({ developer: 'Croteam', publisher: 'Devolver Digital' }, ['loyal studio'], ['devolver digital']))
      .toEqual({ role: 'publisher', name: 'Devolver Digital' });
    expect(matchedLoyalStudio({ developer: 'Croteam', publisher: 'Other' }, ['loyal studio'], ['devolver digital'])).toBeNull();
  });

  it('computeStudioLoyaltyBoost values are unchanged', () => {
    const profile = { ...buildTasteProfile([], FIXTURE_NOW), loyalPublishers: ['devolver digital'] };
    expect(computeStudioLoyaltyBoost(makeCandidate('a', { developer: 'Loyal Studio', publisher: 'Devolver Digital' }), ['loyal studio'], profile)).toBe(0.35);
    expect(computeStudioLoyaltyBoost(makeCandidate('b', { developer: 'Croteam', publisher: 'Devolver Digital' }), ['loyal studio'], profile)).toBe(0.25);
    expect(computeStudioLoyaltyBoost(makeCandidate('c', { developer: 'Croteam', publisher: 'Other' }), ['loyal studio'], profile)).toBe(0);
  });
});

describe('studio wording in the explainer (oracle#15)', () => {
  const game = (boost: number, over: Partial<ReturnType<typeof makeScored>['reasons']> = {}) => makeScored('steam-1', 0.5, {
    developer: 'Croteam',
    publisher: 'Devolver Digital',
    layerScores: { ...base.layerScores, studioLoyaltyBoost: boost },
    reasons: { ...base.reasons, ...over },
  });

  it('a recorded publisher match names the publisher', () => {
    const g = game(0.25, { loyalStudio: { role: 'publisher', name: 'Devolver Digital' } });
    expect(explanationHeadline(g)).toMatch(/published by Devolver Digital/);
    expect(explanationHeadline(g)).not.toMatch(/Croteam/);
    expect(generateExplanation(g)).toContain('Published by a label you trust (Devolver Digital)');
  });

  it('a developer match keeps the current wording', () => {
    const g = game(0.35, { loyalStudio: { role: 'developer', name: 'Croteam' } });
    expect(explanationHeadline(g)).toMatch(/Croteam is a studio you keep coming back to/);
    expect(generateExplanation(g)).toContain('From a studio you trust (Croteam)');
  });

  it('results cached without the role infer it from the boost', () => {
    expect(explanationHeadline(game(0.35))).toMatch(/Croteam is a studio/);
    expect(explanationHeadline(game(0.25))).toMatch(/published by Devolver Digital/);
  });
});

describe('score breakdown penalties (oracle#22)', () => {
  it('negativeSignal is not listed as a positive contributor and the rest total ~100', () => {
    const g = makeScored('steam-1', 0.4, {
      layerScores: { ...base.layerScores, contentSimilarity: 0.6, qualitySignal: 0.5, negativeSignal: 0.8 },
    });
    const weights = { contentSimilarity: 0.3, qualitySignal: 0.2, negativeSignal: 0.15 };
    const rows = normalizeLayerScores(g, weights);
    expect(rows.map(r => r.name)).not.toContain('Negative Signal');
    const total = rows.reduce((s, r) => s + r.percentage, 0);
    expect(total).toBeGreaterThanOrEqual(99);
    expect(total).toBeLessThanOrEqual(101);
    // Real contributors keep their true shares (0.18 : 0.10), not shrunk by the penalty.
    expect(rows.find(r => r.name === 'Genre & Theme Match')!.percentage).toBe(64);
  });
});
