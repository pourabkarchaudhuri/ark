/**
 * Hook for detecting and tracking installed games on the system
 * Uses Electron's installed games API to scan for Steam and Epic games
 */

import { useState, useEffect, useCallback, useRef } from 'react';

interface InstalledGame {
  appId: number;
  name: string;
  installPath: string;
  platform: 'steam' | 'epic' | 'other';
  sizeOnDisk?: number;
}

interface UseInstalledGamesResult {
  /** Set of installed Steam AppIDs for quick lookup */
  installedAppIds: Set<number>;
  /** Full list of installed games with details */
  installedGames: InstalledGame[];
  /** Whether the scan is currently in progress */
  loading: boolean;
  /** Any error that occurred during scanning */
  error: string | null;
  /** Check if a specific Steam AppID is installed */
  isInstalled: (appId: number) => boolean;
  /** Refresh the installed games list */
  refresh: () => Promise<void>;
}

// Check if running in Electron
function isElectron(): boolean {
  return typeof window !== 'undefined' && typeof window.installedGames !== 'undefined';
}

/**
 * Hook to get installed games from the system
 * Automatically scans on mount and provides quick lookup
 */
export function useInstalledGames(): UseInstalledGamesResult {
  const [installedAppIds, setInstalledAppIds] = useState<Set<number>>(new Set());
  const [installedGames, setInstalledGames] = useState<InstalledGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasFetched = useRef(false);

  const fetchInstalledGames = useCallback(async (forceRefresh = false) => {
    if (!isElectron()) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Get just the AppIDs for quick lookup (lighter operation)
      const appIds = await window.installedGames!.getInstalledAppIds();
      setInstalledAppIds(new Set(appIds));

      // Also get full details if needed for other features
      const games = await window.installedGames!.getInstalled(forceRefresh);
      setInstalledGames(games);

      console.log(`[useInstalledGames] Found ${appIds.length} installed Steam games`);
    } catch (err) {
      console.error('[useInstalledGames] Error fetching installed games:', err);
      setError(err instanceof Error ? err.message : 'Failed to scan installed games');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount (only once)
  useEffect(() => {
    if (!hasFetched.current) {
      hasFetched.current = true;
      fetchInstalledGames();
    }
  }, [fetchInstalledGames]);

  // Check if a specific game is installed
  const isInstalled = useCallback((appId: number): boolean => {
    return installedAppIds.has(appId);
  }, [installedAppIds]);

  // Refresh the installed games list
  const refresh = useCallback(async () => {
    await fetchInstalledGames(true);
  }, [fetchInstalledGames]);

  return {
    installedAppIds,
    installedGames,
    loading,
    error,
    isInstalled,
    refresh,
  };
}

/**
 * Simple check for whether a specific AppID is installed
 * Use this for lightweight checks without the full hook
 */
export async function checkGameInstalled(appId: number): Promise<boolean> {
  if (!isElectron()) {
    return false;
  }

  try {
    const appIds = await window.installedGames!.getInstalledAppIds();
    return appIds.includes(appId);
  } catch {
    return false;
  }
}
