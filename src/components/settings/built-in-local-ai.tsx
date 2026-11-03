/**
 * Settings > AI Models > "Built-in local AI" (1.0.97 B36).
 *
 * Shows what Ark's own llama.cpp runtime is doing: runtime version, GPU or CPU, each model
 * (ready / downloading x% / missing), the disk it uses, and the actions: Download chat model
 * (with a size prompt), Remove models, Change folder, Re-check. The user's own Ollama is a
 * separate advanced switch below it (rendered by settings-screen).
 */
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  describeModelState,
  formatBytes,
  type LocalAiStatus,
  type LocalAiModelStatus,
} from '@/services/local-ai-types';

function StateIcon({ m }: { m: LocalAiModelStatus }) {
  if (m.state === 'ready') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400/80" aria-hidden />;
  if (m.state === 'downloading' || m.state === 'verifying') return <Loader2 className="h-3.5 w-3.5 text-white/50 animate-spin" aria-hidden />;
  if (m.state === 'error') return <AlertCircle className="h-3.5 w-3.5 text-amber-400/80" aria-hidden />;
  return <Download className="h-3.5 w-3.5 text-white/30" aria-hidden />;
}

/** Model rows for the table; `auto` models first. Exported for tests. */
export function orderModels(models: LocalAiModelStatus[]): LocalAiModelStatus[] {
  return [...models].sort((a, b) => Number(b.auto) - Number(a.auto));
}

export function BuiltInLocalAiPanel({ onStatus }: { onStatus?: (s: LocalAiStatus | null) => void }) {
  const api = typeof window !== 'undefined' ? window.localAi : undefined;
  const [status, setStatus] = useState<LocalAiStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmChat, setConfirmChat] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const apply = useCallback((s: LocalAiStatus) => {
    setStatus(s);
    onStatus?.(s);
  }, [onStatus]);

  useEffect(() => {
    if (!api?.status) return;
    let cancelled = false;
    api.status().then((s) => { if (!cancelled) apply(s); }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    const off = api.onStatusChanged?.((s) => { if (!cancelled) apply(s); });
    return () => { cancelled = true; off?.(); };
  }, [api, apply]);

  const run = useCallback(async (fn: () => Promise<LocalAiStatus | { cancelled: boolean; status: LocalAiStatus }>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      apply('status' in r ? r.status : r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }, [apply]);

  if (!api) {
    return <p className="text-xs text-white/35">Built-in local AI is available in the desktop app.</p>;
  }
  if (!status) {
    return <p className="text-xs text-white/35" role="status">{error ?? 'Checking the built-in local AI…'}</p>;
  }

  const chat = status.models.find((m) => m.role === 'chat');
  const anyBusy = status.models.some((m) => m.state === 'downloading' || m.state === 'queued');
  const anyFailed = status.models.some((m) => m.state === 'error' || m.state === 'paused');
  const compute = status.compute === 'gpu' ? 'GPU (Vulkan)' : status.compute === 'cpu' ? 'CPU' : 'GPU if available, else CPU';

  return (
    <div className="space-y-3" data-testid="built-in-local-ai">
      <div>
        <p className="text-sm font-medium text-white/90">Built-in local AI</p>
        <p className="text-xs text-white/35 mt-0.5">
          Ark runs its own AI on your computer, so nothing leaves your PC and Ollama no longer needs installing.
          The models download once, in the background.
        </p>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
        <dt className="text-white/30">Runtime</dt>
        <dd className="text-white/60">
          {status.runtime.available ? `llama.cpp ${status.runtime.build}` : 'Not found in this install'}
        </dd>
        <dt className="text-white/30">Runs on</dt>
        <dd className="text-white/60">{compute}</dd>
        <dt className="text-white/30">Models folder</dt>
        <dd className="text-white/60 break-all">{status.modelsDir}</dd>
        <dt className="text-white/30">Disk used</dt>
        <dd className="text-white/60">
          {formatBytes(status.diskUsedBytes)}
          {status.diskFreeBytes !== null ? ` (${formatBytes(status.diskFreeBytes)} free)` : ''}
        </dd>
      </dl>

      <ul className="space-y-1.5" aria-label="Local AI models">
        {orderModels(status.models).map((m) => (
          <li key={m.id} className="flex items-center gap-2 text-xs">
            <StateIcon m={m} />
            <span className="text-white/70 flex-1 min-w-0 truncate">{m.label}</span>
            <span className="text-white/30">{formatBytes(m.sizeBytes)}</span>
            <span className={m.state === 'error' ? 'text-amber-400/80' : m.state === 'ready' ? 'text-emerald-400/80' : 'text-white/45'} data-testid={`model-state-${m.id}`}>
              {describeModelState(m)}
            </span>
          </li>
        ))}
      </ul>

      {status.declined && (
        <p className="text-[11px] text-amber-400/80">
          Local AI downloads are off for this session. Choose Re-check to turn them back on.
        </p>
      )}
      {error && <p className="text-[11px] text-red-400/80" role="alert">{error}</p>}

      <div className="flex flex-wrap gap-2">
        {chat && chat.state !== 'ready' && (
          <Button size="sm" variant="secondary" className="h-7 text-[11px]" disabled={busy || chat.state === 'downloading' || chat.state === 'queued'}
            onClick={() => setConfirmChat(true)}>
            Download chat model
          </Button>
        )}
        {anyFailed && !anyBusy && (
          <Button size="sm" variant="secondary" className="h-7 text-[11px]" disabled={busy} onClick={() => run(() => api.retry())}>Retry</Button>
        )}
        {anyBusy && (
          <Button size="sm" variant="secondary" className="h-7 text-[11px]" disabled={busy} onClick={() => run(async () => api.pause())}>Pause</Button>
        )}
        <Button size="sm" variant="secondary" className="h-7 text-[11px]" disabled={busy} onClick={() => run(() => api.recheck())}>Re-check</Button>
        <Button size="sm" variant="secondary" className="h-7 text-[11px]" disabled={busy || anyBusy} onClick={() => run(() => api.changeFolder())}>Change folder</Button>
        <Button size="sm" variant="secondary" className="h-7 text-[11px]" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove models</Button>
      </div>

      <ConfirmDialog
        open={confirmChat}
        onOpenChange={setConfirmChat}
        title="Download the local chat model?"
        description={`${status.chatModel.label} is about ${formatBytes(status.chatModel.sizeBytes)}. It downloads in the background and is only needed for AI Chat on your own computer.`}
        confirmText={`Download ${formatBytes(status.chatModel.sizeBytes)}`}
        variant="info"
        onConfirm={() => { setConfirmChat(false); void run(() => api.downloadChat({ confirmed: true })); }}
      />
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the downloaded models?"
        description="Ark goes back to running without local AI until you download them again. Your library and settings are not touched."
        confirmText="Remove models"
        onConfirm={() => { setConfirmRemove(false); void run(() => api.removeModels()); }}
      />
    </div>
  );
}
