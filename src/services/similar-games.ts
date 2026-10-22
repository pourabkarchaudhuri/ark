/**
 * Ark / embedding-space nearest neighbors for game details (cross-store gameId).
 */

import { buildGameImageChain } from '@/lib/utils';
import type { Game } from '@/types/game';
import type { EpicCatalogItem } from '@/types/epic';
import type { SteamAppDetails } from '@/types/steam';
import { getSteamCoverUrl } from '@/types/steam';
import { annIndex } from '@/services/ann-index';
import { getEmbeddingById } from '@/services/embedding-service';
import {
  queryAnnNeighborGames,
  annNeighborOverFetch,
  isChunkAnnMaxSimEnabled,
} from '@/services/ann-neighbor-query';
import { aggregateMaxSimByGameId, parseAnnIdToGameId } from '@/services/ann-max-sim';
import { findGameById } from '@/services/prefetch-store';
import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';
import { transformEpicGame } from '@/services/epic-service';

/** Cap on store-detail enrichment for neighbor rows (Steam rate limiter is shared). */
const NEIGHBOR_DETAILS_TIMEOUT_MS = 5_000;

/** Resolve `fallback` if `p` hasn't settled within `ms`; a late result is dropped. */
function raceWithTimeout<T>(p: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      console.warn(`[similar-games] ${label} exceeded ${ms}ms — rendering with local metadata`);
      resolve(fallback);
    }, ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export type SimilarGamesSectionPhase =
  | 'hidden'
  | 'index_building'
  | 'index_loading'
  | 'fetching'
  | 'no_embedding'
  | 'ready';

export interface SimilarGameCard {
  gameId: string;
  title: string;
  /** Cosine distance from ANN (lower = closer in embedding space). */
  distance: number;
  imageChain: string[];
  /** Up to 2 genre strings for small badges. */
  genreTags: string[];
}

export type SimilarGamesFetchStatus = 'ok' | 'ann_unavailable' | 'no_embedding' | 'empty';

export interface SimilarGamesResult {
  status: SimilarGamesFetchStatus;
  items: SimilarGameCard[];
}

export interface SimilarGamesForDetailsOptions {
  /** Page title (Steam `details.name` / Epic title) — improves same-game detection when prefetch link is missing. */
  sourceDisplayTitle?: string;
}

function normalizeTitleForSimilarDedup(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[™®©]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** All universal ids that represent the same product as `gameId` (cross-store dedup). */
function getLinkedStoreIds(gameId: string): Set<string> {
  const out = new Set<string>();
  out.add(gameId);

  const g = findGameById(gameId);
  if (g) {
    out.add(g.id);
    if (g.secondaryId) out.add(g.secondaryId);
  }

  const lib = libraryStore.getEntry(gameId);
  if (lib?.secondaryGameId) {
    out.add(lib.gameId);
    out.add(lib.secondaryGameId);
  }

  if (g?.secondaryId) {
    const twin = findGameById(g.secondaryId);
    if (twin) {
      out.add(twin.id);
      if (twin.secondaryId) out.add(twin.secondaryId);
    }
  }

  return out;
}

/**
 * Drop alternate-store twins of the source, same title as source, and duplicate titles among neighbors (keep closest by distance).
 */
function dedupeSimilarNeighbors(
  sourceGameId: string,
  sourceTitleHint: string | undefined,
  enriched: SimilarGameCard[],
  k: number,
): SimilarGameCard[] {
  const linked = getLinkedStoreIds(sourceGameId);
  const sourceMetaTitle = resolveNeighborMeta(sourceGameId).title;
  const sourceLabel = (sourceTitleHint?.trim() || sourceMetaTitle).trim();
  const sourceNorm =
    sourceLabel.length >= 2 && !isAppPlaceholderTitle(sourceLabel)
      ? normalizeTitleForSimilarDedup(sourceLabel)
      : '';

  const sorted = [...enriched].sort((a, b) => a.distance - b.distance);
  const seenTitleNorms = new Set<string>();
  const out: SimilarGameCard[] = [];

  for (const card of sorted) {
    if (linked.has(card.gameId)) continue;

    const tn = normalizeTitleForSimilarDedup(card.title);
    if (sourceNorm.length >= 2 && tn === sourceNorm) continue;
    if (tn.length >= 3 && seenTitleNorms.has(tn)) continue;
    if (tn.length >= 3) seenTitleNorms.add(tn);

    out.push(card);
    if (out.length >= k) break;
  }

  return out;
}

function fallbackTitleFromGameId(id: string): string {
  const steam = id.match(/^steam-(\d+)$/);
  if (steam) return `App ${steam[1]}`;
  const epic = id.match(/^epic-[^:]+:(.+)$/);
  if (epic) return epic[1].replace(/[-_]/g, ' ');
  return id;
}

function isAppPlaceholderTitle(title: string): boolean {
  return /^App \d+$/.test(title.trim());
}

function parseEpicGameId(id: string): { ns: string; offerId: string } | null {
  if (!id.startsWith('epic-')) return null;
  const rest = id.slice('epic-'.length);
  const c = rest.indexOf(':');
  if (c < 0) return null;
  return { ns: rest.slice(0, c), offerId: rest.slice(c + 1) };
}

function resolveNeighborMeta(gameId: string): { title: string; imageChain: string[]; genreTags: string[] } {
  const prefetched: Game | null = findGameById(gameId);
  if (prefetched) {
    const genres = prefetched.genre.filter(Boolean).slice(0, 2);
    return {
      title: prefetched.title,
      imageChain: buildGameImageChain(
        prefetched.id,
        prefetched.title,
        prefetched.coverUrl,
        prefetched.headerImage,
        prefetched.screenshots?.filter(Boolean),
      ),
      genreTags: genres,
    };
  }

  const lib = libraryStore.getEntry(gameId);
  const m = lib?.cachedMeta;
  if (m?.title) {
    const genres = (m.genre ?? []).filter(Boolean).slice(0, 2);
    return {
      title: m.title,
      imageChain: buildGameImageChain(
        gameId,
        m.title,
        m.coverUrl,
        m.headerImage,
        undefined,
      ),
      genreTags: genres,
    };
  }

  const custom = customGameStore.getGame(gameId);
  if (custom) {
    return {
      title: custom.title,
      imageChain: buildGameImageChain(gameId, custom.title, undefined, undefined),
      genreTags: [],
    };
  }

  const t = fallbackTitleFromGameId(gameId);
  return {
    title: t,
    imageChain: buildGameImageChain(gameId, t, undefined, undefined),
    genreTags: [],
  };
}

function metaFromSteamDetails(gameId: string, det: SteamAppDetails): { title: string; imageChain: string[]; genreTags: string[] } {
  const genres = (det.genres ?? []).map((g) => g.description).filter(Boolean).slice(0, 2);
  const shots = det.screenshots?.map((s) => s.path_full).filter(Boolean) ?? [];
  return {
    title: det.name,
    imageChain: buildGameImageChain(
      gameId,
      det.name,
      getSteamCoverUrl(det.steam_appid),
      det.header_image || undefined,
      shots.length ? shots : undefined,
    ),
    genreTags: genres,
  };
}

/** Display ANN cosine distance (usearch Cos metric). */
export function formatNeighborDistance(distance: number): string {
  if (!Number.isFinite(distance)) return '—';
  const abs = Math.abs(distance);
  if (abs >= 1000 || (abs > 0 && abs < 1e-4)) return distance.toExponential(2);
  const s = distance.toFixed(4);
  return s.replace(/\.?0+$/, '') || '0';
}

async function enrichNeighborRows(
  rows: Array<{ gameId: string; distance: number }>,
): Promise<SimilarGameCard[]> {
  type Row = {
    gameId: string;
    distance: number;
    title: string;
    imageChain: string[];
    genreTags: string[];
  };

  const base: Row[] = rows.map((r) => {
    const meta = resolveNeighborMeta(r.gameId);
    return {
      gameId: r.gameId,
      distance: r.distance,
      title: meta.title,
      imageChain: meta.imageChain,
      genreTags: meta.genreTags,
    };
  });

  const steamAppIds = [
    ...new Set(
      base
        .map((b) => {
          const m = b.gameId.match(/^steam-(\d+)$/);
          return m ? Number(m[1]) : null;
        })
        .filter((x): x is number => x != null),
    ),
  ];

  const steamDetailsByApp = new Map<number, SteamAppDetails>();
  if (steamAppIds.length > 0 && typeof window !== 'undefined' && window.steam?.getMultipleAppDetails) {
    try {
      // Shares the Steam rate limiter with Oracle hydrate / library sync — cap
      // the wait; local meta + cached names below fill in what didn't arrive.
      const arr = await raceWithTimeout(
        window.steam.getMultipleAppDetails(steamAppIds),
        NEIGHBOR_DETAILS_TIMEOUT_MS,
        [],
        'getMultipleAppDetails',
      );
      for (const { appId, details } of arr) {
        if (details) steamDetailsByApp.set(appId, details as SteamAppDetails);
      }
    } catch (e) {
      console.warn('[similar-games] getMultipleAppDetails:', e);
    }
  }

  for (const b of base) {
    const m = b.gameId.match(/^steam-(\d+)$/);
    if (!m) continue;
    const aid = Number(m[1]);
    const det = steamDetailsByApp.get(aid);
    if (det) {
      const merged = metaFromSteamDetails(b.gameId, det);
      b.title = merged.title;
      b.imageChain = merged.imageChain;
      b.genreTags = merged.genreTags;
    }
  }

  const stillPlaceholderSteamIds = [
    ...new Set(
      base
        .filter((b) => /^steam-\d+$/.test(b.gameId) && isAppPlaceholderTitle(b.title))
        .map((b) => Number(b.gameId.replace('steam-', ''))),
    ),
  ];
  if (stillPlaceholderSteamIds.length > 0 && typeof window !== 'undefined' && window.steam?.getCachedGameNames) {
    try {
      const nameMap = await window.steam.getCachedGameNames(stillPlaceholderSteamIds);
      for (const b of base) {
        const m = b.gameId.match(/^steam-(\d+)$/);
        if (!m || !isAppPlaceholderTitle(b.title)) continue;
        const aid = Number(m[1]);
        const n = nameMap[aid]?.trim();
        if (n) {
          b.title = n;
          b.imageChain = buildGameImageChain(b.gameId, n, getSteamCoverUrl(aid), undefined, undefined);
        }
      }
    } catch {
      /* ignore */
    }
  }

  const epicKeys = new Map<string, { ns: string; offerId: string }>();
  for (const b of base) {
    const p = parseEpicGameId(b.gameId);
    if (p) epicKeys.set(`${p.ns}:${p.offerId}`, p);
  }

  const epicByKey = new Map<string, EpicCatalogItem>();
  if (epicKeys.size > 0 && typeof window !== 'undefined' && window.epic?.getGameDetails) {
    await raceWithTimeout(
      Promise.all(
        [...epicKeys.values()].map(async (p) => {
          try {
            const item = await window.epic!.getGameDetails(p.ns, p.offerId);
            if (item) epicByKey.set(`${p.ns}:${p.offerId}`, item);
          } catch {
            /* ignore */
          }
        }),
      ),
      NEIGHBOR_DETAILS_TIMEOUT_MS,
      [],
      'epic getGameDetails',
    );
  }

  for (const b of base) {
    const p = parseEpicGameId(b.gameId);
    if (!p) continue;
    const item = epicByKey.get(`${p.ns}:${p.offerId}`);
    if (!item) continue;
    const g = transformEpicGame(item, libraryStore.getEntry(b.gameId));
    b.title = g.title;
    b.imageChain = buildGameImageChain(
      g.id,
      g.title,
      g.coverUrl,
      g.headerImage,
      g.screenshots?.filter(Boolean),
    );
    b.genreTags = g.genre.filter(Boolean).slice(0, 2);
  }

  const out: SimilarGameCard[] = [];
  for (const b of base) {
    if (isAppPlaceholderTitle(b.title)) continue;
    out.push({
      gameId: b.gameId,
      distance: b.distance,
      title: b.title,
      imageChain: b.imageChain.length > 0 ? b.imageChain : buildGameImageChain(b.gameId, b.title, undefined, undefined),
      genreTags: b.genreTags,
    });
  }

  return out;
}

const DEFAULT_K = 8;

/** Same cosine-distance ceiling as Oracle ANN taste retrieval / Taste Match. */
export const SIMILAR_TITLES_DISTANCE_CEILING = 0.45;

/**
 * Lightweight ANN neighbor titles for Oracle survivor hydrate (F4).
 * Returns display titles only — no Steam recommendations.total fakes.
 * Uses the same distance ceiling as the details similar strip / Oracle ANN gate.
 */
export async function getSimilarTitlesForReco(
  sourceGameId: string,
  k: number = 6,
): Promise<string[]> {
  if (!annIndex.isReady) return [];

  const vec = await getEmbeddingById(sourceGameId);
  if (!vec) return [];

  const maxSim = await isChunkAnnMaxSimEnabled();
  const overFetch = Math.max(annNeighborOverFetch(k, maxSim), k + 24);
  const neighbors = await queryAnnNeighborGames(vec, overFetch, sourceGameId);
  return pickSimilarTitles(sourceGameId, neighbors, k);
}

/** Distance-gate, dedupe and resolve display titles for one source's ANN neighbors. */
function pickSimilarTitles(
  sourceGameId: string,
  neighbors: Array<{ id: string; distance: number }>,
  k: number,
): string[] {
  const filtered = neighbors.filter((r) => r.distance <= SIMILAR_TITLES_DISTANCE_CEILING);

  if (filtered.length === 0) return [];

  const linked = getLinkedStoreIds(sourceGameId);
  const sourceMetaTitle = resolveNeighborMeta(sourceGameId).title;
  const sourceNorm =
    sourceMetaTitle.length >= 2 && !isAppPlaceholderTitle(sourceMetaTitle)
      ? normalizeTitleForSimilarDedup(sourceMetaTitle)
      : '';

  const titles: string[] = [];
  const seenTitleNorms = new Set<string>();

  for (const r of filtered) {
    if (linked.has(r.id)) continue;
    const meta = resolveNeighborMeta(r.id);
    if (isAppPlaceholderTitle(meta.title)) continue;
    const tn = normalizeTitleForSimilarDedup(meta.title);
    if (sourceNorm.length >= 2 && tn === sourceNorm) continue;
    if (tn.length >= 3 && seenTitleNorms.has(tn)) continue;
    if (tn.length >= 3) seenTitleNorms.add(tn);
    titles.push(meta.title);
    if (titles.length >= k) break;
  }

  return titles;
}

/**
 * Batched `getSimilarTitlesForReco` for Oracle survivor hydrate: one ANN
 * `queryBatch` round-trip for every source, using vectors the caller already
 * holds in memory. Replaces up to 80 sequential lookups at ~3 IPC each
 * (embedding read + settings read + ANN query).
 */
export async function getSimilarTitlesForRecoBatch(
  sources: Array<{ gameId: string; vector: number[] }>,
  k: number = 6,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!annIndex.isReady || sources.length === 0) return out;

  const maxSim = await isChunkAnnMaxSimEnabled();
  const overFetch = Math.max(annNeighborOverFetch(k, maxSim), k + 24);
  const raw = await annIndex.queryBatch(
    sources.map((s) => ({ id: s.gameId, vector: s.vector })),
    overFetch,
  );

  for (const { gameId } of sources) {
    const hits = raw[gameId];
    if (!hits || hits.length === 0) continue;
    // Same game-level folding as queryAnnNeighborGames.
    const neighbors = maxSim
      ? aggregateMaxSimByGameId(hits, { excludeGameId: gameId }).map((r) => ({
        id: r.gameId,
        distance: r.distance,
      }))
      : hits
        .filter((r) => !r.id.includes('::') && parseAnnIdToGameId(r.id) !== gameId)
        .sort((a, b) => a.distance - b.distance);
    const titles = pickSimilarTitles(gameId, neighbors, k);
    if (titles.length > 0) out.set(gameId, titles);
  }
  return out;
}

/**
 * Nearest neighbors in the persisted ANN index for the given game's embedding.
 * Enriches Steam/Epic rows via IPC so titles and art match the store.
 * Dedupes cross-store twins (same product) and duplicate display titles among neighbors.
 */
export async function getSimilarGamesForDetails(
  sourceGameId: string,
  k: number = DEFAULT_K,
  opts?: SimilarGamesForDetailsOptions,
): Promise<SimilarGamesResult> {
  if (!annIndex.isReady) {
    return { status: 'ann_unavailable', items: [] };
  }

  const vec = await getEmbeddingById(sourceGameId);
  if (!vec) {
    return { status: 'no_embedding', items: [] };
  }

  const maxSim = await isChunkAnnMaxSimEnabled();
  const overFetch = Math.max(annNeighborOverFetch(k, maxSim), k + 24);
  const filtered = await queryAnnNeighborGames(vec, overFetch, sourceGameId);

  if (filtered.length === 0) {
    return { status: 'empty', items: [] };
  }

  const enriched = await enrichNeighborRows(
    filtered.map((r) => ({ gameId: r.id, distance: r.distance })),
  );

  if (enriched.length === 0) {
    return { status: 'empty', items: [] };
  }

  const deduped = dedupeSimilarNeighbors(sourceGameId, opts?.sourceDisplayTitle, enriched, k);

  if (deduped.length === 0) {
    return { status: 'empty', items: [] };
  }

  return { status: 'ok', items: deduped };
}
