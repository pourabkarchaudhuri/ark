/**
 * Golden composition tests — the production text builders, pinned per source.
 *
 * These import the REAL builders (embedding-quality.test.ts / neighbor-quality.test.ts keep stale local copies of
 * them, so they never fail when production text changes). The expectations below are today's composition on
 * purpose: they document how Steam, Epic and the library differ, and any change to a builder fails here and has to
 * update the golden deliberately — together with a layout-version bump (embedding-layout.ts), otherwise cached
 * vectors built from the old text would be treated as current.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCatalogEmbeddingText,
  buildEmbeddingText,
  buildEpicCatalogEmbeddingText,
} from '@/services/embedding-service';
import { buildGameChunks } from '@/services/embedding-chunks';

const base = {
  title: 'Hades II: Night Edition',
  genres: ['Action', 'Indie', 'RPG'],
  themes: ['Mythology'],
  modes: ['Single-player'],
  developer: 'Supergiant Games',
};
const FACETS =
  'Hades II: Night Edition. gameplay: Action, RPG. type: Action, RPG. series: hades. modes: Single-player. setting: Mythology. by Supergiant Games. Hades II: Night Edition, Action';
const FACETS_LIB = FACETS.replace('modes:', 'perspective: Isometric. modes:');

const lib = {
  id: 'steam-1',
  ...base,
  playerPerspectives: ['Isometric'],
  publisher: 'Supergiant',
  summary: 'Escape the underworld again.',
  description: 'A long description of the game world.',
  userNotes: 'loved the combat',
  similarGames: [{ name: 'Dead Cells' }, { name: 'Hades' }],
};
const steam = {
  appid: 10, name: base.title, genres: base.genres, themes: base.themes, modes: base.modes,
  developer: base.developer, publisher: 'Supergiant', shortDescription: 'Escape the underworld again.',
} as never;
const epic = {
  epicId: 'ns:o', name: base.title, genres: base.genres, themes: base.themes, modes: base.modes,
  developer: base.developer, publisher: 'Supergiant',
  description: 'Escape the underworld again.', longDescription: 'A long description of the game world.',
} as never;

describe('whole-text builders (feed the pooled skip hash)', () => {
  it('library text: facets + perspective + summary + description + similar + notes', () => {
    expect(buildEmbeddingText(lib)).toBe(
      'Hades II: Night Edition. gameplay: Action, RPG. type: Action, RPG. series: hades. perspective: Isometric. modes: Single-player. setting: Mythology. by Supergiant Games. Escape the underworld again.. A long description of the game world.. similar to: Dead Cells, Hades. player notes: loved the combat. Hades II: Night Edition, Action',
    );
  });
  it('Steam text: facets + short description only (no perspective / long description)', () => {
    expect(buildCatalogEmbeddingText(steam)).toBe(
      'Hades II: Night Edition. gameplay: Action, RPG. type: Action, RPG. series: hades. modes: Single-player. setting: Mythology. by Supergiant Games. Escape the underworld again.. Hades II: Night Edition, Action',
    );
  });
  it('Epic text: facets + short AND long description', () => {
    expect(buildEpicCatalogEmbeddingText(epic)).toBe(
      'Hades II: Night Edition. gameplay: Action, RPG. type: Action, RPG. series: hades. modes: Single-player. setting: Mythology. by Supergiant Games. Escape the underworld again.. A long description of the game world.. Hades II: Night Edition, Action',
    );
  });
  it('noise genres (Indie) never reach any text', () => {
    for (const t of [buildEmbeddingText(lib), buildCatalogEmbeddingText(steam), buildEpicCatalogEmbeddingText(epic)]) {
      expect(t).not.toMatch(/indie/i);
    }
  });
});

describe('chunk builder (feeds the vectors)', () => {
  const spec = (tier: 'lib' | 'cat', id: string, input: Parameters<typeof buildGameChunks>[2]) =>
    buildGameChunks(tier, id, input).map(c => [c.chunkId, c.text, c.weight]);

  it('library: facets, notes, summary, description, similar', () => {
    expect(spec('lib', 'steam-1', {
      ...base, playerPerspectives: lib.playerPerspectives, summary: lib.summary,
      description: lib.description, userNotes: lib.userNotes, similarGames: lib.similarGames,
    })).toEqual([
      ['lib:steam-1::facets#0', FACETS_LIB, 1],
      ['lib:steam-1::notes#0', 'player notes: loved the combat', 0.85],
      ['lib:steam-1::summary#0', 'Escape the underworld again.', 0.55],
      ['lib:steam-1::description#0', 'A long description of the game world.', 0.35],
      ['lib:steam-1::similar#0', 'similar to: Dead Cells, Hades', 0.3],
    ]);
  });

  it('Steam: facets + summary only (two chunks, never a description chunk)', () => {
    expect(spec('cat', 'steam-10', { ...base, shortDescription: 'Escape the underworld again.', source: 'steam' })).toEqual([
      ['cat:steam-10::facets#0', FACETS, 1],
      ['cat:steam-10::summary#0', 'Escape the underworld again.', 0.55],
    ]);
  });

  it('Epic: facets + summary + description windows', () => {
    expect(spec('cat', 'epic-ns:o', {
      ...base, description: 'Escape the underworld again.', longDescription: 'A long description of the game world.', source: 'epic',
    })).toEqual([
      ['cat:epic-ns:o::facets#0', FACETS, 1],
      ['cat:epic-ns:o::summary#0', 'Escape the underworld again.', 0.55],
      ['cat:epic-ns:o::description#0', 'A long description of the game world.', 0.35],
    ]);
  });

  it('the source difference this release documents: Steam has fewer chunks than Epic', () => {
    const steamN = spec('cat', 's', { ...base, shortDescription: 'x', source: 'steam' }).length;
    const epicN = spec('cat', 'e', { ...base, description: 'x', longDescription: 'y', source: 'epic' }).length;
    expect(steamN).toBeLessThan(epicN);
  });
});
