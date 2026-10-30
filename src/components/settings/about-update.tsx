/**
 * Settings > About update control: Check for Updates → Download vX → Downloading… → Install & Restart vX.
 *
 * The main process reports `status` on `updater:check` (and on `updater:download`) once an update
 * is downloading or downloaded, so About never offers a download of the version it already has
 * and can switch to Install after its own download. The snackbar keeps its own state machine;
 * nothing here subscribes to updater events (the preload has no per-listener unsubscribe).
 */

import { useCallback, useState } from 'react';
import { Download, RefreshCw, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export type UpdateCheckState = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error';

export interface AboutUpdate {
  state: UpdateCheckState;
  latestVersion: string | null;
  error: string | null;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => void;
}

export function useAboutUpdate(): AboutUpdate {
  const [state, setState] = useState<UpdateCheckState>('idle');
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    if (!window.updater) {
      setState('error');
      setError('Updater unavailable in this build.');
      return;
    }
    setState('checking');
    setError(null);
    try {
      const result = await window.updater.checkForUpdates();
      if (result.error) {
        setError(result.hint ?? "Couldn't reach GitHub.");
        setState('error');
        return;
      }
      setLatestVersion(result.latestVersion);
      if (result.status === 'downloaded') setState('ready');
      else if (result.status === 'downloading') setState('downloading');
      else setState(result.updateAvailable ? 'available' : 'latest');
    } catch (err) {
      console.error('[Settings] Update check failed:', err);
      setError("Couldn't reach GitHub.");
      setState('error');
    }
  }, []);

  const download = useCallback(async () => {
    if (!window.updater) return;
    setState('downloading');
    setError(null);
    try {
      const result = await window.updater.downloadUpdate();
      if (result && !result.success) {
        setError(result.hint ?? result.error ?? 'Download failed.');
        setState('error');
        return;
      }
      // 'downloading' = a download started elsewhere (snackbar) is still running; it offers Install.
      setState(result?.status === 'downloading' ? 'downloading' : 'ready');
    } catch (err) {
      console.error('[Settings] Update download failed:', err);
      setError('Download failed.');
      setState('error');
    }
  }, []);

  const install = useCallback(() => {
    window.updater?.installUpdate();
  }, []);

  return { state, latestVersion, error, check, download, install };
}

/** The single action button for the current update state. */
export function AboutUpdateButton({ update }: { update: AboutUpdate }) {
  const { state, latestVersion } = update;
  if ((state === 'available' || state === 'ready') && latestVersion) {
    const ready = state === 'ready';
    return (
      <Button
        size="sm"
        onClick={ready ? update.install : () => void update.download()}
        className="h-8 gap-1.5 text-xs bg-blue-500 hover:bg-blue-600 text-white"
      >
        {ready ? <RotateCcw className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
        {ready ? `Install & Restart v${latestVersion}` : `Download v${latestVersion}`}
      </Button>
    );
  }
  if (state === 'downloading') {
    return (
      <Button size="sm" disabled className="h-8 gap-1.5 text-xs bg-blue-500 text-white">
        <Download className="h-3.5 w-3.5 animate-pulse" />
        Downloading…
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => void update.check()}
      disabled={state === 'checking'}
      className="h-8 gap-1.5 text-xs"
    >
      <RefreshCw className={cn('h-3.5 w-3.5', state === 'checking' && 'animate-spin')} />
      {state === 'checking' ? 'Checking…' : 'Check for Updates'}
    </Button>
  );
}
