import { describe, expect, it } from 'vitest';
import { budgets, evaluate, leakRules } from '../../scripts/perf/lib/analyze.mjs';

const sample = (over = {}) => ({
  renderer: { jsHeapUsedMB: 50, domNodes: 3000, jsEventListeners: 800 },
  ipcListeners: 13,
  processCount: 4,
  externalProcessCount: 2,
  llamaCount: 2,
  llamaWorkingSetMB: 1500,
  pythonCount: 0,
  otherExternal: [],
  gpuWorkingSetMB: 200,
  totalWorkingSetMB: 900,
  mainRssMB: 300,
  mainHeapMB: 60,
  ...over,
});

function run({ heap = 50, nodes = 3000, listeners = 800, ipc = 13, procs = 4 } = {}) {
  const cycles = [];
  for (let n = 1; n <= 10; n++) {
    const grown = n > 2;
    cycles.push({
      n,
      sample: sample({
        renderer: { jsHeapUsedMB: grown ? heap : 50, domNodes: grown ? nodes : 3000, jsEventListeners: grown ? listeners : 800 },
        ipcListeners: grown ? ipc : 13,
        processCount: grown ? procs : 4,
      }),
      steps: { 'browse-load': { ipc: { invokeCalls: 5, sendCalls: 2, kb: 3 } }, oracle: { ipc: { invokeCalls: 10, sendCalls: 0, kb: 20 } } },
      extra: { settingsPages: [{ i: 0, label: 'a', mountMs: 90, longTaskMaxMs: 60 }, { i: 1, label: 'b', mountMs: 120, longTaskMaxMs: 80 }], settingsOpenLongTaskMaxMs: 70, browseLoadIpc: { invoke: { a: { calls: 5, argBytes: 100, resultBytes: 1000 } } }, gpuAfterArk: 210, browseScrollFrames: { p95: 17 } },
      eld: { p99: 20, max: 30 },
      longTasks: { 'browse-scroll': [80], oracle: [], 'oracle-compute': [120], all: [120] },
    });
  }
  return {
    meta: { label: 'v1.0.97', ai: { enabled: true } },
    ipcSelfTest: { ok: true, channel: 'localAi:status', expected: 5, got: 5, handlers: 188 },
    quitScenario: { leftovers: [] },
    scenarioModels: { ready: true, ms: 9000 },
    ai: {
      atBoot: { pythonCount: 0, llamaCount: 0 },
      llama: {
        quiesced: true,
        quietAfterS: 90,
        perRole: { embed: { workingSetMB: 900, idleCpuPct: 0.1, burstCpuPct: 150 }, rerank: { workingSetMB: 700, idleCpuPct: 0.1, burstCpuPct: 90 } },
        routes: { embeddings: 'local', reranker: 'local' },
        overheadPct: { embed: 2, rerank: 3, combined: 2.4 },
        itemsPerS: { app: 40, direct: 41 },
        burstEld: { max: 30 },
      },
      download: { ok: true, mbPerS: 400, eldMaxMs: 40, statusPushesMaxPerSec: 2, statusPushesPerSecAvg: 1.3 },
      sidecar: { beforeRoute: { pythonProcesses: 0 }, afterRoute: { sidecarState: 'ready', pythonProcesses: 1, pythonWorkingSetMB: 120 }, idleCpuPct: 0.1 },
      quit: { sidecarWasRunning: true, leftovers: [] },
    },
    coldStart: { runs: [{ enterReadyMs: 9000, interactiveMs: 12000, eldMax: 100 }] },
    idle60: { cpuPct: 0.4, eld: { p99: 20 } },
    hiddenIdle: { cpuPct: 0.2, eld: { max: 30 } },
    baselineSample: sample(),
    cycles,
    applist: { eld: { max: 40 }, ms: 500 },
  };
}

describe('perf harness analysis', () => {
  it('passes a flat run', () => {
    expect(leakRules(run()).every((r) => r.pass)).toBe(true);
  });

  it('flags heap growth of 5% or more, any listener growth and extra processes', () => {
    const rules = leakRules(run({ heap: 53, listeners: 801, ipc: 14, procs: 5 }));
    const failed = rules.filter((r) => !r.pass).map((r) => r.name);
    expect(failed).toEqual(
      expect.arrayContaining([
        'JS heap growth (after forced GC)',
        'JS event listeners net growth',
        'IPC (ipcRenderer) listeners net growth',
        'Child process count net growth',
      ]),
    );
  });

  it('GPU rule: compares the settled reading with the warm pre-Ark reading and with the warm-up visit', () => {
    const gpuRule = (r) => leakRules(r).find((x) => x.name.startsWith('GPU memory'));
    const withGpu = (before, after2, afterN) => {
      const r = run();
      r.baselineSample.gpuWorkingSetMB = 170; // cold start reading, before any screen has cached anything
      r.cycles.find((c) => c.n === 2).extra.gpuBeforeArk = before;
      r.cycles.find((c) => c.n === 2).extra.gpuAfterArk = after2;
      r.cycles[r.cycles.length - 1].extra.gpuAfterArk = afterN;
      return r;
    };
    expect(gpuRule(withGpu(280, 182, 190)).pass).toBe(true);
    // memory that creeps up from one Ark visit to the next is a leak even while it stays under the pre-Ark level
    expect(gpuRule(withGpu(280, 182, 230)).pass).toBe(false);
    // and memory that never comes back down fails
    expect(gpuRule(withGpu(200, 330, 330)).pass).toBe(false);
  });

  it('event-loop max budget uses the median of the per-cycle maxima, not the one worst spike', () => {
    const base = run();
    const cur = run();
    cur.cycles[2].eld.max = 400; // one GC / compaction spike in a 10-cycle run
    expect(budgets(cur, base).find((r) => r.name.startsWith('Main event-loop max per cycle')).pass).toBe(true);
    cur.cycles.forEach((c) => (c.eld.max = 400)); // every cycle stalls
    expect(budgets(cur, base).find((r) => r.name.startsWith('Main event-loop max per cycle')).pass).toBe(false);
  });

  it('enforces the absolute budgets and the 10% relative budget', () => {
    const base = run();
    const bad = run();
    bad.applist.eld.max = 150;
    bad.cycles.forEach((c) => (c.sample.renderer.jsHeapUsedMB = 60));
    const failed = budgets(bad, base).filter((r) => !r.pass).map((r) => r.name);
    expect(failed).toContain('Main event-loop max during Steam app-list refresh');
    expect(failed).toContain('JS heap after scenario vs v1.0.97');
    expect(evaluate(base, base).failures).toEqual([]);
  });

  it('hidden idle budget reads the detached measurement, never the attached (Playwright) one', () => {
    const base = run();
    const cur = run();
    cur.hiddenIdleAttached = { cpuPct: 1.77, seconds: 120 }; // informational only
    cur.hiddenIdle = { cpuPct: 0.14, seconds: 120 };
    expect(budgets(cur, base).filter((r) => /hidden/i.test(r.name)).every((r) => r.pass)).toBe(true);
    cur.hiddenIdle = { cpuPct: 1.5, seconds: 120 };
    expect(budgets(cur, base).filter((r) => /hidden/i.test(r.name)).some((r) => !r.pass)).toBe(true);
  });

  describe('1.0.98 harness upgrade', () => {
    const rule = (r, start) => leakRules(r).find((x) => x.name.startsWith(start));
    const budget = (r, start) => budgets(r, run()).find((x) => x.name.startsWith(start));

    it('a run whose IPC self-test failed fails a rule and reports no IPC metrics (a blind probe proves nothing)', () => {
      const r = run();
      expect(rule(r, 'IPC probe self-test').pass).toBe(true);
      r.ipcSelfTest = { ok: false, channel: 'localAi:status', expected: 5, got: 0, handlers: 188 };
      expect(rule(r, 'IPC probe self-test').pass).toBe(false);
      expect(evaluate(r, run()).metrics.cycleIpcInvokeCalls).toBeNaN();
      delete r.ipcSelfTest;
      expect(rule(r, 'IPC probe self-test').pass).toBe(false);
    });

    it('sums IPC over every step of a cycle, so a Browse screen with no call is not the whole story', () => {
      const m = evaluate(run(), null).metrics;
      expect(m.cycleIpcInvokeCalls).toBe(15);
      expect(m.cycleIpcPushCalls).toBe(2);
      expect(m.cycleIpcKB).toBe(23);
      const base = run();
      const cur = run();
      cur.cycles.forEach((c) => (c.steps.oracle.ipc.invokeCalls = 40));
      expect(budget(cur, 'IPC calls per scenario cycle').pass).toBe(false);
      expect(budget(base, 'IPC calls per scenario cycle').pass).toBe(true);
    });

    it('compares from meta.warmupCycle: a one-time step-up inside the warm-up window is not growth', () => {
      const r = run({ heap: 60 });
      r.cycles.forEach((c) => c.n === 3 && (c.sample.renderer.jsHeapUsedMB = 60)); // 50 -> 60 at cycle 3, flat after
      expect(rule(r, 'JS heap growth').pass).toBe(false);
      r.meta.warmupCycle = 4;
      expect(rule(r, 'JS heap growth').pass).toBe(true);
      r.cycles.forEach((c) => c.n > 4 && (c.sample.renderer.jsHeapUsedMB = 70));
      expect(rule(r, 'JS heap growth').pass).toBe(false); // growth after the warm-up still fails
    });

    it('llama-server and python leak rules', () => {
      expect(leakRules(run()).filter((r) => !r.pass)).toEqual([]);
      const grow = run();
      grow.cycles.forEach((c) => c.n > 2 && (c.sample.llamaCount = 3));
      expect(rule(grow, 'llama-server process count').pass).toBe(false);
      const mem = run();
      mem.cycles.forEach((c) => c.n > 2 && (c.sample.llamaWorkingSetMB = 1800));
      expect(rule(mem, 'llama-server working set').pass).toBe(false);
      const nomodels = run();
      nomodels.scenarioModels = { ready: false, ms: 180000 };
      expect(rule(nomodels, 'Embed and rerank models were ready').pass).toBe(false);
      const none = run();
      none.cycles.forEach((c) => (c.sample.llamaCount = 0));
      expect(rule(none, 'llama-server processes never exceed').pass).toBe(false); // the scenario never exercised the AI
      const py = run();
      py.cycles[4].sample.pythonCount = 1;
      expect(rule(py, 'LiteLLM python sidecar does not run').pass).toBe(false);
      const other = run();
      other.cycles[4].sample.otherExternal = ['node.exe'];
      expect(rule(other, 'Non-Electron children').pass).toBe(false);
      const left = run();
      left.quitScenario.leftovers = [{ name: 'llama-server.exe' }];
      expect(rule(left, 'No llama-server / python left').pass).toBe(false);
      const stay = run();
      stay.ai.quit.leftovers = [{ name: 'python.exe' }];
      expect(rule(stay, 'LiteLLM python and llama-server exit on quit').pass).toBe(false);
      const nosc = run();
      nosc.ai.quit.sidecarWasRunning = false; // an exit check with nothing running proves nothing
      expect(rule(nosc, 'LiteLLM python and llama-server exit on quit').pass).toBe(false);
    });

    it('download, Settings, idle CPU and router overhead budgets', () => {
      expect(budgets(run(), run()).filter((r) => !r.pass)).toEqual([]);
      const dl = run();
      dl.ai.download.eldMaxMs = 140;
      expect(budget(dl, 'Download: main event-loop max').pass).toBe(false);
      const push = run();
      push.ai.download.statusPushesMaxPerSec = 6;
      expect(budget(push, 'Download: status IPC pushes').pass).toBe(false);
      const st = run();
      st.cycles[3].extra.settingsPages[1].longTaskMaxMs = 260;
      expect(budget(st, 'Renderer long task while a Settings page mounts').pass).toBe(false);
      const busy = run();
      busy.ai.llama.quiesced = false;
      expect(budget(busy, 'llama-server goes quiet').pass).toBe(false);
      const idle = run();
      idle.ai.llama.perRole.embed.idleCpuPct = 4.5;
      expect(budget(idle, 'llama-server idle CPU').pass).toBe(false);
      const ov = run();
      ov.ai.llama.overheadPct.combined = 22;
      expect(budget(ov, 'Router overhead').pass).toBe(false);
      const routed = run();
      routed.ai.llama.routes.embeddings = 'router';
      expect(budget(routed, 'Router overhead measured on the built-in route').pass).toBe(false);
    });

    it('an AI-enabled run that never measured the AI fails instead of passing silently', () => {
      const r = run();
      delete r.ai.llama;
      expect(budget(r, 'Built-in AI measured').pass).toBe(false);
      const broken = run();
      broken.ai.download = { ok: false, error: 'build has no overridable local-ai manifest' };
      expect(budget(broken, 'Built-in AI measured').pass).toBe(false);
    });

    it('a run without the AI profile skips the AI rules and budgets but not the self-test', () => {
      const r = run();
      r.meta.ai = { enabled: false };
      delete r.ai;
      expect(leakRules(r).filter((x) => !x.pass)).toEqual([]);
      expect(budgets(r, run()).some((x) => /Built-in AI measured|^Download: (main event-loop max while|status)|^Router overhead/.test(x.name))).toBe(false);
    });
  });
});
