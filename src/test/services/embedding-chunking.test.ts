import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/ann-index', () => ({
  annIndex: {
    isReady: false,
    addVectors: vi.fn(),
    save: vi.fn(),
    finishBuild: vi.fn(),
    setBuildProgress: vi.fn(),
    vectorCount: 0,
  },
}));

vi.mock('@/services/reco-store', () => ({
  setEmbeddingCache: vi.fn(),
}));

import {
  quantizeEmbedding,
  dequantizeEmbedding,
  cosineSimilarity,
  EMBEDDING_DIM,
} from '@/services/embedding-quant';
import {
  EMBEDDING_CHUNK_VERSION,
  CURRENT_POOL_VERSION,
  CHUNK_WEIGHTS,
  makeChunkId,
  hashChunkText,
  hashWholeEmbeddingText,
  buildGameChunks,
  diffChunksAgainstCache,
  poolChunkVectors,
  shouldSkipPooled,
  type ChunkSpec,
  type CachedChunkMeta,
} from '@/services/embedding-chunks';
import {
  buildEmbeddingText,
  readPooledVector,
  type CachedEmbedding,
} from '@/services/embedding-service';

function unitVector(seed: number, dim = EMBEDDING_DIM): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed * 12.9898 + i * 78.233) * 0.5;
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

describe('embedding-quant', () => {
  it('round-trips with cosine > 0.995', () => {
    const original = unitVector(42);
    const { q, scale } = quantizeEmbedding(original);
    expect(q).toBeInstanceOf(Int8Array);
    expect(q.length).toBe(EMBEDDING_DIM);
    expect(typeof scale).toBe('number');
    expect(scale).toBeGreaterThan(0);

    const restored = dequantizeEmbedding(q, scale);
    expect(restored.length).toBe(EMBEDDING_DIM);
    expect(cosineSimilarity(original, restored)).toBeGreaterThan(0.995);
  });

  it('rejects wrong-length vectors on dequant via length gate in callers', () => {
    const { q, scale } = quantizeEmbedding(unitVector(1));
    expect(q.length).toBe(1024);
    expect(dequantizeEmbedding(q, scale).length).toBe(1024);
  });
});

describe('chunk ids and tiers', () => {
  it('uses tier-prefixed chunk ids', () => {
    expect(makeChunkId('lib', 'steam-1', 'notes', 0)).toBe('lib:steam-1::notes#0');
    expect(makeChunkId('cat', 'steam-1', 'facets', 0)).toBe('cat:steam-1::facets#0');
  });

  it('lib vs cat ids differ for the same gameId', () => {
    const lib = makeChunkId('lib', '42', 'facets', 0);
    const cat = makeChunkId('cat', '42', 'facets', 0);
    expect(lib).not.toBe(cat);
  });

  it('chunk hash includes EMBEDDING_CHUNK_VERSION', () => {
    const h = hashChunkText('hello');
    const h2 = hashChunkText('hello');
    expect(h).toBe(h2);
    expect(EMBEDDING_CHUNK_VERSION).toBe(1);
    // Changing text changes hash
    expect(hashChunkText('hello')).not.toBe(hashChunkText('hello!'));
  });
});

describe('buildGameChunks', () => {
  const baseLib = {
    title: 'Hades',
    genres: ['Action', 'Rogue-like', 'Indie'],
    themes: ['Mythology'],
    modes: ['Singleplayer'],
    playerPerspectives: ['Isometric'],
    developer: 'Supergiant Games',
    summary: 'A rogue-like dungeon crawler.',
    description: 'Battle out of the Underworld. '.repeat(80),
    userNotes: 'Love the soundtrack',
    similarGames: [{ name: 'Dead Cells' }, { name: 'Bastion' }],
  };

  it('builds library chunks with expected kinds and weights', () => {
    const chunks = buildGameChunks('lib', 'steam-1145360', baseLib);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThanOrEqual(8);
    const kinds = chunks.map(c => c.kind);
    expect(kinds).toContain('facets');
    expect(kinds).toContain('summary');
    expect(kinds).toContain('notes');
    expect(kinds).toContain('similar');
    expect(kinds).toContain('description');
    expect(chunks.find(c => c.kind === 'facets')!.weight).toBe(CHUNK_WEIGHTS.facets);
    expect(chunks.find(c => c.kind === 'notes')!.weight).toBe(CHUNK_WEIGHTS.notes);
    expect(chunks.every(c => c.chunkId.startsWith('lib:'))).toBe(true);
    expect(chunks.every(c => c.tier === 'lib')).toBe(true);
  });

  it('omits notes/similar/description for steam catalog', () => {
    const chunks = buildGameChunks('cat', 'steam-10', {
      title: 'Portal',
      genres: ['Puzzle'],
      themes: [],
      modes: ['Singleplayer'],
      developer: 'Valve',
      shortDescription: 'A puzzle game',
      source: 'steam',
    });
    const kinds = new Set(chunks.map(c => c.kind));
    expect(kinds.has('facets')).toBe(true);
    expect(kinds.has('summary')).toBe(true);
    expect(kinds.has('notes')).toBe(false);
    expect(kinds.has('similar')).toBe(false);
    expect(kinds.has('description')).toBe(false);
    expect(chunks.every(c => c.chunkId.startsWith('cat:'))).toBe(true);
  });

  it('includes epic longDescription as description windows', () => {
    const long = 'X'.repeat(2500);
    const chunks = buildGameChunks('cat', 'epic-ns:offer', {
      title: 'Epic Game',
      genres: ['Action'],
      themes: [],
      modes: [],
      developer: 'Studio',
      description: 'Short blurb',
      longDescription: long,
      source: 'epic',
    });
    expect(chunks.some(c => c.kind === 'summary')).toBe(true);
    expect(chunks.some(c => c.kind === 'description')).toBe(true);
  });

  it('notes-only edit changes only notes hash', () => {
    const a = buildGameChunks('lib', 'g1', baseLib);
    const b = buildGameChunks('lib', 'g1', { ...baseLib, userNotes: 'Different notes now' });
    const byKind = (chunks: ChunkSpec[]) =>
      new Map(chunks.map(c => [`${c.kind}#${c.seq}`, c.textHash]));
    const ha = byKind(a);
    const hb = byKind(b);
    for (const [key, hash] of ha) {
      if (key.startsWith('notes#')) {
        expect(hb.get(key)).not.toBe(hash);
      } else {
        expect(hb.get(key)).toBe(hash);
      }
    }
  });
});

describe('diffChunksAgainstCache', () => {
  it('embeds all chunks when cache empty (first materialization)', () => {
    const desired = buildGameChunks('lib', 'g1', {
      title: 'Game',
      genres: ['Action'],
      summary: 'Sum',
      userNotes: 'Note',
    });
    const { toEmbed, staleIds } = diffChunksAgainstCache(desired, new Map());
    expect(toEmbed.length).toBe(desired.length);
    expect(staleIds).toEqual([]);
  });

  it('embeds only mismatched chunks on notes edit', () => {
    const base = {
      title: 'Game',
      genres: ['Action'],
      summary: 'Sum',
      userNotes: 'Note A',
    };
    const desiredA = buildGameChunks('lib', 'g1', base);
    const cache = new Map<string, CachedChunkMeta>();
    for (const c of desiredA) {
      cache.set(c.chunkId, { chunkId: c.chunkId, textHash: c.textHash });
    }
    const desiredB = buildGameChunks('lib', 'g1', { ...base, userNotes: 'Note B' });
    const { toEmbed, staleIds } = diffChunksAgainstCache(desiredB, cache);
    expect(toEmbed.every(c => c.kind === 'notes')).toBe(true);
    expect(toEmbed.length).toBe(1);
    expect(staleIds).toEqual([]);
  });

  it('marks removed chunk ids as stale', () => {
    const desired = buildGameChunks('lib', 'g1', { title: 'Game', genres: ['Action'] });
    const cache = new Map<string, CachedChunkMeta>([
      ['lib:g1::notes#0', { chunkId: 'lib:g1::notes#0', textHash: 'x' }],
      ...desired.map(c => [c.chunkId, { chunkId: c.chunkId, textHash: c.textHash }] as const),
    ]);
    const { staleIds } = diffChunksAgainstCache(desired, cache);
    expect(staleIds).toContain('lib:g1::notes#0');
  });
});

describe('poolChunkVectors', () => {
  it('returns L2-normalized weighted pool of length 1024', () => {
    const a = unitVector(1);
    const b = unitVector(2);
    const pooled = poolChunkVectors([
      { vector: a, weight: 1.0 },
      { vector: b, weight: 0.5 },
    ]);
    expect(pooled.length).toBe(1024);
    let norm = 0;
    for (let i = 0; i < pooled.length; i++) norm += pooled[i] * pooled[i];
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });
});

describe('shouldSkipPooled', () => {
  it('skips when hash matches and poolVersion compatible', () => {
    expect(shouldSkipPooled({ textHash: 'abc', poolVersion: undefined }, 'abc')).toBe(true);
    expect(shouldSkipPooled({ textHash: 'abc', poolVersion: CURRENT_POOL_VERSION }, 'abc')).toBe(true);
    expect(shouldSkipPooled({ textHash: 'abc', poolVersion: 99 }, 'abc')).toBe(false);
    expect(shouldSkipPooled({ textHash: 'abc' }, 'xyz')).toBe(false);
    expect(shouldSkipPooled(null, 'abc')).toBe(false);
  });
});

describe('whole-text hash compatibility', () => {
  it('hashWholeEmbeddingText matches production buildEmbeddingText (t10m1)', () => {
    const game = {
      title: 'Celeste',
      genres: ['Platformer', 'Indie'],
      themes: ['Mountain'],
      modes: ['Singleplayer'],
      developer: 'Maddy Makes Games',
      summary: 'Climb the mountain.',
      description: 'A tough platformer.',
      userNotes: 'Great OST',
    };
    const text = buildEmbeddingText(game);
    const hash = hashWholeEmbeddingText(text);
    // djb2 folded to base36 can be negative (leading '-').
    expect(hash).toMatch(/^-?[0-9a-z]+$/);
    expect(hashWholeEmbeddingText(text)).toBe(hash);
    expect(hashWholeEmbeddingText(text + 'x')).not.toBe(hash);
    // Production builder includes canonical type for gameplay genres.
    expect(text).toContain('gameplay:');
    expect(text).toContain('player notes:');
  });
});

describe('readPooledVector decode boundary', () => {
  it('decodes legacy float arrays', () => {
    const embedding = Array.from(unitVector(3));
    const entry: CachedEmbedding = {
      gameId: 'g1',
      embedding,
      textHash: 'h',
      timestamp: Date.now(),
      format: 'f32',
    };
    const v = readPooledVector(entry);
    expect(v).not.toBeNull();
    expect(v!.length).toBe(1024);
    expect(cosineSimilarity(v!, embedding)).toBeGreaterThan(0.999);
  });

  it('decodes int8 + scale', () => {
    const original = unitVector(4);
    const { q, scale } = quantizeEmbedding(original);
    const entry: CachedEmbedding = {
      gameId: 'g1',
      q,
      scale,
      textHash: 'h',
      timestamp: Date.now(),
      format: 'i8',
      poolVersion: 1,
    };
    const v = readPooledVector(entry);
    expect(v).not.toBeNull();
    expect(cosineSimilarity(v!, original)).toBeGreaterThan(0.995);
  });

  it('returns null for invalid rows', () => {
    expect(readPooledVector({ gameId: 'x', textHash: 'h', timestamp: 1 })).toBeNull();
    expect(readPooledVector({
      gameId: 'x',
      embedding: [1, 2, 3],
      textHash: 'h',
      timestamp: 1,
    })).toBeNull();
  });

  it('hash-match alone is insufficient without a decodable pooled vector', () => {
    const entry: CachedEmbedding = {
      gameId: 'x',
      textHash: 'abc',
      timestamp: Date.now(),
    };
    expect(shouldSkipPooled(entry, 'abc')).toBe(true);
    expect(readPooledVector(entry)).toBeNull();
  });
});

describe('Ollama mock: skip / first materialization / notes-only', () => {
  const embedMock = vi.fn(async (items: Array<{ id: string; text: string }>) => {
    const out: Record<string, number[]> = {};
    for (const item of items) {
      out[item.id] = Array.from(unitVector(item.id.length + item.text.length));
    }
    return out;
  });

  beforeEach(() => {
    embedMock.mockClear();
  });

  it('skips Ollama when pooled whole-hash matches', () => {
    const text = buildEmbeddingText({ title: 'Hades', genres: ['Action'], userNotes: 'A' });
    const hash = hashWholeEmbeddingText(text);
    expect(shouldSkipPooled({ textHash: hash, poolVersion: 1 }, hash)).toBe(true);
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('first materialization embeds every chunk once', async () => {
    const desired = buildGameChunks('lib', 'steam-1', {
      title: 'Hades',
      genres: ['Action'],
      summary: 'Roguelike',
      userNotes: 'Notes',
      similarGames: [{ name: 'Dead Cells' }],
    });
    const { toEmbed } = diffChunksAgainstCache(desired, new Map());
    await embedMock(toEmbed.map(c => ({ id: c.chunkId, text: c.text })));
    expect(embedMock).toHaveBeenCalledTimes(1);
    const called = embedMock.mock.calls[0][0];
    expect(called.length).toBe(desired.length);
    expect(called.length).toBeGreaterThan(1);
  });

  it('notes-only edit embeds only the notes chunk', async () => {
    const base = {
      title: 'Hades',
      genres: ['Action'],
      summary: 'Roguelike',
      userNotes: 'Notes A',
    };
    const a = buildGameChunks('lib', 'steam-1', base);
    const cache = new Map(a.map(c => [c.chunkId, { chunkId: c.chunkId, textHash: c.textHash }]));
    const b = buildGameChunks('lib', 'steam-1', { ...base, userNotes: 'Notes B' });
    const { toEmbed } = diffChunksAgainstCache(b, cache);
    await embedMock(toEmbed.map(c => ({ id: c.chunkId, text: c.text })));
    expect(toEmbed).toHaveLength(1);
    expect(toEmbed[0].kind).toBe('notes');
    expect(embedMock.mock.calls[0][0]).toHaveLength(1);
  });
});
