import { useState, useEffect, useCallback, useRef } from 'react';
import { cacheStore } from '@/services/cache-store';

export interface OnlineStatus {
  isOnline: boolean;
  wasOffline: boolean;
  pendingSyncCount: number;
}

/**
 * Hook to track online/offline status and manage sync queue
 */
export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [wasOffline, setWasOffline] = useState(false);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  
  // Use ref to track previous online status to avoid stale closures
  const wasOnlineRef = useRef(navigator.onLine);

  // Update pending sync count
  const updatePendingCount = useCallback(async () => {
    try {
      const queue = await cacheStore.getSyncQueue();
      setPendingSyncCount(queue.length);
    } catch (error) {
      console.error('Failed to get sync queue:', error);
    }
  }, []);

  // Set up event listeners - using refs to avoid stale closures
  useEffect(() => {
    // Per-effect liveness flag (not a ref): StrictMode's mount-cleanup-mount
    // left a shared ref false forever, so dev builds ignored every event.
    let active = true;

    const handleOnline = () => {
      if (!active) return;
      // Check ref for previous state to avoid stale closure
      if (!wasOnlineRef.current) {
        setWasOffline(true);
      }
      wasOnlineRef.current = true;
      setIsOnline(true);
    };

    const handleOffline = () => {
      if (!active) return;
      wasOnlineRef.current = false;
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Initial sync queue count
    updatePendingCount();

    // ---- Active network probe ----
    // navigator.onLine only detects physical disconnection (Wi-Fi off, cable unplugged).
    // This probe catches "connected but no internet" by pinging a lightweight endpoint.
    const PROBE_INTERVAL_MS = 30_000; // 30 seconds
    const PROBE_TIMEOUT_MS = 12_000;  // 12 second timeout — tolerate slow networks
    const FAIL_THRESHOLD = 2;         // require N consecutive failures before flipping offline
    const RECOVER_THRESHOLD = 2;      // require N consecutive successes before flipping back online
    // Fallback for networks that block Google (corporate filters, some regions):
    // a probe only fails when BOTH endpoints fail. Host is allow-listed in electron/main.ts.
    const PROBE_URLS = [
      'https://connectivitycheck.gstatic.com/generate_204',
      'https://store.steampowered.com/favicon.ico',
    ];

    // Local (per-effect) counters — each resets on the opposite outcome.
    let failCount = 0;
    let successCount = 0;

    const probeOnce = async (url: string): Promise<boolean> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        await fetch(url, {
          method: 'HEAD',
          mode: 'no-cors',
          cache: 'no-store',
          signal: controller.signal,
        });
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    };

    const probeNetwork = async () => {
      // Only probe when the browser thinks we're online
      if (!navigator.onLine) return;
      // Window hidden in the tray: nobody sees the banner, skip the ping.
      // visibilitychange re-probes as soon as it is shown again.
      if (document.hidden) return;
      let ok = false;
      for (const url of PROBE_URLS) {
        if (await probeOnce(url)) { ok = true; break; }
      }
      if (!active) return;
      if (ok) {
        // Success — reset the fail counter; flip back online only after N
        // consecutive successes so a flapping link doesn't repeat the toast.
        failCount = 0;
        if (!wasOnlineRef.current) {
          successCount += 1;
          if (successCount >= RECOVER_THRESHOLD) {
            successCount = 0;
            handleOnline();
          }
        } else {
          successCount = 0;
        }
      } else {
        // Probe failed — only flip offline after N consecutive failures
        successCount = 0;
        failCount += 1;
        if (failCount >= FAIL_THRESHOLD && wasOnlineRef.current) {
          handleOffline();
        }
      }
    };

    const handleVisibility = () => {
      if (!document.hidden) probeNetwork();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const probeInterval = setInterval(probeNetwork, PROBE_INTERVAL_MS);
    // Run an initial probe after a short delay (don't block mount)
    const initialProbe = setTimeout(probeNetwork, 3000);

    return () => {
      active = false;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
      clearInterval(probeInterval);
      clearTimeout(initialProbe);
    };
  }, [updatePendingCount]);

  // Process sync queue when coming back online
  const processSyncQueue = useCallback(async (): Promise<boolean> => {
    if (!isOnline || isSyncing) return false;

    setIsSyncing(true);
    try {
      const queue = await cacheStore.getSyncQueue();
      
      if (queue.length === 0) {
        setWasOffline(false);
        return true;
      }

      // Process each item in order
      for (const item of queue) {
        try {
          // Here we would sync with the server
          // Since library is localStorage only, we just clear the queue
          await cacheStore.removeSyncQueueItem(item.id);
        } catch (error) {
          console.error('Failed to sync item:', item, error);
          // Stop on first error, try again later
          break;
        }
      }

      await updatePendingCount();
      setWasOffline(false);
      return true;
    } catch (error) {
      console.error('Failed to process sync queue:', error);
      return false;
    } finally {
      setIsSyncing(false);
    }
  }, [isOnline, isSyncing, updatePendingCount]);

  // Auto-sync when coming back online
  useEffect(() => {
    if (wasOffline && isOnline) {
      processSyncQueue();
    }
  }, [wasOffline, isOnline, processSyncQueue]);

  // Clear wasOffline flag
  const acknowledgeOffline = useCallback(() => {
    setWasOffline(false);
  }, []);

  return {
    isOnline,
    wasOffline,
    pendingSyncCount,
    isSyncing,
    processSyncQueue,
    acknowledgeOffline,
    updatePendingCount,
  };
}

/**
 * Simple hook for just checking online status
 */
export function useIsOnline(): boolean {
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}

