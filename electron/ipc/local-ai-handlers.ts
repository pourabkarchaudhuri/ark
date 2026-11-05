/**
 * IPC for the built-in local AI (1.0.97 B36): status for Settings and the splash, and the few
 * actions the user has there (download the chat model, remove models, change the models folder,
 * re-check, retry, continue without local AI, use my own Ollama).
 *
 * The controller is plain code over injected dependencies so its behaviour is unit-tested without
 * Electron; `register` only wires it to ipcMain and pushes `localAi:status-changed` to the windows.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../safe-logger.js';
import { settingsStore } from '../settings-store.js';
import { getBackendKind, backendEmbeddingTag } from '../local-ai/backend.js';
import { getManifest, getModelForRole } from '../local-ai/manifest.js';
import { getLocalAiService, resolveModelsDir, type LocalAiService } from '../local-ai/service.js';
import { defaultFreeBytes, type ModelStatus } from '../local-ai/model-store.js';
import type { RoleStatus } from '../local-ai/llama-runtime.js';
import {
  allowBuiltinAutoDownload,
  declineBuiltinAutoDownload,
  isBuiltinAutoDownloadDeclined,
  startBuiltinModelDownloadsAndNotify,
  onBuiltinModelsSettled,
  resetGpuModeCache,
} from '../ollama-setup.js';
import { resetRerankTierCache } from '../rerank-engine.js';

const require = createRequire(import.meta.url);

export interface LocalAiStatus {
  backend: 'builtin' | 'ollama';
  runtime: { available: boolean; build: string; roles: RoleStatus[] };
  models: ModelStatus[];
  modelsDir: string;
  /** Bytes used by model files and partial downloads. */
  diskUsedBytes: number;
  /** Free bytes on the models volume; null when unknown. */
  diskFreeBytes: number | null;
  paused: boolean;
  /** "Continue without local AI" was chosen this session. */
  declined: boolean;
  /** GPU or CPU, from the embed server's log; null until a server has started. */
  compute: 'gpu' | 'cpu' | null;
  /** GPU name from the embed server's log when it runs on a GPU ("NVIDIA GeForce RTX 3070 Ti Laptop GPU"). */
  computeDevice: string | null;
  /** VRAM the embed model occupies, in bytes (0 on the CPU). */
  computeVramBytes: number;
  chatModel: { id: string; label: string; sizeBytes: number };
  externalOllama: { enabled: boolean; url: string };
}

export interface LocalAiControllerDeps {
  service: () => LocalAiService;
  modelsDir: () => string;
  getSettings: () => { useExternalOllama: boolean; modelsDir: string | null; ollamaUrl: string };
  setSettings: (next: { useExternalOllama?: boolean; modelsDir?: string | null }) => void;
  backendKind: () => 'builtin' | 'ollama';
  freeBytes?: (dir: string) => number | null;
  /** Called after a change that invalidates cached tier / GPU decisions. */
  onConfigChanged?: () => void;
  startDownloads?: () => Promise<void>;
  decline?: () => void;
  allow?: () => void;
  declined?: () => boolean;
}

const MAX_PATH_LEN = 1024;

/** `localAi:downloadChat` carries `{ confirmed: true }` once the user saw the size prompt. */
export function parseDownloadChatPayload(payload: unknown): { confirmed: true } | null {
  if (!payload || typeof payload !== 'object') return null;
  return (payload as { confirmed?: unknown }).confirmed === true ? { confirmed: true } : null;
}

/** `localAi:setExternalOllama`: a boolean toggle, nothing else. */
export function parseExternalOllamaPayload(payload: unknown): { enabled: boolean } | null {
  if (!payload || typeof payload !== 'object') return null;
  const enabled = (payload as { enabled?: unknown }).enabled;
  return typeof enabled === 'boolean' ? { enabled } : null;
}

/** A folder chosen for the models: absolute, no NUL, bounded, not a drive root. */
export function validateModelsDir(dir: unknown): string | null {
  if (typeof dir !== 'string') return null;
  const trimmed = dir.trim();
  if (!trimmed || trimmed.length > MAX_PATH_LEN || trimmed.includes('\0')) return null;
  if (!path.isAbsolute(trimmed)) return null;
  // Network shares (\\server\share, \\?\ and \\.\ device paths) are not a local drive: a dropped link mid-download or mid-load is a bad place for 7 GB of models.
  if (/^[\\/]{2}/.test(trimmed)) return null;
  const resolved = path.resolve(trimmed);
  if (/^[\\/]{2}/.test(resolved)) return null;
  if (path.parse(resolved).root === resolved) return null;
  // Windows system folders are not a place for the models (and are usually read-only for the user).
  if (/^[a-z]:[\\/](windows|program files( \(x86\))?|programdata)([\\/]|$)/i.test(resolved)) return null;
  return resolved;
}

export class LocalAiController {
  constructor(private readonly deps: LocalAiControllerDeps) {}

  status(disk?: { used: number; free: number | null }): LocalAiStatus {
    const { store, runtime } = this.deps.service();
    const settings = this.deps.getSettings();
    const dir = this.deps.modelsDir();
    const manifest = getManifest();
    const embedRole = runtime.roleStatus('embed');
    const chat = getModelForRole('chat');
    return {
      backend: this.deps.backendKind(),
      runtime: { available: runtime.isRuntimeAvailable(), build: manifest.runtime.build, roles: runtime.status() },
      models: store.statuses(),
      modelsDir: dir,
      diskUsedBytes: disk ? disk.used : store.diskUsedBytes(),
      diskFreeBytes: disk ? disk.free : (this.deps.freeBytes ?? defaultFreeBytes)(dir),
      paused: store.isPaused(),
      declined: (this.deps.declined ?? isBuiltinAutoDownloadDeclined)(),
      compute: embedRole.state === 'ready' && embedRole.gpu
        ? (embedRole.gpu.gpuBytes > 0 ? 'gpu' : 'cpu')
        : null,
      computeDevice: embedRole.state === 'ready' && embedRole.gpu && embedRole.gpu.gpuBytes > 0
        ? (embedRole.gpu.deviceName ?? embedRole.gpu.device)
        : null,
      computeVramBytes: embedRole.state === 'ready' && embedRole.gpu ? embedRole.gpu.gpuBytes : 0,
      chatModel: { id: chat?.id ?? '', label: chat?.label ?? '', sizeBytes: chat?.sources[0]?.size ?? 0 },
      externalOllama: { enabled: settings.useExternalOllama, url: settings.ollamaUrl },
    };
  }

  private diskStatsCache: { at: number; dir: string; used: number; free: number | null } | null = null;

  /**
   * Status for the background push while downloads run: the same shape, but the disk numbers (a
   * stat of every model file) are re-read at most every few seconds, not on every progress tick.
   */
  statusForPush(maxAgeMs = 3_000): LocalAiStatus {
    const dir = this.deps.modelsDir();
    const now = Date.now();
    const c = this.diskStatsCache;
    if (!c || c.dir !== dir || now - c.at > maxAgeMs) {
      const { store } = this.deps.service();
      this.diskStatsCache = { at: now, dir, used: store.diskUsedBytes(), free: (this.deps.freeBytes ?? defaultFreeBytes)(dir) };
    }
    const cached = this.diskStatsCache!;
    return this.status(cached);
  }

  /** Refresh what is on disk first, then report. */
  async refreshedStatus(): Promise<LocalAiStatus> {
    await this.deps.service().store.refresh();
    return this.status();
  }

  async downloadChat(payload: unknown): Promise<LocalAiStatus> {
    if (!parseDownloadChatPayload(payload)) throw new Error('Downloading the chat model needs the user to confirm its size');
    const chat = getModelForRole('chat');
    if (!chat) throw new Error('No chat model in the manifest');
    const { store } = this.deps.service();
    (this.deps.allow ?? allowBuiltinAutoDownload)();
    void store.ensure([chat.id], { resumePaused: true });
    return this.status();
  }

  /** Re-check everything: clear failures, re-hash, restart the automatic downloads. */
  async recheck(): Promise<LocalAiStatus> {
    const { store, runtime } = this.deps.service();
    runtime.reset();
    (this.deps.allow ?? allowBuiltinAutoDownload)();
    await store.refresh();
    this.deps.onConfigChanged?.();
    store.unpause();
    void (this.deps.startDownloads ?? startBuiltinModelDownloadsAndNotify)();
    return this.status();
  }

  /** Retry failed downloads. */
  async retry(): Promise<LocalAiStatus> {
    const { store } = this.deps.service();
    (this.deps.allow ?? allowBuiltinAutoDownload)();
    store.unpause();
    // Failed or paused models first, then every automatic model: a stop-class failure resets the rest of the
    // queue to 'missing', which resume() alone would not pick up. Both settle the embeddings when the queue drains.
    void store.resume();
    void (this.deps.startDownloads ?? startBuiltinModelDownloadsAndNotify)();
    return this.status();
  }

  pause(): LocalAiStatus {
    this.deps.service().store.pause();
    return this.status();
  }

  /** "Continue without local AI": stop downloading until the user retries. */
  continueWithout(): LocalAiStatus {
    (this.deps.decline ?? declineBuiltinAutoDownload)();
    return this.status();
  }

  async removeModels(): Promise<LocalAiStatus> {
    const { store, runtime } = this.deps.service();
    await runtime.stopAll();
    try {
      await store.removeAll();
    } finally {
      this.deps.onConfigChanged?.();
    }
    return this.status();
  }

  /** Move the models to `dir` (already validated) and remember it. Servers and downloads stop first. */
  async changeFolder(dir: string): Promise<LocalAiStatus> {
    const target = validateModelsDir(dir);
    if (!target) throw new Error('Choose a folder on a local drive (not a drive root)');
    return this.relocate(target, target);
  }

  /** Back to the default folder (%LOCALAPPDATA%\Ark\models). */
  async resetFolder(defaultDir: string): Promise<LocalAiStatus> {
    return this.relocate(defaultDir, null);
  }

  /**
   * Stop the servers and downloads, copy the models over, switch the setting, then delete the old
   * copies. A failure at any step puts everything back and leaves the old folder in use.
   */
  private async relocate(target: string, setting: string | null): Promise<LocalAiStatus> {
    const { store, runtime } = this.deps.service();
    const from = this.deps.modelsDir();
    const previous = this.deps.getSettings().modelsDir;
    const wasPaused = store.isPaused();
    await runtime.stopAll();
    store.cancelAll();
    try {
      if (!(await waitUntil(() => !store.isBusy(), 5_000))) {
        throw new Error('Downloads are still stopping. Wait a moment and try again.');
      }
      const plan = await store.beginMove(target, from);
      try {
        this.deps.setSettings({ modelsDir: setting });
        await store.refresh();
      } catch (err) {
        this.deps.setSettings({ modelsDir: previous });
        await plan.rollback();
        throw err;
      }
      await plan.commit();
    } catch (err) {
      await store.refresh().catch(() => undefined);
      throw err;
    } finally {
      // The stop was only for the move: a Pause the user chose stays, anything else may continue.
      if (!wasPaused) store.unpause();
      this.deps.onConfigChanged?.();
    }
    return this.status();
  }

  async setExternalOllama(payload: unknown): Promise<LocalAiStatus> {
    const parsed = parseExternalOllamaPayload(payload);
    if (!parsed) throw new Error('Invalid value');
    this.deps.setSettings({ useExternalOllama: parsed.enabled });
    // Whichever backend just became inactive must not keep holding memory.
    if (parsed.enabled) await this.deps.service().runtime.stopAll();
    this.deps.onConfigChanged?.();
    return this.status();
  }
}

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return cond();
}

export interface LocalAiIpcRegistrar {
  handle: (channel: string, listener: (event: any, ...args: any[]) => unknown) => void;
}

export function createDefaultController(): LocalAiController {
  return new LocalAiController({
    service: getLocalAiService,
    modelsDir: resolveModelsDir,
    getSettings: () => ({ ...settingsStore.getLocalAiSettings(), ollamaUrl: settingsStore.getOllamaSettings().url }),
    setSettings: (next) => settingsStore.setLocalAiSettings(next),
    backendKind: getBackendKind,
    onConfigChanged: () => {
      resetRerankTierCache();
      resetGpuModeCache();
      // The built-in and an own Ollama make slightly different vectors: the model tag the renderer compares
      // against its stored one changes with the backend, which marks the existing re-embed as recommended.
      void import('./ann-handlers.js').then((m) => m.refreshAnnModelTag()).catch(() => undefined);
    },
  });
}

export interface LocalAiPushOptions {
  /** Minimum time between pushes while downloads report progress. */
  pushIntervalMs?: number;
}

type PushWindow = {
  webContents?: { send: (channel: string, ...args: unknown[]) => void };
  isVisible?: () => boolean;
  isMinimized?: () => boolean;
  isDestroyed?: () => boolean;
};

export function register(
  getMainWindow: () => PushWindow | null,
  ipc?: LocalAiIpcRegistrar,
  controller: LocalAiController = createDefaultController(),
  pushOptions: LocalAiPushOptions = {},
): void {
  const electron = require('electron');
  const registrar: LocalAiIpcRegistrar = ipc ?? electron.ipcMain;

  const wrap = <T>(name: string, fn: (...args: any[]) => Promise<T> | T) => async (_event: unknown, ...args: any[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      logger.warn(`[LocalAI] ${name} failed:`, err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  registrar.handle('localAi:status', wrap('status', () => controller.refreshedStatus()));
  registrar.handle('localAi:downloadChat', wrap('downloadChat', (payload: unknown) => controller.downloadChat(payload)));
  registrar.handle('localAi:recheck', wrap('recheck', () => controller.recheck()));
  registrar.handle('localAi:retry', wrap('retry', () => controller.retry()));
  registrar.handle('localAi:pause', wrap('pause', () => controller.pause()));
  registrar.handle('localAi:continueWithout', wrap('continueWithout', () => controller.continueWithout()));
  registrar.handle('localAi:removeModels', wrap('removeModels', () => controller.removeModels()));
  registrar.handle('localAi:setExternalOllama', wrap('setExternalOllama', (payload: unknown) => controller.setExternalOllama(payload)));
  registrar.handle('localAi:changeFolder', wrap('changeFolder', async () => {
    const win = getMainWindow();
    const result = await electron.dialog.showOpenDialog(win ?? undefined, {
      title: 'Choose a folder for the local AI models',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { cancelled: true as const, status: controller.status() };
    return { cancelled: false as const, status: await controller.changeFolder(result.filePaths[0]) };
  }));
  registrar.handle('localAi:resetFolder', wrap('resetFolder', async () => {
    const { defaultModelsDir } = await import('../local-ai/service.js');
    return controller.resetFolder(defaultModelsDir());
  }));

  // Push status to the window while anything changes (download progress, server start/stop). Pushes are
  // coalesced (at most one per interval, the last one wins) and skipped while the window is hidden or
  // minimised: building a status stats every model file, which is wasted work nobody sees. The renderer asks
  // for a fresh status when it mounts or comes back.
  const intervalMs = pushOptions.pushIntervalMs ?? 750;
  let lastPush = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pushNow = () => {
    timer = null;
    try {
      const win = getMainWindow();
      if (!win?.webContents) return;
      if (win.isDestroyed?.() || win.isMinimized?.() || win.isVisible?.() === false) return;
      lastPush = Date.now();
      win.webContents.send('localAi:status-changed', controller.statusForPush());
    } catch {
      // Window closed.
    }
  };
  const push = () => {
    if (timer) return;
    const wait = lastPush + intervalMs - Date.now();
    if (wait <= 0) pushNow();
    else { timer = setTimeout(pushNow, wait); (timer as { unref?: () => void }).unref?.(); }
  };
  const { store, runtime } = getLocalAiService();
  store.onChange(push);
  runtime.onChange(push);
  // After the first background queue drains the renderer re-checks embedding availability.
  onBuiltinModelsSettled((embeddingReady) => {
    try {
      getMainWindow()?.webContents?.send('localAi:models-settled', { embeddingReady });
    } catch {
      // Window closed.
    }
  });
}
