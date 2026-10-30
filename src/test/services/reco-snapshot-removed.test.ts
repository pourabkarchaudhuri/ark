/**
 * v1.0.97 B16 — a game in the library (or a custom game) is owned for Oracle,
 * even when a stale journey row still says removedAt.
 */
import { describe, it, expect, vi } from 'vitest';

const removedAt = '2025-01-01T00:00:00.000Z';
const journeyRow = (gameId: string) => ({
  gameId, title: gameId, genre: [], platform: [], status: 'Playing',
  hoursPlayed: 20, rating: 0, addedAt: '2024-01-01T00:00:00.000Z', removedAt,
});

vi.mock('@/services/library-store', () => ({
  libraryStore: {
    getAllGameIds: () => ['steam-1'],
    getEntry: (id: string) => (id === 'steam-1'
      ? { gameId: 'steam-1', status: 'Playing', priority: 'Medium', hoursPlayed: 20, rating: 0, addedAt: new Date(), updatedAt: new Date() }
      : undefined),
    getAllEntries: () => [],
    subscribe: () => () => {},
  },
}));
vi.mock('@/services/custom-game-store', () => ({
  customGameStore: {
    getAllGames: () => [],
    getGame: (id: string) => (id === 'custom-1' ? { id: 'custom-1', title: 'Mine' } : undefined),
    subscribe: () => () => {},
  },
}));
vi.mock('@/services/journey-store', () => ({
  journeyStore: { getAllEntries: () => [journeyRow('steam-1'), journeyRow('custom-1'), journeyRow('steam-2')] },
}));
vi.mock('@/services/session-store', () => ({ sessionStore: { getAll: () => [] } }));
vi.mock('@/services/status-history-store', () => ({ statusHistoryStore: { getAll: () => [] } }));
vi.mock('@/services/reco-history-store', () => ({
  recoHistoryStore: { getDismissals: () => [], getThumbsUpIds: () => [], getThumbsDownIds: () => [] },
}));
vi.mock('@/services/catalog-store', () => ({ catalogStore: {} }));
vi.mock('@/services/epic-catalog-store', () => ({ epicCatalogStore: {} }));
vi.mock('@/services/ann-index', () => ({ annIndex: { isReady: false, vectorCount: 0 } }));
vi.mock('@/services/bm25-index', () => ({ bm25Index: { isReady: false, scheduleIdleRebuild: () => {} } }));
vi.mock('@/services/embedding-service', () => ({ embeddingService: { computeTasteCentroid: () => null } }));
vi.mock('@/services/game-graph-store', () => ({ gameGraphStore: { isReady: false } }));
vi.mock('@/services/similar-games', () => ({ getSimilarTitlesForRecoBatch: async () => new Map() }));

import { RecoStore } from '@/services/reco-store';
import type { UserGameSnapshot } from '@/types/reco';

describe('buildUserGameSnapshots removedAt', () => {
  it('drops a stale removedAt for owned games and keeps it for really removed ones', () => {
    const store = new RecoStore();
    const snaps = (store as unknown as { buildUserGameSnapshots(): UserGameSnapshot[] }).buildUserGameSnapshots();
    const byId = new Map(snaps.map((s) => [s.gameId, s]));
    expect(byId.get('steam-1')!.removedAt).toBeUndefined();
    expect(byId.get('custom-1')!.removedAt).toBeUndefined();
    expect(byId.get('steam-2')!.removedAt).toBe(removedAt);
  });
});
