/**
 * Hidden-idle CPU measured WITHOUT an automation client attached.
 *
 * Why this exists: while Playwright (CDP) is attached, Chromium keeps ticking BeginFrames for a hidden window. Any animation that
 * starts while the window is hidden (a toast, a Web Animations call) then waits for a compositor frame that never commits and keeps
 * the renderer and GPU process at ~60 frames/s (~1.7% of a core each) until the page is shown again. That is a property of the
 * attached browser, not of the app: v1.0.96 shows the same 1.8% when a single 300 ms animation is started while its window is hidden
 * (scripts/perf/hidden-probe.mjs --inject-anim). A user's tray-hidden window has no automation client, so this phase measures that:
 *
 *   spawn the app, drive it over a raw CDP socket only until it is on Browse, hide it the way a user does (the title-bar minimize
 *   button, which hides the window to the tray), CLOSE THE SOCKET, then read OS CPU counters for the whole process tree over the idle window.
 *
 * A MutationObserver installed before the hide records any toast added while hidden, so the result shows whether the
 * "animation started while hidden" condition was exercised (the 75 s auto On Hold sweep toasts ~20 s into the window).
 */
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { copyProfile, sanitizedEnv, hostRules, electronBinary } from './launch.mjs';
import { sampleProcessTree, sleep, round } from './util.mjs';

const KEYS = ['welcome', 'overview', 'browse', 'library', 'oracle', 'journey', 'calendar', 'buzz', 'ann-graph', 'data-flow', 'devlog', 'settings', 'game-details'];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function connect(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  while (Date.now() < deadline && !target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === 'page' && /\/index\.html/.test(t.url) && !/overlay/.test(t.url)) ?? null;
    } catch {
      /* not up yet */
    }
    if (!target) await sleep(500);
  }
  if (!target) throw new Error('detached: main window target not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('detached: ws error'));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    pending.get(d.id)?.(d);
    pending.delete(d.id);
  };
  const evaluate = (expression) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, (d) => resolve(d.result?.result?.value));
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  return { ws, evaluate };
}

/** Which Electron process is which: from the command line (--type=gpu-process / renderer / utility). */
function processKinds() {
  try {
    const cmd = "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    let rows = JSON.parse(out);
    if (!Array.isArray(rows)) rows = [rows];
    return new Map(rows.map((r) => [r.ProcessId, /--type=([\w-]+)/.exec(r.CommandLine ?? '')?.[1] ?? 'browser']));
  } catch {
    return new Map();
  }
}

export async function measureDetachedHiddenIdle({ appDir, repoRoot, seedDir, label, version, hiddenIdleS = 120, settleS = 45, minUptimeS = 150, log = () => {} }) {
  const userData = copyProfile(seedDir, `${label}-detached`);
  const port = await freePort();
  const child = spawn(electronBinary(repoRoot), [`--user-data-dir=${userData}`, hostRules(), `--remote-debugging-port=${port}`, appDir], {
    cwd: appDir,
    env: sanitizedEnv(appDir, { ARK_PERF: '0' }),
    stdio: 'ignore',
  });
  const tStart = Date.now();
  const result = { method: 'detached (no automation client attached while hidden)', seconds: hiddenIdleS, minUptimeS };
  try {
    let cdp = await connect(port);
    await cdp.evaluate(`for (const k of ${JSON.stringify(KEYS)}) localStorage.setItem('ark-tour-completed-' + k, 'true'); localStorage.setItem('ark-tour-completed', 'true'); localStorage.setItem('ark_last_seen_version', ${JSON.stringify(version)}); 1`);
    let ready = false;
    for (let i = 0; i < 240 && !ready; i++) {
      ready = await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => /Enter Ark/.test(b.textContent)); if (b) { b.click(); return false; } return !!document.querySelector('[data-tour="browse-button"]'); })()`);
      if (!ready) await sleep(500);
    }
    if (!ready) throw new Error('detached: dashboard never appeared');
    await sleep(2000);
    await cdp.evaluate(`document.querySelector('[data-tour="browse-button"]')?.click(); 1`);
    // The full scenario hides the window minutes after launch, so one-shot start-up jobs (the 75 s auto On Hold sweep and its 15 s
    // toast, the Browse retry chain) are long done. A fresh launch must wait for the same: hide at settleS after Browse AND not
    // before minUptimeS of app uptime, otherwise the window measures the sweep, not idle.
    const waitS = Math.max(settleS, minUptimeS - (Date.now() - tStart) / 1000);
    log(`[${label}] detached: on Browse, settling ${Math.round(waitS)}s (uptime >= ${minUptimeS}s)`);
    await sleep(waitS * 1000);
    await cdp.evaluate(
      `(() => { window.__hiddenToasts = []; const t0 = performance.now(); new MutationObserver((l) => { for (const m of l) for (const n of m.addedNodes) if (n.nodeType === 1 && /pointer-events-auto/.test(String(n.className))) window.__hiddenToasts.push(Math.round((performance.now() - t0) / 1000) + 's ' + (n.textContent || '').slice(0, 80)); }).observe(document.body, { childList: true, subtree: true }); window.electron.minimize(); return 1; })()`,
    );
    cdp.ws.close(); // from here on nothing is attached
    await sleep(5000);
    const tree0 = await sampleProcessTree(child.pid);
    const t0 = Date.now();
    // 10 s samples of the whole tree (so a cost that starts at a given moment, e.g. a toast, shows up in time).
    const series = [];
    let prevTree = tree0;
    let prevT = t0;
    while (Date.now() - t0 < hiddenIdleS * 1000) {
      await sleep(Math.min(10_000, hiddenIdleS * 1000 - (Date.now() - t0)));
      const tr = await sampleProcessTree(child.pid);
      const now = Date.now();
      const k = processKinds();
      series.push({
        atS: Math.round((now - t0) / 1000),
        byType: Object.fromEntries(tr.procs.map((p) => [`${k.get(p.pid) ?? p.name}:${p.pid}`, round(((p.cpuSec - (prevTree.procs.find((q) => q.pid === p.pid)?.cpuSec ?? p.cpuSec)) / ((now - prevT) / 1000)) * 100, 2)])),
      });
      prevTree = tr;
      prevT = now;
    }
    result.series = series;
    const tree1 = await sampleProcessTree(child.pid);
    const t1 = Date.now();
    const kinds = processKinds();
    const total = (t) => t.procs.reduce((a, p) => a + p.cpuSec, 0);
    const wall = (t1 - t0) / 1000;
    result.cpuPct = round(((total(tree1) - total(tree0)) / wall) * 100, 2);
    result.eld = null;
    result.perProcessCpuSec = tree1.procs.map((p) => ({ type: kinds.get(p.pid) ?? p.name, pid: p.pid, dCpuSec: round(p.cpuSec - (tree0.procs.find((q) => q.pid === p.pid)?.cpuSec ?? p.cpuSec), 3) }));
    result.startWS = round(tree0.procs.reduce((a, p) => a + p.workingSetMB, 0), 1);
    result.endWS = round(tree1.procs.reduce((a, p) => a + p.workingSetMB, 0), 1);
    // Evidence that the "animation started while hidden" condition was exercised: reconnect read-only after the measurement.
    try {
      cdp = await connect(port, 10_000);
      result.toastsWhileHidden = JSON.parse((await cdp.evaluate('JSON.stringify(window.__hiddenToasts ?? null)')) ?? 'null');
      cdp.ws.close();
    } catch (e) {
      result.toastsWhileHidden = null;
      result.toastProbeError = String(e?.message ?? e);
    }
    log(`[${label}] detached hidden idle ${hiddenIdleS}s: cpu ${result.cpuPct}% (toasts while hidden: ${JSON.stringify(result.toastsWhileHidden)})`);
  } finally {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
  return result;
}
