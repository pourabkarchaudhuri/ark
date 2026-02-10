/**
 * useDetailEnricher — small hook that wires the DetailEnricher singleton
 * to the game store so that visible catalog cards get their full metadata
 * fetched automatically.
 */

import { useEffect } from 'react';
import { Game } from '@/types/game';
import { detailEnricher } from '@/services/detail-enricher';

export function useDetailEnricher(
  enrichGames: (results: Map<string, Partial<Game>>) => void,
  allGamesRef: React.RefObject<Game[]>,
  enrichmentMapRef: React.RefObject<Map<string, Partial<Game>>>,
) {
  useEffect(() => {
    detailEnricher.configure({
      onEnriched: enrichGames,
      needsEnrichment: (gameId) => {
        // Already enriched via the ref map? Skip.
        if (enrichmentMapRef.current?.has(gameId)) return false;
        const games = allGamesRef.current;
        if (!games) return false;
        const game = games.find(g => g.id === gameId);
        // Lightweight catalog cards have developer === ''
        return !!game && !game.developer;
      },
    });
    return () => detailEnricher.reset();
  }, [enrichGames, allGamesRef, enrichmentMapRef]);
}
