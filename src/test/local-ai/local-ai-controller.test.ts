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
    removeAll: vi.fn(async () => undefined),
    unpause: vi.fn(),
    plan: { commit: vi.fn(async () => undefined), rollback: vi.fn(async () => undefined) },
    beginMove: vi.fn(async function (this: unknown) { return (store as { plan: unknown }).plan; }),
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
    expect(t.store.ensure).toHaveBeenCalledWith(['gemma3-12b'], { resumePaused: true });
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

  it('retry resumes failed downloads, re-queues every automatic model and lifts a Pause', async () => {
    const t = setup();
    await t.controller.retry();
    expect(t.store.unpause).toHaveBeenCalled();
    expect(t.store.resume).toHaveBeenCalled();
    expect(t.calls.startDownloads).toBe(1);
    expect(t.calls.allow).toBe(1);
  });

  it('pause and continueWithout stop the downloads', async () => {
    const t = setup();
    t.controller.pause();
    expect(t.store.pause).toHaveBeenCalled();
    t.controller.continueWithout();
    expect(t.calls.decline).toBe(1);
  });

  it('removeModels stops the servers before deleting', async () => {
    const t = setup();
    const order: string[] = [];
    t.runtime.stopAll.mockImplementation(async () => { order.push('stop'); });
    t.store.removeAll.mockImplementation(async () => { order.push('remove'); });
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
      expect(t.store.beginMove).toHaveBeenCalledWith(path.resolve(target), 'C:/models');
      expect(t.getSettings().modelsDir).toBe(path.resolve(target));
      expect(t.store.refresh).toHaveBeenCalled();
      expect(t.store.plan.commit).toHaveBeenCalled();
      expect(t.store.plan.rollback).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('a failed move keeps the old folder in the settings, rolls back and lets downloads continue', async () => {
    const t = setup();
    t.store.beginMove.mockRejectedValueOnce(new Error('Not enough free space in the new folder'));
    await expect(t.controller.changeFolder(path.resolve('D:\\models'))).rejects.toThrow(/Not enough free space/);
    expect(t.getSettings().modelsDir).toBeNull();
    expect(t.store.plan.commit).not.toHaveBeenCalled();
    expect(t.store.refresh).toHaveBeenCalled();
    expect(t.store.unpause).toHaveBeenCalled();
    // A failure after the copy (settings/refresh) is rolled back too.
    t.store.refresh.mockRejectedValueOnce(new Error('boom'));
    await expect(t.controller.changeFolder(path.resolve('D:\\models'))).rejects.toThrow(/boom/);
    expect(t.store.plan.rollback).toHaveBeenCalled();
    expect(t.getSettings().modelsDir).toBeNull();
  });

  it('a move does not start while downloads are still stopping', async () => {
    const t = setup();
    t.store.isBusy.mockReturnValue(true);
    vi.useFakeTimers();
    try {
      const p = t.controller.changeFolder(path.resolve('D:\\models')).catch((e) => e);
      await vi.advanceTimersByTimeAsync(6_000);
      expect((await p).message).toMatch(/still stopping/);
      expect(t.store.beginMove).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a Pause the user chose survives a folder move', async () => {
    const t = setup();
    t.store.isPaused.mockReturnValue(true);
    await t.controller.changeFolder(path.resolve('D:\\models'));
    expect(t.store.unpause).not.toHaveBeenCalled();
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

describe('models folder validation (1.0.98)', () => {
  it('rejects network shares and Windows system folders', () => {
    for (const bad of ['\\\\server\\share\\models', '\\\\?\\C:\\models', '//server/share/models', 'C:\\Windows\\System32', 'C:\\Program Files\\Ark', 'C:\\Program Files (x86)\\x', 'D:\\ProgramData\\x']) {
      expect(validateModelsDir(bad)).toBeNull();
    }
    expect(validateModelsDir('D:\\AI models')).toBe(path.resolve('D:\\AI models'));
  });
});

describe('embedding backend identity (1.0.98)', () => {
  it('an own Ollama records its vectors under its own tag; the built-in keeps the plain one', async () => {
    const { backendEmbeddingTag } = await import('../../../electron/local-ai/backend');
    expect(backendEmbeddingTag('snowflake-arctic-embed2', 'builtin')).toBe('snowflake-arctic-embed2');
    expect(backendEmbeddingTag('snowflake-arctic-embed2', 'ollama')).toBe('snowflake-arctic-embed2@ollama');
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
    // Pushes are coalesced and skipped while the window is hidden.
    send.mockClear();
    push(); push(); push();
    expect(send.mock.calls.length).toBeLessThanOrEqual(1);
    __setLocalAiServiceForTests(null);
    // A rejected action surfaces as an error to the renderer.
    __setLocalAiServiceForTests({ store: t.store, runtime: t.runtime, backend: {} } as never);
    await expect(handlers.get('localAi:downloadChat')!({}, {})).rejects.toThrow(/confirm/);
    __setLocalAiServiceForTests(null);
  });

  it('a push skipped while the window is minimised is sent when it fires restore or show', () => {
    const t = setup();
    __setLocalAiServiceForTests({ store: t.store, runtime: t.runtime, backend: {} } as never);
    const send = vi.fn();
    const listeners = new Map<string, () => void>();
    let minimized = true;
    const win = {
      webContents: { send },
      isMinimized: () => minimized,
      isVisible: () => true,
      isDestroyed: () => false,
      on: vi.fn((ev: string, fn: () => void) => { listeners.set(ev, fn); }),
      removeListener: vi.fn((ev: string) => { listeners.delete(ev); }),
    };
    register(() => win, { handle: () => undefined }, t.controller, { pushIntervalMs: 0 });
    const push = (t.store.onChange.mock.calls[0] as unknown as [() => void])[0];
    push();
    push(); // a second skipped push must not arm a second listener
    expect(send).not.toHaveBeenCalled();
    expect(win.on).toHaveBeenCalledTimes(2);
    expect([...listeners.keys()].sort()).toEqual(['restore', 'show']);
    minimized = false;
    listeners.get('restore')!();
    expect(send).toHaveBeenCalledWith('localAi:status-changed', expect.objectContaining({ backend: 'builtin' }));
    expect(listeners.size).toBe(0);
    __setLocalAiServiceForTests(null);
  });
});
