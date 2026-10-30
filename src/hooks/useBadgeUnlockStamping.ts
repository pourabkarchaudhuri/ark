import { useEffect } from 'react';
import { startBadgeUnlockStamping, type BadgeStamperDeps } from '@/services/badge-unlock-stamper';

/**
 * Mounted once at the app root: stamps badge unlock dates when they are
 * earned, independent of whether the Medals view is open (v1.0.97).
 * `deps` is a test seam and is read on mount only.
 */
export function useBadgeUnlockStamping(deps?: Partial<BadgeStamperDeps>): void {
  useEffect(() => startBadgeUnlockStamping(deps), []); // eslint-disable-line react-hooks/exhaustive-deps
}
