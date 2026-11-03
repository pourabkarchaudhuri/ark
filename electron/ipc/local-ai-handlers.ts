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
import { getBackendKind } from '../local-ai/backend.js';
import { getManifest, getModelForRole } from '../local-ai/manifest.js';
import { getLocalAiService, resolveModelsDir, type LocalAiService } from '../local-ai/service.js';
import { defaultFreeBytes, type ModelStatus } from '../local-ai/model-store.js';
import type { RoleStatus } from '../local-ai/llama-runtime.js';
import {
  allowBuiltinAutoDownload,
  declineBuiltinAutoDownload,
  isBuiltinAutoDownloadDeclined,
  startBuiltinModelDownloads,
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
  const resolved = path.resolve(trimmed);
  if (path.parse(resolved).root === resolved) return null;
  return resolved;
}

export class LocalAiController {
  constructor(private readonly deps: LocalAiControllerDeps) {}

  status(): LocalAiStatus {
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
      diskUsedBytes: store.diskUsedBytes(),
      diskFreeBytes: (this.deps.freeBytes ?? defaultFreeBytes)(dir),
      paused: store.isPaused(),
      declined: (this.deps.declined ?? isBuiltinAutoDownloadDeclined)(),
      compute: embedRole.state === 'ready' && embedRole.gpu
        ? (embedRole.gpu.gpuBytes > 0 ? 'gpu' : 'cpu')
        : null,
      chatModel: { id: chat?.id ?? '', label: chat?.label ?? '', sizeBytes: chat?.sources[0]?.size ?? 0 },
      externalOllama: { enabled: settings.useExternalOllama, url: settings.ollamaUrl },
    };
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
    void store.ensure([chat.id]);
    return this.status();
  }

  /** Re-check everything: clear failures, re-hash, restart the automatic downloads. */
  async recheck(): Promise<LocalAiStatus> {
    const { store, runtime } = this.deps.service();
    runtime.reset();
    (this.deps.allow ?? allowBuiltinAutoDownload)();
    await store.refresh();
    this.deps.onConfigChanged?.();
    void (this.deps.startDownloads ?? startBuiltinModelDownloads)();
    return this.status();
  }

  /** Retry failed downloads. */
  async retry(): Promise<LocalAiStatus> {
    const { store } = this.deps.service();
    (this.deps.allow ?? allowBuiltinAutoDownload)();
    void store.resume();
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
    store.removeAll();
    this.deps.onConfigChanged?.();
    return this.status();
  }

  /** Move the models to `dir` (already validated) and remember it. Servers and downloads stop first. */
  async changeFolder(dir: string): Promise<LocalAiStatus> {
    const target = validateModelsDir(dir);
    if (!target) throw new Error('Choose a folder on a local drive (not a drive root)');
    const { store, runtime } = this.deps.service();
    const from = this.deps.modelsDir();
    await runtime.stopAll();
    store.cancelAll();
    await waitUntil(() => !store.isBusy(), 5_000);
    fs.mkdirSync(target, { recursive: true });
    store.moveTo(target, from);
    this.deps.setSettings({ modelsDir: target });
    await store.refresh();
    this.deps.onConfigChanged?.();
    return this.status();
  }

  /** Back to the default folder (%LOCALAPPDATA%\Ark\models). */
  async resetFolder(defaultDir: string): Promise<LocalAiStatus> {
    const { store, runtime } = this.deps.service();
    const from = this.deps.modelsDir();
    await runtime.stopAll();
    store.cancelAll();
    await waitUntil(() => !store.isBusy(), 5_000);
    store.moveTo(defaultDir, from);
    this.deps.setSettings({ modelsDir: null });
    await store.refresh();
    this.deps.onConfigChanged?.();
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

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
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
    },
  });
}

export function register(
  getMainWindow: () => { webContents?: { send: (channel: string, ...args: unknown[]) => void } } | null,
  ipc?: LocalAiIpcRegistrar,
  controller: LocalAiController = createDefaultController(),
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

  // Push status to the window while anything changes (download progress, server start/stop).
  const push = () => {
    try {
      getMainWindow()?.webContents?.send('localAi:status-changed', controller.status());
    } catch {
      // Window closed.
    }
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
