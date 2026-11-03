/**
 * IPC validators and the controller behind `localAi:*` (Settings and the splash): what the status
 * reports, that the chat model needs the user's confirmed size prompt, folder changes, removal,
 * re-check and the "use my own Ollama" switch.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../electron/safe-logger.js', () => ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../electron/settings-store.js', () => ({ settingsStore: {} }));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, dialog: {}, app: {} }));

import {
  LocalAiController, parseDownloadChatPayload, parseExternalOllamaPayload, validateModelsDir,
  register, type LocalAiControllerDeps,
} from '../../../electron/ipc/local-ai-handlers';
import { __setLocalAiServiceForTests, defaultModelsDir } from '../../../electron/local-ai/service';

function setup(over: Partial<LocalAiControllerDeps> = {}) {
  let settings = { useExternalOllama: false, modelsDir: null as string | null, ollamaUrl: 'http://localhost:11434' };
  const store = {
    statuses: vi.fn(() => [{ id: 'arctic-embed2', role: 'embed', auto: true, state: 'ready', sizeBytes: 1, label: 'e', pct: 100 }]),
    refresh: vi.fn(async () => undefined),
    diskUsedBytes: vi.fn(() => 1234),
    isPaused: vi.fn(() => false),
    isBusy: vi.fn(() => false),
    ensure: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    pause: vi.fn(),
    cancelAll: vi.fn(),
    removeAll: vi.fn(),
    moveTo: vi.fn(),
    onChange: vi.fn(() => () => undefined),
  };
  const runtime = {
    isRuntimeAvailable: vi.fn(() => true),
    status: vi.fn(() => []),
    roleStatus: vi.fn(() => ({ state: 'ready', gpu: { gpuBytes: 10, cpuBytes: 0 } })),
    stopAll: vi.fn(async () => undefined),
    reset: vi.fn(),
    onChange: vi.fn(() => () => undefined),
  };
  const calls = { allow: 0, decline: 0, startDownloads: 0, configChanged: 0 };
  const deps: LocalAiControllerDeps = {
    service: () => ({ store, runtime, backend: {} }) as never,
    modelsDir: () => 'C:/models',
    getSettings: () => settings,
    setSettings: (next) => { settings = { ...settings, ...next } as typeof settings; },
    backendKind: () => (settings.useExternalOllama ? 'ollama' : 'builtin'),
    freeBytes: () => 5_000_000_000,
    onConfigChanged: () => { calls.configChanged++; },
    startDownloads: async () => { calls.startDownloads++; },
    allow: () => { calls.allow++; },
    decline: () => { calls.decline++; },
    declined: () => false,
    ...over,
  };
  return { controller: new LocalAiController(deps), store, runtime, calls, getSettings: () => settings };
}

describe('IPC validators', () => {
  it('downloadChat needs { confirmed: true }', () => {
    expect(parseDownloadChatPayload({ confirmed: true })).toEqual({ confirmed: true });
    for (const bad of [undefined, null, {}, { confirmed: 'true' }, { confirmed: false }, 'yes', 1]) {
      expect(parseDownloadChatPayload(bad)).toBeNull();
    }
  });

  it('setExternalOllama takes a boolean only', () => {
    expect(parseExternalOllamaPayload({ enabled: true })).toEqual({ enabled: true });
    expect(parseExternalOllamaPayload({ enabled: false })).toEqual({ enabled: false });
    for (const bad of [undefined, null, {}, { enabled: 1 }, { enabled: 'on' }, true]) {
      expect(parseExternalOllamaPayload(bad)).toBeNull();
    }
  });

  it('a models folder must be an absolute path that is not a drive root', () => {
    expect(validateModelsDir('C:\\Users\\me\\Ark models')).toBe(path.resolve('C:\\Users\\me\\Ark models'));
    for (const bad of ['', '   ', 'relative/dir', 'C:\\', '/', 'D:\\bad\0name', 42, null, undefined, 'C:\\' + 'a'.repeat(2000)]) {
      expect(validateModelsDir(bad)).toBeNull();
    }
  });

  it('the default models folder is under %LOCALAPPDATA%, not roaming', () => {
    expect(defaultModelsDir({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } as NodeJS.ProcessEnv, 'C:\\Users\\me'))
      .toBe(path.join('C:\\Users\\me\\AppData\\Local', 'Ark', 'models'));
    expect(defaultModelsDir({} as NodeJS.ProcessEnv, 'C:\\Users\\me')).toBe(path.join('C:\\Users\\me', 'AppData', 'Local', 'Ark', 'models'));
  });
});

describe('LocalAiController', () => {
  it('reports runtime, models, disk, compute and the chat model size', () => {
    const t = setup();
    const s = t.controller.status();
    expect(s.backend).toBe('builtin');
    expect(s.runtime).toMatchObject({ available: true, build: expect.stringMatching(/^b\d+$/) });
    expect(s.modelsDir).toBe('C:/models');
    expect(s.diskUsedBytes).toBe(1234);
    expect(s.diskFreeBytes).toBe(5_000_000_000);
    expect(s.compute).toBe('gpu');
    expect(s.chatModel.sizeBytes).toBeGreaterThan(5e9);
    expect(s.externalOllama).toEqual({ enabled: false, url: 'http://localhost:11434' });
  });

  it('refuses the chat download without the confirmed size prompt, and starts it with it', async () => {
    const t = setup();
    await expect(t.controller.downloadChat({})).rejects.toThrow(/confirm/);
    expect(t.store.ensure).not.toHaveBeenCalled();
    await t.controller.downloadChat({ confirmed: true });
    expect(t.store.ensure).toHaveBeenCalledWith(['gemma3-12b']);
    expect(t.calls.allow).toBe(1);
  });

  it('recheck clears failures, re-hashes, re-allows downloads and restarts them', async () => {
    const t = setup();
    await t.controller.recheck();
    expect(t.runtime.reset).toHaveBeenCalled();
    expect(t.store.refresh).toHaveBeenCalled();
    expect(t.calls.allow).toBe(1);
    expect(t.calls.startDownloads).toBe(1);
    expect(t.calls.configChanged).toBe(1);
  });

  it('retry resumes failed downloads; pause and continueWithout stop them', async () => {
    const t = setup();
    await t.controller.retry();
    expect(t.store.resume).toHaveBeenCalled();
    t.controller.pause();
    expect(t.store.pause).toHaveBeenCalled();
    t.controller.continueWithout();
    expect(t.calls.decline).toBe(1);
  });

  it('removeModels stops the servers before deleting', async () => {
    const t = setup();
    const order: string[] = [];
    t.runtime.stopAll.mockImplementation(async () => { order.push('stop'); });
    t.store.removeAll.mockImplementation(() => { order.push('remove'); });
    await t.controller.removeModels();
    expect(order).toEqual(['stop', 'remove']);
  });

  it('changeFolder moves the files, saves the setting and rejects a bad folder', async () => {
    const t = setup();
    await expect(t.controller.changeFolder('relative')).rejects.toThrow(/local drive/);
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-newmodels-'));
    try {
      await t.controller.changeFolder(target);
      expect(t.runtime.stopAll).toHaveBeenCalled();
      expect(t.store.moveTo).toHaveBeenCalledWith(path.resolve(target), 'C:/models');
      expect(t.getSettings().modelsDir).toBe(path.resolve(target));
      expect(t.store.refresh).toHaveBeenCalled();
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('the Ollama switch saves, stops the built-in servers when turned on, and rejects junk', async () => {
    const t = setup();
    await expect(t.controller.setExternalOllama({ enabled: 'yes' })).rejects.toThrow(/Invalid/);
    const s = await t.controller.setExternalOllama({ enabled: true });
    expect(t.getSettings().useExternalOllama).toBe(true);
    expect(t.runtime.stopAll).toHaveBeenCalled();
    expect(s.backend).toBe('ollama');
    expect(t.calls.configChanged).toBe(1);
    await t.controller.setExternalOllama({ enabled: false });
    expect(t.getSettings().useExternalOllama).toBe(false);
  });
});

describe('register', () => {
  it('registers every localAi channel and pushes status changes to the window', async () => {
    const t = setup();
    __setLocalAiServiceForTests({ store: t.store, runtime: t.runtime, backend: {} } as never);
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const send = vi.fn();
    register(() => ({ webContents: { send } }), { handle: (c, fn) => { handlers.set(c, fn as never); } }, t.controller);
    expect([...handlers.keys()].sort()).toEqual([
      'localAi:changeFolder', 'localAi:continueWithout', 'localAi:downloadChat', 'localAi:pause', 'localAi:recheck',
      'localAi:removeModels', 'localAi:resetFolder', 'localAi:retry', 'localAi:setExternalOllama', 'localAi:status',
    ]);
    const status = await handlers.get('localAi:status')!({}) as { backend: string };
    expect(status.backend).toBe('builtin');
    // Store and runtime changes are pushed.
    const push = (t.store.onChange.mock.calls[0] as unknown as [() => void])[0];
    push();
    expect(send).toHaveBeenCalledWith('localAi:status-changed', expect.objectContaining({ backend: 'builtin' }));
    // A rejected action surfaces as an error to the renderer.
    await expect(handlers.get('localAi:downloadChat')!({}, {})).rejects.toThrow(/confirm/);
    __setLocalAiServiceForTests(null);
  });
});
