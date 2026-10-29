/**
 * Publish the GitHub release for the current package.json version.
 *
 *   GITHUB_TOKEN=<pat> node scripts/publish-github-release.mjs     (or: npm run release:publish)
 *
 * Order matters for the auto-updater: the release is created as a DRAFT, the installer, blockmap
 * and latest.yml are uploaded and checked, and only then is the release published. Clients read
 * the latest *published* release, so they can never see a release that has no latest.yml or a
 * half-uploaded installer.
 *
 * Uploads use curl (streams the 200+ MB installer; Node fetch would buffer it). The token is
 * passed to curl in a temporary header file, never on the command line, and never printed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('Set GITHUB_TOKEN');
  process.exit(1);
}

const repo = 'pourabkarchaudhuri/ark';
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const v = pkg.version;
const tag = `v${v}`;
const body = fs.readFileSync(path.join(root, 'release', 'release-body.md'), 'utf8');
const buildDir = path.join(root, 'release', 'builds', v);
const assetNames = [`Ark-Setup-${v}.exe`, `Ark-Setup-${v}.exe.blockmap`, 'latest.yml'];

const apiHeaders = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function api(method, url, json) {
  const res = await fetch(url, {
    method,
    headers: json ? { ...apiHeaders, 'Content-Type': 'application/json' } : apiHeaders,
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

function uploadAsset(releaseId, name) {
  const filePath = path.join(buildDir, name);
  const hdrFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ark-pub-')), 'h.txt');
  fs.writeFileSync(hdrFile, `Authorization: Bearer ${token}\nContent-Type: application/octet-stream\n`, { mode: 0o600 });
  try {
    const out = execFileSync('curl', [
      '-sS', '-X', 'POST', '-H', `@${hdrFile}`,
      `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
      '--data-binary', `@${filePath}`,
    ], { maxBuffer: 64 * 1024 * 1024 }).toString();
    return JSON.parse(out);
  } finally {
    fs.rmSync(path.dirname(hdrFile), { recursive: true, force: true });
  }
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function main() {
  for (const name of assetNames) {
    if (!fs.existsSync(path.join(buildDir, name))) fail(`Missing build artifact: ${name}`);
  }
  // latest.yml must point at the installer we are uploading.
  const yml = fs.readFileSync(path.join(buildDir, 'latest.yml'), 'utf8');
  if (!yml.includes(`path: ${assetNames[0]}`) || !yml.includes(`version: ${v}`)) {
    fail('latest.yml does not reference this version\'s installer');
  }

  const existing = await api('GET', `https://api.github.com/repos/${repo}/releases/tags/${tag}`);
  if (existing.ok && !existing.data.draft) fail(`Release ${tag} is already published`);

  let release = existing.ok ? existing.data : null;
  if (!release) {
    const created = await api('POST', `https://api.github.com/repos/${repo}/releases`, {
      tag_name: tag, name: tag, body, draft: true, prerelease: false,
    });
    if (!created.ok) fail(`Create failed (${created.status}): ${JSON.stringify(created.data).slice(0, 300)}`);
    release = created.data;
    console.log('Created draft release id=', release.id);
  } else {
    console.log('Reusing existing draft release id=', release.id);
  }

  const present = new Set((release.assets ?? []).filter((a) => a.state === 'uploaded').map((a) => a.name));
  for (const name of assetNames) {
    if (present.has(name)) {
      console.log('Already uploaded', name);
      continue;
    }
    const out = uploadAsset(release.id, name);
    if (out.state !== 'uploaded') fail(`Upload failed for ${name}: ${JSON.stringify(out).slice(0, 300)}`);
    console.log('Uploaded', name, out.size);
  }

  // Verify before going public: every asset present, uploaded, and the same size as on disk.
  const check = await api('GET', `https://api.github.com/repos/${repo}/releases/${release.id}`);
  if (!check.ok) fail(`Could not re-read release (${check.status})`);
  for (const name of assetNames) {
    const a = check.data.assets.find((x) => x.name === name);
    const size = fs.statSync(path.join(buildDir, name)).size;
    if (!a || a.state !== 'uploaded' || a.size !== size) {
      fail(`Asset check failed for ${name} (remote ${a ? `${a.size}/${a.state}` : 'missing'}, local ${size}). Release left as draft.`);
    }
  }

  const pub = await api('PATCH', `https://api.github.com/repos/${repo}/releases/${release.id}`, {
    draft: false, make_latest: 'true',
  });
  if (!pub.ok) fail(`Publish failed (${pub.status}); release left as draft`);
  console.log('Published', pub.data.html_url);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
