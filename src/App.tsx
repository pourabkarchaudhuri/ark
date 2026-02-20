import { useState, useCallback, useEffect, lazy, Suspense } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Router, Route, Switch, useLocation } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { ErrorBoundary } from '@/components/error-boundary';
import { ToastProvider } from '@/components/ui/toast';
import { UpdateSnackbar } from '@/components/update-snackbar';
import { ChangelogModal } from '@/components/changelog-modal';
import { trackPageView } from '@/services/analytics';

// ---------------------------------------------------------------------------
// Lazy-loaded heavy components — split into separate chunks for faster initial load
// ---------------------------------------------------------------------------
const SplashScreen = lazy(() => import('@/components/splash-screen').then(m => ({ default: m.SplashScreen })));
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
            <Suspense fallback={<ChunkFallback />}>
              <SplashScreen key="splash" onEnter={handleSplashEnter} />
            </Suspense>
          )}

          {appState === 'ready' && (
            <motion.div
              key={`app-${appKey}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4 }}
            >
              <AppRoutes />
              <ChangelogModal />
            </motion.div>
          )}
        </AnimatePresence>
      </ErrorBoundary>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Router hook={useHashLocation}>
        <AppContent />
      </Router>
      <UpdateSnackbar />
    </ToastProvider>
  );
}
