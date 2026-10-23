import { describe, it, expect } from 'vitest';
import {
  CHUNK_HASH_PREFIX,
  EMBEDDING_LAYOUT_GENERATION,
  EMBEDDING_LAYOUT_ID,
  EMBEDDING_LAYOUT_STAMP,
  EMBEDDING_MODEL_VERSION,
  EMBEDDING_POOL_VERSION,
  EMBEDDING_TEXT_VERSION,
  LEGACY_LAYOUT_ID,
  LEGACY_LAYOUT_STAMP,
  WHOLE_HASH_PREFIX,
  buildChunkHashPrefix,
  buildLayoutStamp,
  buildWholeHashPrefix,
  isCurrentLayout,
  layoutIdIsCurrent,
  layoutKeySuffix,
  rowLayoutOf,
  watermarkStampIsCurrent,
} from '@/services/embedding-layout';
import {
  CURRENT_POOL_VERSION,
  HASH_VERSION_PREFIX,
  diffChunksAgainstCache,
  hashChunkText,
  hashWholeEmbeddingText,
  shouldSkipPooled,
  type ChunkSpec,
} from '@/services/embedding-chunks';
import {
  EMBEDDING_TEXT_VERSION as SERVICE_TEXT_VERSION,
  EMBEDDING_MODEL_VERSION as SERVICE_MODEL_VERSION,
} from '@/services/embedding-service';
import { annGraphSignature } from '@/services/graph-signature';

// The djb2 the hashes were always built with, computed here independently of the production code.
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0xffffffff;
  return h.toString(36);
}

describe('this release is a no-op for existing vectors', () => {
  it('derived prefixes equal the literals that shipped before the layout module', () => {
    expect(WHOLE_HASH_PREFIX).toBe('t10m1');
    expect(CHUNK_HASH_PREFIX).toBe('c1');
    expect(EMBEDDING_LAYOUT_STAMP).toBe('t10m1c1p1');
    expect(EMBEDDING_LAYOUT_STAMP).toBe(LEGACY_LAYOUT_STAMP);
    expect(EMBEDDING_LAYOUT_ID).toBe(LEGACY_LAYOUT_ID);
    expect(EMBEDDING_LAYOUT_GENERATION).toBe(1);
  });

  it('whole and chunk hashes are byte-identical to the pre-module formulas', () => {
    for (const text of ['', 'Hades. gameplay: Action', 'ü é 日本語']) {
      expect(hashWholeEmbeddingText(text)).toBe(djb2(`t10m1:${text}`));
      expect(hashChunkText(text)).toBe(djb2(`c1:${text}`));
    }
  });

  it('the service and the chunk module share ONE version source (they used to carry separate copies)', () => {
    expect(SERVICE_TEXT_VERSION).toBe(EMBEDDING_TEXT_VERSION);
    expect(SERVICE_MODEL_VERSION).toBe(EMBEDDING_MODEL_VERSION);
    expect(HASH_VERSION_PREFIX).toBe(WHOLE_HASH_PREFIX);
    expect(CURRENT_POOL_VERSION).toBe(EMBEDDING_POOL_VERSION);
    expect(`t${EMBEDDING_TEXT_VERSION}m${EMBEDDING_MODEL_VERSION}`).toBe(HASH_VERSION_PREFIX);
  });

  it('unstamped rows, old-format watermarks and key suffixes stay valid', () => {
    expect(rowLayoutOf({})).toBe(LEGACY_LAYOUT_STAMP);
    expect(isCurrentLayout({})).toBe(true);
    expect(isCurrentLayout({ layout: EMBEDDING_LAYOUT_STAMP })).toBe(true);
    expect(watermarkStampIsCurrent('t10m1')).toBe(true); // old watermarks (bare whole-hash prefix)
    expect(watermarkStampIsCurrent(EMBEDDING_LAYOUT_STAMP)).toBe(true);
    expect(layoutKeySuffix()).toBe('');
    expect(layoutIdIsCurrent(undefined)).toBe(true); // caches saved before layout ids existed
    expect(layoutIdIsCurrent(EMBEDDING_LAYOUT_ID)).toBe(true);
    expect(annGraphSignature(1234)).toBe('ann-1234-c1-p1'); // unchanged → no forced graph rebuild
  });
});

describe('a future bump invalidates what it should (the old no-op bug)', () => {
  it('a MODEL bump changes the chunk hash prefix (it used to be invisible to chunk vectors) and the whole prefix', () => {
    expect(buildChunkHashPrefix(1, 1)).toBe('c1');
    expect(buildChunkHashPrefix(1, 2)).toBe('c1m2');
    expect(buildChunkHashPrefix(1, 2)).not.toBe(buildChunkHashPrefix(1, 1));
    expect(buildWholeHashPrefix(10, 2)).not.toBe(buildWholeHashPrefix(10, 1));
  });

  it('a chunk-version bump changes the chunk prefix', () => {
    expect(buildChunkHashPrefix(2, 1)).not.toBe(buildChunkHashPrefix(1, 1));
  });

  it('every version dimension changes the row stamp', () => {
    const base = { text: 10, model: 1, chunk: 1, pool: 1 };
    const stamps = [
      buildLayoutStamp(base),
      buildLayoutStamp({ ...base, text: 11 }),
      buildLayoutStamp({ ...base, model: 2 }),
      buildLayoutStamp({ ...base, chunk: 2 }),
      buildLayoutStamp({ ...base, pool: 2 }),
    ];
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it('generation bumps flip derived-cache keys', () => {
    expect(layoutKeySuffix(2)).toBe('-g2');
    expect(layoutKeySuffix(7)).toBe('-g7');
  });

  it('rows from another layout are not skipped even when the text hash matches', () => {
    const wholeHash = hashWholeEmbeddingText('x');
    expect(shouldSkipPooled({ textHash: wholeHash, layout: EMBEDDING_LAYOUT_STAMP }, wholeHash)).toBe(true);
    expect(shouldSkipPooled({ textHash: wholeHash }, wholeHash)).toBe(true); // legacy row, legacy layout
    expect(shouldSkipPooled({ textHash: wholeHash, layout: 't10m2c1p1' }, wholeHash)).toBe(false);
    expect(shouldSkipPooled({ textHash: wholeHash, poolVersion: 99 }, wholeHash)).toBe(false);
    expect(shouldSkipPooled(null, wholeHash)).toBe(false);
  });
});

describe('force reaches the chunk diff (it used to re-embed nothing)', () => {
  const chunk = (id: string, text: string): ChunkSpec => ({
    chunkId: id, tier: 'cat', gameId: 'g', kind: 'facets', seq: 0, text, textHash: hashChunkText(text), weight: 1,
  });
  it('unchanged chunks are re-used normally and re-embedded when forced', () => {
    const desired = [chunk('cat:g::facets#0', 'same text')];
    const cached = new Map([['cat:g::facets#0', { chunkId: 'cat:g::facets#0', textHash: hashChunkText('same text') }]]);
    expect(diffChunksAgainstCache(desired, cached).toEmbed).toHaveLength(0);
    expect(diffChunksAgainstCache(desired, cached, { force: true }).toEmbed).toHaveLength(1);
  });
  it('stale chunk ids are still reported when forced', () => {
    const cached = new Map([['cat:g::old#0', { chunkId: 'cat:g::old#0', textHash: 'x' }]]);
    expect(diffChunksAgainstCache([chunk('cat:g::facets#0', 't')], cached, { force: true }).staleIds).toEqual(['cat:g::old#0']);
  });
});
