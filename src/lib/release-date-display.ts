/**
 * Display helpers for dates that may be Steam/Epic display text rather than
 * parseable timestamps ('Coming soon', 'Q4 2026', missing news dates).
 */

const REGISTRY_TEXT_MAX = 12;

function parsedOrNull(value: string | undefined | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Ark terminal panel REL:: line. The journey entry's date wins when it parses;
 * otherwise the library cachedMeta date (a game added before release keeps a
 * stale 'Coming soon' on its journey row). If neither parses, the raw text is
 * shown uppercased and truncated instead of 'Invalid Date'.
 */
export function formatRegistryReleaseDate(
  entryDate: string | undefined | null,
  metaDate: string | undefined | null,
): string | null {
  const d = parsedOrNull(entryDate) ?? parsedOrNull(metaDate);
  if (d) return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
  const raw = (entryDate || metaDate || '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  return upper.length > REGISTRY_TEXT_MAX ? upper.slice(0, REGISTRY_TEXT_MAX - 1) + '…' : upper;
}

/** News card date line (unix seconds); null when the item has no usable date. */
export function newsDateLabel(seconds: number | undefined | null): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Epic article date string → unix seconds, 0 when missing or unparseable (was NaN). */
export function newsDateSeconds(date: string | undefined | null): number {
  const t = date ? Date.parse(date) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}
