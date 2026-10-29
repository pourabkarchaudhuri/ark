/**
 * The two automatic status rules and their on/off switches (stored per profile in localStorage,
 * which is what the session tracker and the idle sweep read).
 *
 *   Auto On Hold — a Playing game with no play for 4 weeks moves to On Hold (default ON).
 *   Auto Playing — a 10+ minute play session moves a Want to Play game to Playing (default OFF).
 */
export const AUTO_ON_HOLD_LS_KEY = 'ark:autoOnHoldTransition';
export const AUTO_STATUS_TRANSITION_LS_KEY = 'ark:autoStatusTransition';

function read(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: boolean): void {
  try {
    window.localStorage?.setItem(key, value ? 'true' : 'false');
  } catch {
    /* storage unavailable: the default applies */
  }
}

export function getAutoOnHoldEnabled(): boolean {
  return read(AUTO_ON_HOLD_LS_KEY) !== 'false';
}

export function setAutoOnHoldEnabled(enabled: boolean): void {
  write(AUTO_ON_HOLD_LS_KEY, enabled);
}

export function getAutoStatusTransitionEnabled(): boolean {
  return read(AUTO_STATUS_TRANSITION_LS_KEY) === 'true';
}

export function setAutoStatusTransitionEnabled(enabled: boolean): void {
  write(AUTO_STATUS_TRANSITION_LS_KEY, enabled);
}
