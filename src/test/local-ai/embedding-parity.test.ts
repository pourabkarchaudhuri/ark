/**
 * Vector parity gate (1.0.97 B36): the built-in llama.cpp runtime (Hugging Face arctic-embed2 GGUF,
 * the only one stock llama.cpp loads) against Ollama's snowflake-arctic-embed2 on 34 fixed texts.
 *
 * Measured result, recorded in src/test/fixtures/embedding-parity.json by
 * `node scripts/record-embedding-parity.mjs --llama-url=...`: plain game descriptions agree at
 * cosine >= 0.99994, GPU vs CPU at >= 0.99994, but texts with curly quotes, trade marks, full-width
 * punctuation or tabs/newlines differ (min 0.966): Ollama's tokenizer skips the sentencepiece
 * precompiled_charsmap that llama.cpp applies. The vector space is therefore NOT identical and
 * EMBEDDING_MODEL_VERSION was bumped to 2 (every cached vector is re-embedded once on first launch).
 *
 * Always run: fixture shape, the offline Ollama-vs-builtin comparison from the recorded vectors,
 * and the guard that the model version was bumped. Run only with the real runtime
 * (build/llama-runtime/llama-server.exe) and an embedding GGUF on disk (the models folder,
 * ARK_PARITY_MODEL, or .llama-cache/real/hf-embed.gguf): a live embed must reproduce the recorded
 * builtin vectors (cosine >= 0.999 per row, covers GPU and CPU) and stay within the same envelope
 * against Ollama.
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
import { EMBEDDING_MODEL_VERSION } from '../../services/embedding-layout';
// @ts-expect-error plain .mjs without types
import { PARITY_TEXTS } from '../../../scripts/record-embedding-parity.mjs';

const root = path.resolve(__dirname, '../../..');
const fixturePath = path.join(root, 'src', 'test', 'fixtures', 'embedding-parity.json');
const runtimeDir = path.join(root, 'build', 'llama-runtime');
const modelPath = [
  process.env.ARK_PARITY_MODEL,
  path.join(defaultModelsDir(), getModelForRole('embed')!.file),
  path.join(root, '.llama-cache', 'real', 'hf-embed.gguf'),
].find((p) => !!p && fs.existsSync(p)) ?? '';

/** Characters llama.cpp normalises through the sentencepiece charsmap but Ollama's tokenizer leaves alone. */
const CHARSMAP_SENSITIVE = /[\u2018\u2019\u201c\u201d\u2014\u2026\u2122\u00ae\uff00-\uffef\t\r\n]/;
/** Rows listed as divergent must stay this close to Ollama (same meaning, different token ids). */
const DIVERGENT_FLOOR = 0.95;

export function cosine(a: number[], b: number[]): number {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const fixture = fs.existsSync(fixturePath)
  ? JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as { texts: string[]; ollama: number[][]; builtin?: number[][]; divergent?: number[] }
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
    expect(fixture!.builtin).toHaveLength(PARITY_TEXTS.length);
    for (const row of [...fixture!.ollama, ...fixture!.builtin!]) expect(row).toHaveLength(1024);
  });

  it.skipIf(!fixture)('recorded Ollama vs built-in: identical space on plain text, known divergence elsewhere', () => {
    const cos = fixture!.builtin!.map((v, i) => cosine(v, fixture!.ollama[i]!));
    const divergent = cos.flatMap((c, i) => (c < 0.999 ? [i] : []));
    expect(divergent).toEqual(fixture!.divergent);
    expect(divergent.length).toBeGreaterThan(0);
    // Every plain row is the same vector (tolerance for f16 / different kernels).
    cos.forEach((c, i) => { if (!divergent.includes(i)) expect(c, `row ${i}`).toBeGreaterThanOrEqual(0.9999); });
    // The divergence has one cause: characters the charsmap rewrites. Still the same meaning.
    for (const i of divergent) {
      expect(fixture!.texts[i]).toMatch(CHARSMAP_SENSITIVE);
      expect(cos[i]!, `row ${i}`).toBeGreaterThanOrEqual(DIVERGENT_FLOOR);
    }
    expect(Math.min(...cos)).toBeGreaterThanOrEqual(DIVERGENT_FLOOR);
  });

  it('the embedding model version was bumped because the vector space changed', () => {
    expect(EMBEDDING_MODEL_VERSION).toBeGreaterThanOrEqual(2);
  });
});

// jsdom's AbortController is not accepted by Node's fetch; the real runtime does not need the abort here.
const nodeFetch = (u: string, init?: RequestInit) => fetch(u, { ...init, signal: undefined });

describe.skipIf(!canRun)('built-in runtime (needs the fixture, llama-server and the embedding GGUF)', () => {
  it('reproduces the recorded vectors and stays within the recorded envelope against Ollama', async () => {
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
      const drift: string[] = [];
      const offEnvelope: string[] = [];
      out.embeddings.forEach((vec, i) => {
        expect(vec).not.toBeNull();
        const own = cosine(vec as number[], fixture!.builtin![i]!);
        if (own < 0.999) drift.push(`row ${i}: ${own.toFixed(5)}`);
        const ol = cosine(vec as number[], fixture!.ollama[i]!);
        const plain = !(fixture!.divergent ?? []).includes(i);
        if (ol < (plain ? 0.9999 : DIVERGENT_FLOOR)) offEnvelope.push(`row ${i}: ${ol.toFixed(5)}`);
      });
      // A failure here means the model, the runtime build or the launch flags changed the vector space:
      // re-record the fixture, bump EMBEDDING_MODEL_VERSION and review the Oracle golden test.
      expect(drift).toEqual([]);
      expect(offEnvelope).toEqual([]);
    } finally {
      runtime.stopAllSync();
    }
  }, 240_000);
});
