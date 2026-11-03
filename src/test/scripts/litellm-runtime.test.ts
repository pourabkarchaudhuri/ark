/**
 * The bundled LiteLLM runtime's supply chain and release gates (1.0.97 B35), without any network:
 *  - the shipped lock file and manifest agree (hashes, pinned version, launcher), every package is
 *    hash-locked, and none of the LiteLLM releases that shipped malware is pinned;
 *  - scripts/lib/litellm-runtime.mjs accepts a matching runtime folder and flags a missing
 *    interpreter, a changed launcher or lock, a different litellm version, an unexpected .pth file
 *    and key material;
 *  - scripts/build-litellm-runtime.mjs stops before downloading anything when the lock or launcher
 *    no longer match the manifest;
 *  - after-pack-check does not text-scan the third-party python tree but still scans the rest.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain .mjs helper without types
import * as lib from '../../../scripts/lib/litellm-runtime.mjs';
// @ts-expect-error plain .mjs helper without types
import { checkPackagedDir, checkPackagedLitellmRuntime } from '../../../scripts/after-pack-check.mjs';

const root = path.resolve(__dirname, '../../..');
const manifestPath = path.join(root, 'electron', 'ai-router', 'litellm-manifest.json');
const lockPath = path.join(root, 'scripts', 'litellm', 'requirements.lock.txt');
const launcherPath = path.join(root, 'scripts', 'litellm', 'ark_litellm.py');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const lockText = fs.readFileSync(lockPath, 'utf8');

describe('shipped lock file and manifest', () => {
  it('the manifest pins the lock file and the launcher by sha256', () => {
    expect(manifest.litellm.lockSha256).toBe(lib.sha256File(lockPath));
    expect(manifest.launcher.sha256).toBe(lib.sha256File(launcherPath));
  });

  it('every locked package is exact-versioned and has exactly one sha256', () => {
    const pins = lockText.match(/^[A-Za-z0-9_.-]+==\S+ \\$/gm) ?? [];
    const hashes = lockText.match(/--hash=sha256:[0-9a-f]{64}/g) ?? [];
    expect(pins.length).toBeGreaterThan(50);
    expect(hashes).toHaveLength(pins.length);
    expect(new Set(pins.map((p) => p.split('==')[0])).size).toBe(pins.length);
  });

  it('pins the manifest\'s litellm version and none of the releases that shipped malware', () => {
    expect(lockText).toMatch(new RegExp(`^litellm==${manifest.litellm.version.replace(/\./g, '\\.')} `, 'm'));
    expect(manifest.litellm.neverUse).toEqual(expect.arrayContaining(['1.82.7', '1.82.8', '1.107.0']));
    for (const bad of manifest.litellm.neverUse) {
      expect(lockText).not.toMatch(new RegExp(`^litellm==${bad.replace(/\./g, '\\.')}\\b`, 'm'));
    }
    expect(manifest.litellm.advisoryCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('python sources are pinned by sha256 on known hosts, and only a reviewed .pth is allowed', () => {
    expect(manifest.python.sources.length).toBeGreaterThanOrEqual(2);
    for (const s of manifest.python.sources) {
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.url).toMatch(/^https:\/\/(github\.com\/astral-sh\/python-build-standalone\/|api\.nuget\.org\/)/);
      expect(s.version).toMatch(/^3\.12\./);
    }
    expect(manifest.python.allowedPth).toEqual(['pywin32.pth']);
  });

  it('the launcher binds loopback only and takes secrets from the environment', () => {
    const py = fs.readFileSync(launcherPath, 'utf8');
    expect(py).toMatch(/refusing to bind a non-loopback address/);
    expect(py).toMatch(/LITELLM_MASTER_KEY/);
    expect(py).not.toMatch(/sk-[A-Za-z0-9]{20}/);
  });
});

describe('checkLitellmRuntimeDir', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-lt-rt-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function build(over: { launcher?: string; lock?: string; version?: string; pth?: string[]; extra?: Record<string, string>; noPython?: boolean } = {}) {
    const rt = path.join(dir, 'litellm-runtime');
    const site = path.join(rt, 'python', 'Lib', 'site-packages');
    fs.mkdirSync(path.join(site, `litellm-${over.version ?? '1.2.3'}.dist-info`), { recursive: true });
    if (!over.noPython) fs.writeFileSync(path.join(rt, 'python', 'python.exe'), 'exe');
    fs.writeFileSync(path.join(rt, 'ark_litellm.py'), over.launcher ?? 'print("launcher")');
    fs.writeFileSync(path.join(rt, 'requirements.lock.txt'), over.lock ?? 'litellm==1.2.3 \\\n    --hash=sha256:' + 'a'.repeat(64));
    for (const p of over.pth ?? []) fs.writeFileSync(path.join(site, p), '');
    for (const [n, body] of Object.entries(over.extra ?? {})) fs.writeFileSync(path.join(rt, n), body);
    return rt;
  }
  const man = (rt: string, allowedPth: string[] = []) => ({
    litellm: { version: '1.2.3', lockSha256: lib.sha256File(path.join(rt, 'requirements.lock.txt')) },
    launcher: { sha256: lib.sha256File(path.join(rt, 'ark_litellm.py')) },
    python: { allowedPth },
  });

  it('a runtime that matches its manifest has no problems', () => {
    const rt = build();
    expect(lib.checkLitellmRuntimeDir(rt, man(rt))).toEqual([]);
  });

  it('flags a missing interpreter, a changed launcher and a changed lock copy', () => {
    const rt = build({ noPython: true });
    const m = man(rt);
    fs.writeFileSync(path.join(rt, 'ark_litellm.py'), 'import os; os.system("x")');
    fs.writeFileSync(path.join(rt, 'requirements.lock.txt'), 'evil==1');
    const problems = lib.checkLitellmRuntimeDir(rt, m).join('; ');
    expect(problems).toMatch(/python\/python\.exe missing/);
    expect(problems).toMatch(/ark_litellm\.py sha256 does not match/);
    expect(problems).toMatch(/lock file sha256 does not match/);
  });

  it('flags another litellm version than the pinned one', () => {
    const rt = build({ version: '1.107.0' });
    expect(lib.checkLitellmRuntimeDir(rt, man(rt)).join('; ')).toMatch(/litellm version litellm-1\.107\.0\.dist-info != pinned 1\.2\.3/);
  });

  it('a .pth file runs code at interpreter start: only the reviewed ones are allowed', () => {
    const rt = build({ pth: ['pywin32.pth', 'litellm_init.pth'] });
    expect(lib.checkLitellmRuntimeDir(rt, man(rt, ['pywin32.pth']))).toEqual(['unexpected .pth file in site-packages: litellm_init.pth']);
  });

  it('flags key material: key-like file names and credential-shaped text in our own files', () => {
    const rt = build({ extra: { 'config.yaml': 'x', '.env': 'A=1', 'notes.txt': 'key sk-ant-api03-abcdefghijklmnopqrstuvwx' } });
    const problems = lib.checkLitellmRuntimeDir(rt, man(rt)).join('; ');
    expect(problems).toMatch(/key-like file in the runtime folder: config\.yaml/);
    expect(problems).toMatch(/key-like file in the runtime folder: \.env/);
    expect(problems).toMatch(/notes\.txt contains key-like text/);
  });

  it('a missing folder is reported, not thrown', () => {
    expect(lib.checkLitellmRuntimeDir(path.join(dir, 'nope'), man(build()))[0]).toMatch(/runtime folder missing/);
  });
});

describe('build-litellm-runtime.mjs stops before downloading when pins do not match', () => {
  let work: string;
  beforeEach(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-lt-build-')); });
  afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

  function run(env: Record<string, string>, args: string[] = []) {
    return spawnSync(process.execPath, [path.join(root, 'scripts', 'build-litellm-runtime.mjs'), ...args], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, ARK_LITELLM_CACHE_DIR: path.join(work, 'cache'), ARK_LITELLM_OUT_DIR: path.join(work, 'out'), ...env },
    });
  }

  it('a lock file that differs from the manifest hash is refused', () => {
    const lock = path.join(work, 'lock.txt');
    fs.writeFileSync(lock, `${lockText}# tampered\n`);
    const r = run({ ARK_LITELLM_LOCK: lock });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/requirements\.lock\.txt sha256 .* != manifest/);
    expect(fs.existsSync(path.join(work, 'out'))).toBe(false);
  });

  it('a lock that pins a release that shipped malware is refused even when the manifest was updated to match', () => {
    const lock = path.join(work, 'lock.txt');
    fs.writeFileSync(lock, lockText.replace(/^litellm==\S+ /m, 'litellm==1.107.0 '));
    const man = JSON.parse(JSON.stringify(manifest));
    man.litellm.lockSha256 = lib.sha256File(lock);
    const mp = path.join(work, 'manifest.json');
    fs.writeFileSync(mp, JSON.stringify(man));
    const r = run({ ARK_LITELLM_LOCK: lock, ARK_LITELLM_MANIFEST: mp });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/pins litellm 1\.107\.0, a release that shipped malware/);
  });

  it('a lock entry without a hash is refused', () => {
    const lock = path.join(work, 'lock.txt');
    fs.writeFileSync(lock, `${lockText}\nrequests==2.0.0 \\\n`);
    const man = JSON.parse(JSON.stringify(manifest));
    man.litellm.lockSha256 = lib.sha256File(lock);
    const mp = path.join(work, 'manifest.json');
    fs.writeFileSync(mp, JSON.stringify(man));
    const r = run({ ARK_LITELLM_LOCK: lock, ARK_LITELLM_MANIFEST: mp });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/exactly one sha256 hash/);
  });

  it('a python archive that is not one of the pinned ones is refused', () => {
    const bogus = path.join(work, 'python.zip');
    fs.writeFileSync(bogus, 'not python');
    const r = run({}, [`--python-archive=${bogus}`]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/is not a pinned python archive/);
  });
});

describe('after-pack-check', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-pack-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('does not text-scan the third-party python tree, but still scans everything else', () => {
    const py = path.join(dir, 'resources', 'litellm-runtime', 'python', 'Lib', 'site-packages', 'litellm');
    fs.mkdirSync(py, { recursive: true });
    fs.writeFileSync(path.join(py, 'constants.py'), 'AZURE_API_KEY = "name only"\n');
    expect(checkPackagedDir(dir)).toEqual([]);
    fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'resources', 'settings.txt'), 'AZURE_OPENAI_KEY=abc\n');
    expect(checkPackagedDir(dir).join(';')).toMatch(/settings\.txt assigns AZURE_OPENAI_KEY/);
  });

  it('checkPackagedLitellmRuntime reports a packaged app without the runtime', () => {
    expect(checkPackagedLitellmRuntime(dir)[0]).toMatch(/^litellm-runtime: runtime folder missing/);
  });
});
