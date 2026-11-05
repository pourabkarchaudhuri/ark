/**
 * The IPC counters of the perf probe (electron/perf-probe.ts). The 1.0.97 run read 0 for every IPC budget and nothing
 * proved the counters could read anything else. These tests drive a fake ipcMain / webContents through the same wrapping
 * the real app gets and check that a known call increments exactly what it should, so a 0 from the harness means
 * "the screen made no IPC call", not "the probe is blind".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installPerfProbes } from '../../electron/perf-probe';

type Listener = (...a: unknown[]) => unknown;

function fakeElectron() {
  const handlers = new Map<string, Listener>();
  const ons = new Map<string, Listener>();
  const appListeners: Array<(e: unknown, wc: unknown) => void> = [];
  const ipcMain = {
    handle(channel: string, l: Listener) { handlers.set(channel, l); },
    on(channel: string, l: Listener) { ons.set(channel, l); },
  };
  const app = {
    on(ev: string, fn: (e: unknown, wc: unknown) => void) { if (ev === 'web-contents-created') appListeners.push(fn); },
    getAppMetrics: () => [],
  };
  return {
    electron: { app, ipcMain },
    handlers,
    ons,
    createWebContents() {
      const sent: unknown[][] = [];
      const wc = { send: (channel: string, ...args: unknown[]) => { sent.push([channel, ...args]); } };
      for (const fn of appListeners) fn({}, wc);
      return { wc, sent };
    },
  };
}

type Probe = {
  ipc(reset?: boolean): { invoke: Record<string, any>; send: Record<string, any>; probeMs: number };
  handlerCount(): number;
  setByteAccounting(on: boolean): void;
  eventLoopMonitor(on: boolean): void;
};
const probe = () => (globalThis as unknown as { __arkPerf: Probe }).__arkPerf;

describe('perf probe IPC counters', () => {
  const saved = process.env.ARK_PERF;
  beforeEach(() => {
    process.env.ARK_PERF = '1';
    delete (globalThis as { __arkPerf?: unknown }).__arkPerf;
  });
  afterEach(() => {
    probe()?.eventLoopMonitor(false);
    delete (globalThis as { __arkPerf?: unknown }).__arkPerf;
    if (saved === undefined) delete process.env.ARK_PERF;
    else process.env.ARK_PERF = saved;
  });

  it('counts a handled invoke call, its payload and its result', async () => {
    const f = fakeElectron();
    installPerfProbes({ electron: f.electron });
    f.electron.ipcMain.handle('thing:get', async (_e, a: unknown) => ({ echo: a }));
    expect(probe().handlerCount()).toBe(1);

    const h = f.handlers.get('thing:get')!;
    await h({}, 'abc');
    await h({}, 'abc');
    await h({}, 'abc');

    const s = probe().ipc(false).invoke['thing:get'];
    expect(s.calls).toBe(3);
    expect(s.errors).toBe(0);
    expect(s.argBytes).toBeGreaterThan(0);
    expect(s.resultBytes).toBeGreaterThan(0);
  });

  it('counts a failing handler as a call and an error, and still rethrows', async () => {
    const f = fakeElectron();
    installPerfProbes({ electron: f.electron });
    f.electron.ipcMain.handle('thing:fail', () => { throw new Error('nope'); });
    await expect(f.handlers.get('thing:fail')!({})).rejects.toThrow('nope');
    const s = probe().ipc(false).invoke['thing:fail'];
    expect(s.calls).toBe(1);
    expect(s.errors).toBe(1);
  });

  it('counts fire-and-forget ipcMain.on messages under on:<channel>', () => {
    const f = fakeElectron();
    installPerfProbes({ electron: f.electron });
    f.electron.ipcMain.on('log:line', () => undefined);
    f.ons.get('log:line')!({}, 'x');
    expect(probe().ipc(false).invoke['on:log:line'].calls).toBe(1);
  });

  it('counts main -> renderer pushes per channel, with the busiest second', () => {
    const f = fakeElectron();
    installPerfProbes({ electron: f.electron });
    const { wc, sent } = f.createWebContents();
    for (let i = 0; i < 5; i++) wc.send('localAi:status-changed', { i });
    const s = probe().ipc(false).send['localAi:status-changed'];
    expect(s.calls).toBe(5);
    expect(s.maxPerSec).toBe(5);
    expect(sent).toHaveLength(5); // the real send still happens
  });

  it('reset hands back the window and starts a fresh one', async () => {
    const f = fakeElectron();
    installPerfProbes({ electron: f.electron });
    f.electron.ipcMain.handle('thing:get', () => 1);
    await f.handlers.get('thing:get')!({});
    const first = probe().ipc(true);
    expect(first.invoke['thing:get'].calls).toBe(1);
    expect(probe().ipc(false).invoke['thing:get']).toBeUndefined();
    await f.handlers.get('thing:get')!({});
    expect(probe().ipc(false).invoke['thing:get'].calls).toBe(1);
  });

  it('is inert without ARK_PERF=1', () => {
    delete process.env.ARK_PERF;
    const f = fakeElectron();
    installPerfProbes({ electron: f.electron });
    expect((globalThis as { __arkPerf?: unknown }).__arkPerf).toBeUndefined();
    const original = f.electron.ipcMain.handle;
    expect(f.electron.ipcMain.handle).toBe(original);
  });
});
