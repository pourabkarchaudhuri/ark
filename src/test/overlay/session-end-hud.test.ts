import { describe, it, expect } from 'vitest';

/**
 * Pure gate used by session-tracker updateOverlayVisibility:
 * - show is edge-triggered (only when latch was false)
 * - hide is level-triggered (always when activeCount === 0) to repair desync
 */
function overlayVisibilityAction(
  activeCount: number,
  lastShouldShow: boolean,
): { shouldShow: boolean; invoke: boolean; nextLatch: boolean } {
  const shouldShow = activeCount > 0;
  if (!shouldShow) {
    return { shouldShow: false, invoke: true, nextLatch: false };
  }
  if (lastShouldShow) {
    return { shouldShow: true, invoke: false, nextLatch: true };
  }
  return { shouldShow: true, invoke: true, nextLatch: true };
}

describe('overlay session-end visibility gate', () => {
  it('always invokes hide when no active sessions (repairs hotkey/settings desync)', () => {
    // Desync: HWND was shown via Settings but latch stayed false
    const a = overlayVisibilityAction(0, false);
    expect(a.invoke).toBe(true);
    expect(a.shouldShow).toBe(false);
    expect(a.nextLatch).toBe(false);

    const b = overlayVisibilityAction(0, true);
    expect(b.invoke).toBe(true);
    expect(b.shouldShow).toBe(false);
  });

  it('invokes show only on 0→1 edge', () => {
    expect(overlayVisibilityAction(1, false).invoke).toBe(true);
    expect(overlayVisibilityAction(1, true).invoke).toBe(false);
  });

  it('starting a new session after clear can show again', () => {
    let latch = true;
    const end = overlayVisibilityAction(0, latch);
    expect(end.invoke).toBe(true);
    latch = end.nextLatch;
    const restart = overlayVisibilityAction(1, latch);
    expect(restart.invoke).toBe(true);
    expect(restart.shouldShow).toBe(true);
  });
});
