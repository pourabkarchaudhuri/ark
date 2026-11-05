/**
 * BuiltinBackend: the embed / rerank / Qwen3 / chat calls Ark makes against its own llama-server
 * processes, with a fake runtime and a fake fetch (no process, no network).
 */
import { describe, it, expect, vi } from 'vitest';
import { BuiltinBackend } from '../../../electron/local-ai/builtin-backend';
import { RuntimeError, type LlamaRuntime, type ServerInfo, type RoleStatus } from '../../../electron/local-ai/llama-runtime';
import type { ModelStore } from '../../../electron/local-ai/model-store';

interface Req { url: string; body: any; auth: string | null }

function setup(over: { ensure?: (role: string, launch?: unknown) => Promise<ServerInfo>; ready?: string[]; respond?: (r: Req) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }> } = {}) {
  const requests: Req[] = [];
  const ensured: Array<{ role: string; launch: unknown }> = [];
  const server = (role: string): ServerInfo => ({
    role: role as ServerInfo['role'], port: 47410, apiKey: 'secret', baseUrl: 'http://127.0.0.1:47410',
    gpu: { device: 'Vulkan0', layersOffloaded: 25, layersTotal: 25, gpuBytes: 1000, cpuBytes: 0 }, cpuFallback: false,
  });
  const runtime = {
    ensure: vi.fn(async (role: string, launch?: unknown) => {
      ensured.push({ role, launch });
      return over.ensure ? over.ensure(role, launch) : server(role);
    }),
    markUsed: vi.fn(),
    isRuntimeAvailable: vi.fn(() => true),
    roleStatus: vi.fn((role: string): RoleStatus => ({ role: role as RoleStatus['role'], state: 'ready', port: 47410, pid: 1, restarts: 0, cpuFallback: false, lastError: null, gpu: { device: 'Vulkan0', layersOffloaded: 25, layersTotal: 25, gpuBytes: 1000, cpuBytes: 24 } })),
    status: vi.fn((): RoleStatus[] => [{ role: 'embed', state: 'ready', port: 47410, pid: 1, restarts: 0, cpuFallback: false, lastError: null, gpu: null }]),
    stopAll: vi.fn(async () => undefined),
  } as unknown as LlamaRuntime;
  const store = {
    isReady: (role: string) => (over.ready ?? ['embed', 'rerank', 'rerank-qwen', 'chat']).includes(role),
    statuses: () => [{ id: 'arctic-embed2', role: 'embed', state: 'ready', sizeBytes: 1160285024 }],
  } as unknown as ModelStore;
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const req: Req = { url, body: JSON.parse(String(init?.body ?? '{}')), auth: (init?.headers as Record<string, string>)?.Authorization ?? null };
    requests.push(req);
    const r = over.respond ? await over.respond(req) : { status: 200, body: {} };
    return { status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) } as Response;
  });
  const backend = new BuiltinBackend({ runtime, store, runtimeBuild: 'b11780', fetchFn: fetchFn as unknown as typeof fetch });
  return { backend, requests, ensured, runtime, fetchFn };
}

describe('BuiltinBackend.health', () => {
  it('is "running" with the llama.cpp build as version when the packaged server exists', () => {
    expect(setup().backend.health()).toEqual({ running: true, version: 'b11780' });
  });
  it('is not running when llama-server is missing from the install', () => {
    const t = setup();
    (t.runtime.isRuntimeAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect(t.backend.health()).toEqual({ running: false, version: null });
  });
});

describe('BuiltinBackend.embed', () => {
  it('posts the texts to /v1/embeddings with the private key and maps rows by index', async () => {
    const t = setup({ respond: () => ({ status: 200, body: { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] } }) });
    const out = await t.backend.embed(['a', 'b'], { numBatch: 1024, numThread: 4 });
    expect(out.error).toBeNull();
    expect(out.embeddings).toEqual([[1, 0], [0, 1]]);
    expect(t.requests[0].url).toBe('http://127.0.0.1:47410/v1/embeddings');
    expect(t.requests[0].body.input).toEqual(['a', 'b']);
    expect(t.requests[0].auth).toBe('Bearer secret');
    expect(t.ensured[0]).toEqual({ role: 'embed', launch: { numBatch: 1024, numThread: 4 } });
    expect(t.runtime.markUsed).toHaveBeenCalledWith('embed');
  });

  it('never talks to port 11434', async () => {
    const t = setup({ respond: () => ({ status: 200, body: { data: [{ index: 0, embedding: [1] }] } }) });
    await t.backend.embed(['a']);
    expect(t.requests.every((r) => !r.url.includes(':11434'))).toBe(true);
  });

  it('returns an empty batch without starting a server', async () => {
    const t = setup();
    expect(await t.backend.embed([])).toEqual({ embeddings: [], error: null });
    expect(t.ensured).toHaveLength(0);
  });

  it('reports an http error with the server message (the OOM step-down reads it)', async () => {
    const t = setup({ respond: () => ({ status: 500, body: { error: { code: 500, message: 'ggml_vulkan: out of memory' } } }) });
    const out = await t.backend.embed(['a', 'b']);
    expect(out.embeddings).toEqual([null, null]);
    expect(out.error).toMatchObject({ kind: 'http', status: 500, message: 'ggml_vulkan: out of memory' });
  });

  it('reports a network error when the server cannot start (model missing, runtime failed)', async () => {
    const t = setup({ ensure: async () => { throw new RuntimeError('The embed model is not downloaded yet', 'no_model'); } });
    const out = await t.backend.embed(['a']);
    expect(out.error).toMatchObject({ kind: 'network' });
    expect(out.error?.message).toMatch(/not downloaded/);
  });

  it('reports parse and empty responses', async () => {
    const parse = setup({ respond: () => ({ status: 200, body: 'not json' }) });
    expect((await parse.backend.embed(['a'])).error?.kind).toBe('parse');
    const empty = setup({ respond: () => ({ status: 200, body: { data: [] } }) });
    expect((await empty.backend.embed(['a'])).error?.kind).toBe('empty');
  });

  it('reports a timeout distinctly from a network error', async () => {
    const t = setup();
    t.fetchFn.mockImplementationOnce(async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); });
    expect((await t.backend.embed(['a'])).error?.kind).toBe('timeout');
  });
});

describe('BuiltinBackend.rerank', () => {
  it('posts to /v1/rerank and returns the raw rows', async () => {
    const rows = [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }];
    const t = setup({ respond: () => ({ status: 200, body: { results: rows } }) });
    const out = await t.backend.rerank('q', ['a', 'b']);
    expect(out).toMatchObject({ code: 'ok', rows });
    expect(t.requests[0].url).toBe('http://127.0.0.1:47410/v1/rerank');
    expect(t.requests[0].body).toMatchObject({ query: 'q', documents: ['a', 'b'] });
    expect(t.ensured[0].role).toBe('rerank');
  });

  it('maps a missing model, an http error and a cancel to codes the handler understands', async () => {
    const missing = setup({ ensure: async () => { throw new RuntimeError('no model', 'no_model'); } });
    expect((await missing.backend.rerank('q', ['a'])).code).toBe('model_missing');
    const http = setup({ respond: () => ({ status: 500, body: { error: 'boom' } }) });
    const failed = await http.backend.rerank('q', ['a']);
    expect(failed).toMatchObject({ code: 'http_error', httpStatus: 500 });
    const ac = new AbortController();
    ac.abort();
    const cancelled = await setup().backend.rerank('q', ['a'], { signal: ac.signal });
    expect(cancelled.code).toBe('cancelled');
  });
});

describe('BuiltinBackend.generateScore (Qwen3 reranker)', () => {
  it('maps top_logprobs from the current llama-server shape', async () => {
    const t = setup({ respond: () => ({ status: 200, body: { content: 'yes', completion_probabilities: [{ top_logprobs: [{ token: 'yes', logprob: -0.1 }, { token: 'no', logprob: -2.5 }] }] } }) });
    const out = await t.backend.generateScore('prompt', true);
    expect(out?.response).toBe('yes');
    expect(out?.logprobs?.[0].top_logprobs).toEqual([{ token: 'yes', logprob: -0.1 }, { token: 'no', logprob: -2.5 }]);
    expect(t.requests[0].url).toBe('http://127.0.0.1:47410/completion');
    expect(t.requests[0].body).toMatchObject({ n_predict: 1, temperature: 0, n_probs: 20 });
    expect(t.ensured[0].role).toBe('rerank-qwen');
  });

  it('maps the older probs shape to logprobs', () => {
    const out = BuiltinBackend.toGenerateResponse({ content: 'no', completion_probabilities: [{ probs: [{ tok_str: 'no', prob: 0.5 }] }] });
    expect(out.logprobs?.[0].top_logprobs?.[0].token).toBe('no');
    expect(out.logprobs?.[0].top_logprobs?.[0].logprob).toBeCloseTo(Math.log(0.5));
  });

  it('asks for no probabilities in binary mode and returns null on failure', async () => {
    const t = setup({ respond: () => ({ status: 200, body: { content: 'yes' } }) });
    const out = await t.backend.generateScore('p', false);
    expect(t.requests[0].body.n_probs).toBeUndefined();
    expect(out?.logprobs).toBeUndefined();
    const bad = setup({ respond: () => ({ status: 500, body: {} }) });
    expect(await bad.backend.generateScore('p', true)).toBeNull();
  });
});

describe('BuiltinBackend chat, gpu, unload, model info', () => {
  it('chatEndpoint starts the chat server with the context size and exposes an OpenAI base URL', async () => {
    const t = setup();
    const ep = await t.backend.chatEndpoint(8192);
    expect(ep).toEqual({ baseUrl: 'http://127.0.0.1:47410/v1', apiKey: 'secret' });
    expect(t.ensured[0]).toEqual({ role: 'chat', launch: { numCtx: 8192 } });
  });

  it('gpuReading comes from the embed server log', () => {
    // every layer on the GPU: the CPU-mapped embedding table is not a spill, so size == vram
    expect(setup().backend.gpuReading()).toEqual({ loaded: true, sizeBytes: 1000, vramBytes: 1000 });
    const partial = setup();
    (partial.runtime.roleStatus as ReturnType<typeof vi.fn>).mockReturnValue({ state: 'ready', gpu: { device: 'Vulkan0', layersOffloaded: 10, layersTotal: 25, gpuBytes: 400, cpuBytes: 600 } });
    expect(partial.backend.gpuReading()).toEqual({ loaded: true, sizeBytes: 1000, vramBytes: 400 });
    const t = setup();
    (t.runtime.roleStatus as ReturnType<typeof vi.fn>).mockReturnValue({ state: 'stopped', gpu: null });
    expect(t.backend.gpuReading()).toEqual({ loaded: false, sizeBytes: 0, vramBytes: 0 });
  });

  it('unloadAll stops the servers and names the roles that were up', async () => {
    const t = setup();
    expect(await t.backend.unloadAll()).toEqual(['embed']);
    expect(t.runtime.stopAll).toHaveBeenCalled();
  });

  it('embeddingModelInfo reports the downloaded model', () => {
    expect(setup().backend.embeddingModelInfo()).toMatchObject({ installed: true, sizeBytes: 1160285024, quantization: 'F16' });
  });
});
