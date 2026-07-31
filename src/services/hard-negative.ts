/**
 * Hard-negative suppress expansion (F3).
 * Franchise mute 14d / developer mute 7d from dismiss metadata.
 */

import { extractFranchiseBase } from '@/services/franchise';

export interface DismissMeta {
  gameId: string;
  at: number;
  franchiseBase?: string;
  developer?: string;
  /** Optional title used to derive franchiseBase when missing. */
  title?: string;
}

export interface HardNegCatalogRow {
  gameId: string;
  title: string;
  developer?: string;
}

export const FRANCHISE_MUTE_MS = 14 * 24 * 60 * 60 * 1000;
export const DEVELOPER_MUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const HARD_NEG_EXPAND_CAP = 200;

/**
 * Expand exact dismiss ids with same-franchise / same-developer catalog ids
 * inside the mute windows. Caps expansion at HARD_NEG_EXPAND_CAP extra ids.
 */
export function expandHardNegativeIds(
  dismissals: ReadonlyArray<DismissMeta>,
  catalog: ReadonlyArray<HardNegCatalogRow>,
  nowMs: number = Date.now(),
): string[] {
  const out = new Set<string>();
  const franchiseBases = new Set<string>();
  const developers = new Set<string>();

  for (const d of dismissals) {
    if (!d?.gameId) continue;
    out.add(d.gameId);
    const age = nowMs - (typeof d.at === 'number' ? d.at : 0);

    let base = (d.franchiseBase || '').toLowerCase().trim();
    if (!base && d.title) base = extractFranchiseBase(d.title);

    if (base && age <= FRANCHISE_MUTE_MS) franchiseBases.add(base);

    const dev = (d.developer || '').toLowerCase().trim();
    if (dev && age <= DEVELOPER_MUTE_MS) developers.add(dev);
  }

  if (franchiseBases.size === 0 && developers.size === 0) {
    return [...out];
  }

  let expanded = 0;
  for (const row of catalog) {
    if (expanded >= HARD_NEG_EXPAND_CAP) break;
    if (!row.gameId || out.has(row.gameId)) continue;

    const rowBase = extractFranchiseBase(row.title || '');
    const rowDev = (row.developer || '').toLowerCase().trim();

    const franchiseHit = !!rowBase && franchiseBases.has(rowBase);
    const developerHit = !!rowDev && developers.has(rowDev);
    if (!franchiseHit && !developerHit) continue;

    out.add(row.gameId);
    expanded++;
  }

  return [...out];
}
