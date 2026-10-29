/**
 * Deals For You: with gg.deals data, games at their all-time low qualify (even with a small store
 * discount) and come first.
 */
import { describe, it, expect } from 'vitest';
import { FIXTURE_NOW, candidatePool, multiTasteLibrary } from './fixtures';
import { baseWorkerInput, runWorkerPipeline } from './pipeline-harness';

describe('Deals For You shelf', () => {
  it('puts games at their all-time low first, then the biggest discounts', async () => {
    // Distinct titles: the shelf keeps one game per franchise, and "Candidate N" all share one.
    const name = (i: number) => String.fromCharCode(65 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)) + 'rion';
    const pool = candidatePool(80).map((c, i) => {
      const titled = { ...c, title: name(i), developer: `Studio ${i}` };
      if (i % 4 === 0) return { ...titled, price: { isFree: false, discountPercent: 50 } };
      if (i % 4 === 1) return { ...titled, price: { isFree: false, discountPercent: 5, atHistoricalLow: true } };
      return titled;
    });
    const result = await runWorkerPipeline(baseWorkerInput(multiTasteLibrary(), pool, FIXTURE_NOW));
    const shelf = result.shelves.find(s => s.type === 'deals-for-you');
    expect(shelf).toBeDefined();
    const flags = shelf!.games.map(g => !!g.price?.atHistoricalLow);
    expect(flags[0]).toBe(true);
    // Once the all-time lows run out, no later game is at its low (they are ordered first).
    const firstNotLow = flags.indexOf(false);
    if (firstNotLow >= 0) expect(flags.slice(firstNotLow).every(f => !f)).toBe(true);
    // A 5% discount alone would not qualify; at an all-time low it does.
    expect(shelf!.games.some(g => g.price?.discountPercent === 5)).toBe(true);
  });
});
