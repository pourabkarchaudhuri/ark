#!/usr/bin/env node
// Diagnostic: per-process CPU time series while the window is hidden.
//   node scripts/perf/hidden-probe.mjs --app DIR [--page browse|home] [--settle-s 45] [--seconds 120] [--trace out.json] [--args "--flag ..."]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, copyProfile } from './lib/launch.mjs';
import { makeRunner } from './lib/scenario.mjs';
import { Probes } from './lib/probes.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const repoRoot = path.resolve(here, '..', '..');
const argv = process.argv.slice(2); const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const appDir = path.resolve(opt('--app', repoRoot)); const pageName = opt('--page', 'browse');
const settle = Number(opt('--settle-s', 45)); const seconds = Number(opt('--seconds', 120));
const extra = opt('--args', '').split(' ').filter(Boolean); const tracePath = opt('--trace', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seed = path.join(os.tmpdir(), 'ark-perf-seed');
const primed = copyProfile(seed, 'hp'); // seed flags already primed? prime tour flags below
const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
const { app, page, pid, tLaunch } = await launchApp({ appDir, userDataDir: primed, repoRoot, extraArgs: extra });
const KEYS = ['welcome','overview','browse','library','oracle','journey','calendar','buzz','ann-graph','data-flow','devlog','settings','game-details'];
await page.evaluate(([k, v]) => { for (const x of k) localStorage.setItem(`ark-tour-completed-${x}`, 'true'); localStorage.setItem('ark-tour-completed', 'true'); localStorage.setItem('ark_last_seen_version', v); }, [KEYS, pkg.version]);
await page.reload().catch(() => {});
const enter = page.locator('button:has-text("Enter Ark")').first();
await enter.waitFor({ state: 'visible', timeout: 120000 }); await enter.click();
await page.waitForSelector('[data-tour="browse-button"]', { state: 'visible', timeout: 60000 });
const probes = new Probes(app, page, pid); const runner = makeRunner(probes, () => {});
if (pageName === 'browse') await runner.toBrowseTop();
await sleep(settle * 1000);
if (argv.includes('--mutations')) await page.evaluate(() => { window.__mut = []; const t0 = performance.now(); new MutationObserver((l) => { for (const m of l) if (m.addedNodes.length) window.__mut.push(Math.round(performance.now() - t0) + ' ' + (m.target.className?.toString?.().slice(0, 50) ?? m.target.nodeName) + ' +' + m.addedNodes.length); }).observe(document.body, { childList: true, subtree: true }); console.log('obs'); });
await page.evaluate(() => { window.__toast = []; const t0 = performance.now(); new MutationObserver((l) => { for (const m of l) for (const n of m.addedNodes) { if (n.nodeType === 1 && /pointer-events-auto/.test(n.className?.toString?.() ?? '')) window.__toast.push(Math.round((performance.now() - t0) / 1000) + 's ' + n.textContent.slice(0, 120)); } }).observe(document.body, { childList: true, subtree: true }); });
console.log('anims before hide', await page.evaluate(() => { const m = {}; for (const a of document.getAnimations()) { const k = (a.animationName ?? 'waapi') + ':' + a.playState + ':' + a.pending; m[k] = (m[k] ?? 0) + 1; } return JSON.stringify(m); }));
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
if (argv.includes('--mutations')) { await sleep(15000); console.log('mut', JSON.stringify(await page.evaluate(() => window.__mut.slice(0, 40)), null, 0)); }
if (argv.includes('--dump-animations')) {
  await sleep(Number(opt('--dump-delay', 5)) * 1000);
  const info = await page.evaluate(() => ({ vis: document.visibilityState, anims: document.getAnimations().map((a) => ({ state: a.playState, name: a.animationName ?? a.transitionProperty ?? a.constructor.name, target: (a.effect?.target?.tagName ?? '') + '.' + String(a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? '').slice(0, 80), timing: a.effect?.getComputedTiming?.() ? { iter: a.effect.getComputedTiming().iterations, dur: a.effect.getComputedTiming().duration } : null })), canvases: [...document.querySelectorAll('canvas,video')].map((c) => c.tagName + ' ' + c.width + 'x' + c.height + ' ' + (c.className||'')) }));
  console.log(JSON.stringify(info.anims.map((a) => a.name + ' ' + a.state + ' ' + a.target.slice(0, 30)), null, 0), info.vis, info.canvases);
  const tl = () => page.evaluate(() => ({ tl: document.timeline.currentTime, cts: document.getAnimations().map((a) => Math.round(a.currentTime ?? -1)), pend: document.getAnimations().filter((a) => a.pending).length }));
  console.log(JSON.stringify(await tl())); await sleep(2000); console.log(JSON.stringify(await tl()));
}
if (argv.includes('--cancel-anims')) { await sleep(40000); console.log('cancelled', await page.evaluate(() => { const n = document.getAnimations().length; document.getAnimations().forEach((a) => a.cancel()); return n; })); }
if (tracePath) { await sleep(Number(opt('--trace-delay', 40)) * 1000); await app.evaluate(async ({ contentTracing }) => { await contentTracing.startRecording({ included_categories: ['*'] }); }); await sleep(8000); const f = await app.evaluate(async ({ contentTracing }, p) => await contentTracing.stopRecording(p), tracePath); console.log('trace', f); }
if (argv.includes('--inspect')) { await sleep(20000); console.log(JSON.stringify(await page.evaluate(() => { const all = [...document.querySelectorAll('*')]; return { iframes: document.querySelectorAll('iframe,webview').length, shadows: all.filter((e) => e.shadowRoot).length, canvases: document.querySelectorAll('canvas').length, videos: document.querySelectorAll('video').length, anim: document.getAnimations({ subtree: true }).length, running: all.filter((e) => { const cs = getComputedStyle(e); return cs.animationName !== 'none' && cs.animationPlayState === 'running'; }).map((e) => e.tagName + '.' + String(e.className).slice(0, 60) + ' ' + getComputedStyle(e).animationName + ' ' + getComputedStyle(e).animationIterationCount + ' ' + getComputedStyle(e).display).slice(0, 20), transitions: all.filter((e) => getComputedStyle(e).transitionDuration !== '0s').length }; })));
  console.log(JSON.stringify(await page.evaluate(() => performance.getEntriesByType('long-animation-frame').length))); }
if (argv.includes('--kill-css')) { await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' }); console.log('css killed'); }
if (argv.includes('--toasts')) { await sleep(60000); console.log(JSON.stringify(await page.evaluate(() => window.__toast))); }
if (argv.includes('--inject-anim')) { await sleep(5000); console.log('injected', await page.evaluate(() => { const a = document.body.animate([{ opacity: 0.99 }, { opacity: 1 }], { duration: 300 }); return a.pending; })); }
const snap = async () => (await probes.processes()).electron.map((p) => ({ id: `${p.type}:${p.pid}`, c: p.cpuSec }));
let prev = await snap(); let prevT = Date.now(); const rows = [];
for (let t = 0; t < seconds; t += 10) {
  await sleep(10000); const cur = await snap(); const now = Date.now();
  const d = cur.map((p) => `${p.id.split(':')[0]}=${(((p.c - (prev.find((q) => q.id === p.id)?.c ?? p.c)) / ((now - prevT) / 1000)) * 100).toFixed(2)}%`);
  console.log(`+${t + 10}s`, d.join(' ')); prev = cur; prevT = now;
}
await app.close().catch(() => {});
