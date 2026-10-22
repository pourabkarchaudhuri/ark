import { describe, it, expect, vi } from 'vitest';
import type { GraphNode } from '@/services/galaxy-cache';
import type { JourneyEntry } from '@/types/game';

// The neighbour module pulls in the embedding / ANN services; only the pure
// helpers are exercised here, so stub the I/O-heavy dependencies.
vi.mock('@/services/embedding-service', () => ({
  getEmbeddingById: vi.fn(),
  extractFranchiseBase: (t: string) => t.toLowerCase().replace(/\s+\d+$/, '').trim(),
}));
vi.mock('@/services/ann-index', () => ({ annIndex: { isReady: false } }));
vi.mock('@/services/ann-neighbor-query', () => ({
  queryAnnNeighborGames: vi.fn(), annNeighborOverFetch: vi.fn(), isChunkAnnMaxSimEnabled: vi.fn(),
}));
vi.mock('@/services/ollama-rerank', () => ({ applyOllamaNeighborRerank: vi.fn(), NEIGHBOR_HEURISTIC_POOL: 72 }));
vi.mock('@/services/oracle-rerank', () => ({ rerankTierLabel: (t: string) => t }));

import { buildPath, buildMockPath } from '@/features/embedding-space/data/path';
import { cosineDistance, fetchNeighbors, rerankNeighbors, spatialNeighbors } from '@/features/embedding-space/data/neighbors';

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id, title: id, genres: ['Action'], themes: [], developer: '', publisher: '', isLibrary: false,
    hoursPlayed: 0, reviewCount: 5000, luminance: 0.6, releaseYear: 2020, x: 0, y: 0, z: 0, colorIdx: 0, ...over,
  };
}

function journey(gameId: string, firstPlayedAt: string | undefined, hoursPlayed: number): JourneyEntry {
  return { gameId, title: gameId, genre: [], platform: [], status: 'Playing', hoursPlayed, rating: 0, firstPlayedAt, addedAt: '2024-01-01T00:00:00Z' };
}

describe('The Path builder', () => {
  const nodes = [node('a', { x: 1 }), node('b', { x: 2 }), node('c', { x: 3 }), node('d', { x: 4 })];
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  it('orders stops by first-played date and keeps only games with hours', () => {
    const pb = buildPath([
      journey('c', '2024-03-01T00:00:00Z', 5),
      journey('a', '2023-01-01T00:00:00Z', 12),
      journey('b', '2023-06-01T00:00:00Z', 0), // no hours → skipped
      journey('d', '2025-02-01T00:00:00Z', 30),
    ], nodeMap);
    expect(pb.disabledReason).toBeNull();
    expect(pb.stops.map(s => s.node.id)).toEqual(['a', 'c', 'd']);
    expect(pb.stops.map(s => s.playedYear)).toEqual([2023, 2024, 2025]);
    expect(pb.stops[2].hoursPlayed).toBe(30);
  });

  it('ignores games that are not in the galaxy and reports why it is disabled', () => {
    const none = buildPath([journey('x', '2023-01-01T00:00:00Z', 4), journey('y', '2023-02-01T00:00:00Z', 4)], nodeMap);
    expect(none.stops).toHaveLength(0);
    expect(none.disabledReason).toMatch(/aren't in the galaxy/);
    const tooFew = buildPath([journey('a', undefined, 4), journey('b', '2023-02-01T00:00:00Z', 4)], nodeMap);
    expect(tooFew.disabledReason).toMatch(/at least 2 games/);
  });

  it('excludes games removed from the library', () => {
    const removed = { ...journey('b', '2023-06-01T00:00:00Z', 8), removedAt: '2024-01-01T00:00:00Z' };
    const pb = buildPath([journey('a', '2023-01-01T00:00:00Z', 5), removed, journey('c', '2024-03-01T00:00:00Z', 5)], nodeMap);
    expect(pb.stops.map(s => s.node.id)).toEqual(['a', 'c']);
  });

  it('ignores unparseable dates', () => {
    const pb = buildPath([journey('a', 'not-a-date', 3), journey('b', '2023-02-01T00:00:00Z', 3)], nodeMap);
    expect(pb.stops).toHaveLength(0);
  });

  it('mock path orders library games by release year', () => {
    const mock = buildMockPath([
      node('m1', { isLibrary: true, hoursPlayed: 3, releaseYear: 2024 }),
      node('m2', { isLibrary: true, hoursPlayed: 9, releaseYear: 2021 }),
      node('m3', { isLibrary: false, hoursPlayed: 9, releaseYear: 2019 }),
    ]);
    expect(mock.stops.map(s => s.node.id)).toEqual(['m2', 'm1']);
  });
});

describe('Neighbour helpers', () => {
  it('spatial neighbours are nearest-first and honour exclusions', () => {
    const origin = node('o');
    const all = [origin, node('far', { x: 50 }), node('near', { x: 1 }), node('mid', { x: 10 }), node('skip', { x: 2 })];
    const nbs = spatialNeighbors(origin, all, 2, new Set(['skip']));
    expect(nbs.map(n => n.id)).toEqual(['near', 'mid']);
    expect(nbs[0].node?.id).toBe('near');
  });

  it('cosine distance is 0 for identical and 1 for orthogonal vectors', () => {
    expect(cosineDistance([1, 0, 0], [2, 0, 0])).toBeCloseTo(0);
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1);
    expect(cosineDistance([0, 0], [1, 1])).toBe(1);
  });

  it('heuristic rerank lifts franchise siblings and drops out-of-galaxy / distant candidates', () => {
    const sel = node('sel', { title: 'Star Saga 2', genres: ['RPG'] });
    const sibling = node('sib', { title: 'Star Saga 3', genres: ['RPG'] });
    const stranger = node('str', { title: 'Kart Party', genres: ['Racing'] });
    const nodeMap = new Map([sel, sibling, stranger].map(n => [n.id, n]));
    const out = rerankNeighbors(sel, [
      { id: 'str', distance: 0.20 },
      { id: 'sib', distance: 0.30 },
      { id: 'ghost', distance: 0.05 }, // not in the galaxy
      { id: 'far', distance: 1.8 },    // beyond MAX_DISTANCE
    ], nodeMap, 5);
    expect(out.map(n => n.id)).toEqual(['sib', 'str']);
  });

  it('falls back to spatial neighbours while the ANN index is unavailable', async () => {
    const origin = node('o');
    const all = [origin, node('n1', { x: 1 }), node('n2', { x: 2 })];
    const res = await fetchNeighbors(origin, {
      nodes: all, nodeMap: new Map(all.map(n => [n.id, n])), useMock: false,
      neighborRerankEnabled: true, isStale: () => false,
    }, 2);
    expect(res?.statusChip).toBe('ann_rebuilding');
    expect(res?.neighbors.map(n => n.id)).toEqual(['n1', 'n2']);
  });

  it('returns null when the request goes stale mid-flight', async () => {
    const origin = node('o');
    const res = await fetchNeighbors(origin, {
      nodes: [origin], nodeMap: new Map([[origin.id, origin]]), useMock: false,
      neighborRerankEnabled: true, isStale: () => true,
    });
    expect(res).toBeNull();
  });
});
