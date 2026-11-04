/**
 * Launch helpers: a built Ark checkout under Playwright's `_electron`, on a COPIED test profile.
 *
 * Safety rules enforced here:
 *   - always `--user-data-dir=<temp copy>`, never the real userData
 *   - every variable name found in the checkout's `.env` is blanked in the child environment (dotenv does
 *     not override variables that already exist), so no real key reaches the app. Values are never read
 *     into the harness or printed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);

/** Names (not values) defined in a .env file. */
export function envVarNames(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1])
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function sanitizedEnv(appDir, extra = {}) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: undefined };
  delete env.ELECTRON_RUN_AS_NODE;
  const names = new Set([
    ...envVarNames(path.join(appDir, '.env')),
    // known key holders, in case the packaged .env lives elsewhere
    'STEAM_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GGDEALS_API_KEY', 'GA_API_SECRET', 'GA_MEASUREMENT_ID',
  ]);
  for (const n of names) env[n] = '';
  return { ...env, NODE_ENV: 'production', ARK_PERF: '1', ELECTRON_ENABLE_LOGGING: '0', ...extra };
}

/**
 * Fail-fast offline: every host except loopback resolves to NOTFOUND inside Chromium's network stack, so the
 * run does not depend on (or wait for) the real Steam/Epic/GitHub endpoints. `extraHostRules` (checked first)
 * map specific hosts to local fakes.
 */
export function hostRules(extra = []) {
  return `--host-resolver-rules=${[...extra, 'MAP * ~NOTFOUND', 'EXCLUDE 127.0.0.1', 'EXCLUDE localhost'].join(', ')}`;
}

export function electronBinary(repoRoot) {
  return createRequire(path.join(repoRoot, 'package.json'))('electron');
}

export function copyProfile(seedDir, label) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `ark-perf-${label}-`));
  fs.cpSync(seedDir, dest, { recursive: true });
  return dest;
}

/**
 * Start the app; resolves with { app, page, tLaunch } where page is the main (non-DevTools) window.
 * `appDir` must hold a built checkout (dist-electron/ + dist/). Extra electron args go before the app path.
 */
export async function launchApp({ appDir, userDataDir, repoRoot, env = {}, extraArgs = [], extraHostRules = [], timeout = 120_000, logFile }) {
  const tLaunch = performance.now();
  const app = await electron.launch({
    executablePath: electronBinary(repoRoot),
    // Windows occlusion detection pauses frames (and so Playwright's rAF-based stability check) whenever another window covers
    // the app, which made "Enter Ark" unclickable in some runs; keep rendering regardless, for every build measured.
    args: [...(process.env.PERF_KEEP_OCCLUSION ? [] : ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows']), `--user-data-dir=${userDataDir}`, hostRules(extraHostRules), ...extraArgs, appDir],
    cwd: appDir,
    env: sanitizedEnv(appDir, env),
    timeout,
  });
  const proc = app.process();
  const pid = proc.pid;
  if (logFile) {
    const out = fs.createWriteStream(logFile, { flags: 'a' });
    proc.stdout?.pipe(out, { end: false });
    proc.stderr?.pipe(out, { end: false });
  }
  proc.on('exit', (code, sig) => { try { if (logFile) fs.appendFileSync(logFile, `
[perf-harness] electron main exited code=${code} signal=${sig} at ${new Date().toISOString()}
`); } catch { /* ignore */ } });
  // The main window is the one serving dist/index.html (overlay/DevTools/helper windows are skipped).
  await app.firstWindow({ timeout });
  let page = null;
  const deadline = performance.now() + timeout;
  while (!page && performance.now() < deadline) {
    page = app.windows().find((w) => /\/index\.html/.test(w.url()) && !/overlay/.test(w.url())) ?? null;
    if (!page) await new Promise((r) => setTimeout(r, 200));
  }
  if (!page) throw new Error(`main window not found; windows: ${app.windows().map((w) => w.url()).join(', ')}`);
  const tWindow = performance.now();
  return { app, page, pid, tLaunch, tWindow };
}

/** Block until the dashboard's Browse button exists (first interactive). Returns ms since `tLaunch`. */
export async function waitInteractive(page, tLaunch, timeout = 120_000) {
  await page.waitForSelector('[data-tour="browse-button"]', { state: 'visible', timeout });
  return performance.now() - tLaunch;
}
