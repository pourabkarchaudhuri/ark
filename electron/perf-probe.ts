/**
 * Main-process performance probes (release gate, scripts/perf/measure.mjs).
 *
 * Everything here is inert unless ARK_PERF=1 is in the environment: with the
 * variable unset `installPerfProbes()` returns immediately and nothing is
 * patched, so a normal run pays nothing.
 *
 * With ARK_PERF=1 it publishes `globalThis.__arkPerf` (read by the harness via
 * Playwright's `electronApp.evaluate`, no IPC surface is added):
 *   - event-loop delay histogram (`monitorEventLoopDelay`, p50/p99/max, resettable)
 *   - per-channel IPC counts and payload bytes (ipcMain.handle / .on, and
 *     webContents.send for main -> renderer traffic)
 *   - app.getAppMetrics() for every Electron process, plus the main process's
 *     own memory and CPU
 */

import { createRequire } from 'node:module';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const require = createRequire(import.meta.url);

interface ChannelStat {
  calls: number;
  errors: number;
  argBytes: number;
  resultBytes: number;
  totalMs: number;
  maxMs: number;
}

interface PerfProbeApi {
  version: 1;
  /** Event-loop delay in ms since the last reset (resetAfter=true restarts the window). */
  eventLoop(resetAfter?: boolean): Record<string, number>;
  /** Per-channel IPC stats since the last reset. */
  ipc(resetAfter?: boolean): {
    invoke: Record<string, ChannelStat>;
    send: Record<string, ChannelStat>;
    probeMs: number;
  };
  /** Toggle payload byte accounting (JSON.stringify per call is itself main-thread work). */
  setByteAccounting(on: boolean): void;
  /** Number of handlers registered per channel (a flat count means no handler churn). */
  handlerCount(): number;
  /** app.getAppMetrics() + main process memory/CPU. */
  processMetrics(): unknown;
}

const stat = (): ChannelStat => ({ calls: 0, errors: 0, argBytes: 0, resultBytes: 0, totalMs: 0, maxMs: 0 });

export function installPerfProbes(): void {
  if (process.env.ARK_PERF !== '1') return;
  const g = globalThis as unknown as { __arkPerf?: PerfProbeApi };
  if (g.__arkPerf) return;

  const electron = require('electron');
  const { app, ipcMain } = electron;

  let byteAccounting = true;
  let probeMs = 0;
  let invoke: Record<string, ChannelStat> = {};
  let send: Record<string, ChannelStat> = {};
  let handlers = 0;

  const sizeOf = (v: unknown): number => {
    if (v == null) return 0;
    if (typeof v === 'string') return v.length;
    if (v instanceof ArrayBuffer) return v.byteLength;
    if (ArrayBuffer.isView(v)) return v.byteLength;
    try {
      const t0 = performance.now();
      const n = JSON.stringify(v)?.length ?? 0;
      probeMs += performance.now() - t0;
      return n;
    } catch {
      return 0;
    }
  };
  const bytes = (v: unknown): number => (byteAccounting ? sizeOf(v) : 0);

  const record = (table: Record<string, ChannelStat>, channel: string, ms: number, a: number, r: number, failed: boolean) => {
    const s = (table[channel] ??= stat());
    s.calls++;
    if (failed) s.errors++;
    s.argBytes += a;
    s.resultBytes += r;
    s.totalMs += ms;
    if (ms > s.maxMs) s.maxMs = ms;
  };

  // ipcMain.handle / ipcMain.on: wrap each listener as it is registered.
  const origHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel: string, listener: (...a: unknown[]) => unknown) => {
    handlers++;
    return origHandle(channel, async (event: unknown, ...args: unknown[]) => {
      const t0 = performance.now();
      let failed = false;
      let result: unknown;
      try {
        result = await listener(event, ...args);
        return result;
      } catch (err) {
        failed = true;
        throw err;
      } finally {
        record(invoke, channel, performance.now() - t0, bytes(args), failed ? 0 : bytes(result), failed);
      }
    });
  };
  const origOn = ipcMain.on.bind(ipcMain);
  ipcMain.on = (channel: string, listener: (...a: unknown[]) => unknown) => {
    handlers++;
    return origOn(channel, (event: unknown, ...args: unknown[]) => {
      const t0 = performance.now();
      let failed = false;
      try {
        return listener(event, ...args);
      } catch (err) {
        failed = true;
        throw err;
      } finally {
        record(invoke, `on:${channel}`, performance.now() - t0, bytes(args), 0, failed);
      }
    });
  };

  // Main -> renderer pushes
  app.on('web-contents-created', (_e: unknown, wc: { send: (channel: string, ...a: unknown[]) => void }) => {
    const origSend = wc.send.bind(wc);
    wc.send = (channel: string, ...args: unknown[]) => {
      record(send, channel, 0, bytes(args), 0, false);
      return origSend(channel, ...args);
    };
  });

  const hist = monitorEventLoopDelay({ resolution: 10 });
  hist.enable();
  const ms = (ns: number) => Math.round((ns / 1e6) * 100) / 100;

  g.__arkPerf = {
    version: 1,
    eventLoop(resetAfter = false) {
      const out = {
        count: hist.count,
        min: ms(hist.min),
        mean: ms(hist.mean),
        p50: ms(hist.percentile(50)),
        p99: ms(hist.percentile(99)),
        max: ms(hist.max),
      };
      if (resetAfter) hist.reset();
      return out;
    },
    ipc(resetAfter = false) {
      const out = { invoke, send, probeMs: Math.round(probeMs * 100) / 100 };
      if (resetAfter) {
        invoke = {};
        send = {};
        probeMs = 0;
      }
      // Detach from the live tables when resetting; otherwise hand back a copy.
      return resetAfter ? out : JSON.parse(JSON.stringify(out));
    },
    setByteAccounting(on: boolean) {
      byteAccounting = on;
    },
    handlerCount: () => handlers,
    processMetrics() {
      return {
        pid: process.pid,
        appMetrics: app.getAppMetrics(),
        mainMemory: process.memoryUsage(),
        mainCpu: process.cpuUsage(),
        uptimeS: process.uptime(),
      };
    },
  };
}
