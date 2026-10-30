/**
 * auto-updater main-process state machine: retained native notifications, the updater:check
 * short-circuit while a download runs or is done, the final updater:error after a failed download
 * loop, and the startup cleanup of old alternate-download installers.
 *
 * `require('electron')` (createRequire) bypasses vi.mock, so the Electron APIs come in through
 * __setUpdaterDepsForTests; electron-updater is a normal ESM import and is mocked here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const fakeUpdater = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('electron-updater', () => ({
  default: {
    get autoUpdater() {
      return fakeUpdater.current;
    },
  },
}));

type Handler = (...args: unknown[]) => unknown;

class FakeNotification extends EventEmitter {
  static instances: FakeNotification[] = [];
  static isSupported = () => true;
  shown = false;
  closed = false;
  constructor(public options: { title: string; body: string }) {
    super();
    FakeNotification.instances.push(this);
  }
  show() {
    this.shown = true;
  }
  close() {
    this.closed = true;
    this.emit('close');
  }
}

async function setup() {
  vi.resetModules();
  FakeNotification.instances = [];
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
    currentVersion: { version: '1.0.0' },
    autoDownload: true,
    autoInstallOnAppQuit: false,
    disableDifferentialDownload: false,
  });
  fakeUpdater.current = updater as unknown as Record<string, unknown>;
  const handlers = new Map<string, Handler>();
  const sent: Array<[string, unknown]> = [];
  const win = {
    isDestroyed: () => false,
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: (ch: string, data: unknown) => sent.push([ch, data]) },
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-au-'));
  const mod = await import('../../../electron/auto-updater');
  mod.__setUpdaterDepsForTests({
    ipcMain: { handle: (ch: string, fn: Handler) => handlers.set(ch, fn) },
    Notification: FakeNotification,
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    shell: { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() },
    session: { fromPartition: () => ({ fetch: vi.fn() }) },
    app: { isPackaged: false, getVersion: () => '1.0.0', quit: vi.fn() },
    tmpDir,
  });
  mod.registerUpdaterIpcHandlers();
  mod.initAutoUpdater(win as never);
  const invoke = (ch: string) => handlers.get(ch)!({});
  return { mod, updater, sent, invoke, tmpDir };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('auto-updater notifications', () => {
  it('keeps the "update available" notification after the handler returns and replaces it on a newer version', async () => {
    const { mod, updater } = await setup();
    updater.emit('update-available', { version: '2.0.0' });
    const first = FakeNotification.instances[0];
    expect(first.shown).toBe(true);
    expect(mod.__getUpdaterNotificationsForTests().available).toBe(first);

    updater.emit('update-available', { version: '2.0.1' });
    const second = FakeNotification.instances[1];
    expect(first.closed).toBe(true);
    // The old instance's close must not clear the new reference.
    expect(mod.__getUpdaterNotificationsForTests().available).toBe(second);
  });

  it('keeps the "update ready" notification, replaces it on a second show and releases it on click', async () => {
    const { mod, updater } = await setup();
    updater.emit('update-downloaded', { version: '2.0.0' });
    const first = FakeNotification.instances[0];
    expect(mod.__getUpdaterNotificationsForTests().ready).toBe(first);

    updater.emit('update-downloaded', { version: '2.0.0' });
    const second = FakeNotification.instances[1];
    expect(first.closed).toBe(true);
    expect(mod.__getUpdaterNotificationsForTests().ready).toBe(second);

    second.emit('click');
    expect(updater.quitAndInstall).toHaveBeenCalled();
    expect(mod.__getUpdaterNotificationsForTests().ready).toBeNull();
  });
});

describe('updater:check while a download runs or is done', () => {
  it('reports the real new version and status "downloaded"', async () => {
    const { updater, invoke } = await setup();
    updater.emit('update-available', { version: '2.0.0' });
    updater.emit('update-downloaded', { version: '2.0.0' });
    expect(await invoke('updater:check')).toEqual({
      updateAvailable: true,
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
      status: 'downloaded',
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('reports status "downloading" mid-download', async () => {
    const { updater, invoke } = await setup();
    updater.emit('update-available', { version: '2.0.0' });
    updater.emit('download-progress', { percent: 10, bytesPerSecond: 1, transferred: 1, total: 10 });
    expect(await invoke('updater:check')).toMatchObject({ latestVersion: '2.0.0', status: 'downloading' });
  });
});

describe('updater:download', () => {
  it('sends one final updater:error after the retry loop fails (per-attempt errors stay hidden)', async () => {
    const { updater, sent, invoke } = await setup();
    updater.downloadUpdate.mockImplementation(async () => {
      const err = new Error('net::ERR_CONNECTION_RESET');
      updater.emit('error', err);
      throw err;
    });
    const p = invoke('updater:download') as Promise<{ success: boolean }>;
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await p;
    expect(result.success).toBe(false);
    const errors = sent.filter(([ch]) => ch === 'updater:error');
    expect(errors).toHaveLength(1);
    expect(errors[0][1]).toMatchObject({ message: 'net::ERR_CONNECTION_RESET', kind: 'network-reset' });
  });

  it('reports status so callers can tell "done" from "already running"', async () => {
    const { updater, invoke } = await setup();
    let finish: () => void = () => undefined;
    updater.downloadUpdate.mockImplementation(() => new Promise<never[]>((r) => { finish = () => r([]); }));
    const first = invoke('updater:download') as Promise<unknown>;
    expect(await invoke('updater:download')).toEqual({ success: true, status: 'downloading' });
    finish();
    expect(await first).toEqual({ success: true, status: 'downloaded' });
  });
});

describe('startup cleanup of alternate-download installers', () => {
  it('removes installers for the running version or older a few seconds after start', async () => {
    const { tmpDir } = await setup();
    const dir = path.join(tmpDir, 'ark-update');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['Ark-Setup-0.9.0.exe', 'Ark-Setup-1.0.0.exe.part', 'Ark-Setup-2.0.0.exe']) fs.writeFileSync(path.join(dir, f), 'x');
    expect(fs.readdirSync(dir)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fs.readdirSync(dir)).toEqual(['Ark-Setup-2.0.0.exe']);
  });
});
