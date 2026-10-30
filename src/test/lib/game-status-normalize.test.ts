/**
 * normalizeGameStatus — LLM-issued status strings map onto the five library statuses (1.0.97 B14).
 */

import { describe, it, expect } from 'vitest';
import { normalizeGameStatus, GAME_STATUS_VALUES } from '@/lib/game-status-normalize';
import type { GameStatus } from '@/types/game';

describe('normalizeGameStatus', () => {
  it('passes the five exact statuses through', () => {
    for (const s of GAME_STATUS_VALUES) expect(normalizeGameStatus(s)).toBe(s);
    // Type check: the shared list is assignable to GameStatus.
    const asGameStatus: GameStatus[] = [...GAME_STATUS_VALUES];
    expect(asGameStatus).toHaveLength(5);
  });

  it('is case and whitespace insensitive', () => {
    expect(normalizeGameStatus('want to play')).toBe('Want to Play');
    expect(normalizeGameStatus('  WANT   TO PLAY ')).toBe('Want to Play');
    expect(normalizeGameStatus('playing now')).toBe('Playing Now');
    expect(normalizeGameStatus('PLAYING')).toBe('Playing');
    expect(normalizeGameStatus('on-hold')).toBe('On Hold');
    expect(normalizeGameStatus('on_hold')).toBe('On Hold');
    expect(normalizeGameStatus('OnHold')).toBe('On Hold');
    expect(normalizeGameStatus('completed')).toBe('Completed');
    expect(normalizeGameStatus('WantToPlay')).toBe('Want to Play');
  });

  it('maps synonyms', () => {
    expect(normalizeGameStatus('dropped')).toBe('On Hold');
    expect(normalizeGameStatus('Paused')).toBe('On Hold');
    expect(normalizeGameStatus('finished')).toBe('Completed');
    expect(normalizeGameStatus('Beaten')).toBe('Completed');
    expect(normalizeGameStatus('Backlog')).toBe('Want to Play');
    expect(normalizeGameStatus('wishlist')).toBe('Want to Play');
  });

  it('falls back to Want to Play for garbage and non-strings', () => {
    expect(normalizeGameStatus('banana')).toBe('Want to Play');
    expect(normalizeGameStatus('')).toBe('Want to Play');
    expect(normalizeGameStatus('   ')).toBe('Want to Play');
    expect(normalizeGameStatus(undefined)).toBe('Want to Play');
    expect(normalizeGameStatus(null)).toBe('Want to Play');
    expect(normalizeGameStatus(42)).toBe('Want to Play');
  });
});
