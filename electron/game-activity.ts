/**
 * Edge-triggered "is any game being played" signal from session-tracker.
 *
 * Kept out of session-tracker.ts so main-process consumers (the Ollama
 * resource policy) can subscribe without importing the tracker, and so the
 * edge logic is testable without the tracker's electron / process-list deps.
 */
import { logger } from './safe-logger.js';

type GameActivityListener = (active: boolean) => void;

let listener: GameActivityListener | null = null;
let lastActive = false;

/** Register the single consumer (main.ts). Pass null to detach. */
export function setGameActivityListener(fn: GameActivityListener | null): void {
  listener = fn;
}

/**
 * Report the current number of active sessions. The listener fires only when
 * the count crosses zero in either direction (0 → n: a game started,
 * n → 0: the last one ended).
 */
export function reportGameActivity(activeCount: number): void {
  const active = activeCount > 0;
  if (active === lastActive) return;
  lastActive = active;
  try {
    listener?.(active);
  } catch (err) {
    logger.error('[GameActivity] Listener failed:', err);
  }
}

/** Test seam: forget the last reported state and the listener. */
export function resetGameActivityForTests(): void {
  listener = null;
  lastActive = false;
}
