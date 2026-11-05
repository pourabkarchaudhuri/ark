/**
 * Built-in local AI backend (1.0.97 B36): embeddings, reranking, Qwen3 scoring and the chat
 * endpoint, served by Ark's own llama-server processes (see llama-runtime.ts). The Ollama-protocol
 * code in ollama-setup.ts / rerank-engine.ts / ollama-handlers.ts stays as the "use my own
 * Ollama" implementation; each of those entry points asks `backend.ts` which one is active and
 * calls this class when it is the built-in one.
 *
 * Wire formats (llama-server, OpenAI-compatible):
 *  - embeddings: POST /v1/embeddings  { input: string[] } -> { data: [{ index, embedding }] }
 *    (L2-normalised, like Ollama's /api/embed, so cached vectors stay comparable)
 *  - rerank:     POST /v1/rerank      { query, documents } -> { results: [{ index, relevance_score }] }
 *  - Qwen3:      POST /completion     { prompt, n_predict: 1, n_probs } -> content + top_logprobs
 */
import type { LlamaRuntime, ServerInfo, LaunchOptions } from './llama-runtime.js';
import { RuntimeError } from './llama-runtime.js';
import type { ModelStore } from './model-store.js';
import type { LocalAiRole } from './manifest.js';
import { getModelForRole } from './manifest.js';

export interface BuiltinEmbedOptions {
  numThread?: number;
  numBatch?: number;
}

export interface BuiltinEmbedError {
  kind: 'timeout' | 'network' | 'http' | 'parse' | 'empty';
  status?: number;
  message: string;
}

export interface BuiltinRerankRow {
  index: number;
  relevance_score: number;
}

export interface BuiltinRerankOutcome {
  /** Raw rows as the server sent them (the caller normalises). */
  rows: Array<{ index?: number; relevance_score?: number; score?: number }> | null;
  /** 'ok' | 'model_missing' | 'http_error' | 'network_error' | 'timeout' | 'cancelled' */
  code: string;
  message: string;
  httpStatus?: number;
}

/** Same shape rerank-engine reads from Ollama's /api/generate. */
export interface BuiltinGenerateResponse {
  response?: string;
  logprobs?: Array<{ top_logprobs?: Array<{ token?: string; logprob?: number }> }>;
}

export interface BuiltinGpuReading {
  loaded: boolean;
  sizeBytes: number;
  vramBytes: number;
}

export interface BuiltinBackendDeps {
  runtime: LlamaRuntime;
  store: ModelStore;
  /** llama.cpp build tag, shown as the "version". */
  runtimeBuild: string;
  fetchFn?: typeof fetch;
}

const EMBED_BASE_TIMEOUT_MS = 120_000;
const EMBED_PER_TEXT_TIMEOUT_MS = 4_000;
const RERANK_DEFAULT_TIMEOUT_MS = 90_000;
const QWEN_DOC_TIMEOUT_MS = 30_000;
const QWEN_TOP_PROBS = 20;

export class BuiltinBackend {
  readonly kind = 'builtin' as const;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: BuiltinBackendDeps) {
    this.fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
  }

  get runtime(): LlamaRuntime { return this.deps.runtime; }
  get store(): ModelStore { return this.deps.store; }

  /** "Running" for the built-in runtime means: the packaged servers are there to start on demand. */
  health(): { running: boolean; version: string | null } {
    return this.deps.runtime.isRuntimeAvailable()
      ? { running: true, version: this.deps.runtimeBuild }
      : { running: false, version: null };
  }

  isModelReady(role: LocalAiRole): boolean {
    return this.deps.store.isReady(role);
  }

  private async post(
    server: ServerInfo,
    path: string,
    body: unknown,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ status: number; text: string }> {
    // One controller for both deadlines (our timeout and the caller's cancel), so the failure
    // reason can be told apart: TimeoutError for the deadline, AbortError for a cancel.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), opts.timeoutMs);
    const onCancel = () => ac.abort();
    if (opts.signal?.aborted) ac.abort();
    else opts.signal?.addEventListener('abort', onCancel, { once: true });
    try {
      const res = await this.fetchFn(`${server.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.apiKey}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      if (ac.signal.aborted && (ac.signal.reason as { name?: string } | undefined)?.name === 'TimeoutError') {
        throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      }
      throw err;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onCancel);
    }
  }

  private static errorMessage(text: string, status: number): string {
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string };
      const e = parsed.error;
      const msg = typeof e === 'string' ? e : e?.message;
      if (msg) return msg;
    } catch { /* not JSON */ }
    return text.slice(0, 300) || `HTTP ${status}`;
  }

  /** Start the server for `role`, mapping start problems to the caller's error shape. */
  private async server(role: LocalAiRole, launch?: LaunchOptions): Promise<ServerInfo> {
    return this.deps.runtime.ensure(role, launch);
  }

  // ── Embeddings ──────────────────────────────────────────────────────────────

  async embed(
    texts: string[],
    opts: BuiltinEmbedOptions = {},
  ): Promise<{ embeddings: (number[] | null)[]; error: BuiltinEmbedError | null }> {
    const nulls = () => texts.map(() => null);
    if (texts.length === 0) return { embeddings: [], error: null };
    let server: ServerInfo;
    try {
      server = await this.server('embed', { numBatch: opts.numBatch, numThread: opts.numThread });
    } catch (err) {
      return { embeddings: nulls(), error: { kind: 'network', message: err instanceof Error ? err.message : String(err) } };
    }
    const timeoutMs = EMBED_BASE_TIMEOUT_MS + texts.length * EMBED_PER_TEXT_TIMEOUT_MS;
    try {
      const { status, text } = await this.post(server, '/v1/embeddings', { input: texts, encoding_format: 'float' }, { timeoutMs });
      this.deps.runtime.markUsed('embed');
      if (status >= 400) {
        return { embeddings: nulls(), error: { kind: 'http', status, message: BuiltinBackend.errorMessage(text, status) } };
      }
      let parsed: { data?: Array<{ index?: number; embedding?: number[] }> } | null = null;
      try { parsed = JSON.parse(text) as typeof parsed; } catch { parsed = null; }
      if (!parsed) return { embeddings: nulls(), error: { kind: 'parse', status, message: 'Unparseable /v1/embeddings response' } };
      const data = parsed.data ?? [];
      if (data.length === 0) return { embeddings: nulls(), error: { kind: 'empty', status, message: 'No embeddings in the response' } };
      const out: (number[] | null)[] = nulls();
      data.forEach((row, i) => {
        const at = typeof row.index === 'number' ? row.index : i;
        if (at >= 0 && at < out.length && Array.isArray(row.embedding)) out[at] = row.embedding;
      });
      return { embeddings: out, error: null };
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { embeddings: nulls(), error: { kind: 'timeout', message: `No response within ${Math.round(timeoutMs / 1000)}s` } };
      }
      return { embeddings: nulls(), error: { kind: 'network', message: err instanceof Error ? err.message : String(err) } };
    }
  }

  // ── Reranking ───────────────────────────────────────────────────────────────

  /** Cross-encoder rerank (bge-reranker-v2-m3). */
  async rerank(
    query: string,
    documents: string[],
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<BuiltinRerankOutcome> {
    if (opts?.signal?.aborted) return { rows: null, code: 'cancelled', message: 'Cancelled by the renderer' };
    let server: ServerInfo;
    try {
      server = await this.server('rerank');
    } catch (err) {
      const code = err instanceof RuntimeError && err.code === 'no_model' ? 'model_missing' : 'network_error';
      return { rows: null, code, message: err instanceof Error ? err.message : String(err) };
    }
    try {
      const { status, text } = await this.post(server, '/v1/rerank', { query, documents, top_n: documents.length }, {
        timeoutMs: opts?.timeoutMs ?? RERANK_DEFAULT_TIMEOUT_MS,
        signal: opts?.signal,
      });
      this.deps.runtime.markUsed('rerank');
      if (status >= 400) {
        return { rows: null, code: 'http_error', message: `Rerank HTTP ${status}: ${BuiltinBackend.errorMessage(text, status)}`, httpStatus: status };
      }
      const parsed = JSON.parse(text) as { results?: BuiltinRerankOutcome['rows'] };
      return { rows: parsed.results ?? [], code: 'ok', message: 'ok', httpStatus: status };
    } catch (err) {
      if (opts?.signal?.aborted) return { rows: null, code: 'cancelled', message: 'Cancelled by the renderer' };
      const name = (err as { name?: string } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') return { rows: null, code: 'timeout', message: 'Rerank exceeded its time budget' };
      return { rows: null, code: 'network_error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** One yes/no completion for the Qwen3 reranker; null when the call failed. */
  async generateScore(prompt: string, graded: boolean): Promise<BuiltinGenerateResponse | null> {
    let server: ServerInfo;
    try {
      server = await this.server('rerank-qwen');
    } catch {
      return null;
    }
    const body: Record<string, unknown> = {
      prompt, n_predict: 1, temperature: 0, stream: false, cache_prompt: true,
    };
    if (graded) body.n_probs = QWEN_TOP_PROBS;
    try {
      const { status, text } = await this.post(server, '/completion', body, { timeoutMs: QWEN_DOC_TIMEOUT_MS });
      this.deps.runtime.markUsed('rerank-qwen');
      if (status >= 400) return null;
      return BuiltinBackend.toGenerateResponse(JSON.parse(text));
    } catch {
      return null;
    }
  }

  /** Map llama-server's /completion reply (both the current and the older probability shape). */
  static toGenerateResponse(raw: unknown): BuiltinGenerateResponse {
    const r = raw as {
      content?: string;
      completion_probabilities?: Array<{
        top_logprobs?: Array<{ token?: string; logprob?: number }>;
        probs?: Array<{ tok_str?: string; prob?: number }>;
      }>;
    } | null;
    const first = r?.completion_probabilities?.[0];
    let top: Array<{ token?: string; logprob?: number }> | undefined = first?.top_logprobs;
    if (!top && Array.isArray(first?.probs)) {
      top = first.probs.map((p) => ({
        token: p.tok_str,
        logprob: typeof p.prob === 'number' && p.prob > 0 ? Math.log(p.prob) : -Infinity,
      }));
    }
    return { response: r?.content ?? '', ...(top?.length ? { logprobs: [{ top_logprobs: top }] } : {}) };
  }

  // ── GPU, model info, unload ─────────────────────────────────────────────────

  /** What the running embed server loaded, from its own log. `loaded` is false until it started. */
  gpuReading(): BuiltinGpuReading {
    const st = this.deps.runtime.roleStatus('embed');
    if (st.state !== 'ready' || !st.gpu) return { loaded: false, sizeBytes: 0, vramBytes: 0 };
    // llama-server keeps the token-embedding table in a CPU-mapped buffer even with every layer offloaded
    // (arctic-embed2: ~545 MB of 1.15 GB). That is by design, not a spill: counting it as model size made
    // the Settings graphics-memory check report "Too high / part of the AI spilled" on an idle 8 GB card
    // (found by the 1.0.97 packaged-app smoke test). Only a run that offloaded fewer layers than it has is partial.
    const { gpuBytes, cpuBytes, layersOffloaded, layersTotal } = st.gpu;
    const allOffloaded = gpuBytes > 0 && (layersTotal === null || layersOffloaded === null || layersOffloaded >= layersTotal);
    return { loaded: true, sizeBytes: allOffloaded ? gpuBytes : gpuBytes + cpuBytes, vramBytes: gpuBytes };
  }

  async unloadAll(): Promise<string[]> {
    const running = this.deps.runtime.status().filter((s) => s.state === 'ready' || s.state === 'starting').map((s) => s.role);
    await this.deps.runtime.stopAll();
    return running;
  }

  embeddingModelInfo(): { name: string; installed: boolean; sizeBytes: number; parameterSize: string; quantization: string } {
    const m = getModelForRole('embed');
    const st = this.deps.store.statuses().find((s) => s.role === 'embed');
    return {
      name: m?.id ?? 'snowflake-arctic-embed2',
      installed: st?.state === 'ready',
      sizeBytes: st?.state === 'ready' ? st.sizeBytes : 0,
      parameterSize: '568M',
      quantization: 'F16',
    };
  }

  /** Server for the chat model, started on demand. Held by ai-chat for its OpenAI-compatible client. */
  async chatEndpoint(numCtx: number): Promise<{ baseUrl: string; apiKey: string }> {
    const server = await this.server('chat', { numCtx });
    return { baseUrl: `${server.baseUrl}/v1`, apiKey: server.apiKey };
  }

  markChatUsed(): void {
    this.deps.runtime.markUsed('chat');
  }
}
