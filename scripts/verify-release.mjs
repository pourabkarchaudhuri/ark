/**
 * Check a published release the way the auto-updater will see it, plus the local build it came from.
 *
 *   node scripts/verify-release.mjs [version] [--download]
 *
 * Remote (GitHub API, no token needed): release is published, has the installer, blockmap and
 * latest.yml, all uploaded; latest.yml names this version's installer and its size matches.
 * Local (release/builds/<version>, when present): latest.yml sha512 matches the installer on disk;
 * the packaged .env holds only allow-listed key names; no token file was packaged; unused
 * onnxruntime platform binaries were excluded.
 * --download also streams the published installer and compares its sha512 (off by default: some
 * networks reset executable downloads).
 * Exits non-zero on any failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const repo = 'pourabkarchaudhuri/ark';
const args = process.argv.slice(2);
const doDownload = args.includes('--download');
const version = args.find((a) => !a.startsWith('--'))?.replace(/^v/, '')
  ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const exeName = `Ark-Setup-${version}.exe`;

// Names (never values) of the keys that are meant to ship in the installer's .env.
const ENV_ALLOWED = new Set([
  'STEAM_API_KEY', 'GA_MEASUREMENT_ID', 'GA_API_SECRET',
  'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_KEY', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_KEY_VERSION',
]);

const failures = [];
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { failures.push(m); console.log(`  FAIL ${m}`); };

function parseYml(text) {
  const get = (k) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(text)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  const size = Number(/^\s+size:\s*(\d+)/m.exec(text)?.[1]);
  return { version: get('version'), path: get('path'), sha512: get('sha512'), size };
}

async function sha512OfStream(body) {
  const hash = crypto.createHash('sha512');
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return hash.digest('base64');
}

const headers = { Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

console.log(`Release v${version} (remote)`);
let yml = null;
const relRes = await fetch(`https://api.github.com/repos/${repo}/releases/tags/v${version}`, { headers });
if (!relRes.ok) {
  bad(`release v${version} not found (${relRes.status})`);
} else {
  const rel = await relRes.json();
  rel.draft ? bad('release is still a draft') : ok('published');
  const assets = new Map(rel.assets.map((a) => [a.name, a]));
  for (const name of [exeName, `${exeName}.blockmap`, 'latest.yml']) {
    const a = assets.get(name);
    a && a.state === 'uploaded' ? ok(`${name} (${a.size} bytes)`) : bad(`${name} missing or not uploaded`);
  }
  const ymlAsset = assets.get('latest.yml');
  if (ymlAsset) {
    const r = await fetch(ymlAsset.browser_download_url);
    if (r.ok) {
      yml = parseYml(await r.text());
      yml.version === version ? ok('latest.yml version') : bad(`latest.yml version is ${yml.version}`);
      yml.path === exeName ? ok('latest.yml path') : bad(`latest.yml path is ${yml.path}`);
      const exe = assets.get(exeName);
      exe && yml.size === exe.size ? ok('latest.yml size matches the installer') : bad(`latest.yml size ${yml.size} != asset ${exe?.size}`);
    } else {
      bad(`could not fetch latest.yml (${r.status})`);
    }
  }
  if (doDownload && yml && assets.get(exeName)) {
    const r = await fetch(assets.get(exeName).browser_download_url);
    if (!r.ok || !r.body) bad(`installer download failed (${r.status})`);
    else (await sha512OfStream(r.body)) === yml.sha512 ? ok('published installer sha512') : bad('published installer sha512 mismatch');
  }
}

const buildDir = path.join(root, 'release', 'builds', version);
if (fs.existsSync(buildDir)) {
  console.log(`Local build ${path.relative(root, buildDir)}`);
  const localYmlPath = path.join(buildDir, 'latest.yml');
  const localExe = path.join(buildDir, exeName);
  if (fs.existsSync(localYmlPath) && fs.existsSync(localExe)) {
    const local = parseYml(fs.readFileSync(localYmlPath, 'utf8'));
    const digest = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha512');
      fs.createReadStream(localExe).on('data', (d) => hash.update(d)).on('error', reject).on('end', () => resolve(hash.digest('base64')));
    });
    digest === local.sha512 ? ok('local installer sha512 matches latest.yml') : bad('local installer sha512 != latest.yml');
    if (yml && yml.sha512 !== local.sha512) bad('published latest.yml differs from the local one');
  }
  const unpacked = path.join(buildDir, 'win-unpacked');
  if (fs.existsSync(unpacked)) {
    const envPath = path.join(unpacked, '.env');
    if (fs.existsSync(envPath)) {
      const names = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
        .map((l) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1]).filter(Boolean);
      const extra = names.filter((n) => !ENV_ALLOWED.has(n));
      extra.length ? bad(`packaged .env has unexpected keys: ${extra.join(', ')}`) : ok(`packaged .env keys allow-listed (${names.length})`);
    }
    const found = [];
    const walk = (d, depth) => {
      if (depth > 6) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (/GIT_TOKEN|DONT_COMMIT/i.test(e.name)) found.push(path.relative(unpacked, p));
      }
    };
    walk(unpacked, 0);
    found.length ? bad(`token-like files packaged: ${found.join(', ')}`) : ok('no token files packaged');
    const ortBin = path.join(unpacked, 'resources', 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
    if (fs.existsSync(ortBin)) {
      const stray = ['darwin', 'linux', path.join('win32', 'arm64')].filter((p) => fs.existsSync(path.join(ortBin, p)));
      stray.length ? bad(`unused onnxruntime binaries packaged: ${stray.join(', ')}`) : ok('only win32/x64 onnxruntime binaries packaged');
      fs.existsSync(path.join(ortBin, 'win32', 'x64', 'onnxruntime_binding.node')) ? ok('win32/x64 onnxruntime binding present') : bad('win32/x64 onnxruntime binding missing');
    }
  }
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
