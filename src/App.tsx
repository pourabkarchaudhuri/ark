import { useState, useCallback, useEffect, useSyncExternalStore, lazy, Suspense } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Router, Route, Switch, useLocation } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { ErrorBoundary } from '@/components/error-boundary';
import { ToastProvider } from '@/components/ui/toast';
import { UpdateSnackbar } from '@/components/update-snackbar';
import { ChangelogModal } from '@/components/changelog-modal';
import { trackPageView } from '@/services/analytics';
import { SplashScreen } from '@/components/splash-screen';
import { SessionTrackerProvider } from '@/hooks/session-tracker-context';
import { getStorageHealth, subscribeStorageHealth } from '@/services/storage-health';
import { loadSafeMode, type SafeModeState } from '@/services/safe-mode';

// ---------------------------------------------------------------------------
// Lazy-loaded heavy components — split into separate chunks for faster initial load.
// The splash screen is a direct import (not lazy) because it's the very first
// thing the user sees — any chunk-loading delay would show a blank black screen.
// The heavy Three.js 3D scene inside the splash is separately lazy-loaded.
// ---------------------------------------------------------------------------
const Dashboard = lazy(() => import('@/pages/dashboard').then(m => ({ default: m.Dashboard })));
const GameDetailsPage = lazy(() => import('@/pages/game-details').then(m => ({ default: m.GameDetailsPage })));

// Minimal fallback shown while a lazy chunk is loading
const ChunkFallback = () => <div className="h-screen bg-black" />;

type AppState = 'splash' | 'ready';

function AppRoutes() {
  const [location] = useLocation();
  useEffect(() => { trackPageView(location); }, [location]);
  return (
    <ErrorBoundary key={location}>
      <Suspense fallback={<ChunkFallback />}>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/game/:id" component={GameDetailsPage} />
          <Route>
            {/* 404 fallback */}
            <Dashboard />
          </Route>
        </Switch>
      </Suspense>
    </ErrorBoundary>
  );
}

function AppContent() {
  // Splash → Ready (splash handles all data prefetching in the background)
  const [appState, setAppState] = useState<AppState>('splash');
  // Incremented on error-boundary reset to force a clean re-mount of the app tree
  const [appKey, setAppKey] = useState(0);

  const handleSplashEnter = useCallback(() => {
    setAppState('ready');
  }, []);

  const handleReset = useCallback(() => {
    setAppKey(k => k + 1);
  }, []);

  return (
    <div className="dark">
      <ErrorBoundary onReset={handleReset}>
        <AnimatePresence mode="wait">
          {appState === 'splash' && (
            <SplashScreen key="splash" onEnter={handleSplashEnter} />
          )}

          {appState === 'ready' && (
            <motion.div
              key={`app-${appKey}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4 }}
            >
              {/* SessionTrackerProvider lives at the app root (see App below)
                  so tracking runs from launch, not only after "Enter Ark". */}
              <AppRoutes />
              <ChangelogModal />
            </motion.div>
          )}
        </AnimatePresence>
      </ErrorBoundary>
    </div>
  );
}

/**
 * Reliability notices, rendered above everything (including the splash):
 *  - storage read-only: a LevelDB read failed even after retries, so the
 *    affected stores refuse to write this session (prevents rolling the
 *    library back to a stale snapshot). Not dismissible-forever: it returns
 *    if another store fails.
 *  - safe mode: main detected a crash loop and this launch skips heavy
 *    background work. Dismissible.
 */
function ReliabilityNotices() {
  const health = useSyncExternalStore(subscribeStorageHealth, getStorageHealth, getStorageHealth);
  const [safeMode, setSafeMode] = useState<SafeModeState | null>(null);
  const [safeDismissed, setSafeDismissed] = useState(false);
  const [storageDismissedAt, setStorageDismissedAt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void loadSafeMode().then((state) => { if (!cancelled) setSafeMode(state); });
    return () => { cancelled = true; };
  }, []);

  const latestFailureAt = health.failures.reduce((max, f) => Math.max(max, f.at), 0);
  const showStorage = health.readOnly && latestFailureAt > storageDismissedAt;
  const showSafe = !!safeMode?.safeMode && !safeDismissed;
  if (!showStorage && !showSafe) return null;

  return (
    <div className="fixed top-12 left-1/2 -translate-x-1/2 z-[10001] flex flex-col gap-2 w-[min(640px,calc(100vw-32px))] pointer-events-none">
      {showStorage && (
        <div role="alert" className="pointer-events-auto rounded-lg border border-red-500/40 bg-red-950/90 px-4 py-3 text-sm text-red-100 shadow-lg backdrop-blur">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <div className="font-semibold">Ark couldn&apos;t read your saved data</div>
              <div className="mt-0.5 text-red-200/80">
                {health.failures.map((f) => f.store).join(', ')} {health.failures.length === 1 ? 'is' : 'are'} in
                read-only mode — changes made now won&apos;t be saved, so nothing on disk gets overwritten.
                Restart Ark to try again.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setStorageDismissedAt(Date.now())}
              className="text-red-200/70 hover:text-red-100 text-xs px-2 py-1"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {showSafe && (
        <div role="status" className="pointer-events-auto rounded-lg border border-amber-500/40 bg-amber-950/90 px-4 py-3 text-sm text-amber-100 shadow-lg backdrop-blur">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <div className="font-semibold">Safe mode</div>
              <div className="mt-0.5 text-amber-200/80">
                Ark closed unexpectedly several times, so background work (catalog sync, AI embeddings,
                galaxy builds) is paused for this launch. Your library and playtime tracking work normally.
                Normal mode returns automatically after a few stable minutes.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSafeDismissed(true)}
              className="text-amber-200/70 hover:text-amber-100 text-xs px-2 py-1"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      {/* Session tracking is mounted at the root, independent of the splash
          "Enter Ark" gate: with auto-launch `--hidden` nobody clicks Enter,
          and after a renderer crash the app reloads into the splash — both
          used to mean zero playtime recorded. The provider waits for the
          stores to hydrate before talking to the main process. */}
      <SessionTrackerProvider>
        <Router hook={useHashLocation}>
          <AppContent />
        </Router>
      </SessionTrackerProvider>
      <ReliabilityNotices />
      <UpdateSnackbar />
    </ToastProvider>
  );
}
