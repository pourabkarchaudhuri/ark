/**
 * Ollama neighbor rerank — query text builder
 */

import { describe, it, expect } from 'vitest';
import { graphNodeToNeighborQueryText } from '@/services/ollama-rerank';
import type { GraphNode } from '@/services/galaxy-cache';

function minimalNode(over: Partial<GraphNode>): GraphNode {
  return {
    id: 'steam-1',
    title: 'Test Game',
    genres: [],
    themes: [],
    developer: '',
    publisher: '',
    isLibrary: false,
    hoursPlayed: 0,
    reviewCount: 0,
    luminance: 0.5,
    releaseYear: 2020,
    x: 0,
    y: 0,
    z: 0,
    colorIdx: 0,
    ...over,
  };
}

describe('graphNodeToNeighborQueryText', () => {
  it('includes title, genres, themes, developer, publisher', () => {
    const q = graphNodeToNeighborQueryText(
      minimalNode({
        title: 'Hades',
        genres: ['Action', 'Roguelike'],
        themes: ['Mythology'],
        developer: 'Supergiant Games',
        publisher: 'Supergiant Games',
      }),
    );
    expect(q).toContain('Hades');
    expect(q).toContain('Genres: Action, Roguelike');
    expect(q).toContain('Themes: Mythology');
    expect(q).toContain('Developer: Supergiant Games');
    expect(q).toContain('Publisher: Supergiant Games');
  });

  it('omits empty sections', () => {
    const q = graphNodeToNeighborQueryText(
      minimalNode({ title: 'Solo', genres: ['Indie'], themes: [], developer: '', publisher: '' }),
    );
    expect(q).toBe('Solo | Genres: Indie');
  });
});
