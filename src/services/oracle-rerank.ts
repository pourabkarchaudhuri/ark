/**
 * Ollama /api/rerank pass for Oracle shelves — refines ordering after the reco worker.
 */

import type { TasteProfile, RecoShelf, ScoredGame } from '@/types/reco';

const ORACLE_RERANK_POOL = 200;

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

/**
 * Keyword-focused taste query for BM25 / MiniSearch retrieval.
 * Prefer concrete tokens (genres, themes, studios, loved titles) over prose.
 */
export function buildLexicalTasteQuery(
  profile: TasteProfile,
  opts?: { lovedTitles?: string[] },
): string {
  const genres = profile.genres
    .filter((x) => x.weight > 0)
    .slice(0, 10)
    .map((x) => x.name);
  if (profile.topGenre && !genres.includes(profile.topGenre)) {
    genres.unshift(profile.topGenre);
  }

  const themes = profile.themes
    .filter((x) => x.weight > 0)
    .slice(0, 8)
    .map((x) => x.name);
  if (profile.topTheme && !themes.includes(profile.topTheme)) {
    themes.unshift(profile.topTheme);
  }

  const studios = [
    ...(profile.loyalDevelopers ?? []).slice(0, 6),
    ...(profile.loyalPublishers ?? []).slice(0, 3),
  ];

  const loved = (opts?.lovedTitles ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);

  return [...genres, ...themes, ...studios, ...loved]
    .filter(Boolean)
    .join(' ')
    .trim();
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
  // Synthetic rank denominator covers reranked range AND fallback tail for unranked games.
  const denomR = Math.max(1, maxRankOrdinal + games.length);
  return [...games].sort((a, b) => {
    const oa = origOrder.get(a.gameId) ?? 0;
    const ob = origOrder.get(b.gameId) ?? 0;
    // Fallback for games not in rerank pool: slot AFTER reranked games, preserving worker order.
    // This avoids the historical rank=1_000_000 cliff that flung unreranked games to the bottom.
    const ra = (rank.get(a.gameId) ?? maxRankOrdinal + 1 + oa) / denomR;
    const rb = (rank.get(b.gameId) ?? maxRankOrdinal + 1 + ob) / denomR;
    const ca = blend * ra + (1 - blend) * (oa / denomO);
    const cb = blend * rb + (1 - blend) * (ob / denomO);
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

  // Round-robin pool building: ensures every shelf is represented in the rerank pool
  // even when earlier shelves are long. Prevents late shelves from being entirely cut.
  const seen = new Set<string>();
  const pool: ScoredGame[] = [];
  const cursors = shelves.map(() => 0);
  let progressed = true;
  while (pool.length < ORACLE_RERANK_POOL && progressed) {
    progressed = false;
    for (let i = 0; i < shelves.length; i++) {
      const games = shelves[i].games;
      while (cursors[i] < games.length) {
        const g = games[cursors[i]++];
        if (seen.has(g.gameId)) continue;
        seen.add(g.gameId);
        pool.push(g);
        progressed = true;
        break;
      }
      if (pool.length >= ORACLE_RERANK_POOL) break;
    }
  }
  if (pool.length === 0) return { shelves, status: 'skipped_empty_pool' };

  const query = buildTasteQueryText(profile);
  const documents = pool.map(scoredGameToRerankDoc);
  try {
    const res = await window.ollama.rerank({ query, documents, topN: pool.length });
    // Structured IPC: { results, via } success (incl. embed_fallback) or { error }.
    if (!res || 'error' in res || !('results' in res) || !res.results?.length) {
      if (res && 'error' in res) {
        return {
          shelves,
          status: res.error.code === 'empty_results' ? 'empty_results' : 'error',
        };
      }
      return { shelves, status: 'empty_results' };
    }

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
    // embed_fallback is treated as success (no failure badge).
    return { shelves: out, status: 'applied' };
  } catch {
    return { shelves, status: 'error' };
  }
}
