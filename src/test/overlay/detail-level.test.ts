import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERLAY_DETAIL_LEVEL,
  OVERLAY_CYCLE_HOTKEY,
  OVERLAY_CYCLE_HOTKEY_LABEL,
  OVERLAY_DETAIL_LEVELS,
  OVERLAY_SHORTCUT_HINT_LABEL,
  OVERLAY_SIZES,
  OVERLAY_TOGGLE_HOTKEY,
  OVERLAY_TOGGLE_HOTKEY_LABEL,
  coerceOverlayDetailLevel,
  cycleDetailLevel,
  isOverlayDetailLevel,
  overlaySizeForLevel,
} from '@/overlay/detail-level';

describe('overlay detail-level helpers', () => {
  it('defaults to compact (name + timer)', () => {
    expect(DEFAULT_OVERLAY_DETAIL_LEVEL).toBe('compact');
  });

  it('exposes only collapsed and compact levels', () => {
    expect(OVERLAY_DETAIL_LEVELS).toEqual(['collapsed', 'compact']);
  });

  it('cycles collapsed ↔ compact', () => {
    expect(cycleDetailLevel('collapsed')).toBe('compact');
    expect(cycleDetailLevel('compact')).toBe('collapsed');
  });

  it('walks the full ring without skipping', () => {
    let level = DEFAULT_OVERLAY_DETAIL_LEVEL;
    const seen = new Set<string>();
    for (let i = 0; i < OVERLAY_DETAIL_LEVELS.length; i++) {
      seen.add(level);
      level = cycleDetailLevel(level);
    }
    expect(seen.size).toBe(OVERLAY_DETAIL_LEVELS.length);
    expect(level).toBe(DEFAULT_OVERLAY_DETAIL_LEVEL);
  });

  it('returns a dedicated DIP size for every level', () => {
    for (const level of OVERLAY_DETAIL_LEVELS) {
      const size = overlaySizeForLevel(level);
      expect(size.width).toBe(OVERLAY_SIZES[level].width);
      expect(size.height).toBe(OVERLAY_SIZES[level].height);
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
    }
  });

  it('keeps collapsed smaller than compact', () => {
    const a = overlaySizeForLevel('collapsed');
    const b = overlaySizeForLevel('compact');
    expect(a.width * a.height).toBeLessThan(b.width * b.height);
  });

  it('type-guards detail levels (expanded is no longer valid)', () => {
    expect(isOverlayDetailLevel('collapsed')).toBe(true);
    expect(isOverlayDetailLevel('compact')).toBe(true);
    expect(isOverlayDetailLevel('expanded')).toBe(false);
    expect(isOverlayDetailLevel('full')).toBe(false);
    expect(isOverlayDetailLevel(null)).toBe(false);
  });

  it('coerces legacy expanded to compact', () => {
    expect(coerceOverlayDetailLevel('expanded')).toBe('compact');
    expect(coerceOverlayDetailLevel('collapsed')).toBe('collapsed');
    expect(coerceOverlayDetailLevel('compact')).toBe('compact');
    expect(coerceOverlayDetailLevel('full')).toBe(DEFAULT_OVERLAY_DETAIL_LEVEL);
    expect(coerceOverlayDetailLevel(null)).toBe(DEFAULT_OVERLAY_DETAIL_LEVEL);
  });

  it('uses Super+Shift+D for cycle and Control+Shift+O for toggle', () => {
    expect(OVERLAY_CYCLE_HOTKEY).toBe('Super+Shift+D');
    expect(OVERLAY_CYCLE_HOTKEY_LABEL).toBe('Shift+Win+D');
    expect(OVERLAY_TOGGLE_HOTKEY).toBe('Control+Shift+O');
    expect(OVERLAY_TOGGLE_HOTKEY_LABEL).toBe('Ctrl+Shift+O');
  });

  it('builds compact shortcut hint from shared cycle label', () => {
    expect(OVERLAY_SHORTCUT_HINT_LABEL).toContain(OVERLAY_CYCLE_HOTKEY_LABEL);
    expect(OVERLAY_SHORTCUT_HINT_LABEL).toMatch(/O dismiss/i);
    expect(OVERLAY_SHORTCUT_HINT_LABEL.toLowerCase()).toContain('denser');
  });
});
