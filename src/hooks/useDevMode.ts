/**
 * Developer Mode preference — localStorage-backed, sync-readable.
 *
 * Uses useSyncExternalStore so all consumers re-render when the
 * toggle changes (even across components in the same render tree).
 */

import { useSyncExternalStore, useCallback } from 'react';

const LS_KEY = 'ark-developer-mode';

const listeners = new Set<() => void>();
function notify() { listeners.forEach(fn => fn()); }

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot(): boolean {
  try { return localStorage.getItem(LS_KEY) === '1'; } catch { return false; }
}

export function setDevMode(enabled: boolean) {
  try { localStorage.setItem(LS_KEY, enabled ? '1' : '0'); } catch { /* quota */ }
  notify();
}

export function isDevMode(): boolean {
  return getSnapshot();
}

export function useDevMode(): [boolean, (v: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const toggle = useCallback((v: boolean) => setDevMode(v), []);
  return [enabled, toggle];
}
