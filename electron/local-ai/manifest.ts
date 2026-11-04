/**
 * Built-in local AI manifest (1.0.97 B36).
 *
 * `runtime-manifest.json` pins the llama.cpp release that ships in the installer (build tag, zip
 * sha256, per-file sha256 checked by scripts/build-llama-runtime.mjs and verify-release.mjs) and
 * every model Ark downloads at runtime. Each model lists its sources in download order: an Ollama
 * registry blob and/or a Hugging Face file pinned to a commit. Every source carries its own sha256
 * and size (a file is only used after its hash matched) and a `verifiedWith` stamp: the llama.cpp
 * build it was actually loaded with and how far that check went. Only sources that load in the
 * bundled llama-server are listed: Ollama's own-engine blobs often do not (arctic-embed2 fails to
 * load, the Qwen3 reranker blob loads but answers garbage), so those models list Hugging Face only.
 * validateManifest rejects a source whose stamp is for another build, so a runtime bump forces a
 * re-verification of every model.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** One llama-server per role. `rerank-qwen` is the Qwen3 fallback reranker (completion mode). */
export type LocalAiRole = 'embed' | 'rerank' | 'rerank-qwen' | 'chat';

export const LOCAL_AI_ROLES: readonly LocalAiRole[] = ['embed', 'rerank', 'rerank-qwen', 'chat'];

/** `inference`: real embeddings / rerank scores were produced and sane. `metadata`: GGUF header and tensor table loaded only. */
export type SourceCheck = 'inference' | 'metadata';

export interface ModelSource {
  kind: 'ollama' | 'huggingface';
  url: string;
  /** Lower-case hex. */
  sha256: string;
  size: number;
  /** The runtime build this exact file was loaded with, and how thoroughly. */
  verifiedWith: { build: string; check: SourceCheck };
}

export interface ModelEntry {
  id: string;
  role: LocalAiRole;
  label: string;
  /** File name inside the models folder. */
  file: string;
  /** Downloaded automatically (Oracle models). The chat model only on request. */
  auto: boolean;
  sources: ModelSource[];
}

export interface RuntimeManifest {
  schema: number;
  runtime: {
    build: string;
    asset: string;
    url: string;
    sha256: string;
    size: number;
    license: { file: string; url: string };
    files: Record<string, string>;
  };
  models: ModelEntry[];
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Problems with a manifest object; empty when it is usable. Exported for tests. */
export function validateManifest(m: unknown): string[] {
  const problems: string[] = [];
  const man = m as Partial<RuntimeManifest> | null;
  if (!man || typeof man !== 'object') return ['manifest is not an object'];
  if (man.schema !== 1) problems.push(`unsupported schema ${String(man.schema)}`);
  const rt = man.runtime;
  if (!rt || typeof rt.build !== 'string' || !/^b\d+$/.test(rt.build)) problems.push('runtime.build must be a bNNNN tag');
  if (!rt || !HEX64.test(String(rt.sha256))) problems.push('runtime.sha256 must be 64 hex chars');
  // A release asset, or the tagged source archive when the runtime is built from source (see runtime.note).
  const urlOk = (u: string) =>
    u.startsWith('https://github.com/ggml-org/llama.cpp/releases/download/') ||
    u.startsWith('https://codeload.github.com/ggml-org/llama.cpp/zip/refs/tags/');
  if (rt && !urlOk(String(rt.url))) {
    problems.push('runtime.url must point at a ggml-org/llama.cpp release');
  }
  for (const [name, hash] of Object.entries(rt?.files ?? {})) {
    if (!HEX64.test(String(hash))) problems.push(`runtime.files.${name} is not a sha256`);
  }
  const ids = new Set<string>();
  const roles = new Set<string>();
  for (const model of man.models ?? []) {
    if (!model?.id || ids.has(model.id)) problems.push(`duplicate or missing model id ${String(model?.id)}`);
    ids.add(model?.id);
    if (!LOCAL_AI_ROLES.includes(model?.role)) problems.push(`${model?.id}: unknown role ${String(model?.role)}`);
    if (roles.has(model?.role)) problems.push(`${model?.id}: role ${model?.role} listed twice`);
    roles.add(model?.role);
    if (!/^[\w.-]+\.gguf$/.test(String(model?.file))) problems.push(`${model?.id}: file must be a plain .gguf name`);
    if (!Array.isArray(model?.sources) || model.sources.length === 0) problems.push(`${model?.id}: no sources`);
    for (const src of model?.sources ?? []) {
      const vw = src?.verifiedWith;
      if (!vw || vw.build !== rt?.build) {
        problems.push(`${model.id}: source ${String(src?.kind)} was not verified with runtime ${String(rt?.build)}`);
      } else if (vw.check !== 'inference' && vw.check !== 'metadata') {
        problems.push(`${model.id}: source ${String(src?.kind)} has an unknown check ${String(vw.check)}`);
      } else if (vw.check !== 'inference' && model.role !== 'chat') {
        problems.push(`${model.id}: ${model.role} sources must be verified by inference, not only by metadata`);
      }
      if (!HEX64.test(String(src?.sha256))) problems.push(`${model.id}: source sha256 invalid`);
      if (!(Number.isSafeInteger(src?.size) && src.size > 0)) problems.push(`${model.id}: source size invalid`);
      if (!/^https:\/\/(registry\.ollama\.ai|huggingface\.co)\//.test(String(src?.url))) {
        problems.push(`${model.id}: source host not allowed (${String(src?.url)})`);
      }
    }
  }
  for (const role of ['embed', 'rerank', 'chat'] as const) {
    if (!roles.has(role)) problems.push(`no model for role ${role}`);
  }
  return problems;
}

let _manifest: RuntimeManifest | null = null;

export function getManifest(): RuntimeManifest {
  if (_manifest) return _manifest;
  const loaded = require('./runtime-manifest.json') as RuntimeManifest;
  const problems = validateManifest(loaded);
  if (problems.length) throw new Error(`runtime-manifest.json is invalid: ${problems.join('; ')}`);
  _manifest = loaded;
  return _manifest;
}

/** Test seam: replace (or with null, reload) the manifest. */
export function __setManifestForTests(m: RuntimeManifest | null): void {
  _manifest = m;
}

export function getModelForRole(role: LocalAiRole): ModelEntry | undefined {
  return getManifest().models.find((m) => m.role === role);
}

export function getAutoModels(): ModelEntry[] {
  return getManifest().models.filter((m) => m.auto);
}
