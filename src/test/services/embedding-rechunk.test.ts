import { describe, it, expect } from 'vitest';
import {
  makeChunkId,
  hashChunkText,
  type ChunkSpec,
  type CachedChunkMeta,
} from '@/services/embedding-chunks';
import {
  RECHUNK_META_KEY,
  gameNeedsChunkWork,
  advanceRechunkCursor,
  recordRechunkFailure,
  nextRechunkPhase,
  beginRechunkPhase,
  createInitialRechunkWatermark,
  shouldResumeIdleRechunk,
  gamesAfterCursor,
  rechunkBlockedReason,
  rechunkProgressPercent,
  type RechunkWatermark,
} from '@/services/embedding-rechunk';

function facetsChunk(gameId: string, text = 'facets: Action'): ChunkSpec {
  return {
    chunkId: makeChunkId('lib', gameId, 'facets', 0),
    tier: 'lib',
    gameId,
    kind: 'facets',
    seq: 0,
    text,
    textHash: hashChunkText(text),
    weight: 1,
  };
}

describe('gameNeedsChunkWork', () => {
  it('needs work when no chunks exist (legacy pooled-only game)', () => {
    const desired = [facetsChunk('steam-1')];
    expect(gameNeedsChunkWork(desired, new Map())).toBe(true);
  });

  it('needs work when a desired chunk hash mismatches', () => {
    const desired = [facetsChunk('steam-1', 'facets: RPG')];
    const existing = new Map<string, CachedChunkMeta>([
      [desired[0].chunkId, { chunkId: desired[0].chunkId, textHash: 'stale-hash' }],
    ]);
    expect(gameNeedsChunkWork(desired, existing)).toBe(true);
  });

  it('needs work when stale chunk ids remain', () => {
    const desired = [facetsChunk('steam-1')];
    const staleId = makeChunkId('lib', 'steam-1', 'notes', 0);
    const existing = new Map<string, CachedChunkMeta>([
      [desired[0].chunkId, { chunkId: desired[0].chunkId, textHash: desired[0].textHash }],
      [staleId, { chunkId: staleId, textHash: 'x' }],
    ]);
    expect(gameNeedsChunkWork(desired, existing)).toBe(true);
  });

  it('does not need work when all desired chunks match and none stale', () => {
    const desired = [facetsChunk('steam-1')];
    const existing = new Map<string, CachedChunkMeta>([
      [desired[0].chunkId, { chunkId: desired[0].chunkId, textHash: desired[0].textHash }],
    ]);
    expect(gameNeedsChunkWork(desired, existing)).toBe(false);
  });
});

describe('rechunk watermark cursor', () => {
  it('creates initial watermark at library phase with null cursor', () => {
    const wm = createInitialRechunkWatermark();
    expect(wm.key).toBe(RECHUNK_META_KEY);
    expect(wm.phase).toBe('library');
    expect(wm.cursorAfter).toBeNull();
    expect(wm.successCount).toBe(0);
    expect(wm.skippedCount).toBe(0);
    expect(wm.failureCount).toBe(0);
  });

  it('advances cursor only on success or skip, never on failure', () => {
    let wm = createInitialRechunkWatermark();
    wm = advanceRechunkCursor(wm, 'steam-1', 'success');
    expect(wm.cursorAfter).toBe('steam-1');
    expect(wm.successCount).toBe(1);
    expect(wm.skippedCount).toBe(0);

    wm = advanceRechunkCursor(wm, 'steam-2', 'skipped');
    expect(wm.cursorAfter).toBe('steam-2');
    expect(wm.skippedCount).toBe(1);

    const beforeFail = wm.cursorAfter;
    wm = recordRechunkFailure(wm);
    expect(wm.cursorAfter).toBe(beforeFail);
    expect(wm.failureCount).toBe(1);
  });

  it('resets cursor when entering next phase', () => {
    let wm: RechunkWatermark = {
      ...createInitialRechunkWatermark(),
      phase: 'library',
      cursorAfter: 'steam-99',
      successCount: 5,
    };
    expect(nextRechunkPhase('library')).toBe('steam');
    expect(nextRechunkPhase('steam')).toBe('epic');
    expect(nextRechunkPhase('epic')).toBe('done');
    expect(nextRechunkPhase('done')).toBe('done');

    wm = beginRechunkPhase(wm, 'steam');
    expect(wm.phase).toBe('steam');
    expect(wm.cursorAfter).toBeNull();
    expect(wm.successCount).toBe(5);
  });
});

describe('gamesAfterCursor', () => {
  it('returns sorted games after exclusive cursor', () => {
    const games = [{ id: 'steam-3' }, { id: 'steam-1' }, { id: 'steam-2' }];
    expect(gamesAfterCursor(games, null).map((g) => g.id)).toEqual([
      'steam-1',
      'steam-2',
      'steam-3',
    ]);
    expect(gamesAfterCursor(games, 'steam-1').map((g) => g.id)).toEqual([
      'steam-2',
      'steam-3',
    ]);
  });
});

describe('shouldResumeIdleRechunk / kill switch', () => {
  it('does not resume when chunking kill switch is off', () => {
    expect(shouldResumeIdleRechunk(null, false)).toBe(false);
    expect(shouldResumeIdleRechunk(createInitialRechunkWatermark(), false)).toBe(false);
  });

  it('resumes when never started or phase incomplete', () => {
    expect(shouldResumeIdleRechunk(null, true)).toBe(true);
    expect(shouldResumeIdleRechunk(createInitialRechunkWatermark(), true)).toBe(true);
    const done: RechunkWatermark = { ...createInitialRechunkWatermark(), phase: 'done' };
    expect(shouldResumeIdleRechunk(done, true)).toBe(false);
  });

  it('blocks with clear reasons', () => {
    expect(rechunkBlockedReason({ chunkingEnabled: false, ollamaAvailable: true }))
      .toMatch(/chunk/i);
    expect(rechunkBlockedReason({ chunkingEnabled: true, ollamaAvailable: false }))
      .toMatch(/ollama/i);
    expect(rechunkBlockedReason({ chunkingEnabled: true, ollamaAvailable: true })).toBeNull();
  });
});

describe('rechunkProgressPercent', () => {
  it('reports game-unit progress and never forces 100% with total 0', () => {
    expect(rechunkProgressPercent(0, 0)).toBe(0);
    expect(rechunkProgressPercent(50, 100)).toBe(50);
    expect(rechunkProgressPercent(150, 100)).toBe(100);
  });
});
