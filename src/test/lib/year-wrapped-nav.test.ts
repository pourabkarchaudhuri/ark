import { describe, expect, it } from 'vitest';
import {
  canGoNext,
  canGoPrev,
  resolveSwipeNavAction,
  resolveTapNavAction,
} from '@/lib/year-wrapped-nav';

describe('year-wrapped-nav', () => {
  const TOTAL = 14;

  it('canGoPrev / canGoNext boundaries', () => {
    expect(canGoPrev(0)).toBe(false);
    expect(canGoPrev(1)).toBe(true);
    expect(canGoNext(0, TOTAL)).toBe(true);
    expect(canGoNext(TOTAL - 1, TOTAL)).toBe(false);
  });

  it('resolves tap against full overlay width (not child rect)', () => {
    // Overlay: left=0, width=1000. Click at x=100 (left half) on slide 2 → prev
    expect(resolveTapNavAction(100, 0, 1000, 2, TOTAL)).toBe('prev');
    // Right half → next
    expect(resolveTapNavAction(800, 0, 1000, 2, TOTAL)).toBe('next');
  });

  it('does not soft-lock: left tap on slide 0 is none, right advances', () => {
    expect(resolveTapNavAction(100, 0, 1000, 0, TOTAL)).toBe('none');
    expect(resolveTapNavAction(900, 0, 1000, 0, TOTAL)).toBe('next');
  });

  it('does not soft-lock: right tap on finale is none, left goes back', () => {
    expect(resolveTapNavAction(900, 0, 1000, TOTAL - 1, TOTAL)).toBe('none');
    expect(resolveTapNavAction(100, 0, 1000, TOTAL - 1, TOTAL)).toBe('prev');
  });

  it('handles offset containers (e.g. not full window)', () => {
    // container left=200, width=600 → midpoint at clientX 500
    expect(resolveTapNavAction(499, 200, 600, 1, TOTAL)).toBe('prev');
    expect(resolveTapNavAction(500, 200, 600, 1, TOTAL)).toBe('next');
  });

  it('resolves swipe gestures', () => {
    expect(resolveSwipeNavAction(300, 200, 1, TOTAL)).toBe('next'); // swipe left
    expect(resolveSwipeNavAction(200, 300, 1, TOTAL)).toBe('prev'); // swipe right
    expect(resolveSwipeNavAction(200, 220, 1, TOTAL)).toBe('none'); // tiny move
    expect(resolveSwipeNavAction(300, 200, 0, TOTAL)).toBe('next');
    expect(resolveSwipeNavAction(200, 300, 0, TOTAL)).toBe('none');
  });
});
