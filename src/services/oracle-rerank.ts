/**
 * Ollama /api/rerank pass for Oracle shelves — refines ordering after the reco worker.
 */

import type { TasteProfile, RecoShelf, ScoredGame } from '@/types/reco';

const ORACLE_RERANK_POOL = 80;

export type OracleRerankStatus =
  | 'none'
  | 'applied'
  | 'skipped_disabled'
  | 'skipped_no_client'
  | 'skipped_blend_zero'
  | 'skipped_empty_pool'
  | 'empty_results'
  | 'error';

export function buildTasteQueryText(profile: TasteProfile): string {
  const gTop = profile.genres
    .slice(0, 12)
    .filter((x) => x.weight > 0)
    .map((x) => x.name)
    .join(', ');
  const tTop = profile.themes
    .slice(0, 10)
    .filter((x) => x.weight > 0)
    .map((x) => x.name)
    .join(', ');
  const modes = profile.gameModes.slice(0, 8).map((x) => x.name).join(', ');
  const parts = [
    'Recommend games for this player.',
    profile.topGenre ? `Top genre: ${profile.topGenre}.` : '',
    profile.topTheme ? `Top theme: ${profile.topTheme}.` : '',
    gTop ? `Genre affinities: ${gTop}.` : '',
    tTop ? `Theme affinities: ${tTop}.` : '',
    modes ? `Modes: ${modes}.` : '',
    profile.loyalDevelopers?.length
      ? `Likes developers: ${profile.loyalDevelopers.slice(0, 6).join(', ')}.`
      : '',
  ];
  return parts.filter(Boolean).join(' ');
}

export function scoredGameToRerankDoc(g: ScoredGame): string {
  return [
    g.title,
    g.genres?.length ? `Genres: ${g.genres.join(', ')}` : '',
    g.themes?.length ? `Themes: ${g.themes.join(', ')}` : '',
    g.developer ? `Developer: ${g.developer}` : '',
    g.publisher ? `Publisher: ${g.publisher}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

function sortShelfWithBlend(
  games: ScoredGame[],
  rank: Map<string, number>,
  blend: number,
  maxRankOrdinal: number,
): ScoredGame[] {
  if (games.length <= 1) return [...games];
  const origOrder = new Map(games.map((g, i) => [g.gameId, i]));
  const denomO = Math.max(1, games.length - 1);
  const denomR = Math.max(1, maxRankOrdinal);
  return [...games].sort((a, b) => {
    const ra = (rank.get(a.gameId) ?? 1_000_000) / denomR;
    const rb = (rank.get(b.gameId) ?? 1_000_000) / denomR;
    const oa = (origOrder.get(a.gameId) ?? 0) / denomO;
    const ob = (origOrder.get(b.gameId) ?? 0) / denomO;
    const ca = blend * ra + (1 - blend) * oa;
    const cb = blend * rb + (1 - blend) * ob;
    return ca - cb;
  });
}

export type OracleRerankOptions = {
  /** When false, skip rerank entirely (default true). */
  enabled?: boolean;
  /** 0 = worker order within shelves, 1 = pure rerank order (default 1). */
  blend?: number;
};

/**
 * Rerank up to 80 unique games (shelf order) with the taste query, then reorder games within each shelf.
 */
export async function applyOracleRerankShelves(
  profile: TasteProfile,
  shelves: RecoShelf[],
  opts?: OracleRerankOptions,
): Promise<{ shelves: RecoShelf[]; status: OracleRerankStatus }> {
  if (!shelves.length) return { shelves, status: 'none' };

  const enabled = opts?.enabled !== false;
  if (!enabled) return { shelves, status: 'skipped_disabled' };

  const blend =
    typeof opts?.blend === 'number' && Number.isFinite(opts.blend)
      ? Math.min(1, Math.max(0, opts.blend))
      : 1;
  if (blend <= 0) return { shelves, status: 'skipped_blend_zero' };

  if (typeof window === 'undefined' || !window.ollama?.rerank) {
    return { shelves, status: 'skipped_no_client' };
  }

  const seen = new Set<string>();
  const pool: ScoredGame[] = [];
  for (const sh of shelves) {
    for (const g of sh.games) {
      if (seen.has(g.gameId)) continue;
      seen.add(g.gameId);
      pool.push(g);
      if (pool.length >= ORACLE_RERANK_POOL) break;
    }
    if (pool.length >= ORACLE_RERANK_POOL) break;
  }
  if (pool.length === 0) return { shelves, status: 'skipped_empty_pool' };

  const query = buildTasteQueryText(profile);
  const documents = pool.map(scoredGameToRerankDoc);
  try {
    const res = await window.ollama.rerank({ query, documents, topN: pool.length });
    if (!res?.results?.length) return { shelves, status: 'empty_results' };

    const rank = new Map<string, number>();
    res.results.forEach((r, ord) => {
      const g = pool[r.index];
      if (g && !rank.has(g.gameId)) rank.set(g.gameId, ord);
    });

    const maxRankOrdinal = Math.max(...rank.values(), 0);

    const out = shelves.map((sh) => ({
      ...sh,
      games: sortShelfWithBlend(sh.games, rank, blend, maxRankOrdinal),
    }));
    return { shelves: out, status: 'applied' };
  } catch {
    return { shelves, status: 'error' };
  }
}
