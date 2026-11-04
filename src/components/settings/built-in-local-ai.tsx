/**
 * Settings > AI providers > Built-in connector (1.0.97 B36, restyled in B37).
 *
 * Shows what Ark's own llama.cpp runtime is doing: runtime version, GPU or CPU, each model
 * (ready / downloading x% / missing), the disk it uses, and the actions: Download chat model
 * (with a size prompt), Remove models, Change folder, Re-check. The user's own Ollama is a
 * separate advanced switch below it (rendered by settings-screen).
 */
import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Chip, type Tone } from '@/components/settings/ui';
import {
  describeModelState,
  formatBytes,
  type LocalAiStatus,
  type LocalAiModelStatus,
} from '@/services/local-ai-types';

const MODEL_TONE: Record<LocalAiModelStatus['state'], Tone> = {
  ready: 'live', downloading: 'info', verifying: 'info', queued: 'off', paused: 'warn', error: 'warn', missing: 'off',
};

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
    return <p className="d">Built-in local AI is available in the desktop app.</p>;
  }
  if (!status) {
    return <p className="d" role="status">{error ?? 'Checking the built-in local AI…'}</p>;
  }

  const chat = status.models.find((m) => m.role === 'chat');
  const anyBusy = status.models.some((m) => m.state === 'downloading' || m.state === 'queued');
  const anyFailed = status.models.some((m) => m.state === 'error' || m.state === 'paused');
  const fellBack = status.runtime.roles.some((r) => r.cpuFallback);
  const compute = status.compute === 'gpu'
    ? `GPU (Vulkan)${status.computeDevice ? `: ${status.computeDevice}` : ''}${status.computeVramBytes > 0 ? `, ${formatBytes(status.computeVramBytes)} in use` : ''}`
    : status.compute === 'cpu'
      ? (fellBack ? 'CPU (the GPU could not be used)' : 'CPU (no usable GPU found)')
      : 'GPU if available, else CPU';

  return (
    <div className="stack" style={{ gap: 'var(--space-3)' }} data-testid="built-in-local-ai">
      <div>
        <p className="t">Built-in local AI</p>
        <p className="d">
          Ark runs its own AI on your computer, so nothing leaves your PC and Ollama no longer needs installing.
          The models download once, in the background.
        </p>
      </div>

      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--space-1) var(--space-4)', fontSize: 'var(--text-xs)', margin: 0 }}>
        <dt style={{ color: 'var(--color-ink-3)' }}>Runtime</dt>
        <dd style={{ margin: 0, color: 'var(--color-ink-2)' }}>
          {status.runtime.available ? `llama.cpp ${status.runtime.build}` : 'Not found in this install'}
        </dd>
        <dt style={{ color: 'var(--color-ink-3)' }}>Runs on</dt>
        <dd style={{ margin: 0, color: 'var(--color-ink-2)' }}>{compute}</dd>
        <dt style={{ color: 'var(--color-ink-3)' }}>Models folder</dt>
        <dd style={{ margin: 0, color: 'var(--color-ink-2)', wordBreak: 'break-all' }}>{status.modelsDir}</dd>
        <dt style={{ color: 'var(--color-ink-3)' }}>Disk used</dt>
        <dd style={{ margin: 0, color: 'var(--color-ink-2)' }}>
          {formatBytes(status.diskUsedBytes)}
          {status.diskFreeBytes !== null ? ` (${formatBytes(status.diskFreeBytes)} free)` : ''}
        </dd>
      </dl>

      <ul aria-label="Local AI models" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {orderModels(status.models).map((m) => (
          <li key={m.id} className="inline" style={{ fontSize: 'var(--text-xs)' }}>
            <span className="grow" style={{ color: 'var(--color-ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
            <span style={{ color: 'var(--color-ink-3)' }}>{formatBytes(m.sizeBytes)}</span>
            <Chip tone={MODEL_TONE[m.state]}><span data-testid={`model-state-${m.id}`}>{describeModelState(m)}</span></Chip>
          </li>
        ))}
      </ul>

      {status.declined && (
        <p className="d" style={{ color: 'var(--color-warn)' }}>
          Local AI downloads are off for this session. Choose Re-check to turn them back on.
        </p>
      )}
      {error && <p className="d" style={{ color: 'var(--color-fault)' }} role="alert">{error}</p>}

      <div className="inline" style={{ flexWrap: 'wrap' }}>
        {chat && chat.state !== 'ready' && (
          <button type="button" className="btn" disabled={busy || chat.state === 'downloading' || chat.state === 'queued'}
            onClick={() => setConfirmChat(true)}>
            Download chat model
          </button>
        )}
        {anyFailed && !anyBusy && (
          <button type="button" className="btn" disabled={busy} onClick={() => run(() => api.retry())}>Retry</button>
        )}
        {anyBusy && (
          <button type="button" className="btn" disabled={busy} onClick={() => run(async () => api.pause())}>Pause</button>
        )}
        <button type="button" className="btn" disabled={busy} onClick={() => run(() => api.recheck())}>Re-check</button>
        <button type="button" className="btn" disabled={busy || anyBusy} onClick={() => run(() => api.changeFolder())}>Change folder</button>
        <button type="button" className="btn" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove models</button>
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
