/**
 * Beta features — AI Chat toolbar, cloud LLM provider settings (Gemini, Azure, Anthropic).
 * Persisted in Electron settings (default off). localStorage mirror keeps UI in sync across tabs.
 */

import { useSyncExternalStore, useCallback, useEffect } from 'react';

const LS_KEY = 'ark-beta-features';

const listeners = new Set<() => void>();
function notify() {
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function readLocal(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === '1';
  } catch {
    return false;
  }
}

function getSnapshot(): boolean {
  return readLocal();
}

/** Sync renderer cache from main process (source of truth on disk). */
export function hydrateBetaFeaturesFromMain(): void {
  if (typeof window === 'undefined' || !window.settings?.getBetaFeatures) return;
  window.settings.getBetaFeatures().then((v) => {
    try {
      localStorage.setItem(LS_KEY, v ? '1' : '0');
      notify();
    } catch {
      /* ignore */
    }
  });
}

export function setBetaFeatures(enabled: boolean) {
  try {
    localStorage.setItem(LS_KEY, enabled ? '1' : '0');
  } catch {
    /* quota */
  }
  notify();
  window.settings?.setBetaFeatures(enabled).catch(() => {});
}

export function isBetaFeatures(): boolean {
  return readLocal();
}

export function useBetaFeatures(): [boolean, (v: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, getSnapshot, () => false);

  useEffect(() => {
    hydrateBetaFeaturesFromMain();
  }, []);

  const set = useCallback((v: boolean) => setBetaFeatures(v), []);
  return [enabled, set];
}
