/**
 * "Allow adult content" setting — localStorage-backed, default off.
 * When off, games classified as sexually explicit (by description) are hidden from browse/library.
 * Uses useSyncExternalStore so all consumers re-render when the toggle changes.
 */

import { useSyncExternalStore, useCallback } from 'react';

const LS_KEY = 'ark-allow-adult-content';

const listeners = new Set<() => void>();
function notify() {
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAllowAdultContent(allow: boolean) {
  try {
    localStorage.setItem(LS_KEY, allow ? '1' : '0');
  } catch {
    /* quota */
  }
  notify();
}

export function isAllowAdultContent(): boolean {
  return getSnapshot();
}

export function useAllowAdultContent(): [boolean, (allow: boolean) => void] {
  const allow = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const setAllow = useCallback((value: boolean) => setAllowAdultContent(value), []);
  return [allow, setAllow];
}
