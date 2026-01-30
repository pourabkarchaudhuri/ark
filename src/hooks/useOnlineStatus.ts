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
    const handleOnline = () => {
      // Check ref for previous state to avoid stale closure
      if (!wasOnlineRef.current) {
        setWasOffline(true);
      }
      wasOnlineRef.current = true;
      setIsOnline(true);
    };

    const handleOffline = () => {
      wasOnlineRef.current = false;
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Initial sync queue count
    updatePendingCount();

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
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

