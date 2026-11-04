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
