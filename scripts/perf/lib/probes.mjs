/**
 * Probe access: renderer metrics over CDP, main-process probes via electronApp.evaluate (ARK_PERF=1),
 * and the OS process tree.
 */
import { sleep, sampleProcessTree, round } from './util.mjs';

export class Probes {
  constructor(app, page, pid) {
    this.app = app;
    this.page = page;
    this.pid = pid;
    this.cdp = null;
  }

  async init() {
    this.cdp = await this.page.context().newCDPSession(this.page);
    await this.cdp.send('Performance.enable');
    await this.cdp.send('HeapProfiler.enable');
    // Long tasks + frame sampler live in the page; they survive hash navigation (no reload).
    await this.page.evaluate(() => {
      if (window.__perfInstalled) return;
      window.__perfInstalled = true;
      window.__lt = [];
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]);
        }).observe({ type: 'longtask', buffered: true });
      } catch {
        /* longtask unsupported */
      }
      window.__frames = [];
      window.__frameRun = false;
    });
  }

  now() {
    return this.page.evaluate(() => performance.now());
  }

  longTasksBetween(t0, t1) {
    return this.page.evaluate(([a, b]) => window.__lt.filter(([s, d]) => s + d >= a && s <= b).map(([s, d]) => Math.round(d)), [t0, t1]);
  }

  async startFrames() {
    await this.page.evaluate(() => {
      window.__frames = [];
      window.__frameRun = true;
      let last = 0;
      const f = (t) => {
        if (last) window.__frames.push(t - last);
        last = t;
        if (window.__frameRun) requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
    });
  }

  async stopFrames() {
    return this.page.evaluate(() => {
      window.__frameRun = false;
      const a = window.__frames.slice().sort((x, y) => x - y);
      if (!a.length) return { n: 0 };
      const p = (q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
      return { n: a.length, p50: p(0.5), p95: p(0.95), max: a[a.length - 1], over50: a.filter((x) => x > 50).length, over100: a.filter((x) => x > 100).length };
    });
  }

  async gc() {
    for (let i = 0; i < 3; i++) {
      await this.cdp.send('HeapProfiler.collectGarbage').catch(() => {});
      await sleep(150);
    }
  }

  async rendererMetrics() {
    const { metrics } = await this.cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    return {
      jsHeapUsedMB: round(m.JSHeapUsedSize / 1048576, 2),
      jsHeapTotalMB: round(m.JSHeapTotalSize / 1048576, 2),
      domNodes: m.Nodes,
      jsEventListeners: m.JSEventListeners,
      documents: m.Documents,
      layoutCount: m.LayoutCount,
      recalcStyleCount: m.RecalcStyleCount,
      taskDurationS: round(m.TaskDuration, 3),
      scriptDurationS: round(m.ScriptDuration, 3),
    };
  }

  async ipcListeners() {
    const l = await this.page.evaluate(() => (window.__arkPerf ? window.__arkPerf.ipcListeners() : null)).catch(() => null);
    if (!l) return { total: null, byChannel: null };
    return { total: Object.values(l).reduce((a, b) => a + b, 0), byChannel: l };
  }

  mainProbe(fnName, ...args) {
    return this.app.evaluate((_e, [name, a]) => {
      const p = globalThis.__arkPerf;
      if (!p) return null;
      return p[name](...a);
    }, [fnName, args]);
  }

  eventLoop(reset = false) {
    return this.mainProbe('eventLoop', reset);
  }

  ipc(reset = true) {
    return this.mainProbe('ipc', reset);
  }

  setBytes(on) {
    return this.mainProbe('setByteAccounting', on);
  }

  /** Electron-reported metrics (per process type) plus the OS tree (adds llama-server / sidecars). */
  async processes() {
    const pm = await this.mainProbe('processMetrics');
    const tree = await sampleProcessTree(this.pid);
    const electronProcs = (pm?.appMetrics ?? []).map((m) => ({
      pid: m.pid,
      type: m.type,
      name: m.name ?? null,
      workingSetMB: round(m.memory.workingSetSize / 1024, 1),
      privateMB: round((m.memory.privateBytes ?? 0) / 1024, 1),
      cpuSec: round(m.cpu.cumulativeCPUUsage, 3),
    }));
    const electronPids = new Set(electronProcs.map((p) => p.pid));
    const external = tree.procs.filter((p) => !electronPids.has(p.pid) && p.pid !== this.pid && !/^(conhost|cmd)\.exe$/i.test(p.name));
    return {
      electron: electronProcs,
      external,
      childCount: tree.procs.length - 1,
      externalCount: external.length,
      totalWorkingSetMB: round(tree.procs.reduce((a, p) => a + p.workingSetMB, 0), 1),
      totalCpuSec: round(tree.procs.reduce((a, p) => a + p.cpuSec, 0), 2),
      mainHeapMB: pm ? round(pm.mainMemory.heapUsed / 1048576, 1) : null,
      mainRssMB: pm ? round(pm.mainMemory.rss / 1048576, 1) : null,
    };
  }

  /** GC first so heap readings are comparable, then take every reading. */
  async sample(label) {
    await this.gc();
    const [renderer, ipcL, procs] = await Promise.all([this.rendererMetrics(), this.ipcListeners(), this.processes()]);
    const gpu = procs.electron.filter((p) => p.type === 'GPU');
    return {
      label,
      t: Date.now(),
      renderer,
      ipcListeners: ipcL.total,
      ipcListenersByChannel: ipcL.byChannel,
      processCount: procs.childCount,
      externalProcessCount: procs.externalCount,
      gpuWorkingSetMB: gpu.length ? round(gpu.reduce((a, p) => a + p.workingSetMB, 0), 1) : null,
      gpuPrivateMB: gpu.length ? round(gpu.reduce((a, p) => a + p.privateMB, 0), 1) : null,
      totalWorkingSetMB: procs.totalWorkingSetMB,
      mainHeapMB: procs.mainHeapMB,
      mainRssMB: procs.mainRssMB,
      procs,
    };
  }
}
