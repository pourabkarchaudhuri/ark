/**
 * Facet-chunk builders + hash/diff/pool helpers for Phase A embeddings.
 * Whole-text builders remain in embedding-service for pooled skip hashes.
 */

import { toCanonicalGenres } from '@/data/canonical-genres';
import { extractFranchiseBase } from '@/services/franchise';
import { EMBEDDING_DIM } from '@/services/embedding-quant';

export type EmbeddingTier = 'lib' | 'cat';
export type ChunkKind = 'facets' | 'summary' | 'description' | 'similar' | 'notes';

/** Chunk hash version only — do not bump EMBEDDING_TEXT_VERSION for chunk layout. */
export const EMBEDDING_CHUNK_VERSION = 1;

/** Writers set poolVersion=1; legacy omit is compatible with skip. */
export const CURRENT_POOL_VERSION = 1;

/** Must match embedding-service HASH_VERSION_PREFIX (TEXT=10, MODEL=1). */
export const HASH_VERSION_PREFIX = 't10m1';

export const CHUNK_WEIGHTS: Record<ChunkKind, number> = {
  facets: 1.0,
  notes: 0.85,
  summary: 0.55,
  description: 0.35,
  similar: 0.30,
};

const MAX_CHUNKS_PER_GAME = 8;
const DESC_CAP = 3000;
const DESC_WINDOW = 900;
const SUMMARY_CAP = 1000;
const NOTES_CAP = 1000;

const EMBEDDING_NOISE_GENRES = new Set([
  'indie', 'free to play', 'early access', 'software', 'utilities',
  'design & illustration', 'animation & modeling', 'photo editing',
  'video production', 'web publishing', 'education', 'accounting',
  'comedy', 'fantasy', 'space',
]);

function gameplayGenres(genres: string[]): string[] {
  return genres.filter(g => !EMBEDDING_NOISE_GENRES.has(g.toLowerCase()));
}

function djb2Hash(versioned: string): string {
  let hash = 5381;
  for (let i = 0; i < versioned.length; i++) {
    hash = ((hash << 5) + hash + versioned.charCodeAt(i)) & 0xFFFFFFFF;
  }
  return hash.toString(36);
}

/** Whole-text pooled skip hash (same algorithm as embedding-service.hashText). */
export function hashWholeEmbeddingText(text: string): string {
  return djb2Hash(`${HASH_VERSION_PREFIX}:${text}`);
}

export function hashChunkText(text: string): string {
  return djb2Hash(`c${EMBEDDING_CHUNK_VERSION}:${text}`);
}

export function makeChunkId(
  tier: EmbeddingTier,
  gameId: string,
  kind: ChunkKind,
  seq: number,
): string {
  return `${tier}:${gameId}::${kind}#${seq}`;
}

export interface ChunkSpec {
  chunkId: string;
  tier: EmbeddingTier;
  gameId: string;
  kind: ChunkKind;
  seq: number;
  text: string;
  textHash: string;
  weight: number;
}

export interface CachedChunkMeta {
  chunkId: string;
  textHash: string;
}

export interface LibraryChunkInput {
  title: string;
  genres?: string[];
  themes?: string[];
  modes?: string[];
  playerPerspectives?: string[];
  developer?: string;
  summary?: string;
  description?: string;
  userNotes?: string;
  similarGames?: Array<{ name: string }>;
}

export interface SteamCatalogChunkInput {
  title: string;
  genres?: string[];
  themes?: string[];
  modes?: string[];
  playerPerspectives?: string[];
  developer?: string;
  shortDescription?: string;
  source: 'steam';
}

export interface EpicCatalogChunkInput {
  title: string;
  genres?: string[];
  themes?: string[];
  modes?: string[];
  playerPerspectives?: string[];
  developer?: string;
  description?: string;
  longDescription?: string;
  source: 'epic';
}

export type GameChunkInput = LibraryChunkInput | SteamCatalogChunkInput | EpicCatalogChunkInput;

function buildFacetsText(input: {
  title: string;
  genres?: string[];
  themes?: string[];
  modes?: string[];
  playerPerspectives?: string[];
  developer?: string;
}): string {
  const parts = [input.title];
  const gpGenres = input.genres ? gameplayGenres(input.genres) : [];
  if (gpGenres.length) {
    parts.push(`gameplay: ${gpGenres.join(', ')}`);
    const canonical = toCanonicalGenres(gpGenres);
    if (canonical.length) parts.push(`type: ${canonical.join(', ')}`);
  }
  const franchise = extractFranchiseBase(input.title);
  if (franchise && franchise !== input.title.toLowerCase().trim()) {
    parts.push(`series: ${franchise}`);
  }
  if (input.playerPerspectives?.length) {
    parts.push(`perspective: ${input.playerPerspectives.join(', ')}`);
  }
  if (input.modes?.length) parts.push(`modes: ${input.modes.join(', ')}`);
  if (input.themes?.length) parts.push(`setting: ${input.themes.join(', ')}`);
  if (input.developer) parts.push(`by ${input.developer}`);
  if (gpGenres.length) parts.push(`${input.title}, ${gpGenres[0]}`);
  return parts.join('. ');
}

function pushChunk(
  out: ChunkSpec[],
  tier: EmbeddingTier,
  gameId: string,
  kind: ChunkKind,
  seq: number,
  text: string,
): void {
  if (out.length >= MAX_CHUNKS_PER_GAME) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  out.push({
    chunkId: makeChunkId(tier, gameId, kind, seq),
    tier,
    gameId,
    kind,
    seq,
    text: trimmed,
    textHash: hashChunkText(trimmed),
    weight: CHUNK_WEIGHTS[kind],
  });
}

/**
 * Build ordered facet chunks for a game. Caps at 8 chunks.
 * Priority by weight: facets → notes → summary → description windows → similar.
 */
export function buildGameChunks(
  tier: EmbeddingTier,
  gameId: string,
  input: GameChunkInput,
): ChunkSpec[] {
  const out: ChunkSpec[] = [];

  pushChunk(out, tier, gameId, 'facets', 0, buildFacetsText(input));

  const notes =
    tier === 'lib' && 'userNotes' in input && input.userNotes
      ? input.userNotes.slice(0, NOTES_CAP)
      : '';
  if (notes) pushChunk(out, tier, gameId, 'notes', 0, `player notes: ${notes}`);

  let summary = '';
  if (tier === 'lib' && 'summary' in input && input.summary) {
    summary = input.summary.slice(0, SUMMARY_CAP);
  } else if ('source' in input && input.source === 'steam' && input.shortDescription) {
    summary = input.shortDescription.slice(0, SUMMARY_CAP);
  } else if ('source' in input && input.source === 'epic' && input.description) {
    summary = input.description.slice(0, SUMMARY_CAP);
  }
  if (summary) pushChunk(out, tier, gameId, 'summary', 0, summary);

  // Description windows before similar so higher-weight desc fills slots first.
  let descBody = '';
  if (tier === 'lib' && 'description' in input && input.description) {
    descBody = input.description.slice(0, DESC_CAP);
  } else if ('source' in input && input.source === 'epic' && input.longDescription) {
    descBody = input.longDescription.slice(0, DESC_CAP);
  }
  if (descBody) {
    let seq = 0;
    for (let i = 0; i < descBody.length && out.length < MAX_CHUNKS_PER_GAME; i += DESC_WINDOW) {
      pushChunk(out, tier, gameId, 'description', seq, descBody.slice(i, i + DESC_WINDOW));
      seq++;
    }
  }

  if (tier === 'lib' && 'similarGames' in input && input.similarGames?.length) {
    const names = input.similarGames.slice(0, 6).map(g => g.name);
    pushChunk(out, tier, gameId, 'similar', 0, `similar to: ${names.join(', ')}`);
  }

  return out;
}

export function diffChunksAgainstCache(
  desired: ChunkSpec[],
  existingById: Map<string, CachedChunkMeta>,
): { toEmbed: ChunkSpec[]; staleIds: string[] } {
  const desiredIds = new Set(desired.map(c => c.chunkId));
  const toEmbed: ChunkSpec[] = [];
  for (const chunk of desired) {
    const prev = existingById.get(chunk.chunkId);
    if (!prev || prev.textHash !== chunk.textHash) {
      toEmbed.push(chunk);
    }
  }
  const staleIds: string[] = [];
  for (const id of existingById.keys()) {
    if (!desiredIds.has(id)) staleIds.push(id);
  }
  return { toEmbed, staleIds };
}

/** Weighted average of chunk vectors, then L2-normalize. */
export function poolChunkVectors(
  parts: Array<{ vector: ArrayLike<number>; weight: number }>,
): Float32Array {
  const out = new Float32Array(EMBEDDING_DIM);
  let weightSum = 0;
  for (const { vector, weight } of parts) {
    if (weight <= 0) continue;
    weightSum += weight;
    const n = Math.min(EMBEDDING_DIM, vector.length);
    for (let i = 0; i < n; i++) out[i] += vector[i] * weight;
  }
  if (weightSum > 0) {
    for (let i = 0; i < EMBEDDING_DIM; i++) out[i] /= weightSum;
  }
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (norm > 1e-12) {
    const inv = 1 / norm;
    for (let i = 0; i < EMBEDDING_DIM; i++) out[i] *= inv;
  }
  return out;
}

export function shouldSkipPooled(
  existing: { textHash: string; poolVersion?: number } | null | undefined,
  wholeHash: string,
): boolean {
  if (!existing) return false;
  if (existing.textHash !== wholeHash) return false;
  if (existing.poolVersion === undefined) return true;
  return existing.poolVersion === CURRENT_POOL_VERSION;
}
