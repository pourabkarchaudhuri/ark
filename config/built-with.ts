/**
 * Build-time versions for the About page (1.0.97 B37): the installed version of every package
 * listed in `src/lib/built-with-packages.ts`, plus the pinned LiteLLM and llama.cpp builds from
 * their manifests. Used by vite.config.ts and vitest.config.ts as the `__BUILT_WITH__` define.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BUILT_WITH_PACKAGES } from '../src/lib/built-with-packages.js';

function readJson(file: string): any {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

export function readBuiltWithVersions(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { pkg } of BUILT_WITH_PACKAGES) {
    if (pkg === 'litellm') {
      const v = readJson(path.join(root, 'electron/ai-router/litellm-manifest.json'))?.litellm?.version;
      if (typeof v === 'string') out[pkg] = v;
    } else if (pkg === 'llama.cpp') {
      const v = readJson(path.join(root, 'electron/local-ai/runtime-manifest.json'))?.runtime?.build;
      if (typeof v === 'string') out[pkg] = v;
    } else {
      const v = readJson(path.join(root, 'node_modules', ...pkg.split('/'), 'package.json'))?.version;
      if (typeof v === 'string') out[pkg] = v;
    }
  }
  return out;
}
