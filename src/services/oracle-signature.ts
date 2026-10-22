/**
 * Pure fragments for Oracle library/cache signature (hours bucket + dismiss fp).
 */

import type { DismissMeta } from '@/services/hard-negative';

/** Compact fingerprint for notes / dismiss meta; avoids huge cache keys. */
export function djb2Fingerprint(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

/**
 * Coarse log-scale hours bucket so meaningful engagement shifts invalidate the
 * Oracle cache. Half-octave steps: 0 → 0, (0, √2) → 1, then a new bucket each
 * time hours grow by ~41% (2h, 2.8h, 4h, 5.7h, 8h, 11h, 16h …). The previous
 * floor(hours) bucket changed every played hour, so an active session forced
 * a full Oracle recompute roughly once an hour per game.
 */
export function hoursPlayedBucket(hoursPlayed: number | undefined | null): number {
  const h = typeof hoursPlayed === 'number' && Number.isFinite(hoursPlayed) ? hoursPlayed : 0;
  if (h <= 0) return 0;
  return 1 + Math.floor(Math.log2(Math.max(1, h)) * 2);
}

/**
 * Sorted dismissed ids + djb2 of franchiseBase/developer/at metadata.
 * Included in Oracle result-cache signature so restore cannot resurrect muted siblings.
 */
export function fingerprintDismissals(dismissals: ReadonlyArray<DismissMeta>): string {
  const sorted = [...dismissals]
    .filter(d => d?.gameId)
    .sort((a, b) => a.gameId.localeCompare(b.gameId));
  const ids = sorted.map(d => d.gameId).join(',');
  const meta = sorted
    .map(d => `${d.franchiseBase ?? ''}|${d.developer ?? ''}|${typeof d.at === 'number' ? d.at : 0}`)
    .join(';');
  return `${ids}#${djb2Fingerprint(meta)}`;
}

/** Sorted thumbs-up ids — included in Oracle signature so restore cannot ignore new ups. */
export function fingerprintThumbsUp(ids: ReadonlyArray<string>): string {
  const sorted = [...ids].filter(Boolean).sort((a, b) => a.localeCompare(b));
  return djb2Fingerprint(sorted.join(','));
}
