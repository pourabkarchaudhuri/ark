/**
 * The 10-cycle scenario. Every step is wrapped: a view that cannot render (offline, headless, older build
 * with a different layout) is logged as skipped and the cycle carries on.
 */
import { sleep } from './util.mjs';

const T = (name) => `[data-tour="${name}"]`;

/** Per-step IPC summary: invoke calls (renderer -> main), pushes (main -> renderer), payload KB. */
export function compactIpc(ipc) {
  if (!ipc) return null;
  const sum = (t, k) => Object.values(t ?? {}).reduce((a, x) => a + (x[k] ?? 0), 0);
  return {
    invokeCalls: sum(ipc.invoke, 'calls'),
    sendCalls: sum(ipc.send, 'calls'),
    kb: Math.round(((sum(ipc.invoke, 'argBytes') + sum(ipc.invoke, 'resultBytes') + sum(ipc.send, 'argBytes')) / 1024) * 10) / 10,
    top: Object.entries({ ...ipc.invoke, ...Object.fromEntries(Object.entries(ipc.send ?? {}).map(([k, v]) => [`push:${k}`, v])) })
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 4)
      .map(([k, v]) => `${k} x${v.calls}`),
  };
}

const rawIpcSteps = new Set(['browse-load', 'browse-scroll']);

/**
 * PERF_PROFILE_STEPS=oracle-compute,settings (or *) with PERF_PROFILE_DIR=<dir>: a renderer CPU profile (CDP Profiler, 200 us
 * sampling) around each named step, written as <dir>/c<cycle>-<step>.cpuprofile, to attribute a long task to functions.
 */
const profileSteps = process.env.PERF_PROFILE_DIR && process.env.PERF_PROFILE_STEPS ? new Set(process.env.PERF_PROFILE_STEPS.split(',')) : null;

export function makeRunner(probes, log) {
  const page = probes.page;
  const skipped = new Map();

  async function step(cycle, name, fn, out) {
    const t0 = await probes.now().catch(() => 0);
    const w0 = Date.now();
    let error = null;
    await probes.ipc(true).catch(() => null);
    const profiling = profileSteps && (profileSteps.has('*') || profileSteps.has(name));
    if (profiling) {
      await probes.cdp.send('Profiler.enable').catch(() => {});
      await probes.cdp.send('Profiler.setSamplingInterval', { interval: 200 }).catch(() => {});
      await probes.cdp.send('Profiler.start').catch(() => {});
    }
    try {
      // a Radix menu/dialog left open sets body{pointer-events:none}; Escape closes it before the next action
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(120);
      await fn();
    } catch (e) {
      const lines = String(e?.message ?? e).replace(/\u001b\[[0-9;]*m/g, '').split('\n');
      error = [lines[0], ...lines.filter((l) => /intercepts|not visible|detached|strict mode|waiting for/.test(l)).slice(-1)].join(' | ').slice(0, 300);
      const where = await page.evaluate(() => `${location.hash} "${document.body.innerText.slice(0, 90).replace(/\s+/g, ' ')}"`).catch(() => '?');
      if (process.env.PERF_FAIL_DIR && (globalThis.__perfFailDumped = (globalThis.__perfFailDumped ?? 0) + 1) <= 6) {
        try {
          const fs = await import('node:fs');
          await page.screenshot({ path: `${process.env.PERF_FAIL_DIR}/fail-${cycle}-${name}.png` }).catch(() => {});
          const info = await page.evaluate(() => {
            const d = (e) => e ? `${e.tagName}.${String(e.className).slice(0, 120)} role=${e.getAttribute('role')} data-state=${e.getAttribute('data-state')} text=${(e.innerText || '').slice(0, 100)}` : null;
            const t = document.querySelector('[data-tour="oracle-button"]'); const r = t?.getBoundingClientRect();
            return { target: r ? [r.x, r.y, r.width, r.height] : null, top: r ? d(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) : null,
              bodyPE: getComputedStyle(document.body).pointerEvents, bodyOverflow: getComputedStyle(document.body).overflow,
              dialogs: [...document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true],[data-state=open]')].map(d).slice(0, 12),
              fixed: [...document.querySelectorAll('body *')].filter((e) => getComputedStyle(e).position === 'fixed' && e.getBoundingClientRect().width > 300).map(d).slice(0, 12),
              hash: location.hash, nodes: document.getElementsByTagName('*').length, ae: d(document.activeElement), inert: [...document.querySelectorAll('[inert],[aria-hidden=true]')].length,
              dup: document.querySelectorAll('[data-tour="oracle-button"]').length };
          }).catch((e) => ({ err: String(e) }));
          info.frames = await page.evaluate(() => new Promise((res) => {
            const out = { raf: 0, muts: 0, rects: [], hidden: document.hidden, vis: document.visibilityState, focus: document.hasFocus() };
            const mo = new MutationObserver((l) => { out.muts += l.length; }); mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
            const btn = () => document.querySelector('[data-tour="oracle-button"]');
            const t0 = performance.now();
            const f = () => { out.raf++; const r = btn()?.getBoundingClientRect(); if (out.rects.length < 12) out.rects.push(r ? [Math.round(r.x * 10) / 10, Math.round(r.y * 10) / 10, Math.round(r.width * 10) / 10] : null); if (performance.now() - t0 < 1500) requestAnimationFrame(f); else { mo.disconnect(); out.anims = document.getAnimations().length; res(out); } };
            requestAnimationFrame(f); setTimeout(() => { mo.disconnect(); res({ ...out, timeout: true }); }, 4000);
          })).catch((e) => String(e));
          info.win = await probes.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle().slice(0, 30), visible: w.isVisible(), min: w.isMinimized(), max: w.isMaximized(), focused: w.isFocused(), fs: w.isFullScreen(), bounds: w.getBounds() }))).catch((e) => String(e));
          fs.writeFileSync(`${process.env.PERF_FAIL_DIR}/fail-${cycle}-${name}.json`, JSON.stringify(info, null, 2));
        } catch {}
      }
      const k = `${name}: ${error} @ ${where}`;
      if (!skipped.has(k)) {
        skipped.set(k, 0);
        log(`  skipped/failed step "${name}" (cycle ${cycle}): ${error} @ ${where}`);
      }
      skipped.set(k, skipped.get(k) + 1);
    }
    const t1 = await probes.now().catch(() => 0);
    if (profiling) {
      const { profile } = await probes.cdp.send('Profiler.stop').catch(() => ({}));
      if (profile) {
        const fs = await import('node:fs');
        fs.writeFileSync(`${process.env.PERF_PROFILE_DIR}/c${cycle}-${name}.cpuprofile`, JSON.stringify(profile));
      }
    }
    const ipc = await probes.ipc(true).catch(() => null);
    out[name] = { ms: Date.now() - w0, t0, t1, error, ipc: compactIpc(ipc) };
    if (rawIpcSteps.has(name)) out[name].ipcRaw = ipc;
    return out[name];
  }

  /**
   * Playwright's actionability check ("visible, enabled and stable") needs two animation frames with an unchanged box. In one
   * v1.0.98 run (cycle 6 of 10, 17 min in) it never passed on any nav button for 40 minutes while page.evaluate and the process
   * sampler kept working and mouse.wheel never returned, i.e. the page stopped producing frames; no dialog, error boundary or
   * overlay was involved and three re-runs of the same tree passed all cycles. In the Oracle the Refresh button also failed the
   * check once in cycle 1 while a background "Updating" pass mutated the DOM every frame. A click that cannot be
   * actionability-checked is dispatched as a DOM click after a bounded wait so neither can wedge the scenario. Every fallback is
   * counted (extra.fallbackClicks) and logged with the frame count at that moment, so the cause is visible next time.
   */
  const fallbackClicks = { count: 0, last: null };
  async function framesAlive() {
    return page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 700) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); setTimeout(() => res(n), 2500); })).catch(() => -1);
  }
  async function robustClick(locator, label, timeout) {
    try {
      await locator.click({ timeout: Math.min(timeout, 8000) });
    } catch (e) {
      if (!/Timeout/.test(String(e?.message))) throw e;
      const fps = await framesAlive();
      const hit = await locator.evaluate((el) => { el.click(); return true; }, undefined, { timeout: 4000 }).catch(() => false);
      fallbackClicks.count++;
      fallbackClicks.last = { label, framesIn700ms: fps, domClick: hit };
      log(`  click fallback "${label}": actionability timed out, frames in 700 ms = ${fps}, DOM click ${hit ? 'sent' : 'failed (element missing)'}`);
      if (!hit) throw e;
    }
  }
  const click = (sel, timeout = 30000) => robustClick(page.locator(sel).first(), sel, timeout);
  const clickText = (re, timeout = 6000) => robustClick(page.getByRole('button', { name: re }).first(), String(re), timeout);
  const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_r, rej) => setTimeout(() => rej(new Error(`${what} did not return within ${ms} ms`)), ms))]);

  async function dismissOverlays() {
    for (const re of [/^Got it$/i, /Close changelog/i, /^Skip( tour)?$/i]) {
      const b = page.getByRole('button', { name: re }).first();
      if (await b.isVisible().catch(() => false)) await b.click({ timeout: 2000 }).catch(() => {});
    }
  }

  async function scrollScreens(n) {
    const vp = page.viewportSize() ?? { width: 1400, height: 900 };
    await page.mouse.move(vp.width / 2, vp.height / 2);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 6; k++) {
        await withTimeout(page.mouse.wheel(0, Math.round(vp.height / 6)), 10000, 'mouse.wheel');
        await sleep(40);
      }
      await sleep(500);
    }
    await withTimeout(page.mouse.wheel(0, -100000), 10000, 'mouse.wheel');
    await sleep(500);
  }

  async function toBrowseTop() {
    const back = page.locator('[data-tour="settings-sidebar"] button', { hasText: /^\s*back/i }).first();
    if (await back.isVisible().catch(() => false)) await back.click({ timeout: 5000 }).catch(() => {});
    await click(T('browse-button'));
    await sleep(800);
    await withTimeout(page.mouse.wheel(0, -100000), 10000, 'mouse.wheel').catch(() => {});
  }

  /**
   * Mount cost of one Settings page: click its nav entry from inside the page (so the clock is the page's own).
   * paintMs is click -> second animation frame (the page's first paint after the click, scripts and layout included).
   * mountMs is click -> the last element added or removed, once no element changed for 250 ms (a lazy chunk or a data fetch that
   * fills the page late shows here). Attribute and text changes are ignored on purpose: a ticking clock or a running animation
   * would otherwise keep the page "busy" forever. The longest long task in the window is the renderer stall the user feels.
   */
  async function measureSettingsPage(i) {
    const res = await page
      .evaluate(
        ([idx]) =>
          new Promise((resolve) => {
            const el = document.querySelector(`[data-perf-settings-nav="${idx}"]`);
            if (!el) return resolve(null);
            const label = (el.getAttribute('data-tour') || el.innerText || '').trim().slice(0, 40);
            const t0 = performance.now();
            let last = t0;
            const mo = new MutationObserver(() => {
              last = performance.now();
            });
            mo.observe(document.body, { subtree: true, childList: true });
            let paintMs = null;
            el.click();
            requestAnimationFrame(() => requestAnimationFrame(() => { paintMs = Math.round(performance.now() - t0); }));
            const tick = () => {
              const now = performance.now();
              if (now - last >= 250 || now - t0 > 4000) {
                mo.disconnect();
                resolve({ label, t0, paintMs, mountMs: Math.round(last - t0), nodes: document.getElementsByTagName('*').length });
              } else setTimeout(tick, 50);
            };
            setTimeout(tick, 50);
          }),
        [i],
      )
      .catch(() => null);
    if (!res) return { i, error: 'nav entry missing' };
    const t1 = await probes.now().catch(() => res.t0 + res.mountMs + 250);
    const lts = await probes.longTasksBetween(res.t0, t1).catch(() => []);
    await sleep(400);
    return { i, label: res.label, paintMs: res.paintMs, mountMs: res.mountMs, longTaskMaxMs: lts.length ? Math.max(...lts) : 0, nodes: res.nodes };
  }

  /** One scenario cycle; returns per-step timings and the IPC / long-task / frame data of the steps that need it. */
  async function cycle(n, { settleMs = 2500, ai = false } = {}) {
    const steps = {};
    const extra = {};
    await dismissOverlays();

    // --- Browse: entry cost (IPC per Browse screen), scroll 3 screens (frames, long tasks), filter, search, empty result
    await step(n, 'to-library', () => click(T('library-button')), steps);
    await sleep(1000);
    await probes.setBytes(true);
    await step(n, 'browse-load', async () => {
      await click(T('browse-button'));
      await sleep(settleMs + 1000);
    }, steps);
    extra.browseLoadIpc = steps['browse-load'].ipcRaw;

    await probes.startFrames();
    await step(n, 'browse-scroll', () => scrollScreens(3), steps);
    extra.browseScrollFrames = await probes.stopFrames();
    extra.browseScrollIpc = steps['browse-scroll'].ipcRaw;

    await step(n, 'browse-filter', async () => {
      await page.getByRole('button', { name: /open filters/i }).first().click({ timeout: 4000 });
      await sleep(700);
      const opt = page.locator('[role="dialog"] label, [data-tour="filter-panel"] label, aside label').first();
      if (await opt.isVisible().catch(() => false)) await opt.click({ timeout: 2000 });
      await sleep(700);
      await page.keyboard.press('Escape');
      await sleep(300);
    }, steps);

    const search = page.getByLabel('Search games').first();
    await step(n, 'browse-search', async () => {
      await search.fill('Counter', { timeout: 4000 });
      await sleep(1500);
    }, steps);
    await step(n, 'browse-search-empty', async () => {
      await search.fill('zzqqxxnomatch', { timeout: 4000 });
      await sleep(1500);
      await search.fill('', { timeout: 4000 });
      await sleep(400);
    }, steps);

    // --- Game details x5 (route change remounts the dashboard each time)
    await step(n, 'game-details-x5', async () => {
      for (let k = 0; k < 5; k++) {
        const id = `steam-${10000 + (k + n * 5) * 7}`;
        await page.evaluate((i) => { window.location.hash = `#/game/${i}`; }, id);
        await sleep(1500);
        await page.evaluate(() => window.history.back());
        await sleep(1200);
      }
    }, steps);
    await dismissOverlays();

    // --- Library: status change from a card
    await step(n, 'library-status-change', async () => {
      await click(T('library-button'));
      await sleep(1500);
      await page.locator('button[aria-label^="Status:"]').first().click({ timeout: 20000 });
      await sleep(800);
    }, steps);

    // GPU working set just before this cycle's Voyage visit: what "back to baseline" means once the app has warmed up
    // (the cold start reading predates every image and 3D asset the other screens keep cached)
    extra.gpuBeforeArk = (await probes.processes()).electron.filter((p) => p.type === 'GPU').reduce((acc, p) => acc + p.workingSetMB, 0);

    // --- Voyage tabs
    await step(n, 'voyage', async () => {
      await click(T('journey-button'));
      await sleep(2500);
    }, steps);
    for (const [label, wait] of [['Log', 1500], ['Scenes', 1500], ['Audit', 1500], ['Medals', 1500], ['Your Ark', 4000]]) {
      await step(n, `voyage-${label}`, async () => {
        await robustClick(page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first(), `voyage ${label}`, 30000);
        await sleep(wait);
      }, steps);
    }
    // Leave Ark 3D, let the GPU settle, then read GPU memory (rule: returns to baseline)
    await step(n, 'voyage-leave-ark', async () => {
      await robustClick(page.getByRole('button', { name: /^Log$/i }).first(), 'voyage Log', 30000);
      await click(T('library-button'));
      await sleep(4000);
    }, steps);
    // Chromium hands the GPU process's memory back about 10 s after the WebGL context is gone (measured: 4 s after
    // leaving Ark 3D it is still ~440 MB, 15 s after it is back at the pre-Ark level, in v1.0.96 and 1.0.97 alike), so
    // reading at +4 s only measures that delay. Poll until the reading stops falling (two reads within 5 MB, at least
    // 12 s in, at most 40 s) and record both numbers.
    const gpuNow = async () => (await probes.processes()).electron.filter((p) => p.type === 'GPU').reduce((acc, p) => acc + p.workingSetMB, 0);
    extra.gpuAfterArk4s = await gpuNow();
    {
      let prev = extra.gpuAfterArk4s;
      let cur = prev;
      const t0 = Date.now();
      while (Date.now() - t0 < 40_000) {
        await sleep(3000);
        cur = await gpuNow();
        if (Date.now() - t0 >= 12_000 && Math.abs(cur - prev) < 5) break;
        prev = cur;
      }
      extra.gpuAfterArk = cur;
      extra.gpuSettleS = Math.round((Date.now() - t0) / 1000);
    }

    // --- Oracle compute
    await step(n, 'oracle', async () => {
      await click(T('oracle-button'));
      await sleep(3000);
    }, steps);
    await step(n, 'oracle-compute', async () => {
      await robustClick(page.getByRole('button', { name: /refresh/i }).first(), 'oracle refresh', 4000);
      await sleep(8000);
    }, steps);

    // --- Built-in AI: a small embedding + rerank burst through the app's own path keeps the llama-server processes
    // alive, so the per-cycle samples count them (process and memory growth rules)
    if (ai) {
      await step(n, 'ai-burst', async () => {
        const r = await probes.ai('burst', { mode: 'app', embedTexts: 8, rerankDocs: 8, rounds: 1 });
        if (!r || r.error || !r.embedOk || !r.rerankOk) throw new Error(`ai burst failed: ${r?.error ?? 'not ok'}`);
      }, steps);
    }

    // --- Upcoming
    await step(n, 'upcoming', async () => {
      await click(T('calendar-button'));
      await sleep(2500);
    }, steps);

    // --- every Settings page
    await step(n, 'settings', async () => {
      const tOpen = await probes.now().catch(() => 0);
      await click(T('settings-button'));
      await sleep(1500);
      const openTasks = await probes.longTasksBetween(tOpen, await probes.now().catch(() => tOpen)).catch(() => []);
      extra.settingsOpenLongTaskMaxMs = openTasks.length ? Math.max(...openTasks) : 0;
      const count = await page.evaluate(() => {
        let group = [...document.querySelectorAll('[data-tour^="settings-nav-"]')];
        // older layout (v1.0.96): tab buttons in the sidebar, the first one being Back
        if (!group.length) group = [...document.querySelectorAll('[data-tour="settings-sidebar"] button')].filter((b) => !/^\s*back/i.test(b.innerText));
        group.forEach((b, i) => b.setAttribute('data-perf-settings-nav', String(i)));
        return group.length;
      });
      if (!count) throw new Error('no settings nav found');
      extra.settingsPages = [];
      for (let i = 0; i < count; i++) extra.settingsPages.push(await measureSettingsPage(i));
    }, steps);

    // --- End every cycle on the same view so readings are comparable
    await step(n, 'back-to-browse', async () => {
      // Settings is a full-screen takeover with its own Back button
      const back = page.locator('[data-tour="settings-sidebar"] button', { hasText: /^\s*back/i }).first();
      if (await back.isVisible().catch(() => false)) await back.click({ timeout: 5000 });
      await sleep(600);
      await toBrowseTop();
      await sleep(settleMs);
    }, steps);
    extra.fallbackClicks = { ...fallbackClicks };
    return { steps, extra };
  }

  return { cycle, step, skipped, dismissOverlays, click, toBrowseTop };
}
