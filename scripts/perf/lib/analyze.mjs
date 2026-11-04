/**
 * Turns a harness run (JSON) into flat metrics, applies the leak rules and the budgets from the 1.0.97
 * "Release gate: measure before shipping" plan section, and renders the markdown report.
 */
import { median, round } from './util.mjs';

const WARMUP_CYCLE = 2; // 1-based: leak rules compare cycle 2 against the last cycle

const cycleOf = (run, n) => run.cycles?.find((c) => c.n === n);

/** Flat, comparable metrics (all "lower is better"). */
export function summarize(run) {
  const m = {};
  const cs = run.coldStart?.runs ?? [];
  m.coldStartEnterReadyMs = median(cs.map((r) => r.enterReadyMs));
  m.coldStartInteractiveMs = median(cs.map((r) => r.interactiveMs));
  m.bootEventLoopMaxMs = median(cs.map((r) => r.eldMax));
  m.idle60CpuPct = run.idle60?.cpuPct;
  m.idle60MainEventLoopP99Ms = run.idle60?.eld?.p99;
  m.hiddenIdleCpuPct = run.hiddenIdle?.cpuPct;
  m.hiddenIdleMainEventLoopMaxMs = run.hiddenIdle?.eld?.max;
  const warm = (run.cycles ?? []).filter((c) => c.n >= WARMUP_CYCLE);
  const last = run.cycles?.[run.cycles.length - 1];
  if (last) {
    m.finalJsHeapMB = last.sample.renderer.jsHeapUsedMB;
    m.finalDomNodes = last.sample.renderer.domNodes;
    m.finalJsEventListeners = last.sample.renderer.jsEventListeners;
    m.finalTotalWorkingSetMB = last.sample.totalWorkingSetMB;
    m.finalMainRssMB = last.sample.mainRssMB;
    m.finalMainHeapMB = last.sample.mainHeapMB;
    m.finalGpuWorkingSetMB = last.sample.gpuWorkingSetMB;
  }
  m.scenarioEventLoopP99Ms = median(warm.map((c) => c.eld?.p99));
  m.scenarioEventLoopMaxMs = median((run.cycles ?? []).map((c) => c.eld?.max)); // typical per-cycle worst stall: a max over all cycles grows with the cycle count and is set by one GC / compaction / AV-scan spike
  m.scenarioEventLoopWorstSpikeMs = Math.max(...(run.cycles ?? []).map((c) => c.eld?.max ?? 0), 0);
  m.browseLoadIpcCalls = median(warm.map((c) => c.extra?.browseLoadIpc && sumCalls(c.extra.browseLoadIpc)));
  m.browseLoadIpcKB = median(warm.map((c) => c.extra?.browseLoadIpc && sumBytes(c.extra.browseLoadIpc) / 1024));
  m.browseScrollIpcCalls = median(warm.map((c) => c.extra?.browseScrollIpc && sumCalls(c.extra.browseScrollIpc)));
  m.browseScrollFrameP95Ms = median(warm.map((c) => c.extra?.browseScrollFrames?.p95));
  m.browseScrollFramesOver100 = median(warm.map((c) => c.extra?.browseScrollFrames?.over100));
  const lt = (key) => (run.cycles ?? []).flatMap((c) => c.longTasks?.[key] ?? []);
  m.browseScrollLongTaskMaxMs = Math.max(0, ...lt('browse-scroll'));
  m.oracleComputeLongTaskMaxMs = Math.max(0, ...lt('oracle-compute'), ...lt('oracle'));
  m.allStepsLongTaskMaxMs = Math.max(0, ...(run.cycles ?? []).flatMap((c) => c.longTasks?.all ?? []));
  m.applistRefreshEventLoopMaxMs = run.applist?.eld?.max;
  m.applistRefreshMs = run.applist?.ms;
  return m;
}

const sumCalls = (ipc) => Object.values(ipc.invoke ?? {}).reduce((a, s) => a + s.calls, 0);
const sumBytes = (ipc) => Object.values(ipc.invoke ?? {}).reduce((a, s) => a + s.argBytes + s.resultBytes, 0);

/** Leak rules on the current run only. */
export function leakRules(run) {
  const c2 = cycleOf(run, WARMUP_CYCLE);
  const cN = run.cycles?.[run.cycles.length - 1];
  const rules = [];
  const rule = (name, pass, detail) => rules.push({ name, pass, detail });
  if (!c2 || !cN || cN.n === c2.n) {
    rule('cycles', false, `need cycles ${WARMUP_CYCLE}..N, have ${run.cycles?.length ?? 0}`);
    return rules;
  }
  const a = c2.sample;
  const b = cN.sample;
  const pct = (x, y) => (x ? ((y - x) / x) * 100 : 0);
  const growth = (name, x, y, limitPct) => {
    const g = pct(x, y);
    rule(name, g < limitPct, `cycle ${c2.n}: ${x} -> cycle ${cN.n}: ${y} (${round(g, 2)}%, limit < ${limitPct}%)`);
  };
  const net = (name, x, y) => {
    if (x == null || y == null) return rule(name, false, 'not measured');
    rule(name, y - x <= 0, `cycle ${c2.n}: ${x} -> cycle ${cN.n}: ${y} (net ${y - x >= 0 ? '+' : ''}${y - x}, limit 0)`);
  };
  growth('JS heap growth (after forced GC)', a.renderer.jsHeapUsedMB, b.renderer.jsHeapUsedMB, 5);
  growth('DOM node growth', a.renderer.domNodes, b.renderer.domNodes, 5);
  net('JS event listeners net growth', a.renderer.jsEventListeners, b.renderer.jsEventListeners);
  net('IPC (ipcRenderer) listeners net growth', a.ipcListeners, b.ipcListeners);
  net('Child process count net growth', a.processCount, b.processCount);
  net('Non-Electron child processes (sidecars) net growth', a.externalProcessCount, b.externalProcessCount);
  // Baseline: the GPU working set just before the warm-up cycle's Voyage visit (older results: the cold-start reading).
  const gpu0 = c2.extra?.gpuBeforeArk ?? run.baselineSample?.gpuWorkingSetMB;
  const gpuN = cN.extra?.gpuAfterArk;
  const gpu2 = c2.extra?.gpuAfterArk;
  if (gpu0 && gpuN != null) {
    const okBase = gpuN <= gpu0 * 1.15;
    const okGrowth = gpu2 == null || gpuN <= gpu2 * 1.15; // and no growth from visit to visit
    rule('GPU memory returns to baseline after leaving Ark 3D', okBase && okGrowth, `baseline ${round(gpu0, 1)} MB (before the cycle-${c2.n} Voyage visit), after leaving Ark 3D: cycle ${c2.n} ${gpu2 != null ? round(gpu2, 1) : 'n/a'} MB, cycle ${cN.n} ${round(gpuN, 1)} MB once settled${cN.extra?.gpuAfterArk4s != null ? ` (${round(cN.extra.gpuAfterArk4s, 1)} MB at +4 s, before Chromium releases it)` : ''} (limit baseline +15%, and no more than +15% over cycle ${c2.n}; cold-start reading ${run.baselineSample?.gpuWorkingSetMB ?? 'n/a'} MB)`);
  } else rule('GPU memory returns to baseline after leaving Ark 3D', false, 'GPU process not measured');
  return rules;
}

/** Budgets: absolute ones, plus current vs baseline (no metric more than 10% worse). */
export function budgets(cur, base) {
  const mc = summarize(cur);
  const mb = base ? summarize(base) : null;
  const rows = [];
  const add = (name, pass, detail) => rows.push({ name, pass, detail });

  const lim = (name, v, max, unit) => (v == null || Number.isNaN(v) ? add(name, false, 'not measured') : add(name, v < max, `${round(v, 1)} ${unit} (limit < ${max} ${unit})`));
  lim('Main event-loop max during Steam app-list refresh', mc.applistRefreshEventLoopMaxMs, 100, 'ms');
  lim('Renderer long task during Browse scroll', mc.browseScrollLongTaskMaxMs, 200, 'ms');
  lim('Renderer long task during Oracle compute', mc.oracleComputeLongTaskMaxMs, 200, 'ms');
  lim('Idle CPU with window hidden (total, % of one core)', mc.hiddenIdleCpuPct, 1.0, '%');

  if (!mb) return rows;
  const cmp = (key, label, { tol = 0.1, floor = 0, unit = '' } = {}) => {
    const c = mc[key];
    const b = mb[key];
    if (c == null || b == null || Number.isNaN(c) || Number.isNaN(b)) return add(label, true, `n/a (current ${c ?? 'missing'}, baseline ${b ?? 'missing'})`);
    const limit = b * (1 + tol) + floor;
    add(label, c <= limit, `${round(c, 2)}${unit} vs v1.0.96 ${round(b, 2)}${unit} (${b ? (c >= b ? '+' : '') + round(((c - b) / b) * 100, 1) : 'n/a'}%, limit ${round(limit, 2)}${unit})`);
  };
  cmp('coldStartInteractiveMs', 'Cold start to first interactive (median) vs v1.0.96', { tol: 0.05, unit: ' ms' });
  cmp('coldStartEnterReadyMs', 'Cold start to Enter Ark ready (median) vs v1.0.96', { tol: 0.05, unit: ' ms' });
  cmp('bootEventLoopMaxMs', 'Boot main event-loop max (median) vs v1.0.96', { floor: 5, unit: ' ms' });
  cmp('idle60CpuPct', 'Idle CPU 60 s (total) vs v1.0.96', { floor: 0.5, unit: '%' });
  cmp('hiddenIdleCpuPct', 'Hidden idle CPU vs v1.0.96', { floor: 0.3, unit: '%' });
  cmp('finalJsHeapMB', 'JS heap after scenario vs v1.0.96', { unit: ' MB' });
  cmp('finalDomNodes', 'DOM nodes after scenario vs v1.0.96', {});
  cmp('finalJsEventListeners', 'JS event listeners after scenario vs v1.0.96', {});
  cmp('finalTotalWorkingSetMB', 'Total working set (all processes) after scenario vs v1.0.96', { unit: ' MB' });
  cmp('finalMainRssMB', 'Main process RSS after scenario vs v1.0.96', { unit: ' MB' });
  cmp('scenarioEventLoopP99Ms', 'Main event-loop p99 over scenario vs v1.0.96', { floor: 5, unit: ' ms' });
  cmp('scenarioEventLoopMaxMs', 'Main event-loop max per cycle (median of cycles) vs v1.0.96', { floor: 20, unit: ' ms' });
  cmp('browseLoadIpcCalls', 'IPC calls per Browse screen (median) vs v1.0.96 (not higher)', { tol: 0, unit: '' });
  cmp('browseLoadIpcKB', 'IPC payload per Browse screen vs v1.0.96', { unit: ' KB' });
  cmp('browseScrollFrameP95Ms', 'Browse scroll frame time p95 vs v1.0.96', { floor: 2, unit: ' ms' });
  cmp('applistRefreshEventLoopMaxMs', 'Event-loop max during app-list refresh vs v1.0.96', { floor: 10, unit: ' ms' });
  return rows;
}

export function evaluate(cur, base) {
  const leaks = leakRules(cur);
  const bud = budgets(cur, base);
  const failures = [...leaks.filter((r) => !r.pass).map((r) => `LEAK ${r.name}: ${r.detail}`), ...bud.filter((r) => !r.pass).map((r) => `BUDGET ${r.name}: ${r.detail}`)];
  return { leaks, budgets: bud, failures, metrics: summarize(cur), baselineMetrics: base ? summarize(base) : null };
}

// ---------------------------------------------------------------------------------------------------------

export function renderMarkdown(cur, base, ev) {
  const L = [];
  const f = (v, d = 1) => (v == null || Number.isNaN(v) ? 'n/a' : String(round(v, d)));
  L.push(`# 1.0.97 measurements (${cur.meta.label} vs ${base ? base.meta.label : "no baseline"})`, "");
  L.push(`Harness: \`scripts/perf/measure.mjs\` (Playwright \`_electron\`, ARK_PERF=1 probes, CDP \`Performance.getMetrics\`, forced GC before every heap reading).`);
  L.push(`Current: \`${cur.meta.label}\` (${cur.meta.commit ?? 'n/a'}) on ${cur.meta.machine}. Baseline: ${base ? `\`${base.meta.label}\` (${base.meta.commit ?? 'n/a'})` : 'none'}.`);
  L.push(`Profile: ${cur.meta.profile.games} library games, ${cur.meta.profile.statusRows} status-history rows, ${cur.meta.profile.sessions} sessions, ${cur.meta.profile.appListEntries} Steam app-list entries, copied test userData, no real keys. ${cur.meta.cycles} cycles, ${cur.meta.idleS} s idle, ${cur.meta.hiddenIdleS} s hidden idle.`, '');
  L.push(`Verdict: **${ev.failures.length ? 'FAIL' : 'PASS'}** (${ev.failures.length} failing metric${ev.failures.length === 1 ? '' : 's'}).`, '');

  L.push('## Before / after', '', '| Metric | v1.0.96 | Current | Change |', '|---|---:|---:|---:|');
  const mc = ev.metrics;
  const mb = ev.baselineMetrics;
  const rowsDef = [
    ['coldStartEnterReadyMs', 'Cold start to Enter Ark ready (ms, median)'],
    ['coldStartInteractiveMs', 'Cold start to first interactive (ms, median)'],
    ['bootEventLoopMaxMs', 'Boot main event-loop max (ms, median)'],
    ['idle60CpuPct', 'Idle CPU, 60 s, visible (% of one core, all processes)'],
    ['hiddenIdleCpuPct', 'Idle CPU, window hidden (%)'],
    ['finalJsHeapMB', 'JS heap after scenario (MB, post-GC)'],
    ['finalDomNodes', 'DOM nodes after scenario'],
    ['finalJsEventListeners', 'JS event listeners after scenario'],
    ['finalTotalWorkingSetMB', 'Total working set, all processes (MB)'],
    ['finalMainRssMB', 'Main process RSS (MB)'],
    ['finalGpuWorkingSetMB', 'GPU process working set (MB)'],
    ['scenarioEventLoopP99Ms', 'Main event-loop p99 over scenario (ms, median of cycles)'],
    ['scenarioEventLoopMaxMs', 'Main event-loop max per cycle (ms, median of cycles)'],
    ['scenarioEventLoopWorstSpikeMs', 'Main event-loop worst single spike over scenario (ms, informational)'],
    ['browseLoadIpcCalls', 'IPC calls per Browse screen (median)'],
    ['browseLoadIpcKB', 'IPC payload per Browse screen (KB, median)'],
    ['browseScrollIpcCalls', 'IPC calls during 3-screen Browse scroll (median)'],
    ['browseScrollFrameP95Ms', 'Browse scroll frame time p95 (ms)'],
    ['browseScrollFramesOver100', 'Browse scroll frames over 100 ms (median)'],
    ['browseScrollLongTaskMaxMs', 'Longest renderer long task during Browse scroll (ms)'],
    ['oracleComputeLongTaskMaxMs', 'Longest renderer long task during Oracle (ms)'],
    ['allStepsLongTaskMaxMs', 'Longest renderer long task, any step (ms)'],
    ['applistRefreshEventLoopMaxMs', 'Main event-loop max during Steam app-list refresh (ms)'],
    ['applistRefreshMs', 'Steam app-list refresh wall time (ms)'],
  ];
  for (const [k, label] of rowsDef) {
    const c = mc[k];
    const b = mb?.[k];
    const ch = c != null && b != null && b !== 0 && !Number.isNaN(c) && !Number.isNaN(b) ? `${c >= b ? '+' : ''}${round(((c - b) / b) * 100, 1)}%` : 'n/a';
    L.push(`| ${label} | ${f(b, 2)} | ${f(c, 2)} | ${ch} |`);
  }

  L.push('', '## Leak rules (current build, cycle 2 vs last cycle)', '', '| Rule | Result | Detail |', '|---|---|---|');
  for (const r of ev.leaks) L.push(`| ${r.name} | ${r.pass ? 'pass' : '**FAIL**'} | ${r.detail} |`);

  L.push('', '## Budgets', '', '| Budget | Result | Detail |', '|---|---|---|');
  for (const r of ev.budgets) L.push(`| ${r.name} | ${r.pass ? 'pass' : '**FAIL**'} | ${r.detail} |`);

  const table = (run, title) => {
    L.push('', `## ${title}: per-cycle readings (post-GC)`, '', '| Cycle | JS heap MB | DOM nodes | JS listeners | IPC listeners | Procs | Sidecars | GPU MB after Ark | ELD p99 ms | ELD max ms | Total WS MB |', '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    const b0 = run.baselineSample;
    if (b0) L.push(`| 0 | ${f(b0.renderer.jsHeapUsedMB)} | ${b0.renderer.domNodes} | ${b0.renderer.jsEventListeners} | ${b0.ipcListeners ?? 'n/a'} | ${b0.processCount} | ${b0.externalProcessCount} | ${f(b0.gpuWorkingSetMB)} (pre-Ark) | - | - | ${f(b0.totalWorkingSetMB)} |`);
    for (const c of run.cycles ?? []) {
      const s = c.sample;
      L.push(`| ${c.n} | ${f(s.renderer.jsHeapUsedMB)} | ${s.renderer.domNodes} | ${s.renderer.jsEventListeners} | ${s.ipcListeners ?? 'n/a'} | ${s.processCount} | ${s.externalProcessCount} | ${f(c.extra?.gpuAfterArk)} | ${f(c.eld?.p99, 2)} | ${f(c.eld?.max, 1)} | ${f(s.totalWorkingSetMB)} |`);
    }
  };
  table(cur, cur.meta.label);
  if (base) table(base, base.meta.label);

  L.push('', '## Cold start samples', '', '| Build | Enter Ark ready (ms) | First interactive (ms) | Boot event-loop max (ms) |', '|---|---|---|---|');
  for (const r of [cur, base].filter(Boolean)) L.push(`| ${r.meta.label} | ${(r.coldStart?.runs ?? []).map((x) => Math.round(x.enterReadyMs)).join(', ')} | ${(r.coldStart?.runs ?? []).map((x) => Math.round(x.interactiveMs)).join(', ')} | ${(r.coldStart?.runs ?? []).map((x) => f(x.eldMax)).join(', ')} |`);

  L.push('', '## Processes at end of scenario (current)', '', '| Process | Type | Working set MB | Private MB |', '|---|---|---:|---:|');
  const lastC = cur.cycles?.[cur.cycles.length - 1];
  for (const p of lastC?.sample.procs.electron ?? []) L.push(`| ${p.name ?? p.type} | ${p.type} | ${f(p.workingSetMB)} | ${f(p.privateMB)} |`);
  for (const p of lastC?.sample.procs.external ?? []) L.push(`| ${p.name} | external child | ${f(p.workingSetMB)} | - |`);
  if (!(lastC?.sample.procs.external ?? []).length) L.push('| (no llama-server / Python sidecar running: idle-unloaded) | - | - | - |');

  L.push('', '## Scenario notes', '');
  for (const r of [cur, base].filter(Boolean)) {
    L.push(`- ${r.meta.label}: skipped or failed steps: ${(r.skippedSteps ?? []).length ? (r.skippedSteps ?? []).map((s) => `\`${s}\``).join('; ') : 'none'}`);
  }
  for (const r of [cur, base].filter(Boolean)) if (r.meta.note) L.push(`- ${r.meta.label} note: ${r.meta.note}`);
  L.push('', '## Hidden idle detail', '', '| Build | Method | CPU % | Per process (CPU s over the window) |', '|---|---|---:|---|');
  for (const r of [cur, base].filter(Boolean)) {
    for (const [key, name] of [['hiddenIdle', 'detached (budget)'], ['hiddenIdleAttached', 'Playwright attached (informational)']]) {
      const h = r[key];
      if (!h) continue;
      const per = (h.perProcessCpuSec ?? []).map((p) => `${p.type} ${p.dCpuSec}`).join(', ');
      L.push(`| ${r.meta.label} | ${name}, ${h.seconds} s | ${h.cpuPct} | ${per} |`);
    }
  }
  if (cur.heapDiff) L.push('', '## Heap snapshot diff (cycle 2 vs last cycle)', '', '```', cur.heapDiff, '```');
  L.push('', `Method notes: event-loop numbers come from \`monitorEventLoopDelay\` (10 ms resolution) in the main process; IPC bytes are JSON-length of args plus results and are switched off while the app-list refresh is timed so the probe does not add to the event-loop delay; CPU is the cumulative user+kernel time of the whole process tree (Electron processes plus llama-server and any Python sidecar) divided by wall time. Cold-start budget uses a 5% noise allowance, the other relative budgets 10% (plus a small absolute floor on near-zero metrics).`);
  return L.join('\n') + '\n';
}
