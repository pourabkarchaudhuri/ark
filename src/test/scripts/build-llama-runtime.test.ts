/**
 * scripts/build-llama-runtime.mjs end to end with a synthetic zip (no network): unpacks only
 * llama-server.exe + DLLs + the licence, records hashes with --update-manifest, verifies them on
 * later runs, refuses a zip that does not match the pinned sha256, and never copies other tools.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(__dirname, '../../..');
const script = path.join(root, 'scripts', 'build-llama-runtime.mjs');
const shipped = JSON.parse(fs.readFileSync(path.join(root, 'electron', 'local-ai', 'runtime-manifest.json'), 'utf8'));

let work: string;
let zipPath = '';
let manifestPath = '';
let cacheDir = '';
let outDir = '';
let canZip = true;

const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function run(args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ARK_LLAMA_MANIFEST: manifestPath, ARK_LLAMA_CACHE_DIR: cacheDir, ARK_LLAMA_OUT_DIR: outDir },
  });
}

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-llama-build-'));
  const pkg = path.join(work, 'pkg', 'build', 'bin');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'llama-server.exe'), 'server-binary');
  fs.writeFileSync(path.join(pkg, 'ggml-vulkan.dll'), 'vulkan-backend');
  fs.writeFileSync(path.join(pkg, 'llama-cli.exe'), 'cli-not-wanted');
  fs.writeFileSync(path.join(pkg, 'llama-bench.exe'), 'bench-not-wanted');
  fs.writeFileSync(path.join(pkg, 'LICENSE'), 'MIT licence text');
  zipPath = path.join(work, 'llama-b1-bin-win-vulkan-x64.zip');
  const made = spawnSync('tar', ['-a', '-cf', zipPath, '-C', path.join(work, 'pkg'), '.'], { encoding: 'utf8' });
  canZip = made.status === 0 && fs.existsSync(zipPath);
  cacheDir = path.join(work, 'cache');
  outDir = path.join(work, 'out');
  manifestPath = path.join(work, 'manifest.json');
  if (canZip) {
    const manifest = JSON.parse(JSON.stringify(shipped));
    manifest.runtime.build = 'b1';
    manifest.runtime.asset = path.basename(zipPath);
    manifest.runtime.sha256 = sha(zipPath);
    manifest.runtime.files = {};
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
});
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe.skipIf(process.platform !== 'win32')('build-llama-runtime.mjs', () => {
  it('unpacks only the server, the DLLs and the licence, and records their hashes', () => {
    if (!canZip) return;
    const r = run([`--zip=${zipPath}`, '--update-manifest']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(fs.readdirSync(outDir).sort()).toEqual(['LICENSE-llama.cpp.txt', 'ggml-vulkan.dll', 'llama-server.exe']);
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(Object.keys(m.runtime.files).sort()).toEqual(['ggml-vulkan.dll', 'llama-server.exe']);
    expect(m.runtime.files['llama-server.exe']).toBe(sha(path.join(outDir, 'llama-server.exe')));
    expect(fs.readFileSync(path.join(outDir, 'LICENSE-llama.cpp.txt'), 'utf8')).toBe('MIT licence text');
  });

  it('a later run verifies against the recorded hashes (zip taken from the cache)', () => {
    if (!canZip) return;
    const r = run();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/2 file\(s\)/);
  });

  it('fails when a recorded hash no longer matches the unpacked file', () => {
    if (!canZip) return;
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    m.runtime.files['llama-server.exe'] = '0'.repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(m));
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/does not match the manifest/);
  });

  it('refuses a zip whose sha256 differs from the pinned one', () => {
    if (!canZip) return;
    const other = path.join(work, 'other.zip');
    fs.writeFileSync(other, 'not the pinned zip');
    fs.rmSync(cacheDir, { recursive: true, force: true });
    const r = run([`--zip=${other}`]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/sha256 mismatch/);
  });
});
