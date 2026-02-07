import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Sparkles, Gift } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Current app version - update this with each release
export const APP_VERSION = '1.0.18';

// Changelog entries - add new versions at the top
const CHANGELOG: Record<string, { title: string; changes: string[] }> = {
  '1.0.18': {
    title: "What's New in Ark 1.0.18",
    changes: [
      'Removed auto-detection of installed Steam games — games are no longer auto-added to your library based on local installs',
      'Removed Installed badge from game cards for a cleaner look',
    ],
  },
  '1.0.17': {
    title: "What's New in Ark 1.0.17",
    changes: [
      'Steam News & Updates — Game details page now shows a carousel of the latest news articles from Steam with thumbnails, auto-scroll, and source labels',
      'Recommended by Steam — Similar games section redesigned with content-based recommendations specific to each game',
      'Journey View — New timeline view that persists your entire gaming history, even after removing games from the library',
      'AI Chat with Web Search — Ollama-powered chat now uses DuckDuckGo grounding for real-time answers about awards, releases, and current events',
      'Live Player Counts — Real-time "playing now" counts shown on dashboard cards, game details, and journey cards, consistent across all views',
      'My Progress Skeleton — Dedicated skeleton loader for the progress tab eliminates flicker when navigating to game details',
      'Status Change History — Every status transition is now persisted with game, previous/new state, and timestamp for future tracking features',
      'Image Fallback Overhaul — Robust multi-step fallback chains with placeholder detection for game thumbnails across all views',
      'Performance Audit — Reduced re-renders in game cards, journey view, and game store; optimized memo comparators and batch state updates',
      'Test Suite Reorganization — All 18 test files consolidated into src/test/ with consistent folder structure mirroring source',
    ],
  },
  '1.0.16': {
    title: "What's New in Ark 1.0.16",
    changes: [
      'Hyperlinks now open in your default OS browser - Steam, Metacritic, FitGirl, and all in-page links no longer open inside the Electron window, keeping your site logins intact',
      'Pricing displayed in INR - Game details show Indian Rupee pricing directly from the Steam API (cc=in)',
      'Library view cleanup - Heart icon removed from Library cards since you already have the ellipsis menu and right-click to manage games',
      'Cleaner game lists - Games without developer or publisher info (e.g. FiveM) are filtered out from Browse and Library',
      'Navigation guards - Added will-navigate and window-open handlers to prevent Electron from ever navigating away from the app',
    ],
  },
  '1.0.15': {
    title: "What's New in Ark 1.0.15",
    changes: [
      'Electron app now starts correctly - fixed main process crash when running as ESM (__dirname)',
      'Electron e2e tests pass - window opens, dashboard, Library, search, and Settings tested',
      'Changelog modal no longer blocks clicks - tests dismiss it before interacting with the app',
    ],
  },
  '1.0.14': {
    title: "What's New in Ark 1.0.14",
    changes: [
      'Pricing in INR - Game details and Steam data now show Indian Rupee (₹) from the Steam API',
      'Links open in your browser - Steam, Metacritic, FitGirl, and in-page links open in your default OS browser so your logins stay intact',
      'Cleaner game lists - Games without developer or publisher (e.g. FiveM) are no longer shown in Browse or Library',
      'Library view - Heart and Library badge are hidden in Library view (use menu or right-click to remove)',
      'Performance - Fewer unnecessary re-renders on game cards for smoother scrolling',
    ],
  },
  '1.0.13': {
    title: "What's New in Ark 1.0.13",
    changes: [
      'Export your library - Save all your games to a file for backup',
      'Import library - Restore your games from a backup file (only adds new games or updates changed ones)',
      'Clear library - Remove all games at once with a single click in Library view',
      'Better game images - More fallback options when game covers are not available',
      'Search bar clears when switching to Library view',
    ],
  },
  '1.0.12': {
    title: "What's New in Ark 1.0.12",
    changes: [
      'Fixed game card navigation in production builds',
      'Switched to hash-based routing for Electron compatibility',
      'Navigation now works correctly in installed app',
    ],
  },
  '1.0.11': {
    title: "What's New in Ark 1.0.11",
    changes: [
      'Fixed auto-update snackbar - now performs manual check on startup with full logging',
      'Fixed game card clicks - cards now navigate to details page correctly',
      'Fixed library view - now shows all games in your library, not just top 100',
    ],
  },
  '1.0.10': {
    title: "What's New in Ark 1.0.10",
    changes: [
      'Test release to verify auto-update functionality',
      'If you see this changelog, the auto-update worked!',
    ],
  },
  '1.0.9': {
    title: "What's New in Ark 1.0.9",
    changes: [
      'Fixed auto-update notifications - update snackbar now appears when new versions are available',
      'Added updater API to the preload script for proper IPC communication',
      'Improved update detection and download progress tracking',
    ],
  },
  '1.0.8': {
    title: "What's New in Ark 1.0.8",
    changes: [
      'Renamed application branding from "Game Tracker" to "Ark" throughout the app',
      'Added version display in the navbar',
      'Improved loading screen with updated branding',
      'Added this changelog modal to show updates after each release',
      'Fixed various bugs and improved stability',
    ],
  },
  '1.0.7': {
    title: "What's New in Ark 1.0.7",
    changes: [
      'Added version number display next to app title',
      'Improved auto-update functionality',
    ],
  },
  '1.0.6': {
    title: "What's New in Ark 1.0.6",
    changes: [
      'Added custom app icon with gamepad design',
      'Fixed node-fetch module error in packaged builds',
      'Improved build process with clean step',
      'Updated installer branding to "Ark"',
    ],
  },
};

const STORAGE_KEY = 'ark_last_seen_version';

export function ChangelogModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [changelogData, setChangelogData] = useState<{ title: string; changes: string[] } | null>(null);

  useEffect(() => {
    // Check if we should show the changelog
    const lastSeenVersion = localStorage.getItem(STORAGE_KEY);
    
    if (lastSeenVersion !== APP_VERSION && CHANGELOG[APP_VERSION]) {
      // New version detected, show changelog
      setChangelogData(CHANGELOG[APP_VERSION]);
      setIsOpen(true);
    }
  }, []);

  const handleClose = () => {
    // Mark this version as seen
    localStorage.setItem(STORAGE_KEY, APP_VERSION);
    setIsOpen(false);
  };

  if (!isOpen || !changelogData) {
    return null;
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm"
            onClick={handleClose}
          />
          
          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="fixed inset-0 z-[201] flex items-center justify-center p-4 pointer-events-none"
          >
            <div className="bg-gradient-to-b from-gray-900 to-gray-950 border border-white/10 rounded-2xl shadow-2xl max-w-md w-full pointer-events-auto overflow-hidden">
              {/* Header with gradient */}
              <div className="bg-gradient-to-r from-fuchsia-500/20 to-purple-500/20 px-6 py-4 border-b border-white/10">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 bg-gradient-to-br from-fuchsia-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-fuchsia-500/30">
                      <Gift className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-white">{changelogData.title}</h2>
                      <p className="text-xs text-white/50">Version {APP_VERSION}</p>
                    </div>
                  </div>
                  <button
                    onClick={handleClose}
                    className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                    aria-label="Close changelog"
                  >
                    <X className="h-5 w-5 text-white/60" />
                  </button>
                </div>
              </div>

              {/* Content */}
              <div className="px-6 py-5">
                <ul className="space-y-3">
                  {changelogData.changes.map((change, index) => (
                    <motion.li
                      key={index}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.1 }}
                      className="flex items-start gap-3 text-sm text-white/80"
                    >
                      <Sparkles className="h-4 w-4 text-fuchsia-400 mt-0.5 flex-shrink-0" />
                      <span>{change}</span>
                    </motion.li>
                  ))}
                </ul>
              </div>

              {/* Footer */}
              <div className="px-6 py-4 border-t border-white/10 bg-white/5">
                <Button
                  onClick={handleClose}
                  className="w-full bg-gradient-to-r from-fuchsia-500 to-purple-600 hover:from-fuchsia-600 hover:to-purple-700 text-white font-medium"
                >
                  Got it, let's go!
                </Button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
