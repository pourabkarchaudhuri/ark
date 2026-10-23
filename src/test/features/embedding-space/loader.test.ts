import { describe, it, expect } from 'vitest';
import { loaderMessage, loaderProgress } from '@/features/embedding-space/ui/GalaxyLoader';
import type { LoadingStep } from '@/features/embedding-space/ui/state';

const BASES = ['Loading all embedding vectors', 'Loading game metadata', 'Projecting to 3D (PCA)', 'Building galaxy map', 'Rendering galaxy'];
const steps = (spec: Array<[LoadingStep['status'], number?]>): LoadingStep[] =>
  spec.map(([status, fraction], i) => ({ label: BASES[i], base: BASES[i], status, fraction }));

describe('Embedding Space loader progress', () => {
  it('moves within the first stage instead of sitting at 0% until it completes', () => {
    const early = loaderProgress(steps([['running', 0.1], ['pending'], ['pending'], ['pending'], ['pending']]));
    const later = loaderProgress(steps([['running', 0.6], ['pending'], ['pending'], ['pending'], ['pending']]));
    expect(early).toBeGreaterThan(0);
    expect(later).toBeGreaterThan(early);
    expect(later).toBeLessThan(42); // vectors stage is ~42% of the whole
  });

  it('a running stage without measurable progress still shows motion', () => {
    expect(loaderProgress(steps([['running'], ['pending'], ['pending'], ['pending'], ['pending']]))).toBeGreaterThan(0);
  });

  it('is monotonic across stage completion and reaches 100 only when all done', () => {
    const a = loaderProgress(steps([['done'], ['running', 0.5], ['pending'], ['pending'], ['pending']]));
    const b = loaderProgress(steps([['done'], ['done'], ['done'], ['done'], ['running', 0.8]]));
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(100);
    expect(loaderProgress(steps([['done'], ['done'], ['done'], ['done'], ['done']]))).toBe(100);
  });

  it('speaks plainly, with a running count for the first stage', () => {
    const s = steps([['running', 0.3], ['pending'], ['pending'], ['pending'], ['pending']]);
    s[0].detail = '12,400';
    expect(loaderMessage(s)).toMatch(/12,400 so far/);
    expect(loaderMessage(s)).not.toMatch(/vector|embedding|PCA/i);
    expect(loaderMessage(steps([['waiting'], ['waiting'], ['waiting'], ['waiting'], ['pending']]))).toMatch(/still being analysed/);
  });
});
