/**
 * Overlay HUD detail levels — pure helpers shared by main (window sizing /
 * hotkeys) and the overlay renderer (layout classes).
 *
 * collapsed → compact → expanded → collapsed
 */

export type OverlayDetailLevel = 'collapsed' | 'compact' | 'expanded';

export const OVERLAY_DETAIL_LEVELS: readonly OverlayDetailLevel[] = [
  'collapsed',
  'compact',
  'expanded',
] as const;

/** Default — compact name + timer (not the collapsed-only pill). */
export const DEFAULT_OVERLAY_DETAIL_LEVEL: OverlayDetailLevel = 'compact';

/** Global shortcuts (Electron accelerator strings). */
export const OVERLAY_TOGGLE_HOTKEY = 'Control+Shift+O';
export const OVERLAY_CYCLE_HOTKEY = 'Control+Shift+D';

/** Human-readable labels for Settings hints. */
export const OVERLAY_TOGGLE_HOTKEY_LABEL = 'Ctrl+Shift+O';
export const OVERLAY_CYCLE_HOTKEY_LABEL = 'Ctrl+Shift+D';

/**
 * Always-visible on-HUD shortcut strip (compact + expanded).
 * Short key letters from the toggle / cycle accelerators — not full Ctrl+Shift chords.
 */
export const OVERLAY_SHORTCUT_HINT_LABEL = 'O dismiss · D cycle';

/** DIP sizes per level — window is resized so idle chrome doesn't cover the game. */
export const OVERLAY_SIZES: Record<OverlayDetailLevel, { width: number; height: number }> = {
  collapsed: { width: 88, height: 40 },
  /** Compact includes a one-line shortcut footer. */
  compact: { width: 220, height: 78 },
  /** Expanded includes the always-visible O/D hint strip. */
  expanded: { width: 280, height: 136 },
};

export function isOverlayDetailLevel(value: unknown): value is OverlayDetailLevel {
  return value === 'collapsed' || value === 'compact' || value === 'expanded';
}

/** Advance one step: collapsed → compact → expanded → collapsed. */
export function cycleDetailLevel(current: OverlayDetailLevel): OverlayDetailLevel {
  const idx = OVERLAY_DETAIL_LEVELS.indexOf(current);
  const safe = idx < 0 ? 0 : idx;
  return OVERLAY_DETAIL_LEVELS[(safe + 1) % OVERLAY_DETAIL_LEVELS.length]!;
}

export function overlaySizeForLevel(level: OverlayDetailLevel): { width: number; height: number } {
  return OVERLAY_SIZES[level] ?? OVERLAY_SIZES[DEFAULT_OVERLAY_DETAIL_LEVEL];
}
