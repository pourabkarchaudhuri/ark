import { useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Router, Route, Switch } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { Dashboard } from '@/pages/dashboard';
import { GameDetailsPage } from '@/pages/game-details';
import { LoadingScreen } from '@/components/loading-screen';
import { ErrorBoundary } from '@/components/error-boundary';
import { ToastProvider } from '@/components/ui/toast';
import { UpdateSnackbar } from '@/components/update-snackbar';
import { ChangelogModal } from '@/components/changelog-modal';

type AppState = 'loading' | 'ready';

function AppRoutes() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/game/:id" component={GameDetailsPage} />
      <Route>
        {/* 404 fallback */}
        <Dashboard />
      </Route>
    </Switch>
  );
}

function AppContent() {
  // Start directly with loading screen as the landing page
  const [appState, setAppState] = useState<AppState>('loading');

  const handleLoadingComplete = useCallback(() => {
    setAppState('ready');
  }, []);

  const handleReset = useCallback(() => {
    setAppState('loading');
  }, []);

  return (
    <div className="dark">
      <ErrorBoundary onReset={handleReset}>
        <AnimatePresence mode="wait">
          {appState === 'loading' && (
            <LoadingScreen key="app-loading" onComplete={handleLoadingComplete} duration={5000} />
          )}

          {appState === 'ready' && (
            <motion.div
              key="app"
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
