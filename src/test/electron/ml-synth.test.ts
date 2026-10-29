/**
 * Synthesised ML profiles (v1.0.95): catalog metadata → model features for games outside the bundled
 * Kaggle set, with strict minimums, validated IPC input, and lower weight in scoring.
 */
import { describe, it, expect } from 'vitest';
import { buildSyntheticProfile, buildTagIndex, normalizeTagName, parseSynthMeta, MIN_SYNTH_TAGS } from '../../../electron/ml-synth';
import { FIXTURE_NOW, candidatePool, multiTasteLibrary } from '../oracle/fixtures';
import { baseWorkerInput, runWorkerPipeline } from '../oracle/pipeline-harness';

const tagIndex = buildTagIndex(['indie', 'singleplayer', 'action', 'adventure', 'rpg', 'sci-fi', 'co-op']);

describe('buildSyntheticProfile', () => {
  it('maps store genres/themes to the model tag vocabulary and keeps g_* at defaults', () => {
    const p = buildSyntheticProfile({
      positivity: 0.91, reviews: 12000, priceUsd: 29.99, windows: true, mac: false, linux: true,
      tags: ['Action', 'Role-Playing', 'Science Fiction', 'Unknown Genre'],
    }, tagIndex)!;
    expect(p.positive_ratio).toBe(91);
    expect(p.user_reviews).toBe(12000);
    expect(p.price).toBe(29.99);
    expect([p.win, p.mac, p.linux]).toEqual([true, false, true]);
    expect(p.tags!.sort()).toEqual([2, 4, 5]);
    expect(p.g_rec_rate).toBeUndefined();
  });

  it(`refuses when there is no positive ratio or fewer than ${MIN_SYNTH_TAGS} recognised tags`, () => {
    expect(buildSyntheticProfile({ tags: ['Action', 'RPG'] }, tagIndex)).toBeNull();
    expect(buildSyntheticProfile({ positivity: 0.8, tags: ['Action'] }, tagIndex)).toBeNull();
    expect(buildSyntheticProfile({ positivity: 1.5, tags: ['Action', 'RPG'] }, tagIndex)).toBeNull();
  });

  it('free games price at 0', () => {
    expect(buildSyntheticProfile({ positivity: 0.7, isFree: true, priceUsd: 10, tags: ['Action', 'Indie'] }, tagIndex)!.price).toBe(0);
  });

  it('normalises aliases', () => {
    expect(normalizeTagName('  Single-Player ')).toBe('singleplayer');
    expect(normalizeTagName('Co-Operative')).toBe('co-op');
  });
});

describe('parseSynthMeta (IPC input)', () => {
  it('keeps only well-typed fields and caps sizes', () => {
    const out = parseSynthMeta({
      'epic-1': { positivity: 0.9, reviews: '12', tags: ['Action', 42, 'x'.repeat(99)], windows: 'yes' },
      [`x${'y'.repeat(100)}`]: { positivity: 1 },
    });
    expect(Object.keys(out)).toEqual(['epic-1']);
    expect(out['epic-1']).toMatchObject({ positivity: 0.9, reviews: undefined, tags: ['Action'], windows: undefined });
    expect(parseSynthMeta('nope')).toEqual({});
  });
});

describe('worker: synthesised ML scores carry less weight', () => {
  it('W_ML is lower when the same coverage comes from synthesised scores', async () => {
    const withScores = (synthetic: boolean) => candidatePool(60).map((c, i) => ({ ...c, mlScore: (i % 10) / 10, mlSynthetic: synthetic }));
    const real = await runWorkerPipeline(baseWorkerInput(multiTasteLibrary(), withScores(false), FIXTURE_NOW));
    const synth = await runWorkerPipeline(baseWorkerInput(multiTasteLibrary(), withScores(true), FIXTURE_NOW));
    const w = (r: typeof real) => r.telemetry!.layers.find(l => l.layer === 'mlSignal')!.weight;
    expect(w(synth)).toBeLessThan(w(real));
    expect(synth.telemetry!.mlCoverageSynth).toBe(1);
    expect(synth.telemetry!.mlCoverageReal).toBe(0);
  });
});
