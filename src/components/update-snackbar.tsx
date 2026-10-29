import { useState, useEffect, useCallback, useRef } from 'react';
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

interface UpdateErrorDetail {
  kind?: string;
  code?: string;
  hint?: string;
  downloadUrl?: string;
}

type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

const RELEASES_LATEST_URL = 'https://github.com/pourabkarchaudhuri/ark/releases/latest';

export function UpdateSnackbar() {
  const [state, setState] = useState<UpdateState>('idle');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<UpdateErrorDetail>({});
  // Set after the alternate download opened the installer (replaces the "ready" copy).
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Distinguishes the "couldn't reach GitHub on mount check" error from other errors,
  // so we can show a Retry button and auto-dismiss the toast.
  const [isReachabilityError, setIsReachabilityError] = useState(false);
  const autoDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Check if we're in Electron with updater available
  const hasUpdater = typeof window !== 'undefined' && window.updater;

  // Manual mount-time check — extracted so the Retry button can re-run it.
  const runMountCheck = useCallback(() => {
    if (!window.updater) return;
    console.log('[UpdateSnackbar] Performing manual update check...');
    window.updater.checkForUpdates().then(result => {
      console.log('[UpdateSnackbar] Manual check result:', result);
      if (result.error) {
        setIsReachabilityError(true);
        setErrorMessage(result.hint ?? "Couldn't reach GitHub — will try again in 2 min.");
        setState('error');
        setDismissed(false);
        return;
      }
      if (result.updateAvailable) {
        console.log('[UpdateSnackbar] Update IS available:', result.latestVersion);
        // Manually trigger the available state if IPC events didn't fire
        setUpdateInfo({ version: result.latestVersion });
        setIsReachabilityError(false);
        setErrorMessage(null);
        setState('available');
        setDismissed(false);
      } else {
        console.log('[UpdateSnackbar] No update available. Current:', result.currentVersion, 'Latest:', result.latestVersion);
        // Clear a prior reachability-error toast if the retry now succeeds.
        if (state === 'error') {
          setIsReachabilityError(false);
          setErrorMessage(null);
          setState('idle');
        }
      }
    }).catch(err => {
      console.error('[UpdateSnackbar] Manual check failed:', err);
      setIsReachabilityError(true);
      setErrorMessage("Couldn't reach GitHub — will try again in 2 min.");
      setState('error');
      setDismissed(false);
    });
  }, [state]);

  // Log on mount for debugging + kick off the first check.
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

      runMountCheck();
    }
    // Intentionally empty deps — this must only fire on mount. runMountCheck
    // is stable enough (state ref is only used to clear an error), and adding
    // it here would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-dismiss the reachability-error toast after 12s if the user doesn't interact.
  useEffect(() => {
    if (state === 'error' && isReachabilityError && !dismissed) {
      if (autoDismissTimerRef.current) clearTimeout(autoDismissTimerRef.current);
      autoDismissTimerRef.current = setTimeout(() => {
        setDismissed(true);
      }, 12_000);
      return () => {
        if (autoDismissTimerRef.current) {
          clearTimeout(autoDismissTimerRef.current);
          autoDismissTimerRef.current = null;
        }
      };
    }
    return undefined;
  }, [state, isReachabilityError, dismissed]);

  const handleRetryReachability = useCallback(() => {
    if (autoDismissTimerRef.current) {
      clearTimeout(autoDismissTimerRef.current);
      autoDismissTimerRef.current = null;
    }
    setIsReachabilityError(false);
    setErrorMessage(null);
    setState('checking');
    runMountCheck();
  }, [runMountCheck]);

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
      setErrorDetail({ kind: error.kind, code: error.code, hint: error.hint, downloadUrl: error.downloadUrl });
      setErrorMessage(error.message);
      setState('error');
    });

    // Auto-download triggered by native notification click (from tray)
    updater.onAutoDownload((info) => {
      console.log('[UpdateSnackbar] Event: auto-download triggered for version:', info.version);
      setUpdateInfo(info);
      setDismissed(false);
      setErrorMessage(null);
      setErrorDetail({});
      setFallbackNote(null);
      setState('downloading');
      window.updater!.downloadUpdate().then((result) => {
        if (result && !result.success) {
          console.error('[UpdateSnackbar] Auto-download returned error:', result.error);
          setState('error');
          setErrorMessage(result.error ?? 'Failed to download update');
          setErrorDetail({ kind: result.kind, code: result.code, hint: result.hint, downloadUrl: result.downloadUrl });
        }
      }).catch((err) => {
        console.error('[UpdateSnackbar] Auto-download rejected:', err);
        setState('error');
        setErrorMessage((prev) => prev ?? (err instanceof Error ? err.message : 'Failed to download update'));
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
    // A new attempt must not keep showing the previous attempt's error.
    setErrorMessage(null);
    setErrorDetail({});
    setFallbackNote(null);
    setState('downloading');
    try {
      const result = await window.updater!.downloadUpdate();
      if (result && !result.success) {
        console.error('[UpdateSnackbar] Download returned error:', result.error);
        setState('error');
        setErrorMessage(result.error ?? 'Failed to download update');
        setErrorDetail({ kind: result.kind, code: result.code, hint: result.hint, downloadUrl: result.downloadUrl });
      }
    } catch (error) {
      console.error('[UpdateSnackbar] Download rejected:', error);
      setState('error');
      setErrorMessage((prev) => prev ?? (error instanceof Error ? error.message : 'Failed to download update'));
    }
  }, [hasUpdater, state]);

  const handleFallbackDownload = useCallback(async () => {
    const fallback = window.updater?.fallbackDownload;
    if (!fallback) return;
    setErrorMessage(null);
    setFallbackNote(null);
    setProgress(null);
    setState('downloading');
    try {
      const result = await fallback();
      if (result.success) {
        setFallbackNote(
          result.launched
            ? 'Installer downloaded and verified. Ark will close so the installer can finish; your data is kept.'
            : 'Installer downloaded and verified. Its folder was opened: close Ark, then run it.',
        );
        setState('ready');
      } else {
        setState('error');
        setErrorMessage(result.error ?? 'Alternate download failed');
        setErrorDetail({ kind: result.kind, code: result.code, hint: result.hint, downloadUrl: result.downloadUrl });
      }
    } catch (err) {
      setState('error');
      setErrorMessage(err instanceof Error ? err.message : 'Alternate download failed');
    }
  }, []);

  const releasePageUrl = errorDetail.downloadUrl ?? RELEASES_LATEST_URL;

  const handleCopyLink = useCallback(() => {
    navigator.clipboard?.writeText(releasePageUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => undefined);
  }, [releasePageUrl]);

  const handleOpenReleasePage = useCallback(() => {
    const url = releasePageUrl;
    // Prefer the Electron shell IPC, fall back to window.open for dev/web.
    const shell = (window as unknown as { electron?: { openExternal?: (url: string) => unknown } }).electron;
    if (shell?.openExternal) {
      void shell.openExternal(url);
    } else if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, [releasePageUrl]);

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
              {state === 'error' && (isReachabilityError ? "Couldn't reach GitHub" : 'Update Error')}
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
          {state === 'ready' && fallbackNote && <p>{fallbackNote}</p>}
          {state === 'ready' && !fallbackNote && updateInfo && (
            <p>Version {updateInfo.version} is ready. The app will restart to complete the update.</p>
          )}
          {state === 'error' && isReachabilityError && (
            <p className="text-white/70">{errorMessage ?? 'Will try again in 2 min.'}</p>
          )}
          {state === 'error' && !isReachabilityError && (
            <div className="space-y-1.5">
              <p className="text-red-400">{errorMessage || 'An error occurred while updating.'}</p>
              {errorDetail.code && <p className="text-[11px] font-mono text-white/40">{errorDetail.code}</p>}
              <p className="text-xs text-white/60">
                {errorDetail.hint ?? 'If this keeps happening, download the installer from GitHub and run it. Your data is kept.'}
              </p>
            </div>
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
          {state === 'ready' && fallbackNote && (
            <button
              onClick={handleDismiss}
              className="px-3 py-1.5 text-sm font-medium rounded-md bg-green-500 hover:bg-green-600 transition-colors text-white"
            >
              OK
            </button>
          )}
          {state === 'ready' && !fallbackNote && (
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
          {state === 'error' && isReachabilityError && (
            <>
              <button
                onClick={handleDismiss}
                className="px-3 py-1.5 text-sm font-medium rounded-md hover:bg-white/10 transition-colors text-muted-foreground"
              >
                Dismiss
              </button>
              <button
                onClick={handleRetryReachability}
                className="px-3 py-1.5 text-sm font-medium rounded-md bg-blue-500 hover:bg-blue-600 transition-colors text-white"
              >
                Retry now
              </button>
            </>
          )}
          {state === 'error' && !isReachabilityError && (
            <>
              <button
                onClick={handleDismiss}
                className="px-3 py-1.5 text-sm font-medium rounded-md hover:bg-white/10 transition-colors text-muted-foreground"
              >
                Dismiss
              </button>
              <button
                onClick={handleCopyLink}
                className="px-3 py-1.5 text-sm font-medium rounded-md hover:bg-white/10 transition-colors text-muted-foreground"
              >
                {copied ? 'Copied' : 'Copy link'}
              </button>
              {window.updater?.fallbackDownload && errorDetail.kind !== 'disk-full' && errorDetail.kind !== 'blocked-by-client' && (
                <button
                  onClick={handleFallbackDownload}
                  className="px-3 py-1.5 text-sm font-medium rounded-md bg-purple-500 hover:bg-purple-600 transition-colors text-white"
                >
                  Try alternate download
                </button>
              )}
              <button
                onClick={handleOpenReleasePage}
                className="px-3 py-1.5 text-sm font-medium rounded-md bg-blue-500 hover:bg-blue-600 transition-colors text-white"
              >
                Download from GitHub
              </button>
            </>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
