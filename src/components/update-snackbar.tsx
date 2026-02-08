import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, X, RefreshCw, CheckCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface UpdateInfo {
  version: string;
  releaseDate?: string;
  releaseNotes?: string;
}

interface DownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

// Type declaration for the updater API
declare global {
  interface Window {
    updater?: {
      checkForUpdates: () => Promise<{ updateAvailable: boolean; currentVersion: string; latestVersion: string }>;
      downloadUpdate: () => Promise<{ success: boolean }>;
      installUpdate: () => void;
      getVersion: () => Promise<string>;
      onChecking: (callback: () => void) => void;
      onUpdateAvailable: (callback: (info: UpdateInfo) => void) => void;
      onUpdateNotAvailable: (callback: (info: { version: string }) => void) => void;
      onDownloadProgress: (callback: (progress: DownloadProgress) => void) => void;
      onUpdateDownloaded: (callback: (info: UpdateInfo) => void) => void;
      onError: (callback: (error: { message: string }) => void) => void;
      onAutoDownload: (callback: (info: UpdateInfo) => void) => void;
      removeAllListeners: () => void;
    };
  }
}

export function UpdateSnackbar() {
  const [state, setState] = useState<UpdateState>('idle');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Check if we're in Electron with updater available
  const hasUpdater = typeof window !== 'undefined' && window.updater;

  // Log on mount for debugging
  useEffect(() => {
    console.log('[UpdateSnackbar] Component mounted');
    console.log('[UpdateSnackbar] window.updater exists:', !!window.updater);
    
    if (window.updater) {
      // Get current version for logging
      window.updater.getVersion().then(version => {
        console.log('[UpdateSnackbar] Current app version:', version);
      }).catch(err => {
        console.error('[UpdateSnackbar] Failed to get version:', err);
      });
      
      // Perform a manual update check on mount and log the result
      console.log('[UpdateSnackbar] Performing manual update check...');
      window.updater.checkForUpdates().then(result => {
        console.log('[UpdateSnackbar] Manual check result:', result);
        if (result.updateAvailable) {
          console.log('[UpdateSnackbar] Update IS available:', result.latestVersion);
          // Manually trigger the available state if IPC events didn't fire
          setUpdateInfo({ version: result.latestVersion });
          setState('available');
          setDismissed(false);
        } else {
          console.log('[UpdateSnackbar] No update available. Current:', result.currentVersion, 'Latest:', result.latestVersion);
        }
      }).catch(err => {
        console.error('[UpdateSnackbar] Manual check failed:', err);
      });
    }
  }, []);

  useEffect(() => {
    if (!hasUpdater) {
      console.log('[UpdateSnackbar] No updater available, skipping event listeners');
      return;
    }

    const updater = window.updater!;
    console.log('[UpdateSnackbar] Setting up event listeners');

    // Set up event listeners
    updater.onChecking(() => {
      console.log('[UpdateSnackbar] Event: checking');
      setState('checking');
    });

    updater.onUpdateAvailable((info) => {
      console.log('[UpdateSnackbar] Event: update-available:', info.version);
      setUpdateInfo(info);
      setState('available');
      setDismissed(false);
    });

    updater.onUpdateNotAvailable((info) => {
      console.log('[UpdateSnackbar] Event: update-not-available:', info.version);
      setState('idle');
    });

    updater.onDownloadProgress((prog) => {
      console.log('[UpdateSnackbar] Event: download-progress:', prog.percent.toFixed(1) + '%');
      setProgress(prog);
      setState('downloading');
    });

    updater.onUpdateDownloaded((info) => {
      console.log('[UpdateSnackbar] Event: update-downloaded:', info.version);
      setUpdateInfo(info);
      setState('ready');
    });

    updater.onError((error) => {
      console.error('[UpdateSnackbar] Event: error:', error.message);
      setErrorMessage(error.message);
      setState('error');
    });

    // Auto-download triggered by native notification click (from tray)
    updater.onAutoDownload((info) => {
      console.log('[UpdateSnackbar] Event: auto-download triggered for version:', info.version);
      setUpdateInfo(info);
      setDismissed(false);
      setState('downloading');
      // Automatically start the download
      window.updater!.downloadUpdate().catch((err) => {
        console.error('[UpdateSnackbar] Auto-download failed:', err);
        setState('error');
        setErrorMessage('Failed to download update');
      });
    });

    // Cleanup listeners on unmount
    return () => {
      console.log('[UpdateSnackbar] Cleaning up event listeners');
      updater.removeAllListeners();
    };
  }, [hasUpdater]);

  const handleDownload = useCallback(async () => {
    if (!hasUpdater) return;
    // Guard: don't trigger if already downloading or installed
    if (state === 'downloading' || state === 'ready') return;
    try {
      setState('downloading');
      await window.updater!.downloadUpdate();
    } catch (error) {
      console.error('[UpdateSnackbar] Download failed:', error);
      setState('error');
      setErrorMessage('Failed to download update');
    }
  }, [hasUpdater, state]);

  const handleInstall = useCallback(() => {
    if (!hasUpdater) return;
    window.updater!.installUpdate();
  }, [hasUpdater]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  // Don't render if no update available or dismissed
  if (!hasUpdater || dismissed || state === 'idle' || state === 'checking') {
    return null;
  }

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 50, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 50, scale: 0.95 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className={cn(
          'fixed bottom-4 left-4 z-[100] flex flex-col gap-2 p-4 rounded-lg border backdrop-blur-md shadow-xl',
          'bg-gradient-to-r from-blue-500/10 to-purple-500/10 border-blue-500/30',
          'min-w-[320px] max-w-[400px]'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {state === 'downloading' ? (
              <RefreshCw className="h-5 w-5 text-blue-400 animate-spin" />
            ) : state === 'ready' ? (
              <CheckCircle className="h-5 w-5 text-green-400" />
            ) : (
              <Download className="h-5 w-5 text-blue-400" />
            )}
            <span className="font-semibold text-foreground">
              {state === 'available' && 'Update Available'}
              {state === 'downloading' && 'Downloading Update'}
              {state === 'ready' && 'Ready to Install'}
              {state === 'error' && 'Update Error'}
            </span>
          </div>
          <button
            onClick={handleDismiss}
            className="p-1 rounded-md hover:bg-white/10 transition-colors"
            aria-label="Dismiss update notification"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        {/* Content */}
        <div className="text-sm text-muted-foreground">
          {state === 'available' && updateInfo && (
            <p>Version {updateInfo.version} is available. Would you like to update now?</p>
          )}
          {state === 'downloading' && progress && (
            <div className="space-y-2">
              <p>Downloading... {progress.percent.toFixed(0)}%</p>
              <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-gradient-to-r from-blue-500 to-purple-500"
                  initial={{ width: 0 }}
                  animate={{ width: `${progress.percent}%` }}
                  transition={{ duration: 0.2 }}
                />
              </div>
              <p className="text-xs">
                {formatBytes(progress.transferred)} / {formatBytes(progress.total)} ({formatBytes(progress.bytesPerSecond)}/s)
              </p>
            </div>
          )}
          {state === 'ready' && updateInfo && (
            <p>Version {updateInfo.version} is ready. The app will restart to complete the update.</p>
          )}
          {state === 'error' && (
            <p className="text-red-400">{errorMessage || 'An error occurred while updating.'}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 mt-2">
          {state === 'available' && (
            <>
              <button
                onClick={handleDismiss}
                className="px-3 py-1.5 text-sm font-medium rounded-md hover:bg-white/10 transition-colors text-muted-foreground"
              >
                Later
              </button>
              <button
                onClick={handleDownload}
                className="px-3 py-1.5 text-sm font-medium rounded-md bg-blue-500 hover:bg-blue-600 transition-colors text-white"
              >
                Download Now
              </button>
            </>
          )}
          {state === 'ready' && (
            <>
              <button
                onClick={handleDismiss}
                className="px-3 py-1.5 text-sm font-medium rounded-md hover:bg-white/10 transition-colors text-muted-foreground"
              >
                Later
              </button>
              <button
                onClick={handleInstall}
                className="px-3 py-1.5 text-sm font-medium rounded-md bg-green-500 hover:bg-green-600 transition-colors text-white"
              >
                Install Now
              </button>
            </>
          )}
          {state === 'error' && (
            <button
              onClick={handleDismiss}
              className="px-3 py-1.5 text-sm font-medium rounded-md hover:bg-white/10 transition-colors text-muted-foreground"
            >
              Dismiss
            </button>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
