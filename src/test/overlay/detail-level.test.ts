import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERLAY_DETAIL_LEVEL,
  OVERLAY_DETAIL_LEVELS,
  OVERLAY_SIZES,
  cycleDetailLevel,
  isOverlayDetailLevel,
  overlaySizeForLevel,
} from '@/overlay/detail-level';

describe('overlay detail-level helpers', () => {
  it('defaults to compact (name + timer)', () => {
    expect(DEFAULT_OVERLAY_DETAIL_LEVEL).toBe('compact');
  });

  it('cycles collapsed → compact → expanded → collapsed', () => {
    expect(cycleDetailLevel('collapsed')).toBe('compact');
    expect(cycleDetailLevel('compact')).toBe('expanded');
    expect(cycleDetailLevel('expanded')).toBe('collapsed');
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

  it('keeps collapsed smaller than compact and compact smaller than expanded', () => {
    const a = overlaySizeForLevel('collapsed');
    const b = overlaySizeForLevel('compact');
    const c = overlaySizeForLevel('expanded');
    expect(a.width * a.height).toBeLessThan(b.width * b.height);
    expect(b.width * b.height).toBeLessThan(c.width * c.height);
  });

  it('type-guards detail levels', () => {
    expect(isOverlayDetailLevel('collapsed')).toBe(true);
    expect(isOverlayDetailLevel('compact')).toBe(true);
    expect(isOverlayDetailLevel('expanded')).toBe(true);
    expect(isOverlayDetailLevel('full')).toBe(false);
    expect(isOverlayDetailLevel(null)).toBe(false);
  });
});
