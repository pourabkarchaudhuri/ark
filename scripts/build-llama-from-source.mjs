/**
 * Build the pinned llama.cpp (runtime-manifest.json runtime.build) from the official source tag with MSVC
 * and write .llama-cache/<runtime.asset>, for networks that block GitHub release-asset downloads.
 * Then: node scripts/build-llama-runtime.mjs --update-manifest
 *
 * Needs: Visual Studio Build Tools 2022, cmake + ninja on PATH (pip install cmake ninja). CPU backends only
 * (runtime-selected AVX/AVX2/AVX512 variants); the release's Vulkan build needs the Vulkan SDK.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rt = JSON.parse(fs.readFileSync(path.join(root, 'electron', 'local-ai', 'runtime-manifest.json'), 'utf8')).runtime;
const work = path.join(root, '.llama-cache', `src-${rt.build}`);
const vcvars = process.env.VCVARS64 || 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat';
const srcZip = path.join(root, '.llama-cache', `src-${rt.build}.zip`);
const tar = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe');

fs.mkdirSync(work, { recursive: true });
if (!fs.existsSync(srcZip)) {
  const res = await fetch(`https://codeload.github.com/ggml-org/llama.cpp/zip/refs/tags/${rt.build}`);
  if (!res.ok) throw new Error(`source download failed: HTTP ${res.status}`);
  fs.writeFileSync(srcZip, Buffer.from(await res.arrayBuffer()));
}
execSync(`"${tar}" -xf "${srcZip}" -C "${work}"`, { stdio: 'inherit' });
const src = path.join(work, `llama.cpp-${rt.build}`);
const flags = '-DCMAKE_C_COMPILER=cl -DCMAKE_CXX_COMPILER=cl -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=ON -DGGML_NATIVE=OFF -DGGML_CPU_ALL_VARIANTS=ON -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_OPENSSL=OFF';
execSync(`cmd /c "call "${vcvars}" && cd /d "${src}" && cmake -B build -G Ninja ${flags} && cmake --build build --target llama-server -j 8"`, { stdio: 'inherit' });

const bin = path.join(src, 'build', 'bin');
const files = fs.readdirSync(bin).filter((n) => n === 'llama-server.exe' || n.endsWith('.dll'));
const stage = path.join(work, 'stage');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const n of files) fs.copyFileSync(path.join(bin, n), path.join(stage, n));
fs.copyFileSync(path.join(src, 'LICENSE'), path.join(stage, 'LICENSE'));
const out = path.join(root, '.llama-cache', rt.asset);
fs.rmSync(out, { force: true });
execSync(`"${tar}" -a -cf "${out}" -C "${stage}" .`, { stdio: 'inherit' });
console.log(`[llama-from-source] wrote ${out}; now run: node scripts/build-llama-runtime.mjs --update-manifest`);
