import { createContext, useContext, ReactNode } from 'react';
import { useSessionTracker } from '@/hooks/useSessionTracker';

/**
 * Session tracking must run for the entire lifetime of the app, not just while
 * a particular page is mounted. Previously `useSessionTracker` was called inside
 * the Dashboard, so navigating to a game-details page unmounted it and dropped
 * the `session:ended` listener — whole play sessions were never recorded.
 *
 * Mounting the tracker once via this provider guarantees sessions are
 * recorded regardless of which view the user is on. Consumers read live state
 * from context. The provider is mounted at the app ROOT (App.tsx), outside the
 * splash "Enter Ark" gate: with a hidden auto-launch nobody clicks Enter, and
 * a renderer crash reloads into the splash — both used to stop tracking.
 */
type SessionTrackerValue = ReturnType<typeof useSessionTracker>;

const SessionTrackerContext = createContext<SessionTrackerValue | null>(null);

export function SessionTrackerProvider({ children }: { children: ReactNode }) {
  const value = useSessionTracker();
  return (
    <SessionTrackerContext.Provider value={value}>
      {children}
    </SessionTrackerContext.Provider>
  );
}

export function useSessionTrackerContext(): SessionTrackerValue {
  const ctx = useContext(SessionTrackerContext);
  if (!ctx) {
    throw new Error('useSessionTrackerContext must be used within a SessionTrackerProvider');
  }
  return ctx;
}
