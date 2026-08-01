/**
 * Pure navigation helpers for Ark Wrapped.
 * Click/tap zones must be resolved against the full overlay, never a child target.
 */

export type TapNavAction = 'next' | 'prev' | 'none';

export function canGoPrev(slide: number): boolean {
  return slide > 0;
}

export function canGoNext(slide: number, totalSlides: number): boolean {
  return slide >= 0 && slide < totalSlides - 1;
}

/**
 * Resolve a click/tap into next/prev using the overlay's bounding box.
 * Left half → prev (no-op on first slide). Right half → next (no-op on finale).
 */
export function resolveTapNavAction(
  clientX: number,
  containerLeft: number,
  containerWidth: number,
  currentSlide: number,
  totalSlides: number,
): TapNavAction {
  if (containerWidth <= 0 || totalSlides <= 0) return 'none';
  const x = clientX - containerLeft;
  const forward = x >= containerWidth / 2;
  if (forward) return canGoNext(currentSlide, totalSlides) ? 'next' : 'none';
  return canGoPrev(currentSlide) ? 'prev' : 'none';
}

/** Horizontal swipe: left swipe advances, right swipe goes back. */
export function resolveSwipeNavAction(
  startX: number,
  endX: number,
  currentSlide: number,
  totalSlides: number,
  thresholdPx = 56,
): TapNavAction {
  const dx = endX - startX;
  if (Math.abs(dx) < thresholdPx) return 'none';
  if (dx < 0) return canGoNext(currentSlide, totalSlides) ? 'next' : 'none';
  return canGoPrev(currentSlide) ? 'prev' : 'none';
}
