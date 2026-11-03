/**
 * Vector parity gate (1.0.97 B36): the built-in llama.cpp runtime must embed the fixed game texts
 * into the same vector space as Ollama (cosine >= 0.999 per row), otherwise every cached embedding
 * would need re-computing and EMBEDDING_MODEL_VERSION must be bumped.
 *
 * Ollama's output is recorded once by `node scripts/record-embedding-parity.mjs` into
 * src/test/fixtures/embedding-parity.json. The comparison itself needs the real runtime
 * (build/llama-runtime/llama-server.exe) and the embedding GGUF on disk (the default models
 * folder, or ARK_PARITY_MODEL); without the fixture, the runtime or the model it is skipped.
 * The cosine helper and the fixture's shape are always checked.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
vi.mock('../../../electron/settings-store.js', () => ({ settingsStore: {} }));
vi.mock('../../../electron/safe-logger.js', () => ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { LlamaRuntime } from '../../../electron/local-ai/llama-runtime';
import { BuiltinBackend } from '../../../electron/local-ai/builtin-backend';
import { getModelForRole } from '../../../electron/local-ai/manifest';
import { defaultModelsDir } from '../../../electron/local-ai/service';
import type { ModelStore } from '../../../electron/local-ai/model-store';
// @ts-expect-error plain .mjs without types
import { PARITY_TEXTS } from '../../../scripts/record-embedding-parity.mjs';

const root = path.resolve(__dirname, '../../..');
const fixturePath = path.join(root, 'src', 'test', 'fixtures', 'embedding-parity.json');
const runtimeDir = path.join(root, 'build', 'llama-runtime');
const modelPath = process.env.ARK_PARITY_MODEL
  ?? path.join(defaultModelsDir(), getModelForRole('embed')!.file);

export function cosine(a: number[], b: number[]): number {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const fixture = fs.existsSync(fixturePath)
  ? JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as { texts: string[]; ollama: number[][] }
  : null;
const canRun = !!fixture && fs.existsSync(path.join(runtimeDir, 'llama-server.exe')) && fs.existsSync(modelPath);

describe('parity tooling', () => {
  it('cosine of identical and orthogonal vectors', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('the fixed text set is non-trivial and multilingual', () => {
    expect(PARITY_TEXTS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(PARITY_TEXTS).size).toBe(PARITY_TEXTS.length);
    expect(PARITY_TEXTS.some((t: string) => /[^\x00-\x7f]/.test(t))).toBe(true);
  });

  it.skipIf(!fixture)('the recorded fixture matches the text set and the model dimension', () => {
    expect(fixture!.texts).toEqual(PARITY_TEXTS);
    expect(fixture!.ollama).toHaveLength(PARITY_TEXTS.length);
    for (const row of fixture!.ollama) expect(row).toHaveLength(1024);
  });
});

// jsdom's AbortController is not accepted by Node's fetch; the real runtime does not need the abort here.
const nodeFetch = (u: string, init?: RequestInit) => fetch(u, { ...init, signal: undefined });

describe.skipIf(!canRun)('built-in runtime vs Ollama (needs the fixture, llama-server and the embedding model)', () => {
  it('every row has cosine >= 0.999', async () => {
    const runtime = new LlamaRuntime({
      runtimeDir: () => runtimeDir,
      modelPath: () => modelPath,
      fetchFn: nodeFetch as never,
      startTimeoutMs: { embed: 180_000 },
    });
    const backend = new BuiltinBackend({ runtime, store: {} as ModelStore, runtimeBuild: 'parity', fetchFn: nodeFetch as never });
    try {
      const out = await backend.embed(fixture!.texts);
      expect(out.error).toBeNull();
      const low: string[] = [];
      out.embeddings.forEach((vec, i) => {
        expect(vec).not.toBeNull();
        const c = cosine(vec as number[], fixture!.ollama[i]!);
        if (c < 0.999) low.push(`row ${i}: ${c.toFixed(5)}`);
      });
      // A failure here means: bump EMBEDDING_MODEL_VERSION and review the Oracle golden test.
      expect(low).toEqual([]);
    } finally {
      runtime.stopAllSync();
    }
  }, 240_000);
});
