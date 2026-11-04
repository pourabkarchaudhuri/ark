/**
 * The 10-cycle scenario. Every step is wrapped: a view that cannot render (offline, headless, older build
 * with a different layout) is logged as skipped and the cycle carries on.
 */
import { sleep } from './util.mjs';

const T = (name) => `[data-tour="${name}"]`;

export function makeRunner(probes, log) {
  const page = probes.page;
  const skipped = new Map();

  async function step(cycle, name, fn, out) {
    const t0 = await probes.now().catch(() => 0);
    const w0 = Date.now();
    let error = null;
    try {
      // a Radix menu/dialog left open sets body{pointer-events:none}; Escape closes it before the next action
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(120);
      await fn();
    } catch (e) {
      const lines = String(e?.message ?? e).replace(/\u001b\[[0-9;]*m/g, '').split('\n');
      error = [lines[0], ...lines.filter((l) => /intercepts|not visible|detached|strict mode|waiting for/.test(l)).slice(-1)].join(' | ').slice(0, 300);
      const where = await page.evaluate(() => `${location.hash} "${document.body.innerText.slice(0, 90).replace(/\s+/g, ' ')}"`).catch(() => '?');
      const k = `${name}: ${error} @ ${where}`;
      if (!skipped.has(k)) {
        skipped.set(k, 0);
        log(`  skipped/failed step "${name}" (cycle ${cycle}): ${error} @ ${where}`);
      }
      skipped.set(k, skipped.get(k) + 1);
    }
    const t1 = await probes.now().catch(() => 0);
    out[name] = { ms: Date.now() - w0, t0, t1, error };
    return out[name];
  }

  const click = (sel, timeout = 30000) => page.locator(sel).first().click({ timeout });
  const clickText = (re, timeout = 6000) => page.getByRole('button', { name: re }).first().click({ timeout });

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
        await page.mouse.wheel(0, Math.round(vp.height / 6));
        await sleep(40);
      }
      await sleep(500);
    }
    await page.mouse.wheel(0, -100000);
    await sleep(500);
  }

  async function toBrowseTop() {
    const back = page.locator('[data-tour="settings-sidebar"] button', { hasText: /^\s*back/i }).first();
    if (await back.isVisible().catch(() => false)) await back.click({ timeout: 5000 }).catch(() => {});
    await click(T('browse-button'));
    await sleep(800);
    await page.mouse.wheel(0, -100000);
  }

  /** One scenario cycle; returns per-step timings and the IPC / long-task / frame data of the steps that need it. */
  async function cycle(n, { settleMs = 2500 } = {}) {
    const steps = {};
    const extra = {};
    await dismissOverlays();

    // --- Browse: entry cost (IPC per Browse screen), scroll 3 screens (frames, long tasks), filter, search, empty result
    await step(n, 'to-library', () => click(T('library-button')), steps);
    await sleep(1000);
    await probes.ipc(true);
    await probes.setBytes(true);
    await step(n, 'browse-load', async () => {
      await click(T('browse-button'));
      await sleep(settleMs + 1000);
    }, steps);
    extra.browseLoadIpc = await probes.ipc(true);

    await probes.startFrames();
    await step(n, 'browse-scroll', () => scrollScreens(3), steps);
    extra.browseScrollFrames = await probes.stopFrames();
    extra.browseScrollIpc = await probes.ipc(true);

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

    // --- Voyage tabs
    await step(n, 'voyage', async () => {
      await click(T('journey-button'));
      await sleep(2500);
    }, steps);
    for (const [label, wait] of [['Log', 1500], ['Scenes', 1500], ['Audit', 1500], ['Medals', 1500], ['Your Ark', 4000]]) {
      await step(n, `voyage-${label}`, async () => {
        await page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first().click({ timeout: 30000 });
        await sleep(wait);
      }, steps);
    }
    // Leave Ark 3D, let the GPU settle, then read GPU memory (rule: returns to baseline)
    await step(n, 'voyage-leave-ark', async () => {
      await page.getByRole('button', { name: /^Log$/i }).first().click({ timeout: 30000 });
      await click(T('library-button'));
      await sleep(4000);
    }, steps);
    extra.gpuAfterArk = (await probes.processes()).electron.filter((p) => p.type === 'GPU').reduce((a, p) => a + p.workingSetMB, 0);

    // --- Oracle compute
    await step(n, 'oracle', async () => {
      await click(T('oracle-button'));
      await sleep(3000);
    }, steps);
    await step(n, 'oracle-compute', async () => {
      await page.getByRole('button', { name: /refresh/i }).first().click({ timeout: 4000 });
      await sleep(8000);
    }, steps);

    // --- Upcoming
    await step(n, 'upcoming', async () => {
      await click(T('calendar-button'));
      await sleep(2500);
    }, steps);

    // --- every Settings page
    await step(n, 'settings', async () => {
      await click(T('settings-button'));
      await sleep(1500);
      const count = await page.evaluate(() => {
        let group = [...document.querySelectorAll('[data-tour^="settings-nav-"]')];
        // older layout (v1.0.96): tab buttons in the sidebar, the first one being Back
        if (!group.length) group = [...document.querySelectorAll('[data-tour="settings-sidebar"] button')].filter((b) => !/^\s*back/i.test(b.innerText));
        group.forEach((b, i) => b.setAttribute('data-perf-settings-nav', String(i)));
        return group.length;
      });
      if (!count) throw new Error('no settings nav found');
      for (let i = 0; i < count; i++) {
        await page.locator(`[data-perf-settings-nav="${i}"]`).first().click({ timeout: 3000 }).catch(() => {});
        await sleep(1200);
      }
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
    return { steps, extra };
  }

  return { cycle, step, skipped, dismissOverlays, click, toBrowseTop };
}
