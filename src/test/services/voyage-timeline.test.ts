/**
 * Voyage timeline data (v1.0.87): the first move into Playing is dated, the earliest first-play date
 * always wins, status changes carry who made them, and custom games get status history.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { journeyStore } from '@/services/journey-store';
import { libraryStore } from '@/services/library-store';
import { statusHistoryStore } from '@/services/status-history-store';
import { customGameStore } from '@/services/custom-game-store';
import { earliestIso, isPlausibleTimestamp } from '@/services/first-played';
import { buildLogEvents } from '@/components/journey-view';
import type { StatusChangeEntry } from '@/types/game';

const base = { priority: 'Medium' as const, publicReviews: '', recommendationSource: '' };

beforeEach(() => {
  localStorage.clear();
  journeyStore.clear();
  statusHistoryStore.clear();
  for (const e of libraryStore.getAllEntries()) libraryStore.removeFromLibrary(e.gameId);
});

describe('earliestIso / plausibility', () => {
  it('picks the earliest plausible date and ignores 0 / 1970 / far-future values', () => {
    expect(earliestIso('2026-05-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')).toBe('2025-01-01T00:00:00.000Z');
    expect(earliestIso(0, '1970-01-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')).toBe('2026-05-01T00:00:00.000Z');
    expect(earliestIso('2999-01-01T00:00:00.000Z')).toBeUndefined();
    expect(earliestIso(undefined, null, '', 'garbage')).toBeUndefined();
    expect(isPlausibleTimestamp(Date.UTC(1999, 11, 31))).toBe(false);
  });
});

describe('first move into Playing', () => {
  it('Want to Play → Playing with an existing journey row gets a first-played date', () => {
    libraryStore.addToLibrary({ gameId: 'steam-501', status: 'Want to Play', ...base });
    libraryStore.updateEntry('steam-501', { status: 'Want to Play', priority: 'High' });
    // Moving to Want to Play first creates the journey row without a first-played date.
    libraryStore.updateEntry('steam-501', { status: 'On Hold' });
    libraryStore.updateEntry('steam-501', { status: 'Want to Play' });
    expect(journeyStore.has('steam-501')).toBe(true);
    expect(journeyStore.getEntry('steam-501')?.firstPlayedAt).toBeUndefined();

    const before = Date.now();
    libraryStore.updateEntry('steam-501', { status: 'Playing' });
    const first = journeyStore.getEntry('steam-501')?.firstPlayedAt;
    expect(first).toBeDefined();
    expect(new Date(first!).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('a later status change never moves the first-played date forward', () => {
    libraryStore.addToLibrary({ gameId: 'steam-502', status: 'Want to Play', ...base });
    libraryStore.updateEntry('steam-502', { status: 'On Hold' });
    libraryStore.updateEntry('steam-502', { status: 'Playing' });
    journeyStore.syncProgress('steam-502', { firstPlayedAt: '2024-03-01T10:00:00.000Z' });
    expect(journeyStore.getEntry('steam-502')?.firstPlayedAt).toBe('2024-03-01T10:00:00.000Z');

    libraryStore.updateEntry('steam-502', { status: 'On Hold' });
    libraryStore.updateEntry('steam-502', { status: 'Playing' });
    journeyStore.syncProgress('steam-502', { firstPlayedAt: new Date().toISOString() });
    expect(journeyStore.getEntry('steam-502')?.firstPlayedAt).toBe('2024-03-01T10:00:00.000Z');
  });

  it('journey record() keeps the earliest first-played date too', () => {
    const row = { gameId: 'steam-503', title: 'X', genre: [], platform: [], status: 'Playing' as const, hoursPlayed: 0, rating: 0 };
    journeyStore.record({ ...row, firstPlayedAt: '2023-01-01T00:00:00.000Z' });
    journeyStore.record({ ...row, firstPlayedAt: '2026-01-01T00:00:00.000Z' });
    expect(journeyStore.getEntry('steam-503')?.firstPlayedAt).toBe('2023-01-01T00:00:00.000Z');
    journeyStore.record({ ...row, firstPlayedAt: '1970-01-01T00:00:00.000Z' });
    expect(journeyStore.getEntry('steam-503')?.firstPlayedAt).toBe('2023-01-01T00:00:00.000Z');
  });
});

describe('status-change provenance', () => {
  it('records the source passed by the caller; ordinary edits carry none', () => {
    libraryStore.addToLibrary({ gameId: 'steam-601', status: 'Playing', ...base });
    libraryStore.updateEntry('steam-601', { status: 'On Hold' }, { source: 'auto-hold' });
    libraryStore.updateEntry('steam-601', { status: 'Completed' });
    const rows = statusHistoryStore.getForGame('steam-601');
    expect(rows.map(r => [r.newStatus, r.source])).toEqual([
      ['Playing', undefined],
      ['On Hold', 'auto-hold'],
      ['Completed', undefined],
    ]);
  });

  it('survives export and import', () => {
    statusHistoryStore.record('steam-602', 'Y', 'Playing', 'On Hold', { source: 'auto-hold' });
    const dump = statusHistoryStore.exportData();
    statusHistoryStore.clear();
    statusHistoryStore.importData(dump);
    expect(statusHistoryStore.getForGame('steam-602')[0].source).toBe('auto-hold');
  });

  it('custom games now record status history', () => {
    const g = customGameStore.addGame({ title: 'Homebrew', platform: ['Windows'], status: 'Want to Play' });
    customGameStore.updateGame(g.id, { status: 'Playing' });
    const rows = statusHistoryStore.getForGame(g.id);
    expect(rows.map(r => [r.previousStatus, r.newStatus])).toEqual([[null, 'Want to Play'], ['Want to Play', 'Playing']]);
    customGameStore.removeGame(g.id);
  });
});

describe('buildLogEvents (Captain\'s Log markers)', () => {
  const row = (newStatus: StatusChangeEntry['newStatus'], previousStatus: StatusChangeEntry['previousStatus'], timestamp: string, source?: StatusChangeEntry['source']): StatusChangeEntry =>
    ({ gameId: 'g', title: 'G', newStatus, previousStatus, timestamp, ...(source ? { source } : {}) });

  it('Started, On Hold, Resumed, Completed in order, with auto flags', () => {
    const events = buildLogEvents([
      row('Want to Play', null, '2026-01-01T00:00:00.000Z'),
      row('Playing', 'Want to Play', '2026-01-05T00:00:00.000Z'),
      row('On Hold', 'Playing', '2026-02-10T00:00:00.000Z', 'auto-hold'),
      row('Playing', 'On Hold', '2026-03-01T00:00:00.000Z', 'auto-promote'),
      row('Playing Now', 'Playing', '2026-03-01T01:00:00.000Z'),
      row('Completed', 'Playing', '2026-04-01T00:00:00.000Z'),
    ]).get('g')!;
    expect(events.map(e => [e.kind, e.auto])).toEqual([
      ['started', false],
      ['paused', true],
      ['resumed', true],
      ['completed', false],
    ]);
  });

  it('ignores rows with bad timestamps and On Hold that did not come from Playing', () => {
    const events = buildLogEvents([
      row('On Hold', 'Want to Play', '2026-01-01T00:00:00.000Z'),
      row('Playing', 'On Hold', 'not a date'),
    ]);
    expect(events.get('g')).toBeUndefined();
  });
});
