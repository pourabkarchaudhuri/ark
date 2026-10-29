/**
 * Status-change provenance helpers (see StatusChangeEntry.source).
 */
import type { StatusChangeEntry } from '@/types/game';

/**
 * Bookkeeping rows: changes Ark made on its own (idle On Hold, a status copied from the same game on
 * another store) and the user undoing one. They are real history but say nothing about the user's
 * activity, so counts (badges, Year Wrapped, churn detection) skip them. Rows without a source
 * (written before v1.0.87) always count, so existing totals never drop.
 */
export function isBookkeepingStatusChange(row: Pick<StatusChangeEntry, 'source'>): boolean {
  return row.source === 'auto-hold' || row.source === 'sync' || row.source === 'undo';
}

/** True when the game's latest move into On Hold was the automatic idle sweep. */
export function isAutoHeld(rows: readonly StatusChangeEntry[]): boolean {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].newStatus === 'On Hold') return rows[i].source === 'auto-hold';
  }
  return false;
}
