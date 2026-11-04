/**
 * Renderer-side shape of `window.localAi` (the built-in local AI, 1.0.97 B36). Mirrors
 * `LocalAiStatus` in electron/ipc/local-ai-handlers.ts.
 */
export type LocalAiModelState = 'ready' | 'missing' | 'queued' | 'downloading' | 'paused' | 'verifying' | 'error';
export type LocalAiRoleName = 'embed' | 'rerank' | 'rerank-qwen' | 'chat';

export interface LocalAiModelStatus {
  id: string;
  role: LocalAiRoleName;
  label: string;
  file: string;
  auto: boolean;
  sizeBytes: number;
  state: LocalAiModelState;
  transferred: number;
  /** 0..100 */
  pct: number;
  source: 'ollama' | 'huggingface' | null;
  error: { code: 'offline' | 'blocked' | 'disk_full' | 'checksum' | 'http' | 'unknown'; message: string } | null;
}

export interface LocalAiStatus {
  backend: 'builtin' | 'ollama';
  runtime: {
    available: boolean;
    build: string;
    roles: Array<{ role: LocalAiRoleName; state: 'stopped' | 'starting' | 'ready' | 'failed'; lastError: string | null; cpuFallback: boolean }>;
  };
  models: LocalAiModelStatus[];
  modelsDir: string;
  diskUsedBytes: number;
  diskFreeBytes: number | null;
  paused: boolean;
  declined: boolean;
  compute: 'gpu' | 'cpu' | null;
  computeDevice: string | null;
  computeVramBytes: number;
  chatModel: { id: string; label: string; sizeBytes: number };
  externalOllama: { enabled: boolean; url: string };
}

export interface LocalAiApi {
  status: () => Promise<LocalAiStatus>;
  downloadChat: (payload: { confirmed: true }) => Promise<LocalAiStatus>;
  recheck: () => Promise<LocalAiStatus>;
  retry: () => Promise<LocalAiStatus>;
  pause: () => Promise<LocalAiStatus>;
  continueWithout: () => Promise<LocalAiStatus>;
  removeModels: () => Promise<LocalAiStatus>;
  changeFolder: () => Promise<{ cancelled: boolean; status: LocalAiStatus }>;
  resetFolder: () => Promise<LocalAiStatus>;
  setExternalOllama: (payload: { enabled: boolean }) => Promise<LocalAiStatus>;
  onStatusChanged: (callback: (status: LocalAiStatus) => void) => () => void;
  onModelsSettled: (callback: (data: { embeddingReady: boolean }) => void) => () => void;
}

declare global {
  interface Window {
    localAi?: LocalAiApi;
  }
}

// ── Display helpers (pure, shared by Settings and the splash) ─────────────────

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(n / 1e6))} MB`;
}

/** One short phrase per model state, for the Settings table. */
export function describeModelState(m: Pick<LocalAiModelStatus, 'state' | 'pct' | 'error'>): string {
  switch (m.state) {
    case 'ready': return 'Ready';
    case 'downloading': return `Downloading ${m.pct}%`;
    case 'verifying': return 'Checking…';
    case 'queued': return 'Waiting to download';
    case 'paused': return `Paused at ${m.pct}%`;
    case 'error': return m.error?.message ?? 'Download failed';
    default: return 'Not downloaded';
  }
}

/** Overall progress of the automatic (Oracle) models, or null when none is in flight. */
export function summarizeAutoDownload(models: LocalAiModelStatus[]): { pct: number; label: string } | null {
  const auto = models.filter((m) => m.auto);
  const busy = auto.some((m) => m.state === 'downloading' || m.state === 'queued' || m.state === 'verifying');
  if (!busy) return null;
  const total = auto.reduce((n, m) => n + m.sizeBytes, 0);
  const done = auto.reduce((n, m) => n + (m.state === 'ready' ? m.sizeBytes : m.transferred), 0);
  const current = auto.find((m) => m.state === 'downloading');
  return {
    pct: total > 0 ? Math.min(99, Math.floor((done / total) * 100)) : 0,
    label: current ? `Downloading ${current.label}` : 'Preparing the AI models',
  };
}

/** The first failed automatic model, when nothing is downloading any more. */
export function firstAutoError(models: LocalAiModelStatus[]): LocalAiModelStatus | null {
  const auto = models.filter((m) => m.auto);
  if (auto.some((m) => m.state === 'downloading' || m.state === 'queued')) return null;
  return auto.find((m) => m.state === 'error') ?? null;
}
