/**
 * Release tooling gates (1.0.98 F7), no network and no installer build:
 *  - the packaged python tree is hash-verified against electron/ai-router/litellm-python-tree.json;
 *  - verify-release fails (not "All checks passed") when the local build cannot be checked;
 *  - build-llama-runtime builds from source when the pinned url is a source archive and re-pins the manifest;
 *  - the tar fallback path has its backslash escaped;
 *  - the NSIS include offers to delete only %LOCALAPPDATA%\Ark\models, never for silent or update uninstalls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
// @ts-expect-error plain .mjs helper without types
import * as lib from '../../../scripts/lib/litellm-runtime.mjs';

const root = path.resolve(__dirname, '../../..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-f7-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('python tree hash list', () => {
  function makeRuntime() {
    const rt = path.join(tmp, 'rt');
    const site = path.join(rt, 'python', 'Lib', 'site-packages');
    fs.mkdirSync(path.join(site, 'pkgA', '__pycache__'), { recursive: true });
    fs.mkdirSync(path.join(rt, 'python', 'DLLs'), { recursive: true });
    fs.writeFileSync(path.join(rt, 'python', 'python.exe'), 'exe');
    fs.writeFileSync(path.join(rt, 'python', 'DLLs', 'x.pyd'), 'pyd');
    fs.writeFileSync(path.join(site, 'pkgA', 'mod.py'), 'a = 1');
    fs.writeFileSync(path.join(site, 'pkgA', '__pycache__', 'mod.cpython-312.pyc'), 'bytecode');
    return rt;
  }
  const treeOf = (rt: string) => ({ schema: 1, units: lib.hashPythonTree(rt) });

  it('accepts the tree it was pinned from and ignores bytecode', () => {
    const rt = makeRuntime();
    const tree = treeOf(rt);
    expect(Object.keys(tree.units)).toContain('python/Lib/site-packages/pkgA');
    fs.writeFileSync(path.join(rt, 'python', 'Lib', 'site-packages', 'pkgA', '__pycache__', 'new.pyc'), 'other');
    expect(lib.checkPythonTree(rt, tree)).toEqual([]);
  });

  it('flags a changed, added and removed file, naming the unit', () => {
    const rt = makeRuntime();
    const tree = treeOf(rt);
    const mod = path.join(rt, 'python', 'Lib', 'site-packages', 'pkgA', 'mod.py');
    fs.writeFileSync(mod, 'a = 2');
    expect(lib.checkPythonTree(rt, tree).join('\n')).toMatch(/pkgA does not match/);
    fs.writeFileSync(mod, 'a = 1');
    fs.mkdirSync(path.join(rt, 'python', 'Lib', 'site-packages', 'evil'));
    fs.writeFileSync(path.join(rt, 'python', 'Lib', 'site-packages', 'evil', 'x.py'), 'x');
    expect(lib.checkPythonTree(rt, tree).join('\n')).toMatch(/unexpected python\/Lib\/site-packages\/evil/);
    fs.rmSync(path.join(rt, 'python', 'DLLs'), { recursive: true });
    expect(lib.checkPythonTree(rt, tree).join('\n')).toMatch(/missing python\/DLLs/);
  });

  it('an empty list is a problem, and a packaged copy cannot skip the check', () => {
    const rt = makeRuntime();
    expect(lib.checkPythonTree(rt, { units: {} })[0]).toMatch(/lists no units/);
    const app = path.join(tmp, 'app');
    fs.mkdirSync(path.join(app, 'resources'), { recursive: true });
    fs.cpSync(rt, path.join(app, 'resources', 'litellm-runtime'), { recursive: true });
    expect(lib.checkPackagedLitellm(app, {}).join('\n')).toMatch(/lists no units/);
  });

  it('the shipped list is not empty', () => {
    const tree = JSON.parse(read('electron', 'ai-router', 'litellm-python-tree.json'));
    expect(Object.keys(tree.units).length).toBeGreaterThan(50);
    expect(tree.units['python/python.exe'].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verify-release local gates', () => {
  it('exits non-zero when the local build is missing', () => {
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'verify-release.mjs'), '0.0.0', '--local-only'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL .*not found/);
    expect(r.stdout).not.toMatch(/All checks passed/);
  });

  it('keeps --remote-only as the explicit way to skip them', () => {
    expect(read('scripts', 'verify-release.mjs')).toMatch(/args\.includes\('--remote-only'\)/);
  });
});

describe('build-llama-runtime', () => {
  it('escapes the SystemRoot fallback backslash', () => {
    expect(read('scripts', 'build-llama-runtime.mjs')).toContain("'C:\\\\Windows'");
  });

  it.skipIf(process.platform !== 'win32')('builds from source when the pinned url is a source archive and re-pins the manifest', () => {
    const pkg = path.join(tmp, 'pkg');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'llama-server.exe'), 'server');
    fs.writeFileSync(path.join(pkg, 'LICENSE'), 'MIT');
    const cache = path.join(tmp, 'cache');
    fs.mkdirSync(cache);
    const asset = 'llama-bX-bin.zip';
    const built = path.join(tmp, 'built.zip');
    const made = spawnSync('tar', ['-a', '-cf', built, '-C', pkg, '.']);
    if (made.status !== 0) return;
    const fake = path.join(tmp, 'fake-from-source.mjs');
    fs.writeFileSync(fake, [
      "import fs from 'node:fs'; import path from 'node:path';",
      `fs.copyFileSync(${JSON.stringify(built)}, path.join(process.env.ARK_LLAMA_CACHE_DIR, ${JSON.stringify(asset)}));`,
    ].join('\n'));
    const manifestPath = path.join(tmp, 'manifest.json');
    const shipped = JSON.parse(read('electron', 'local-ai', 'runtime-manifest.json'));
    shipped.runtime.build = 'bX';
    shipped.runtime.asset = asset;
    shipped.runtime.url = 'https://codeload.github.com/ggml-org/llama.cpp/zip/refs/tags/bX';
    shipped.runtime.sha256 = '0'.repeat(64);
    shipped.runtime.files = {};
    fs.writeFileSync(manifestPath, JSON.stringify(shipped));
    const env = {
      ...process.env,
      ARK_LLAMA_MANIFEST: manifestPath,
      ARK_LLAMA_CACHE_DIR: cache,
      ARK_LLAMA_OUT_DIR: path.join(tmp, 'out'),
      ARK_LLAMA_FROM_SOURCE_SCRIPT: fake,
    };
    const script = path.join(root, 'scripts', 'build-llama-runtime.mjs');

    const refused = spawnSync(process.execPath, [script, '--no-source-build'], { encoding: 'utf8', env });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/build-llama-from-source/);

    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(m.runtime.sha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(built)).digest('hex'));
    expect(Object.keys(m.runtime.files)).toEqual(['llama-server.exe']);
    expect(fs.existsSync(path.join(tmp, 'out', 'llama-server.exe'))).toBe(true);
  });
});

describe('NSIS uninstall include', () => {
  const nsh = read('build', 'installer.nsh');

  it('is wired in through nsis.include', () => {
    expect(JSON.parse(read('package.json')).build.nsis.include).toBe('build/installer.nsh');
  });

  it('asks before deleting, defaults to No, skips silent and update uninstalls, and only removes the models folder', () => {
    expect(nsh).toMatch(/!macro customUnInstall/);
    expect(nsh).toMatch(/\$\{ifNot\} \$\{isUpdated\}/);
    expect(nsh).toMatch(/IfSilent /);
    expect(nsh).toMatch(/MB_YESNO[^\n]*MB_DEFBUTTON2/);
    const removals = nsh.match(/^\s*(RMDir|Delete)\b.*$/gm) ?? [];
    expect(removals.map((l) => l.trim())).toEqual(['RMDir /r "$R8\\Ark\\models"']);
  });
});
