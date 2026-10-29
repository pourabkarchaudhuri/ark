/**
 * Golden ranking snapshot: the first 20 distinct games across shelves (shelf, game id, rounded score) on each archetype
 * fixture library. Any change to Oracle ranking shows up here as a snapshot diff, which must be
 * reviewed and intentionally updated (`vitest -u`) in the release that changes ranking.
 */
import { describe, it, expect } from 'vitest';
import { FIXTURE_NOW, backlogHeavyLibrary, candidatePool, multiTasteLibrary, newUserLibrary } from './fixtures';
import { baseWorkerInput, runWorkerPipeline } from './pipeline-harness';

async function top20(userGames: Parameters<typeof baseWorkerInput>[0]) {
  const result = await runWorkerPipeline(baseWorkerInput(userGames, candidatePool(120), FIXTURE_NOW));
  // First 20 distinct games across shelves in display order, tagged with their shelf.
  const seen = new Set<string>();
  const top: string[] = [];
  for (const shelf of result.shelves) {
    for (const g of shelf.games) {
      if (top.length >= 20) break;
      if (seen.has(g.gameId)) continue;
      seen.add(g.gameId);
      top.push(`${shelf.type} ${g.gameId} ${g.score.toFixed(3)}`);
    }
  }
  return { shelves: result.shelves.map(s => s.type), top };
}

describe('Oracle golden top-20', () => {
  it('multi-taste library', async () => {
    expect(await top20(multiTasteLibrary())).toMatchSnapshot();
  });
  it('backlog-heavy library', async () => {
    expect(await top20(backlogHeavyLibrary())).toMatchSnapshot();
  });
  it('new user', async () => {
    expect(await top20(newUserLibrary())).toMatchSnapshot();
  });
});
