/**
 * Splash line for the built-in local AI downloads (1.0.97 B36).
 *
 * Never blocks "Enter Ark": the models download in the background and Ark runs without embeddings
 * until they are ready. Shows progress while the Oracle models download, and when a download fails
 * (offline, blocked, disk full) a clear reason with "Retry" and "Continue without local AI".
 */
import { useEffect, useState } from 'react';
import '@/services/local-ai-types';
import { firstAutoError, summarizeAutoDownload, formatBytes, type LocalAiStatus } from '@/services/local-ai-types';

export function LocalAiSplashStatus() {
  const [status, setStatus] = useState<LocalAiStatus | null>(null);

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.localAi : undefined;
    if (!api?.status) return;
    let cancelled = false;
    void api.status().then((s) => { if (!cancelled) setStatus(s); }).catch(() => undefined);
    const off = api.onStatusChanged?.((s) => { if (!cancelled) setStatus(s); });
    return () => { cancelled = true; off?.(); };
  }, []);

  if (!status || status.backend !== 'builtin') return null;
  const api = window.localAi!;
  const progress = summarizeAutoDownload(status.models);
  const failed = firstAutoError(status.models);

  if (progress && !status.declined) {
    return (
      <div className="font-mono text-[11px] text-white/60" data-testid="local-ai-splash-progress">
        {`> ${progress.label} (${progress.pct}%). Ark works without it until it is ready.`}
      </div>
    );
  }
  if (failed && !status.declined) {
    const need = failed.error?.code === 'disk_full' ? ` (${formatBytes(failed.sizeBytes)} needed)` : '';
    return (
      <div className="font-mono text-[11px] text-amber-300/80" data-testid="local-ai-splash-error">
        <div>{`> Local AI download stopped: ${failed.error?.message ?? 'unknown error'}${need}`}</div>
        <div className="mt-1 flex gap-3 pointer-events-auto">
          <button type="button" className="underline hover:text-white" onClick={() => { void api.retry().then(setStatus).catch(() => undefined); }}>Retry</button>
          <button type="button" className="underline hover:text-white" onClick={() => { void api.continueWithout().then(setStatus).catch(() => undefined); }}>Continue without local AI</button>
        </div>
      </div>
    );
  }
  return null;
}
