/**
 * Shared AI chat library-action helper (1.0.97 B14): adds apply with a normalized status,
 * removals are never applied until confirmed.
 */

import { describe, it, expect, vi } from 'vitest';
import { applyAIChatActions, confirmAIChatRemovals, resolveActionGameId } from '@/services/ai-chat-actions';
import type { LibraryAction } from '@/types/chat';

describe('resolveActionGameId', () => {
  it('prefers explicit gameId, falls back to steam-<appId>, rejects invalid', () => {
    expect(resolveActionGameId({ type: 'add', appId: 1, gameId: 'epic-x' })).toBe('epic-x');
    expect(resolveActionGameId({ type: 'add', appId: 620 })).toBe('steam-620');
    expect(resolveActionGameId({ type: 'add', appId: NaN })).toBe('');
    expect(resolveActionGameId({ type: 'add', appId: 0 })).toBe('');
    expect(resolveActionGameId({ type: 'add' } as unknown as LibraryAction)).toBe('');
  });
});

describe('applyAIChatActions', () => {
  it('adds with a normalized status ("backlog" -> Want to Play)', async () => {
    const addToLibrary = vi.fn();
    const res = await applyAIChatActions(
      [{ type: 'add', appId: 620, gameId: 'steam-620', status: 'backlog', gameName: 'Portal 2' }],
      { addToLibrary },
    );
    expect(res.added).toEqual(['steam-620']);
    expect(addToLibrary).toHaveBeenCalledWith(expect.objectContaining({
      gameId: 'steam-620',
      steamAppId: 620,
      status: 'Want to Play',
      cachedMeta: { title: 'Portal 2', store: 'steam' },
    }));
  });

  it('uses resolved metadata and the given priority', async () => {
    const addToLibrary = vi.fn();
    await applyAIChatActions(
      [{ type: 'add', appId: 1, status: 'finished' }],
      { addToLibrary, priority: 'Medium', resolveCachedMeta: async () => ({ title: 'Resolved', store: 'steam' }) },
    );
    expect(addToLibrary).toHaveBeenCalledWith(expect.objectContaining({
      status: 'Completed',
      priority: 'Medium',
      cachedMeta: { title: 'Resolved', store: 'steam' },
    }));
  });

  it('falls back to the action name when metadata lookup throws', async () => {
    const addToLibrary = vi.fn();
    await applyAIChatActions(
      [{ type: 'add', appId: 0, gameId: 'epic-abc', gameName: 'Epic Game' }],
      { addToLibrary, resolveCachedMeta: async () => { throw new Error('offline'); } },
    );
    expect(addToLibrary).toHaveBeenCalledWith(expect.objectContaining({
      gameId: 'epic-abc',
      steamAppId: undefined,
      cachedMeta: { title: 'Epic Game', store: 'epic' },
    }));
  });

  it('never removes; returns de-duplicated pending removals with names', async () => {
    const addToLibrary = vi.fn();
    const res = await applyAIChatActions(
      [
        { type: 'remove', appId: 1, gameId: 'steam-1', gameName: 'One' },
        { type: 'remove', appId: 1, gameId: 'steam-1', gameName: 'One' },
        { type: 'remove', appId: 2 },
      ],
      { addToLibrary, lookupName: id => (id === 'steam-2' ? 'Two' : undefined) },
    );
    expect(addToLibrary).not.toHaveBeenCalled();
    expect(res.pendingRemovals).toEqual([
      { gameId: 'steam-1', gameName: 'One' },
      { gameId: 'steam-2', gameName: 'Two' },
    ]);
  });

  it('skips actions without a usable id', async () => {
    const addToLibrary = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await applyAIChatActions([{ type: 'add', appId: NaN }], { addToLibrary });
    expect(res).toEqual({ added: [], pendingRemovals: [] });
    expect(addToLibrary).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('confirmAIChatRemovals', () => {
  it('removes each confirmed game and keeps going past a failure', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const remove = vi.fn((id: string) => { if (id === 'b') throw new Error('x'); });
    const removed = confirmAIChatRemovals(
      [{ gameId: 'a', gameName: 'A' }, { gameId: 'b', gameName: 'B' }, { gameId: 'c', gameName: 'C' }],
      remove,
    );
    expect(remove).toHaveBeenCalledTimes(3);
    expect(removed).toEqual(['a', 'c']);
    err.mockRestore();
  });
});
