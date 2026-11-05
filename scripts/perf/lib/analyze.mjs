/**
 * Turns a harness run (JSON) into flat metrics, applies the leak rules and the budgets from the 1.0.97
 * "Release gate: measure before shipping" plan section, and renders the markdown report.
 */
import { median, round } from './util.mjs';

// 1-based: the leak rules compare the warm-up cycle against the last cycle. With the built-in AI running the renderer's heap steps up
// once, over cycles 1-3 (measured on v1.0.97: 38.9, 43.4, 59.9 MB, then flat at 62-64 for seven cycles: caches and vectors the first
// embeddings load), so the harness records meta.warmupCycle = 4 for such runs; without the AI it stays 2.
const warmupOf = (run) => run?.meta?.warmupCycle ?? 2;

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
  const warm = (run.cycles ?? []).filter((c) => c.n >= warmupOf(run));
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
  // IPC over a whole cycle: the Browse screen alone can legitimately make no call (cached, offline), so the budgets also watch the sum
  // over every step. A run whose self-test failed reports null: a blind probe proves nothing.
  const ipcOk = run.ipcSelfTest?.ok === true;
  const perCycle = (key) => median(warm.map((c) => (ipcOk ? Object.values(c.steps ?? {}).reduce((a, st) => a + (st?.ipc?.[key] ?? 0), 0) : null)));
  m.cycleIpcInvokeCalls = perCycle('invokeCalls');
  m.cycleIpcPushCalls = perCycle('sendCalls');
  m.cycleIpcKB = perCycle('kb');
  m.browseLoadIpcCalls = median(warm.map((c) => c.extra?.browseLoadIpc && sumCalls(c.extra.browseLoadIpc)));
  m.browseLoadIpcKB = median(warm.map((c) => c.extra?.browseLoadIpc && sumBytes(c.extra.browseLoadIpc) / 1024));
  m.browseScrollIpcCalls = median(warm.map((c) => c.extra?.browseScrollIpc && sumCalls(c.extra.browseScrollIpc)));
  m.browseScrollFrameP95Ms = median(warm.map((c) => c.extra?.browseScrollFrames?.p95));
  m.browseScrollFramesOver100 = median(warm.map((c) => c.extra?.browseScrollFrames?.over100));
  const lt = (key) => (run.cycles ?? []).flatMap((c) => c.longTasks?.[key] ?? []);
  m.browseScrollLongTaskMaxMs = Math.max(0, ...lt('browse-scroll'));
  m.oracleComputeLongTaskMaxMs = Math.max(0, ...lt('oracle-compute'), ...lt('oracle'));
  m.allStepsLongTaskMaxMs = Math.max(0, ...(run.cycles ?? []).flatMap((c) => c.longTasks?.all ?? []));
  // Settings pages: mount cost per page (click -> DOM quiet) and the longest renderer long task while one mounted
  const pages = (run.cycles ?? []).flatMap((c) => c.extra?.settingsPages ?? []).filter((p) => p && !p.error);
  const opens = (run.cycles ?? []).map((c) => c.extra?.settingsOpenLongTaskMaxMs).filter((x) => x != null);
  m.settingsLongTaskMaxMs = pages.length || opens.length ? Math.max(0, ...pages.map((p) => p.longTaskMaxMs ?? 0), ...opens) : null;
  m.settingsMountMaxMs = pages.length ? Math.max(...(run.cycles ?? []).map((c) => Math.max(0, ...(c.extra?.settingsPages ?? []).map((p) => p.mountMs ?? 0)))) : null;
  m.settingsMountMedianMs = pages.length ? median(pages.map((p) => p.mountMs)) : null;
  m.settingsPagesMeasured = pages.length ? new Set(pages.map((p) => p.i)).size : null;
  // built-in AI
  const ai = run.ai;
  const llama = ai?.llama;
  const roleWs = (role) => llama?.perRole?.[role]?.workingSetMB;
  m.llamaEmbedWorkingSetMB = roleWs('embed');
  m.llamaRerankWorkingSetMB = roleWs('rerank');
  m.llamaWorkingSetTotalMB = llama?.perRole ? round(Object.values(llama.perRole).reduce((a, r) => a + (r.workingSetMB ?? 0), 0), 1) : undefined;
  m.llamaQuietAfterS = llama?.quietAfterS;
  m.llamaIdleCpuPctMax = llama?.perRole ? Math.max(0, ...Object.values(llama.perRole).map((r) => r.idleCpuPct ?? 0)) : undefined;
  m.llamaBurstCpuPctTotal = llama?.perRole ? round(Object.values(llama.perRole).reduce((a, r) => a + (r.burstCpuPct ?? 0), 0), 1) : undefined;
  m.routerOverheadPct = llama?.overheadPct?.combined;
  m.routerOverheadEmbedPct = llama?.overheadPct?.embed;
  m.routerOverheadRerankPct = llama?.overheadPct?.rerank;
  m.aiItemsPerSApp = llama?.itemsPerS?.app;
  m.aiItemsPerSDirect = llama?.itemsPerS?.direct;
  m.aiBurstEventLoopMaxMs = llama?.burstEld?.max;
  m.downloadMBps = ai?.download?.mbPerS;
  m.downloadEventLoopMaxMs = ai?.download?.eldMaxMs;
  m.downloadStatusPushesMaxPerSec = ai?.download?.statusPushesMaxPerSec;
  m.downloadStatusPushesAvgPerSec = ai?.download?.statusPushesPerSecAvg;
  m.sidecarPythonWorkingSetMB = ai?.sidecar?.afterRoute?.pythonWorkingSetMB;
  m.applistRefreshEventLoopMaxMs = run.applist?.eld?.max;
  m.applistRefreshMs = run.applist?.ms;
  return m;
}

const sumCalls = (ipc) => Object.values(ipc.invoke ?? {}).reduce((a, s) => a + s.calls, 0);
const sumBytes = (ipc) => Object.values(ipc.invoke ?? {}).reduce((a, s) => a + s.argBytes + s.resultBytes, 0);

/** Leak rules on the current run only. */
export function leakRules(run) {
  const WARMUP_CYCLE = warmupOf(run);
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
  // The IPC counters must be able to read non-zero before any IPC budget means anything.
  rule('IPC probe self-test (a known call is counted)', run.ipcSelfTest?.ok === true, run.ipcSelfTest ? `${run.ipcSelfTest.channel}: called ${run.ipcSelfTest.expected}x through the renderer bridge, probe counted ${run.ipcSelfTest.got}x, ${run.ipcSelfTest.handlers} handlers wrapped` : 'not run');
  growth('JS heap growth (after forced GC)', a.renderer.jsHeapUsedMB, b.renderer.jsHeapUsedMB, 5);
  growth('DOM node growth', a.renderer.domNodes, b.renderer.domNodes, 5);
  net('JS event listeners net growth', a.renderer.jsEventListeners, b.renderer.jsEventListeners);
  net('IPC (ipcRenderer) listeners net growth', a.ipcListeners, b.ipcListeners);
  net('Child process count net growth', a.processCount, b.processCount);
  net('Non-Electron child processes (sidecars) net growth', a.externalProcessCount, b.externalProcessCount);
  if (run.meta?.ai?.enabled) {
    const all = (run.cycles ?? []).map((c) => c.sample);
    const maxLlama = Math.max(0, ...all.map((x) => x.llamaCount ?? 0));
    rule('Embed and rerank models were ready for the scenario run', run.scenarioModels?.ready === true, run.scenarioModels ? `ready after ${run.scenarioModels.ms} ms` : 'not enabled');
    net('llama-server process count net growth', a.llamaCount, b.llamaCount);
    rule('llama-server processes never exceed the roles in use (4 max)', maxLlama <= 4 && (b.llamaCount ?? 0) > 0, `${b.llamaCount ?? 'n/a'} running at cycle ${cN.n}, most seen ${maxLlama}${(b.llamaCount ?? 0) > 0 ? '' : ' (none ran: the scenario did not exercise the built-in AI)'}`);
    growth('llama-server working set growth', a.llamaWorkingSetMB, b.llamaWorkingSetMB, 10);
    const pyMax = Math.max(0, ...all.map((x) => x.pythonCount ?? 0));
    rule('LiteLLM python sidecar does not run with built-in routes only', pyMax === 0, `most python processes seen in any cycle sample: ${pyMax} (limit 0)`);
    const others = [...new Set(all.flatMap((x) => x.otherExternal ?? []))];
    rule('Non-Electron children are llama-server only', others.length === 0, others.length ? `unexpected: ${others.join(', ')}` : 'none other');
    const left = run.quitScenario?.leftovers;
    rule('No llama-server / python left after quitting the scenario run', Array.isArray(left) && left.every((p) => !/llama-server|python/i.test(p.name)), Array.isArray(left) ? (left.length ? `left: ${left.map((p) => p.name).join(', ')}` : 'tree empty after quit') : 'not measured');
    const aiLeft = run.ai?.quit?.leftovers;
    rule('LiteLLM python and llama-server exit on quit (AI phase, sidecar started)', Array.isArray(aiLeft) && run.ai?.quit?.sidecarWasRunning === true && aiLeft.every((p) => !/llama-server|python/i.test(p.name)), Array.isArray(aiLeft) ? `sidecar running before quit: ${run.ai.quit.sidecarWasRunning}; left after quit: ${aiLeft.length ? aiLeft.map((p) => p.name).join(', ') : 'none'}` : 'not measured');
    const boot = run.ai?.atBoot;
    rule('No LiteLLM python process at boot or before a non-built-in route exists', boot != null && boot.pythonCount === 0 && run.ai?.sidecar?.beforeRoute?.pythonProcesses === 0, boot ? `at boot ${boot.pythonCount} python, before the route ${run.ai?.sidecar?.beforeRoute?.pythonProcesses}` : 'not measured');
  }
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
  const B = base?.meta?.label ?? 'baseline';
  const rows = [];
  const add = (name, pass, detail) => rows.push({ name, pass, detail });

  const lim = (name, v, max, unit) => (v == null || Number.isNaN(v) ? add(name, false, 'not measured') : add(name, v < max, `${round(v, 1)} ${unit} (limit < ${max} ${unit})`));
  lim('Main event-loop max during Steam app-list refresh', mc.applistRefreshEventLoopMaxMs, 100, 'ms');
  lim('Renderer long task during Browse scroll', mc.browseScrollLongTaskMaxMs, 200, 'ms');
  lim('Renderer long task during Oracle compute', mc.oracleComputeLongTaskMaxMs, 200, 'ms');
  lim('Idle CPU with window hidden (total, % of one core)', mc.hiddenIdleCpuPct, 1.0, '%');
  lim('Renderer long task while a Settings page mounts (any page, any cycle)', mc.settingsLongTaskMaxMs, 200, 'ms');
  if (cur.meta?.ai?.enabled) {
    const aiOk = Boolean(cur.ai?.llama?.perRole && Object.keys(cur.ai.llama.perRole).length && cur.ai?.download?.ok && cur.ai?.sidecar?.afterRoute);
    add('Built-in AI measured (llama-server running, burst timed, download, sidecar)', aiOk, cur.ai ? `roles measured: ${Object.keys(cur.ai.llama?.perRole ?? {}).join(', ') || 'none'}; download ok: ${cur.ai.download?.ok ?? 'n/a'}${cur.ai.download?.error ? ` (${cur.ai.download.error})` : ''}; sidecar: ${cur.ai.sidecar?.afterRoute?.sidecarState ?? 'n/a'}` : 'no AI phase result');
    lim('Download: main event-loop max while a model downloads and verifies', mc.downloadEventLoopMaxMs, 100, 'ms');
    lim('Download: status IPC pushes per second (busiest second)', mc.downloadStatusPushesMaxPerSec, 4.0001, 'pushes/s');
    add('llama-server goes quiet once the background embedding queue has drained (within 10 min)', cur.ai?.llama?.quiesced === true, cur.ai?.llama ? `${cur.ai.llama.quiesced ? 'quiet' : 'still busy'} after ${cur.ai.llama.quietAfterS} s` : 'not measured');
    lim('llama-server idle CPU, any role (servers loaded, nothing asked)', mc.llamaIdleCpuPctMax, 3.0, '%');
    if (cur.ai?.llama?.routes?.embeddings && cur.ai.llama.routes.embeddings !== 'local') add('Router overhead measured on the built-in route', false, `embeddings route is ${cur.ai.llama.routes.embeddings}, not built-in`);
    else lim('Router overhead: embedding + rerank through the app vs direct to llama-server', mc.routerOverheadPct, 15, '%');
    if (cur.ai?.llama?.burstError) add('Embedding + rerank burst answered correctly', false, cur.ai.llama.burstError);
  }

  if (!mb) return rows;
  const cmp = (key, label, { tol = 0.1, floor = 0, unit = '' } = {}) => {
    const c = mc[key];
    const b = mb[key];
    if (c == null || b == null || Number.isNaN(c) || Number.isNaN(b)) return add(label, true, `n/a (current ${c ?? 'missing'}, baseline ${b ?? 'missing'})`);
    const limit = b * (1 + tol) + floor;
    add(label, c <= limit, `${round(c, 2)}${unit} vs ${B} ${round(b, 2)}${unit} (${b ? (c >= b ? '+' : '') + round(((c - b) / b) * 100, 1) : 'n/a'}%, limit ${round(limit, 2)}${unit})`);
  };
  cmp('coldStartInteractiveMs', `Cold start to first interactive (median) vs ${B}`, { tol: 0.05, unit: ' ms' });
  cmp('coldStartEnterReadyMs', `Cold start to Enter Ark ready (median) vs ${B}`, { tol: 0.05, unit: ' ms' });
  cmp('bootEventLoopMaxMs', `Boot main event-loop max (median) vs ${B}`, { floor: 5, unit: ' ms' });
  cmp('idle60CpuPct', `Idle CPU 60 s (total) vs ${B}`, { floor: 0.5, unit: '%' });
  cmp('hiddenIdleCpuPct', `Hidden idle CPU vs ${B}`, { floor: 0.3, unit: '%' });
  cmp('finalJsHeapMB', `JS heap after scenario vs ${B}`, { unit: ' MB' });
  cmp('finalDomNodes', `DOM nodes after scenario vs ${B}`, {});
  cmp('finalJsEventListeners', `JS event listeners after scenario vs ${B}`, {});
  cmp('finalTotalWorkingSetMB', `Total working set (all processes) after scenario vs ${B}`, { unit: ' MB' });
  cmp('finalMainRssMB', `Main process RSS after scenario vs ${B}`, { unit: ' MB' });
  cmp('scenarioEventLoopP99Ms', `Main event-loop p99 over scenario vs ${B}`, { floor: 5, unit: ' ms' });
  cmp('scenarioEventLoopMaxMs', `Main event-loop max per cycle (median of cycles) vs ${B}`, { floor: 20, unit: ' ms' });
  cmp('browseLoadIpcCalls', `IPC calls per Browse screen (median) vs ${B} (not higher)`, { tol: 0, unit: '' });
  cmp('browseLoadIpcKB', `IPC payload per Browse screen vs ${B}`, { unit: ' KB' });
  cmp('browseScrollFrameP95Ms', `Browse scroll frame time p95 vs ${B}`, { floor: 2, unit: ' ms' });
  cmp('cycleIpcInvokeCalls', `IPC calls per scenario cycle (median) vs ${B}`, { floor: 3, unit: '' });
  cmp('cycleIpcKB', `IPC payload per scenario cycle vs ${B}`, { floor: 5, unit: ' KB' });
  cmp('settingsMountMedianMs', `Settings page mount time (median over pages) vs ${B}`, { floor: 30, unit: ' ms' });
  cmp('llamaWorkingSetTotalMB', `llama-server working set (all roles) vs ${B}`, { unit: ' MB' });
  cmp('llamaIdleCpuPctMax', `llama-server idle CPU vs ${B}`, { floor: 0.5, unit: '%' });
  cmp('sidecarPythonWorkingSetMB', `LiteLLM python working set vs ${B}`, { unit: ' MB' });
  cmp('downloadEventLoopMaxMs', `Download: main event-loop max vs ${B}`, { floor: 20, unit: ' ms' });
  cmp('applistRefreshEventLoopMaxMs', `Event-loop max during app-list refresh vs ${B}`, { floor: 10, unit: ' ms' });
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
  L.push(`# ${cur.meta.version ?? ''} measurements (${cur.meta.label} vs ${base ? base.meta.label : 'no baseline'})`, '');
  L.push(`Harness: \`scripts/perf/measure.mjs\` (Playwright \`_electron\`, ARK_PERF=1 probes, CDP \`Performance.getMetrics\`, forced GC before every heap reading).`);
  L.push(`Current: \`${cur.meta.label}\` (${cur.meta.commit ?? 'n/a'}) on ${cur.meta.machine}. Baseline: ${base ? `\`${base.meta.label}\` (${base.meta.commit ?? 'n/a'})` : 'none'}.`);
  L.push(`Profile: ${cur.meta.profile.games} library games, ${cur.meta.profile.statusRows} status-history rows, ${cur.meta.profile.sessions} sessions, ${cur.meta.profile.appListEntries} Steam app-list entries, copied test userData, no real keys. ${cur.meta.cycles} cycles, ${cur.meta.idleS} s idle, ${cur.meta.hiddenIdleS} s hidden idle.`, '');
  L.push(`Verdict: **${ev.failures.length ? 'FAIL' : 'PASS'}** (${ev.failures.length} failing metric${ev.failures.length === 1 ? '' : 's'}).`, '');

  L.push('## Before / after', '', `| Metric | ${base?.meta?.label ?? 'Baseline'} | Current | Change |`, '|---|---:|---:|---:|');
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
    ['cycleIpcInvokeCalls', 'IPC calls per scenario cycle (median, renderer -> main)'],
    ['cycleIpcPushCalls', 'IPC pushes per scenario cycle (median, main -> renderer)'],
    ['cycleIpcKB', 'IPC payload per scenario cycle (KB, median)'],
    ['settingsLongTaskMaxMs', 'Longest renderer long task while a Settings page mounts (ms)'],
    ['settingsMountMedianMs', 'Settings page mount time, median over pages (ms)'],
    ['settingsMountMaxMs', 'Settings page mount time, slowest page (ms)'],
    ['llamaEmbedWorkingSetMB', 'llama-server embed working set (MB)'],
    ['llamaRerankWorkingSetMB', 'llama-server rerank working set (MB)'],
    ['llamaQuietAfterS', 'llama-server: seconds until quiet after boot (background embedding)'],
    ['llamaIdleCpuPctMax', 'llama-server idle CPU, busiest role (%)'],
    ['llamaBurstCpuPctTotal', 'llama-server CPU during the embed + rerank burst, all roles (% of one core)'],
    ['aiItemsPerSDirect', 'Embed + rerank items per second, direct to llama-server'],
    ['aiItemsPerSApp', 'Embed + rerank items per second, through the app'],
    ['routerOverheadPct', 'Router overhead, app vs direct (%)'],
    ['downloadMBps', 'Model download throughput (MB/s, local server)'],
    ['downloadEventLoopMaxMs', 'Main event-loop max during the download (ms)'],
    ['downloadStatusPushesMaxPerSec', 'Status IPC pushes, busiest second'],
    ['sidecarPythonWorkingSetMB', 'LiteLLM python working set when started (MB)'],
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

  const aiSection = (run) => {
    L.push('', `## Built-in AI and measurement checks: ${run.meta.label}`, '');
    const st = run.ipcSelfTest;
    L.push(`- IPC self-test: ${st ? `${st.ok ? 'ok' : '**FAILED**'}, ${st.channel ?? 'no channel'} called ${st.expected}x, probe counted ${st.got}x (${st.handlers ?? '?'} handlers wrapped)` : 'not run'}`);
    const ai = run.ai;
    if (!ai) {
      L.push('- Built-in AI phase: not run (no models folder given).');
      return;
    }
    const l = ai.llama;
    if (l?.perRole) {
      L.push('', '| llama-server role | Working set MB | Idle CPU % | Burst CPU % |', '|---|---:|---:|---:|');
      for (const [role, r] of Object.entries(l.perRole)) L.push(`| ${role} | ${f(r.workingSetMB)} | ${f(r.idleCpuPct, 2)} | ${f(r.burstCpuPct, 2)} |`);
      L.push('', `Burst: ${l.embedTexts} texts to embed and ${l.rerankDocs} documents to rerank per round, ${l.rounds} rounds interleaved (direct / through the app). Route: embeddings ${l.routes?.embeddings}, reranker ${l.routes?.reranker}, backend ${l.routes?.backend}.`);
      L.push('', '| Path | Embed median ms | Rerank median ms | Items/s |', '|---|---:|---:|---:|');
      L.push(`| direct to llama-server | ${f(l.direct?.embedMs)} | ${f(l.direct?.rerankMs)} | ${f(l.itemsPerS?.direct, 2)} |`);
      L.push(`| through the app | ${f(l.app?.embedMs)} | ${f(l.app?.rerankMs)} | ${f(l.itemsPerS?.app, 2)} |`);
      L.push(`| overhead | ${f(l.overheadPct?.embed, 2)}% | ${f(l.overheadPct?.rerank, 2)}% | combined ${f(l.overheadPct?.combined, 2)}% |`);
    }
    const d = ai.download;
    if (d) L.push('', `Download probe (${d.sizeMB} MB synthetic model, local HTTP server with Range): ${d.ok ? `${f(d.mbPerS)} MB/s in ${d.wallMs} ms, main event-loop max ${f(d.eldMaxMs)} ms (p99 ${f(d.eldP99Ms)} ms), ${d.statusPushes} status pushes (${f(d.statusPushesPerSecAvg, 2)}/s average, ${d.statusPushesMaxPerSec}/s busiest second), renderer long task max ${d.rendererLongTaskMaxMs} ms` : `**did not finish** ${d.error ?? ''}`}.`);
    const sc = ai.sidecar;
    if (sc) L.push('', `LiteLLM sidecar: before a non-built-in route ${sc.beforeRoute?.sidecarState} (${sc.beforeRoute?.pythonProcesses} python processes); after the route ${sc.afterRoute?.sidecarState}, ${sc.afterRoute?.pythonProcesses} python process(es), ${f(sc.afterRoute?.pythonWorkingSetMB)} MB, idle CPU ${f(sc.idleCpuPct, 2)}%, start ${sc.start?.startMs ?? 'n/a'} ms${sc.start?.error ? ` (error: ${sc.start.error})` : ''}.`);
    if (ai.quit) L.push('', `After quit: ${ai.quit.leftovers?.length ? ai.quit.leftovers.map((p) => p.name).join(', ') + ' still running' : 'no process left'}.`);
  };
  const settingsSection = (run) => {
    const pages = new Map();
    for (const c of run.cycles ?? []) for (const p of c.extra?.settingsPages ?? []) if (p && !p.error) (pages.get(p.i) ?? pages.set(p.i, []).get(p.i)).push(p);
    if (!pages.size) return;
    L.push('', `## Settings pages: ${run.meta.label}`, '', '| Page | Mount median ms | Mount max ms | Long task max ms | DOM nodes |', '|---|---:|---:|---:|---:|');
    for (const [i, a] of pages) {
      const med = median(a.map((p) => p.mountMs));
      L.push(`| ${a[0].label || i} | ${f(med, 0)} | ${Math.max(...a.map((p) => p.mountMs))} | ${Math.max(...a.map((p) => p.longTaskMaxMs ?? 0))} | ${Math.max(...a.map((p) => p.nodes ?? 0))} |`);
    }
  };
  for (const r of [cur, base].filter(Boolean)) {
    aiSection(r);
    settingsSection(r);
  }

  const table = (run, title) => {
    L.push('', `## ${title}: per-cycle readings (post-GC)`, '', '| Cycle | JS heap MB | DOM nodes | JS listeners | IPC listeners | Procs | Sidecars (llama/python) | GPU MB after Ark | ELD p99 ms | ELD max ms | Total WS MB |', '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    const b0 = run.baselineSample;
    if (b0) L.push(`| 0 | ${f(b0.renderer.jsHeapUsedMB)} | ${b0.renderer.domNodes} | ${b0.renderer.jsEventListeners} | ${b0.ipcListeners ?? 'n/a'} | ${b0.processCount} | ${b0.externalProcessCount} (${b0.llamaCount ?? "-"}/${b0.pythonCount ?? "-"}) | ${f(b0.gpuWorkingSetMB)} (pre-Ark) | - | - | ${f(b0.totalWorkingSetMB)} |`);
    for (const c of run.cycles ?? []) {
      const s = c.sample;
      L.push(`| ${c.n} | ${f(s.renderer.jsHeapUsedMB)} | ${s.renderer.domNodes} | ${s.renderer.jsEventListeners} | ${s.ipcListeners ?? 'n/a'} | ${s.processCount} | ${s.externalProcessCount} (${s.llamaCount ?? "-"}/${s.pythonCount ?? "-"}) | ${f(c.extra?.gpuAfterArk)} | ${f(c.eld?.p99, 2)} | ${f(c.eld?.max, 1)} | ${f(s.totalWorkingSetMB)} |`);
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
