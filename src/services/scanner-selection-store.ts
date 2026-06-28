/**
 * ScannerSelection Store
 *
 * Phase 2 attention primitive. Unifies all the "what is the user looking at?" picking
 * surfaces into a single store with mode-aware dwell timers:
 *   - 'observer' — default; OrbitControls drives the view
 *   - 'probe' — explicit modal flight mode (Probe ship)
 *   - 'stargazer' — explicit modal constellation-authoring mode
 *   - 'hover' — passive tracking of pointer-over node for dwell-triggered surfaces (Whisper, Codex)
 *
 * The store does NOT spin its own RAF. The Galaxy animate loop ticks `processDwellTimers(now)`
 * every frame; this keeps the dwell budget shared with the same heartbeat the rest of the
 * cosmos already pays for.
 */

export type ScannerMode = 'observer' | 'probe' | 'stargazer' | 'hover';

interface DwellTimer {
  startMs: number;
  thresholdMs: number;
  cb: (gameId: string, elapsedMs: number) => void;
  fired: boolean;
}

class ScannerSelectionStore {
  private _listeners = new Set<() => void>();
  private _mode: ScannerMode = 'observer';
  private _nodeIds: string[] = [];
  /** Per-gameId dwell timers. Cleared on mode transition + on canvas leave. */
  private _timers = new Map<string, DwellTimer>();
  /** Current hovered/focused node — for HUD subscribers that just want "the one node". */
  private _primaryId: string | null = null;

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  private _notify(): void { this._listeners.forEach((fn) => fn()); }

  get mode(): ScannerMode { return this._mode; }
  get nodeIds(): readonly string[] { return this._nodeIds; }
  get primaryId(): string | null { return this._primaryId; }
  /** Diagnostic — used by verification gate. */
  get _activeTimerCount(): number { return this._timers.size; }

  /**
   * Set mode. Clears dwell timers + primary on transition.
   * Caller is responsible for toggling OrbitControls.enabled to match.
   */
  setMode(mode: ScannerMode): void {
    if (mode === this._mode) return;
    this._mode = mode;
    this._timers.clear();
    if (mode !== 'hover') {
      this._primaryId = null;
      this._nodeIds = [];
    }
    this._notify();
  }

  /**
   * Set the primary node being hovered/observed. Resets any in-flight dwell timer for that node
   * (intentional — first time the pointer lands counts as fresh dwell).
   */
  setPrimary(gameId: string | null): void {
    if (gameId === this._primaryId) return;
    const prev = this._primaryId;
    this._primaryId = gameId;
    // When pointer moves to a new node, drop any timer that was tracking the old one
    // unless caller explicitly re-registers via registerDwell.
    if (prev && prev !== gameId) this._timers.delete(prev);
    if (gameId) this._nodeIds = [gameId];
    else this._nodeIds = [];
    this._notify();
  }

  /**
   * Register a dwell-triggered callback for a gameId. Returns an unsubscribe function.
   * If called repeatedly for the same gameId, only the latest registration wins.
   */
  registerDwell(
    gameId: string,
    thresholdMs: number,
    cb: (gameId: string, elapsedMs: number) => void,
  ): () => void {
    this._timers.set(gameId, {
      startMs: performance.now(),
      thresholdMs,
      cb,
      fired: false,
    });
    return () => {
      this._timers.delete(gameId);
    };
  }

  /**
   * Drive dwell timers forward. Call from the Galaxy animate loop.
   * Each timer fires AT MOST ONCE — past-threshold timers stay in the map so the
   * UI knows the dwell has elapsed, but the callback is one-shot.
   */
  processDwellTimers(nowMs: number): void {
    for (const [gameId, timer] of this._timers) {
      if (timer.fired) continue;
      const elapsed = nowMs - timer.startMs;
      if (elapsed >= timer.thresholdMs) {
        timer.fired = true;
        try { timer.cb(gameId, elapsed); } catch (err) { console.warn('[ScannerSelection] dwell cb threw:', err); }
      }
    }
  }

  /** Remove all dwell timers — call on canvas leave or scene unmount. */
  cancelAll(): void {
    if (this._timers.size === 0) return;
    this._timers.clear();
    this._notify();
  }
}

export const scannerSelectionStore = new ScannerSelectionStore();
