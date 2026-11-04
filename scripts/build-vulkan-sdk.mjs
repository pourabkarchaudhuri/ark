/**
 * Build the minimal Vulkan SDK pieces llama.cpp's ggml-vulkan needs, from the official Khronos/Google sources,
 * for networks that block the LunarG SDK download. Output: .llama-cache/vulkan-sdk
 *   Include/vulkan/*, Include/vk_video/*   (Vulkan-Headers)
 *   Lib/vulkan-1.lib                        (Vulkan-Loader import library only; vulkan-1.dll is never shipped, it comes from the GPU driver)
 *   Bin/glslc.exe                           (shaderc, with its DEPS-pinned glslang / spirv-tools / spirv-headers)
 *
 * Needs: Visual Studio Build Tools 2022, git, python, cmake + ninja on PATH. Repeatable: skips finished steps.
 * Then: node scripts/build-llama-from-source.mjs   (uses this SDK automatically when present)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pinned official sources (tag -> commit recorded for audit).
export const VULKAN_SDK_PINS = {
  headers: { repo: 'https://github.com/KhronosGroup/Vulkan-Headers.git', tag: 'vulkan-sdk-1.4.357.0', commit: 'e3b1eec08173d6b825cd3ac88c885a63b621504a' },
  loader: { repo: 'https://github.com/KhronosGroup/Vulkan-Loader.git', tag: 'vulkan-sdk-1.4.357.0', commit: '5f157b62e333c63260d05d81bf66faa216ab0fb8' },
  shaderc: { repo: 'https://github.com/google/shaderc.git', tag: 'v2026.3', commit: '2c8cae778eec0283b44acbe7ed1a386865d78799' },
};

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.llama-cache');
const sdk = path.join(cache, 'vulkan-sdk');
const work = path.join(cache, 'vulkan-build');
const vcvars = process.env.VCVARS64 || 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat';
const cl = '-DCMAKE_C_COMPILER=cl -DCMAKE_CXX_COMPILER=cl -DCMAKE_BUILD_TYPE=Release';

function sh(cmd, cwd) {
  execSync(`cmd /c "call "${vcvars}" >nul && ${cmd}"`, { stdio: 'inherit', cwd });
}
function clone(name, pin) {
  const dir = path.join(work, name);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    sh(`git clone --branch ${pin.tag} --depth 1 ${pin.repo} "${dir}"`);
  }
  const head = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
  if (head !== pin.commit) throw new Error(`${name}: ${pin.tag} resolved to ${head}, expected ${pin.commit}`);
  return dir;
}

if (!fs.existsSync(path.join(sdk, 'Include', 'vulkan', 'vulkan.h'))) {
  fs.mkdirSync(work, { recursive: true });
  const h = clone('Vulkan-Headers', VULKAN_SDK_PINS.headers);
  sh(`cmake -S "${h}" -B "${h}\\build" -G Ninja ${cl} -DCMAKE_INSTALL_PREFIX="${path.join(work, 'headers-install')}" && cmake --install "${h}\\build"`);
  fs.cpSync(path.join(work, 'headers-install', 'include'), path.join(sdk, 'Include'), { recursive: true });
}
if (!fs.existsSync(path.join(sdk, 'Lib', 'vulkan-1.lib'))) {
  const l = clone('Vulkan-Loader', VULKAN_SDK_PINS.loader);
  sh(`cmake -S "${l}" -B "${l}\\build" -G Ninja ${cl} -DBUILD_TESTS=OFF -DUPDATE_DEPS=OFF -DVULKAN_HEADERS_INSTALL_DIR="${path.join(work, 'headers-install')}" && cmake --build "${l}\\build" --target vulkan -j 8`);
  const lib = fs.readdirSync(path.join(l, 'build'), { recursive: true }).find((p) => /(^|[\\/])vulkan-1\.lib$/.test(String(p)));
  if (!lib) throw new Error('vulkan-1.lib was not produced');
  fs.mkdirSync(path.join(sdk, 'Lib'), { recursive: true });
  fs.copyFileSync(path.join(l, 'build', String(lib)), path.join(sdk, 'Lib', 'vulkan-1.lib'));
}
if (!fs.existsSync(path.join(sdk, 'Bin', 'glslc.exe'))) {
  const s = clone('shaderc', VULKAN_SDK_PINS.shaderc);
  sh('python utils\\git-sync-deps', s); // fetches glslang / spirv-tools / spirv-headers at the revisions in shaderc's DEPS
  sh(`cmake -S "${s}" -B "${s}\\build" -G Ninja ${cl} -DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON -DSHADERC_SKIP_COPYRIGHT_CHECK=ON -DSHADERC_ENABLE_SHARED_CRT=ON && cmake --build "${s}\\build" --target glslc_exe -j 8`);
  fs.mkdirSync(path.join(sdk, 'Bin'), { recursive: true });
  fs.copyFileSync(path.join(s, 'build', 'glslc', 'glslc.exe'), path.join(sdk, 'Bin', 'glslc.exe'));
}
// SPIRV-Headers (the revision shaderc's DEPS pins) as a CMake package: ggml-vulkan does find_package(SPIRV-Headers CONFIG)
if (!fs.existsSync(path.join(sdk, 'share', 'cmake', 'SPIRV-Headers'))) {
  const sh2 = path.join(work, 'shaderc', 'third_party', 'spirv-headers');
  sh(`cmake -S "${sh2}" -B "${sh2}\\build" -G Ninja ${cl} -DCMAKE_INSTALL_PREFIX="${sdk}" && cmake --install "${sh2}\\build"`);
}
console.log(`[vulkan-sdk] ready at ${sdk}`);
