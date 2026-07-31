/**
 * Cross-store linked-id helpers for Oracle candidate exclusion / dismiss.
 */

export interface LinkedIdEntry {
  gameId: string;
  secondaryGameId?: string;
  secondaryId?: string;
}

/** Build exclusion set: primary library ids + secondaryGameId twins. */
export function buildLinkedExclusionIds(
  libraryEntries: ReadonlyArray<LinkedIdEntry>,
  extraIds: Iterable<string> = [],
): Set<string> {
  const ids = new Set<string>();
  for (const id of extraIds) {
    if (id) ids.add(id);
  }
  for (const e of libraryEntries) {
    if (e.gameId) ids.add(e.gameId);
    const sec = e.secondaryGameId || e.secondaryId;
    if (sec) ids.add(sec);
  }
  return ids;
}

/**
 * Expand dismissed ids with cross-store twins known from library / browse rows.
 */
export function expandDismissedWithLinked(
  dismissedIds: ReadonlyArray<string>,
  linkedEntries: ReadonlyArray<LinkedIdEntry>,
): string[] {
  const out = new Set(dismissedIds.filter(Boolean));
  if (out.size === 0) return [];

  const primaryToSecondary = new Map<string, string>();
  const secondaryToPrimary = new Map<string, string>();
  for (const e of linkedEntries) {
    const sec = e.secondaryGameId || e.secondaryId;
    if (!e.gameId || !sec) continue;
    primaryToSecondary.set(e.gameId, sec);
    secondaryToPrimary.set(sec, e.gameId);
  }

  for (const id of [...out]) {
    const sec = primaryToSecondary.get(id);
    if (sec) out.add(sec);
    const primary = secondaryToPrimary.get(id);
    if (primary) out.add(primary);
  }

  return [...out];
}

/** True if candidate id or its secondary is already owned / seen. */
export function isLinkedExcluded(
  gameId: string,
  secondaryId: string | undefined,
  exclusion: Set<string>,
): boolean {
  if (!gameId || exclusion.has(gameId)) return true;
  if (secondaryId && exclusion.has(secondaryId)) return true;
  return false;
}
