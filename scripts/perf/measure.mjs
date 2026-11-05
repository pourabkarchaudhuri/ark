#!/usr/bin/env node
/**
 * Release-gate measurement harness (1.0.97 plan: "Release gate: measure before shipping").
 *
 *   node scripts/perf/measure.mjs --app <built checkout> --label <name> --out <result.json> [options]
 *   node scripts/perf/measure.mjs --report --current cur.json [--baseline base.json] [--md docs/perf/1.0.97-measurements.md]
 *
 * Run options:
 *   --app DIR            built checkout (dist-electron/ + dist/); default: this repo
 *   --label NAME         e.g. main, v1.0.96
 *   --out FILE           result JSON
 *   --cycles N           scenario cycles (default 10)        --idle-s N   visible idle (default 60)
 *   --hidden-idle-s N    hidden idle (default 300)           --cold-runs N  extra cold-start boots (default 2)
 *   --quick              3 cycles, 15 s idle, 20 s hidden idle, 1 cold run (harness debugging only)
 *   --heap-snapshots     snapshots at cycle 2 and the last cycle, constructor diff + retainer paths in the result
 *   --seed-dir DIR       generated profile (created when missing; reused across builds)
 *   --skip-applist       skip the Steam app-list refresh phase
 *   --attached-hidden    also measure hidden idle with Playwright attached (informational; see lib/detached.mjs)
 *   --hidden-only        only the detached hidden-idle phase; with --merge-into result.json it replaces hiddenIdle there
 *   --hidden-settle-s N  visible wait on Browse before hiding the window (default 45)
 *   --models-src DIR     folder of the built-in AI models (.gguf + .verified.json) to measure with: hard-linked into a SCRATCH
 *                        %LOCALAPPDATA% (<tmp>\ark-perf-*-local-\Ark\models). Every launch gets an EMPTY scratch %LOCALAPPDATA% (the
 *                        real %LOCALAPPDATA%\Ark is never touched); the AI phase starts with the models in place, the scenario run
 *                        switches to them right after its idle reading (cold start, idle and hidden idle stay model-free, like the
 *                        1.0.97 report). Turns on: an embedding + rerank burst in every
 *                        scenario cycle (llama-server count / memory leak rules) and the dedicated AI phase (llama-server per
 *                        role idle + burst CPU, router overhead, download throughput, LiteLLM sidecar, exit on quit).
 *                        Also read from ARK_PERF_MODELS_SRC.
 *   --skip-ai-phase      keep the models for the scenario but skip the dedicated AI phase
 *   --ai-only            prime, then run only the dedicated AI phase (harness debugging, quick AI numbers)
 *   --ai-rounds N        interleaved direct/app burst rounds (default 10)    --download-mb N  synthetic model size (default 512)
 *   --ipc-selftest-only  boot, run the IPC self-test, print it and exit (proves the counters can read non-zero)
 *
 * Always runs on a COPIED test profile (--user-data-dir), with every variable named in the checkout's .env
 * blanked so no real key reaches the app. Never touches the real userData.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateProfile, PROFILE_DEFAULTS } from './lib/profile.mjs';
import { launchApp, copyProfile } from './lib/launch.mjs';
import { Probes } from './lib/probes.mjs';
import { makeRunner } from './lib/scenario.mjs';
import { startFakeSteam } from './lib/fake-steam.mjs';
import { evaluate, renderMarkdown } from './lib/analyze.mjs';
import { measureDetachedHiddenIdle } from './lib/detached.mjs';
import { diffSnapshots, takeSnapshot } from './lib/heapdiff.mjs';
import { seedModelsDir, removeScratch, measureLlama, measureDownload, measureSidecar, leftoversAfterQuit, warmServers, waitLlamaQuiet } from './lib/ai.mjs';
import { sleep, median, round } from './lib/util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ------------------------------------------------------------------------------------------ report mode
if (flag('--report')) {
  const cur = JSON.parse(fs.readFileSync(opt('--current'), 'utf8'));
  const base = opt('--baseline') ? JSON.parse(fs.readFileSync(opt('--baseline'), 'utf8')) : null;
  const ev = evaluate(cur, base);
  const md = renderMarkdown(cur, base, ev);
  if (opt('--md')) {
    fs.mkdirSync(path.dirname(opt('--md')), { recursive: true });
    fs.writeFileSync(opt('--md'), md);
  }
  if (opt('--evaluation-out')) fs.writeFileSync(opt('--evaluation-out'), JSON.stringify(ev, null, 2));
  console.log(ev.failures.length ? `FAIL (${ev.failures.length})\n${ev.failures.join('\n')}` : 'PASS');
  process.exit(ev.failures.length ? 1 : 0);
}

// ------------------------------------------------------------------------------------------ run mode
const quick = flag('--quick');
const cfg = {
  appDir: path.resolve(opt('--app', repoRoot)),
  label: opt('--label', 'main'),
  out: path.resolve(opt('--out', path.join(os.tmpdir(), 'ark-perf-result.json'))),
  cycles: Number(opt('--cycles', quick ? 3 : 10)),
  idleS: Number(opt('--idle-s', quick ? 15 : 60)),
  hiddenIdleS: Number(opt('--hidden-idle-s', quick ? 20 : 300)),
  coldRuns: Number(opt('--cold-runs', quick ? 1 : 2)),
  heapSnapshots: flag('--heap-snapshots'),
  seedDir: path.resolve(opt('--seed-dir', path.join(os.tmpdir(), 'ark-perf-seed'))),
  skipApplist: flag('--skip-applist'),
  hiddenSettleS: Number(opt('--hidden-settle-s', quick ? 5 : 45)),
  modelsSrc: opt('--models-src', process.env.ARK_PERF_MODELS_SRC) ? path.resolve(opt('--models-src', process.env.ARK_PERF_MODELS_SRC)) : null,
  skipAiPhase: flag('--skip-ai-phase'),
  aiOnly: flag('--ai-only'),
  aiRounds: Number(opt('--ai-rounds', quick ? 4 : 10)),
  downloadMB: Number(opt('--download-mb', quick ? 128 : 512)),
};
// Scratch %LOCALAPPDATA% holding links to the models; created once, removed at the end.
const aiLocal = cfg.modelsSrc && !flag('--hidden-only') ? seedModelsDir(cfg.modelsSrc, cfg.label) : null;
const aiEnv = aiLocal ? { LOCALAPPDATA: aiLocal.root } : {};

const pkg = JSON.parse(fs.readFileSync(path.join(cfg.appDir, 'package.json'), 'utf8'));
const commit = (() => {
  try {
    return execFileSync('git', ['-C', cfg.appDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
})();

async function ensureSeed() {
  const marker = path.join(cfg.seedDir, 'perf-profile.json');
  if (fs.existsSync(marker)) return JSON.parse(fs.readFileSync(marker, 'utf8'));
  log('generating test profile', cfg.seedDir);
  return generateProfile(cfg.seedDir, PROFILE_DEFAULTS);
}

/** Wait for the splash's Enter Ark button, click it, wait for the dashboard. Records both timings. */
async function bootToDashboard(page, tLaunch, timeout = 240_000) {
  const enter = page.locator('button:has-text("Enter Ark")').first();
  await enter.waitFor({ state: 'visible', timeout });
  const enterReadyMs = performance.now() - tLaunch;
  await enter.click({ timeout: 10_000 });
  await page.waitForSelector('[data-tour="browse-button"]', { state: 'visible', timeout: 60_000 });
  return { enterReadyMs, interactiveMs: performance.now() - tLaunch };
}

const PRIME_KEYS = ['welcome', 'overview', 'browse', 'library', 'oracle', 'journey', 'calendar', 'buzz', 'ann-graph', 'data-flow', 'devlog', 'settings', 'game-details'];
async function primeFlags(page) {
  await page.evaluate(
    ([keys, version]) => {
      for (const k of keys) localStorage.setItem(`ark-tour-completed-${k}`, 'true');
      localStorage.setItem('ark-tour-completed', 'true');
      localStorage.setItem('ark_last_seen_version', version);
    },
    [PRIME_KEYS, pkg.version],
  );
}

async function closeApp(app) {
  await Promise.race([app.close().catch(() => {}), sleep(20_000)]);
}

const cpuPct = (a, b) => {
  const wall = (b.t - a.t) / 1000;
  return wall > 0 ? round(((b.procs.totalCpuSec - a.procs.totalCpuSec) / wall) * 100, 2) : null;
};

async function runHiddenOnly() {
  await ensureSeed();
  const into = opt('--merge-into');
  const r = await measureDetachedHiddenIdle({ appDir: cfg.appDir, repoRoot, seedDir: cfg.seedDir, label: cfg.label, version: pkg.version, hiddenIdleS: cfg.hiddenIdleS, settleS: cfg.hiddenSettleS, log });
  if (into) {
    const j = JSON.parse(fs.readFileSync(into, 'utf8'));
    if (j.hiddenIdle && !j.hiddenIdleAttached) j.hiddenIdleAttached = j.hiddenIdle;
    j.hiddenIdle = r;
    fs.writeFileSync(into, JSON.stringify(j, null, 2));
  } else fs.writeFileSync(cfg.out, JSON.stringify({ hiddenIdle: r }, null, 2));
  log(`[${cfg.label}] hidden idle ${r.cpuPct}%`);
}

async function run() {
  if (flag('--hidden-only')) return runHiddenOnly();
  const profile = await ensureSeed();
  const result = {
    meta: {
      label: cfg.label,
      version: pkg.version,
      commit,
      appDir: path.basename(cfg.appDir),
      machine: `${os.cpus()[0]?.model?.trim()} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${os.platform()} ${os.release()}`,
      startedAt: new Date().toISOString(),
      profile: { ...profile, dir: path.basename(String(profile.dir ?? '')) },
      cycles: cfg.cycles,
      idleS: cfg.idleS,
      hiddenIdleS: cfg.hiddenIdleS,
      heapSnapshots: cfg.heapSnapshots,
      warmupCycle: aiLocal ? 4 : 2,
      ai: { enabled: Boolean(aiLocal), models: aiLocal?.files ?? [], dedicatedPhase: Boolean(aiLocal) && !cfg.skipAiPhase, downloadMB: cfg.downloadMB, aiRounds: cfg.aiRounds },
    },
    coldStart: { runs: [] },
    cycles: [],
    skippedSteps: [],
  };
  const save = () => fs.writeFileSync(cfg.out, JSON.stringify(result, null, 2));
  const launchOpts = (ud, extra = {}) => ({ appDir: cfg.appDir, userDataDir: ud, repoRoot, logFile: path.join(os.tmpdir(), `ark-perf-${cfg.label}.log`), ...extra });

  // 1. Prime: first launch writes the browser-side flags (tour done, changelog seen) into the copied profile.
  log(`[${cfg.label}] priming profile`);
  const primed = copyProfile(cfg.seedDir, `${cfg.label}-primed`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { app, page, tLaunch } = await launchApp(launchOpts(primed));
    try {
      await primeFlags(page);
      await bootToDashboard(page, tLaunch, attempt === 3 ? 240_000 : 90_000);
      await sleep(3000);
      await closeApp(app);
      break;
    } catch (e) {
      log(`[${cfg.label}] prime attempt ${attempt} failed: ${String(e?.message ?? e).slice(0, 120)}`);
      await closeApp(app);
      if (attempt === 3) throw e;
    }
  }

  async function runAiPhase() {
    // Built-in AI phase: llama-server per role, router overhead, download, LiteLLM sidecar, exit on quit
    let launched = null;
    try {
      log(`[${cfg.label}] built-in AI phase`);
      const ud3 = copyProfile(primed, `${cfg.label}-ai`);
      launched = await launchApp(launchOpts(ud3, { env: aiEnv }));
      const p3 = new Probes(launched.app, launched.page, launched.pid);
      await bootToDashboard(launched.page, launched.tLaunch);
      await p3.init();
      await sleep(3000);
      const ai = { ipcSelfTest: await p3.ipcSelfTest() };
      const st0 = await p3.aiStatus();
      const t0 = await p3.processes();
      ai.atBoot = { sidecarState: st0?.sidecar?.state ?? null, pythonCount: t0.pythonCount, llamaCount: t0.llamaCount, embeddingsVia: st0?.embeddingsVia ?? null, backend: st0?.backend ?? null };
      result.ai = ai;
      save();
      ai.llama = await measureLlama(p3, (m) => log(`[${cfg.label}]${m}`), { rounds: cfg.aiRounds });
      save();
      ai.download = await measureDownload({ probes: p3, page: launched.page, modelsDir: aiLocal.modelsDir, log: (m) => log(`[${cfg.label}]${m}`), sizeBytes: cfg.downloadMB * 1024 * 1024 });
      save();
      ai.sidecar = await measureSidecar({ probes: p3, log: (m) => log(`[${cfg.label}]${m}`) });
      const beforeQuit = await p3.processes();
      ai.quit = { sidecarWasRunning: beforeQuit.pythonCount > 0, llamaBefore: beforeQuit.llamaCount, pythonBefore: beforeQuit.pythonCount };
      save();
      await closeApp(launched.app);
      ai.quit.leftovers = (await leftoversAfterQuit(launched.pid, 25)).map((p) => ({ name: p.name }));
      launched = null;
      log(`[${cfg.label}] AI phase done; left after quit: ${ai.quit.leftovers.map((p) => p.name).join(', ') || 'none'}`);
    } catch (e) {
      result.ai = { ...(result.ai ?? {}), error: String(e?.stack ?? e).slice(0, 600) };
      log(`[${cfg.label}] AI phase failed: ${String(e?.message ?? e).split('\n')[0]}`);
      if (launched) await closeApp(launched.app);
    }
    save();
  }

  if (cfg.aiOnly) {
    if (!aiLocal) throw new Error('--ai-only needs --models-src');
    await runAiPhase();
    result.meta.finishedAt = new Date().toISOString();
    removeScratch(aiLocal.root);
    save();
    log(`[${cfg.label}] wrote ${cfg.out}`);
    return;
  }

  // 2. Extra cold-start boots
  for (let i = 0; i < cfg.coldRuns; i++) {
    const ud = copyProfile(primed, `${cfg.label}-cold${i}`);
    const { app, page, pid, tLaunch } = await launchApp(launchOpts(ud));
    const probes = new Probes(app, page, pid);
    const t = await bootToDashboard(page, tLaunch);
    const eld = await probes.eventLoop(false);
    log(`[${cfg.label}] cold start ${i + 1}: enter ${Math.round(t.enterReadyMs)} ms, interactive ${Math.round(t.interactiveMs)} ms, boot ELD max ${eld?.max} ms`);
    result.coldStart.runs.push({ ...t, eldMax: eld?.max ?? null, eldP99: eld?.p99 ?? null });
    await closeApp(app);
  }

  // 3. The scenario run
  log(`[${cfg.label}] scenario run`);
  const ud = copyProfile(primed, `${cfg.label}-scenario`);
  const { app, page, pid, tLaunch } = await launchApp(launchOpts(ud));
  page.on('pageerror', (e) => result.skippedSteps.push(`pageerror: ${String(e.message).slice(0, 120)}`));
  const probes = new Probes(app, page, pid);
  try {
    const t = await bootToDashboard(page, tLaunch);
    await probes.init();
    result.coldStart.runs.push({ ...t, eldMax: (await probes.eventLoop(false))?.max ?? null });
    // Can the IPC counters read anything at all? A 0 is only evidence once a known call has been counted.
    result.ipcSelfTest = await probes.ipcSelfTest();
    log(`[${cfg.label}] IPC self-test: ${JSON.stringify(result.ipcSelfTest)}`);
    if (flag('--ipc-selftest-only')) {
      console.log(JSON.stringify(result.ipcSelfTest));
      await closeApp(app);
      process.exit(result.ipcSelfTest.ok ? 0 : 1);
    }
    log(`[${cfg.label}] scenario boot: enter ${Math.round(t.enterReadyMs)} ms, interactive ${Math.round(t.interactiveMs)} ms`);

    // visible idle
    await probes.eventLoop(true);
    const i0 = await probes.sample('idle-start');
    await sleep(cfg.idleS * 1000);
    const eldIdle = await probes.eventLoop(true);
    const i1 = await probes.sample('idle-end');
    // Models arrive after the idle reading: with them present the app embeds the library in the background for minutes, which would
    // bury the idle-CPU budget (and make it incomparable with the model-free numbers of earlier reports).
    if (aiLocal) {
      const en = await probes.enableModels(aiLocal.root);
      result.scenarioModels = en;
      log(`[${cfg.label}] models enabled in the scenario run after ${en.ms} ms (ready: ${en.ready})`);
      // Start the servers and let the background embedding drain before cycle 1, so the leak rules (cycle 2 vs last) compare steady
      // states: otherwise the one-time cost of the first embeddings (caches, vectors loaded in the renderer) reads as growth.
      const warm = await warmServers(probes, (m) => log(`[${cfg.label}]${m}`));
      result.scenarioModels = { ...en, warmMs: warm.ms, ...(await waitLlamaQuiet(probes, (m) => log(`[${cfg.label}]${m}`), 900)) };
    }
    result.idle60 = { cpuPct: cpuPct(i0, i1), eld: eldIdle, seconds: cfg.idleS, startWS: i0.totalWorkingSetMB, endWS: i1.totalWorkingSetMB };
    log(`[${cfg.label}] idle ${cfg.idleS}s: cpu ${result.idle60.cpuPct}%, ELD max ${eldIdle?.max} ms`);

    const runner = makeRunner(probes, log);
    await runner.dismissOverlays();
    await runner.toBrowseTop();
    await sleep(2500);
    result.baselineSample = await probes.sample('cycle-0');
    result.ipcHandlers = await probes.mainProbe('handlerCount');

    let snapA = null;
    for (let n = 1; n <= cfg.cycles; n++) {
      await probes.eventLoop(true);
      const { steps, extra } = await runner.cycle(n, { ai: Boolean(aiLocal) });
      const eld = await probes.eventLoop(true);
      const lt = { all: await probes.longTasksBetween(Math.min(...Object.values(steps).map((s) => s.t0).filter(Boolean)), Math.max(...Object.values(steps).map((s) => s.t1))) };
      for (const k of ['browse-scroll', 'oracle', 'oracle-compute']) lt[k] = steps[k] ? await probes.longTasksBetween(steps[k].t0, steps[k].t1) : [];
      lt.byStep = {};
      for (const [k, v] of Object.entries(steps)) {
        const tasks = v.t1 ? await probes.longTasksBetween(v.t0, v.t1) : [];
        if (tasks.length) lt.byStep[k] = Math.max(...tasks);
      }
      const sample = await probes.sample(`cycle-${n}`);
      result.cycles.push({ n, steps, extra, eld, longTasks: lt, sample });
      log(`[${cfg.label}] cycle ${n}/${cfg.cycles}: heap ${sample.renderer.jsHeapUsedMB} MB, nodes ${sample.renderer.domNodes}, listeners ${sample.renderer.jsEventListeners}/${sample.ipcListeners}, procs ${sample.processCount}, ELD max ${eld?.max} ms, longest task ${Math.max(0, ...lt.all)} ms ${JSON.stringify(lt.byStep)}`);
      save();
      if (cfg.heapSnapshots && n === 2) snapA = await takeSnapshot(probes.cdp, path.join(os.tmpdir(), `ark-heap-${cfg.label}-c2.heapsnapshot`));
      if (cfg.heapSnapshots && n === cfg.cycles && snapA) {
        const snapB = await takeSnapshot(probes.cdp, path.join(os.tmpdir(), `ark-heap-${cfg.label}-c${n}.heapsnapshot`));
        result.heapDiff = diffSnapshots(snapA, snapB);
      }
    }
    result.skippedSteps.push(...[...runner.skipped.entries()].map(([k, v]) => `${k} (x${v})`));

    if (flag('--attached-hidden')) {
      // hidden idle (window hidden to tray). Back on Browse, the offline Top Sellers fetch chain (egdata / Epic retries with
      // 4 s and 6 s waits, started by every Browse visit) needs ~45 s to run out; hiding earlier measured that burst, not idle.
      await runner.toBrowseTop();
      await sleep(cfg.hiddenSettleS * 1000);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
      await sleep(5000);
      // The probe's own 10 ms event-loop sampler costs ~2% of a core in the main process (a blank Electron window under
      // Playwright idles at 0.07%), which would be charged to the app: stop it while hidden idle is measured.
      const sampler = await probes.mainProbe('eventLoopMonitor', false).then(() => true, () => false);
      const h0 = await probes.processes();
      const h0t = Date.now();
      await sleep(cfg.hiddenIdleS * 1000);
      const h1 = await probes.processes();
      const h1t = Date.now();
      if (sampler) await probes.mainProbe('eventLoopMonitor', true).catch(() => {});
      const eldH = null;
      result.hiddenIdleAttached = {
        cpuPct: cpuPct({ t: h0t, procs: h0 }, { t: h1t, procs: h1 }),
        eld: eldH,
        seconds: cfg.hiddenIdleS,
        startWS: h0.totalWorkingSetMB,
        endWS: h1.totalWorkingSetMB,
        perProcessCpuSec: h1.electron.map((p) => ({ type: p.type, name: p.name, dCpuSec: round(p.cpuSec - (h0.electron.find((q) => q.pid === p.pid)?.cpuSec ?? p.cpuSec), 3) })),
      };
      log(`[${cfg.label}] hidden idle (Playwright attached, informational) ${cfg.hiddenIdleS}s: cpu ${result.hiddenIdleAttached.cpuPct}%, ELD max ${eldH?.max} ms`);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.show()));
  } catch (e) {
    result.aborted = String(e?.stack ?? e).slice(0, 800);
    log(`[${cfg.label}] SCENARIO ABORTED: ${String(e?.message ?? e).split('\n')[0]}`);
  } finally {
    save();
    await closeApp(app);
    // Anything the app started (llama-server, python) must be gone once it quit.
    if (aiLocal) result.quitScenario = { leftovers: (await leftoversAfterQuit(pid, 20)).map((p) => ({ name: p.name })) };
    save();
  }

  // 3b. Hidden idle without an automation client attached (see lib/detached.mjs for why this is the representative number).
  try {
    result.hiddenIdle = await measureDetachedHiddenIdle({ appDir: cfg.appDir, repoRoot, seedDir: cfg.seedDir, label: cfg.label, version: pkg.version, hiddenIdleS: cfg.hiddenIdleS, settleS: cfg.hiddenSettleS, log });
  } catch (e) {
    result.hiddenIdle = { cpuPct: null, error: String(e?.message ?? e).split(String.fromCharCode(10))[0] };
    log(`[${cfg.label}] detached hidden idle failed: ${result.hiddenIdle.error}`);
  }
  save();

  if (aiLocal && !cfg.skipAiPhase) await runAiPhase();

  // 4. Steam app-list refresh (fake local Steam endpoint, test key; the real host is unreachable here)
  if (!cfg.skipApplist) {
    let fake = null;
    try {
      log(`[${cfg.label}] app-list refresh phase`);
      fake = await startFakeSteam({ entries: profile.appListEntries ?? 155000 });
      const ud2 = copyProfile(cfg.seedDir, `${cfg.label}-applist`);
      for (const f of ['steam-applist.json', 'steam-cache.json']) fs.rmSync(path.join(ud2, f), { force: true });
      const launched = await launchApp(
        launchOpts(ud2, {
          env: { STEAM_API_KEY: 'perf-test-key-not-real' },
          extraHostRules: [`MAP api.steampowered.com 127.0.0.1:${fake.port}`],
          extraArgs: ['--ignore-certificate-errors'],
        }),
      );
      const p2 = new Probes(launched.app, launched.page, launched.pid);
      await primeFlags(launched.page);
      await bootToDashboard(launched.page, launched.tLaunch);
      await sleep(3000);
      await p2.setBytes(false);
      await p2.eventLoop(true);
      const t0 = Date.now();
      const n = await launched.page.evaluate(async () => {
        const list = await window.steam.getAppList();
        return Array.isArray(list) ? list.length : -1;
      });
      const ms = Date.now() - t0;
      await sleep(4000); // post-refresh work (sort, store write)
      const eld = await p2.eventLoop(true);
      result.applist = { ok: n > 1000, entries: n, ms, eld, fakeRequests: fake.stats.requests };
      log(`[${cfg.label}] app-list refresh: ${n} entries in ${ms} ms, ELD max ${eld?.max} ms, p99 ${eld?.p99} ms (${fake.stats.requests} fake requests)`);
      await closeApp(launched.app);
    } catch (e) {
      result.applist = { ok: false, error: String(e?.message ?? e).split('\n')[0] };
      log(`[${cfg.label}] app-list phase failed: ${result.applist.error}`);
    } finally {
      await fake?.close().catch(() => {});
    }
    save();
  }

  result.meta.finishedAt = new Date().toISOString();
  if (aiLocal) removeScratch(aiLocal.root);
  save();
  log(`[${cfg.label}] wrote ${cfg.out}`);
}

run().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    if (aiLocal) removeScratch(aiLocal.root);
    process.exit(1);
  },
);
