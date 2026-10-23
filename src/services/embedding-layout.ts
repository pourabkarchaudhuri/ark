/**
 * Embedding LAYOUT identity — the single source of truth for "which vectors are these?".
 *
 * A vector's meaning depends on (a) the model that produced it, (b) the text it was made from
 * (text builder + chunk layout) and (c) how chunk vectors were pooled. Before this module those
 * facts lived in three places that could silently drift:
 *   - embedding-service.ts computed its own `t10m1` prefix (used only for the pass watermark),
 *   - embedding-chunks.ts hard-coded the literal `'t10m1'` (the one that actually hashes), and
 *   - chunk hashes (`c1:`) had no model component at all — so a model swap re-used old-model vectors.
 *
 * Everything that derives a hash, a stamp, a cache key or an index generation imports from here.
 *
 * COMPATIBILITY: with today's version numbers every derived string is byte-identical to what was
 * shipped before (`t10m1`, `c1`, poolVersion 1), so introducing this module re-embeds nothing.
 * Rows written before per-row stamps existed carry no `layout` and are read as LEGACY_LAYOUT_STAMP.
 * A future bump of any version changes the stamp, and unstamped/older rows then read as stale.
 */

/** Whole-text builder version (not for chunk-layout changes — those use EMBEDDING_CHUNK_VERSION). */
export const EMBEDDING_TEXT_VERSION = 10;
/** Bump on a model swap / quant change (the Ollama tag itself is tracked separately, see embedding-migration.ts). */
export const EMBEDDING_MODEL_VERSION = 1;
/** Chunk text/layout version. */
export const EMBEDDING_CHUNK_VERSION = 1;
/** Pooling recipe version (weights, pooling math). */
export const EMBEDDING_POOL_VERSION = 1;
/**
 * Generation of the ANN index / derived caches. Bump when everything derived from vectors
 * (the HNSW file, the neighbour graph, the galaxy layout, Oracle results) must be discarded.
 */
export const EMBEDDING_LAYOUT_GENERATION = 1;

/** Whole-text pooled skip-hash prefix for given versions (`t10m1` for today's). */
export function buildWholeHashPrefix(textVersion: number, modelVersion: number): string {
  return `t${textVersion}m${modelVersion}`;
}

/**
 * Chunk skip-hash prefix. A chunk's vector depends only on (model, chunk text), so the model version
 * belongs in it — and the text version does NOT (chunk text is compared byte-for-byte via the hash).
 * Model version 1 keeps the historical `c1`; a model bump yields `c1m2`, invalidating every chunk vector.
 */
export function buildChunkHashPrefix(chunkVersion: number, modelVersion: number): string {
  return modelVersion === 1 ? `c${chunkVersion}` : `c${chunkVersion}m${modelVersion}`;
}

/** Row layout stamp: text · model · chunk · pool versions. */
export function buildLayoutStamp(v: { text: number; model: number; chunk: number; pool: number }): string {
  return `t${v.text}m${v.model}c${v.chunk}p${v.pool}`;
}

/** Whole-text pooled skip-hash prefix. `t10m1` today — identical to the pre-module literal. */
export const WHOLE_HASH_PREFIX = buildWholeHashPrefix(EMBEDDING_TEXT_VERSION, EMBEDDING_MODEL_VERSION);

/** Chunk skip-hash prefix (`c1` today). */
export const CHUNK_HASH_PREFIX = buildChunkHashPrefix(EMBEDDING_CHUNK_VERSION, EMBEDDING_MODEL_VERSION);

/** Stamp written on every pooled and chunk row. */
export const EMBEDDING_LAYOUT_STAMP = buildLayoutStamp({
  text: EMBEDDING_TEXT_VERSION, model: EMBEDDING_MODEL_VERSION, chunk: EMBEDDING_CHUNK_VERSION, pool: EMBEDDING_POOL_VERSION,
});

/** The layout of every row written before stamps existed. */
export const LEGACY_LAYOUT_STAMP = 't10m1c1p1';

/** Full human-readable identity (logs, status panels). */
export const EMBEDDING_LAYOUT_ID = `${EMBEDDING_LAYOUT_STAMP}g${EMBEDDING_LAYOUT_GENERATION}`;

/** Layout id of everything cached before layout ids existed. */
export const LEGACY_LAYOUT_ID = `${LEGACY_LAYOUT_STAMP}g1`;

/**
 * Is a derived cache (galaxy layout, Oracle results, …) built from the CURRENT layout? A cache saved before
 * layout ids existed carries none and is current only while the layout is still the legacy one — so adding
 * this check invalidates nothing today, and every such cache flips on the first layout/generation bump.
 */
export function layoutIdIsCurrent(id: string | undefined | null): boolean {
  if (id === undefined || id === null || id === '') return EMBEDDING_LAYOUT_ID === LEGACY_LAYOUT_ID;
  return id === EMBEDDING_LAYOUT_ID;
}

/** The layout a row was written under (unstamped rows predate stamps). */
export function rowLayoutOf(row: { layout?: string } | null | undefined): string {
  return row?.layout ?? LEGACY_LAYOUT_STAMP;
}

/** True when the row was produced by the current layout. */
export function isCurrentLayout(row: { layout?: string } | null | undefined): boolean {
  return rowLayoutOf(row) === EMBEDDING_LAYOUT_STAMP;
}

/**
 * Pass watermarks recorded `versionStamp` as the bare whole-hash prefix; they now record the full
 * layout stamp. An old-format stamp is accepted only while the current layout IS the legacy layout.
 */
export function watermarkStampIsCurrent(stamp: string | undefined | null): boolean {
  if (!stamp) return false;
  if (stamp === EMBEDDING_LAYOUT_STAMP) return true;
  return stamp === WHOLE_HASH_PREFIX && EMBEDDING_LAYOUT_STAMP === LEGACY_LAYOUT_STAMP;
}

/**
 * Suffix appended to derived-cache keys (graph signature, galaxy key, Oracle result cache). Empty for
 * generation 1 so existing caches stay valid; `-g<N>` afterwards so every cache keyed with it flips on a bump.
 */
export function layoutKeySuffix(generation: number = EMBEDDING_LAYOUT_GENERATION): string {
  return generation === 1 ? '' : `-g${generation}`;
}
