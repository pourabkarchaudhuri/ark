import { describe, expect, it } from 'vitest';
import { budgets, evaluate, leakRules } from '../../scripts/perf/lib/analyze.mjs';

const sample = (over = {}) => ({
  renderer: { jsHeapUsedMB: 50, domNodes: 3000, jsEventListeners: 800 },
  ipcListeners: 13,
  processCount: 4,
  externalProcessCount: 0,
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
      extra: { browseLoadIpc: { invoke: { a: { calls: 5, argBytes: 100, resultBytes: 1000 } } }, gpuAfterArk: 210, browseScrollFrames: { p95: 17 } },
      eld: { p99: 20, max: 30 },
      longTasks: { 'browse-scroll': [80], oracle: [], 'oracle-compute': [120], all: [120] },
    });
  }
  return {
    meta: {},
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
    expect(failed).toContain('JS heap after scenario vs v1.0.96');
    expect(evaluate(base, base).failures).toEqual([]);
  });
});
