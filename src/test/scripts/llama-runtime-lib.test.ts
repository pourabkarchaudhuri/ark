/**
 * scripts/lib/llama-runtime.mjs: what ships in the installer (llama-server + DLLs, pinned by
 * sha256 in the manifest), and the release gates after-pack-check / verify-release use: runtime
 * folder present and matching, never a model file packaged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain .mjs helper without types
import * as lib from '../../../scripts/lib/llama-runtime.mjs';
// @ts-expect-error plain .mjs helper without types
import { checkPackagedLocalAi } from '../../../scripts/after-pack-check.mjs';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-rt-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function makeRuntimeDir(files: Record<string, string>, licence = 'LICENSE-llama.cpp.txt') {
  const root = path.join(dir, 'llama-runtime');
  fs.mkdirSync(root, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
  fs.writeFileSync(path.join(root, licence), 'MIT');
  const manifest = {
    runtime: {
      license: { file: licence },
      files: Object.fromEntries(Object.keys(files).map((n) => [n, lib.sha256File(path.join(root, n))])),
    },
  };
  return { root, manifest };
}

describe('isRuntimeFile / isModelFile', () => {
  it('keeps only llama-server.exe and DLLs from the release zip', () => {
    expect(lib.isRuntimeFile('llama-server.exe')).toBe(true);
    expect(lib.isRuntimeFile('ggml-vulkan.dll')).toBe(true);
    expect(lib.isRuntimeFile('LLAMA-SERVER.EXE')).toBe(true);
    for (const n of ['llama-cli.exe', 'llama-bench.exe', 'README.md', 'convert.py']) expect(lib.isRuntimeFile(n)).toBe(false);
  });
  it('recognises model weights', () => {
    for (const n of ['a.gguf', 'a.GGUF', 'a.gguf.part', 'm.safetensors']) expect(lib.isModelFile(n)).toBe(true);
    for (const n of ['a.dll', 'a.json']) expect(lib.isModelFile(n)).toBe(false);
  });
});

describe('checkRuntimeDir', () => {
  it('passes for a folder that matches the manifest', () => {
    const { root, manifest } = makeRuntimeDir({ 'llama-server.exe': 'exe', 'ggml.dll': 'dll' });
    expect(lib.checkRuntimeDir(root, manifest)).toEqual([]);
  });

  it('flags a changed file, a missing file, an extra file and a missing licence', () => {
    const { root, manifest } = makeRuntimeDir({ 'llama-server.exe': 'exe', 'ggml.dll': 'dll' });
    fs.writeFileSync(path.join(root, 'ggml.dll'), 'tampered');
    fs.rmSync(path.join(root, 'LICENSE-llama.cpp.txt'));
    fs.writeFileSync(path.join(root, 'extra.dll'), 'x');
    const problems = lib.checkRuntimeDir(root, manifest).join('\n');
    expect(problems).toMatch(/ggml.dll sha256/);
    expect(problems).toMatch(/unexpected file in the runtime folder: extra.dll/);
    expect(problems).toMatch(/licence file .* missing/);
    fs.rmSync(path.join(root, 'llama-server.exe'));
    expect(lib.checkRuntimeDir(root, manifest).join('\n')).toMatch(/missing llama-server.exe/);
  });

  it('flags a model file inside the runtime folder', () => {
    const { root, manifest } = makeRuntimeDir({ 'llama-server.exe': 'exe' });
    fs.writeFileSync(path.join(root, 'model.gguf'), 'weights');
    expect(lib.checkRuntimeDir(root, manifest).join('\n')).toMatch(/model file in the runtime folder: model.gguf/);
  });

  it('fails a manifest that lists no files (hashes not recorded yet) or no server', () => {
    const { root } = makeRuntimeDir({ 'llama-server.exe': 'exe' });
    expect(lib.checkRuntimeDir(root, { runtime: { files: {} } }).join('\n')).toMatch(/lists no files/);
    expect(lib.checkRuntimeDir(root, { runtime: { files: { 'a.dll': 'x' } } }).join('\n')).toMatch(/does not list llama-server.exe/);
  });

  it('reports a missing folder', () => {
    expect(lib.checkRuntimeDir(path.join(dir, 'nope'), { runtime: { files: {} } })[0]).toMatch(/runtime folder missing/);
  });
});

describe('checkPackagedRuntime (release gate)', () => {
  it('passes for resources/llama-runtime matching the manifest with no model anywhere', () => {
    const app = path.join(dir, 'win-unpacked');
    const res = path.join(app, 'resources');
    fs.mkdirSync(res, { recursive: true });
    const { root, manifest } = makeRuntimeDir({ 'llama-server.exe': 'exe' });
    fs.cpSync(root, path.join(res, 'llama-runtime'), { recursive: true });
    expect(lib.checkPackagedRuntime(app, manifest)).toEqual([]);
  });

  it('fails when the runtime folder is absent', () => {
    const app = path.join(dir, 'win-unpacked');
    fs.mkdirSync(app, { recursive: true });
    const problems = lib.checkPackagedRuntime(app, { runtime: { files: { 'llama-server.exe': 'x' } } });
    expect(problems.join('\n')).toMatch(/llama-runtime: runtime folder missing/);
  });

  it('fails when a model file was packaged anywhere in the app', () => {
    const app = path.join(dir, 'win-unpacked');
    const { root, manifest } = makeRuntimeDir({ 'llama-server.exe': 'exe' });
    fs.mkdirSync(path.join(app, 'resources', 'models'), { recursive: true });
    fs.cpSync(root, path.join(app, 'resources', 'llama-runtime'), { recursive: true });
    fs.writeFileSync(path.join(app, 'resources', 'models', 'oops.gguf'), 'weights');
    expect(lib.checkPackagedRuntime(app, manifest).join('\n')).toMatch(/model files packaged: .*oops\.gguf/);
  });

  it('findModelFiles walks nested folders', () => {
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'b', 'x.gguf'), '1');
    fs.writeFileSync(path.join(dir, 'a', 'y.txt'), '1');
    expect(lib.findModelFiles(dir)).toEqual([path.join('a', 'b', 'x.gguf')]);
  });
});

describe('the shipped manifest as the release gate sees it', () => {
  it('exposes the after-pack check against the real manifest (fails until hashes are recorded for a missing folder)', () => {
    const empty = path.join(dir, 'app');
    fs.mkdirSync(empty, { recursive: true });
    const problems = checkPackagedLocalAi(empty) as string[];
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(/llama-runtime/);
  });
});
