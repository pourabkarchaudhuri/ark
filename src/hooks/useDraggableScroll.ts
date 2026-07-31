/**
 * useDraggableScroll — click-and-drag panning for horizontal scroll containers.
 *
 * Attaches pointer listeners to the given element so the user can grab it with
 * the mouse and drag left/right to pan the scroll position, in addition to
 * existing wheel / arrow-button scrolling.
 *
 * Design notes:
 *   - A small movement threshold (default 5px) prevents a plain click on a card
 *     from being interpreted as a drag — card onClick still works normally.
 *   - Drags started on interactive descendants (button, a, input, or any
 *     element carrying `data-no-drag`) are ignored, so the shelf arrow buttons
 *     and card action buttons keep working.
 *   - Uses `setPointerCapture` so the drag continues even if the pointer
 *     leaves the container mid-drag.
 *   - When a drag actually occurred, we install a one-shot capture-phase click
 *     listener that swallows the trailing click so the card underneath the
 *     pointer doesn't navigate.
 */

import { useEffect, type RefObject } from 'react';

export interface UseDraggableScrollOptions {
  /** Disable the drag behavior. Default: true. */
  enabled?: boolean;
  /** Pixels of movement before a drag starts. Default: 5. */
  threshold?: number;
}

export function useDraggableScroll(
  ref: RefObject<HTMLElement>,
  opts: UseDraggableScrollOptions = {},
): void {
  const enabled = opts.enabled !== false;
  const threshold = opts.threshold ?? 5;

  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;

    let isPointerDown = false;
    let isDragging = false;
    let startX = 0;
    let startScrollLeft = 0;
    let activePointerId: number | null = null;
    const prevCursor = el.style.cursor;

    const finish = (releaseCapture: boolean) => {
      const wasDragging = isDragging;
      isPointerDown = false;
      isDragging = false;
      el.style.cursor = prevCursor;
      if (releaseCapture && activePointerId !== null) {
        try { el.releasePointerCapture(activePointerId); } catch { /* ignore */ }
      }
      activePointerId = null;

      if (wasDragging) {
        // Swallow the click that immediately follows the pointerup so the
        // card under the cursor doesn't navigate.
        const suppressClick = (ev: MouseEvent) => {
          ev.stopPropagation();
          ev.preventDefault();
          window.removeEventListener('click', suppressClick, true);
        };
        window.addEventListener('click', suppressClick, true);
        // Failsafe: if no click arrives (rare), tear it down after a tick.
        window.setTimeout(() => {
          window.removeEventListener('click', suppressClick, true);
        }, 300);
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      // Only left-button mouse or pen drags. Touch has native scroll already.
      if (e.button !== 0) return;
      if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;

      const target = e.target as Element | null;
      if (target && typeof target.closest === 'function'
          && target.closest('button, a, input, [data-no-drag]')) {
        return;
      }

      isPointerDown = true;
      isDragging = false;
      startX = e.clientX;
      startScrollLeft = el.scrollLeft;
      activePointerId = e.pointerId;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isPointerDown) return;
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      const dx = e.clientX - startX;
      if (!isDragging) {
        if (Math.abs(dx) < threshold) return;
        isDragging = true;
        el.style.cursor = 'grabbing';
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
      // Inverted so dragging right pans the shelf right (scrollLeft decreases).
      el.scrollLeft = startScrollLeft - dx;
      e.preventDefault();
    };

    const onPointerUp = () => finish(true);
    const onPointerCancel = () => finish(true);
    const onPointerLeave = () => {
      // Only end if a drag isn't in-flight — an in-flight drag stays alive via
      // pointer capture even when the pointer briefly leaves the element.
      if (isPointerDown && !isDragging) finish(false);
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerCancel);
    el.addEventListener('pointerleave', onPointerLeave);

    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerCancel);
      el.removeEventListener('pointerleave', onPointerLeave);
      el.style.cursor = prevCursor;
    };
  }, [ref, enabled, threshold]);
}
