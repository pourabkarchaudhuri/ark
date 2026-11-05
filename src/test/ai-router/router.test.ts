/**
 * AI router (1.0.97 B35): role resolution, embeddings / reranking through LiteLLM with the failure
 * policy, the Oracle fallback to the local backend when the sidecar is down (and the rule that two
 * embedding models' vectors are never mixed), chat errors, connection tests and the scheduled
 * re-check of armed connectors only. The sidecar and `fetch` are fakes.
 */
import { describe, it, expect, vi } from 'vitest';
import { AiRouter, RouterError, scrubMessage, type EmbedOutcome, type RerankOutcome } from '../../../electron/ai-router/router';
import type { LitellmSidecar, SidecarInfo, SidecarSpec, SidecarStatus } from '../../../electron/litellm-sidecar';
import { makeStore } from './helpers';

class FakeSidecar {
  state: SidecarStatus['state'] = 'stopped';
  hash: string | null = null;
  routedHash: string | null = null;
  specProvider: (() => SidecarSpec | null) | null = null;
  ensureCalls: SidecarSpec[] = [];
  failWith: Error | null = null;
  stopped = 0;
  private listeners = new Set<() => void>();
  isRuntimeAvailable() { return true; }
  status(): SidecarStatus { return { state: this.state, port: 47600, pid: 1, restarts: 0, lastError: this.failWith?.message ?? null, configHash: this.hash, routedHash: this.routedHash }; }
  peek(): SidecarInfo | null { return this.state === 'ready' ? { baseUrl: 'http://127.0.0.1:47600', masterKey: 'sk-ark-master-1' } : null; }
  setSpecProvider(fn: (() => SidecarSpec | null) | null) { this.specProvider = fn; }
  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  reset() { this.failWith = null; }
  async stop() { this.stopped++; this.state = 'stopped'; this.hash = null; }
  async ensure(spec: SidecarSpec): Promise<SidecarInfo> {
    this.ensureCalls.push(spec);
    if (this.failWith) throw this.failWith;
    this.state = 'ready';
    this.hash = spec.hash;
    this.routedHash = spec.routedHash ?? null;
    return { baseUrl: 'http://127.0.0.1:47600', masterKey: 'sk-ark-master-1' };
  }
}

interface Req { url: string; body: any; auth: string | undefined }

function makeRouter(opts: { policy?: Partial<ReturnType<ReturnType<typeof makeStore>['store']['policy']>>; respond?: (req: Req) => { status: number; body: unknown } | Error; background?: () => boolean; probe?: (role: string) => { ok: boolean; message: string; model: string } } = {}) {
  const t = makeStore();
  const sidecar = new FakeSidecar();
  const requests: Req[] = [];
  const respond = opts.respond ?? (() => ({ status: 200, body: {} }));
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const req: Req = { url, body: init?.body ? JSON.parse(String(init.body)) : null, auth: (init?.headers as Record<string, string> | undefined)?.Authorization };
    requests.push(req);
    const r = respond(req);
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => JSON.stringify(r.body) } as unknown as Response;
  });
  let now = 10_000;
  const intervals: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const router = new AiRouter({
    store: t.store,
    sidecar: sidecar as unknown as LitellmSidecar,
    fetchFn: fetchFn as unknown as (u: string, i?: RequestInit) => Promise<Response>,
    now: () => (now += 5),
    setIntervalFn: (fn, ms) => { const h = { fn, ms, cleared: false }; intervals.push(h); return h; },
    clearIntervalFn: (h) => { (h as { cleared: boolean }).cleared = true; },
    builtinProbe: async (role) => (opts.probe ? opts.probe(role) : { ok: true, message: 'ready', model: 'snowflake-arctic-embed2' }),
    isBackground: opts.background,
  });
  if (opts.policy) t.store.setPolicy({ ...t.store.policy(), ...opts.policy });
  return { ...t, router, sidecar, requests, fetchFn, intervals };
}

type Made = ReturnType<typeof makeRouter>;

function routeOpenAi(m: Made, roles: Array<'chat' | 'embeddings' | 'reranker'> = ['chat']) {
  m.store.upsertConnector({ id: '', kind: 'openai-compatible', name: 'Server', baseUrl: 'http://127.0.0.1:1234/v1', roles: ['chat', 'embeddings', 'reranker'] });
  m.store.recordTest('compat-1', { ok: true, at: 1, latencyMs: 5, role: 'chat', model: 'm', message: 'ok' });
  for (const role of roles) m.store.setRoute(role, 'compat-1', role === 'chat' ? 'qwen3' : role === 'embeddings' ? 'nomic-embed' : 'bge-rerank');
}

const localRerank = async (): Promise<RerankOutcome> => ({ rows: [{ index: 0, relevance_score: 0.5 }], code: 'ok', message: 'local' });

describe('resolve', () => {
  it('built-in routes stay local: no sidecar involved at all', async () => {
    const m = makeRouter();
    expect(m.router.resolve('chat')).toEqual({ via: 'local' });
    expect(m.router.chatUsesRouter()).toBe(false);
    const local = vi.fn(async () => ({ embeddings: [[1]], error: null }));
    expect(await m.router.embed(['a'], local)).toEqual({ embeddings: [[1]], error: null });
    expect(local).toHaveBeenCalled();
    expect(await m.router.chatTarget()).toBeNull();
    expect(m.sidecar.ensureCalls).toHaveLength(0);
    expect(m.fetchFn).not.toHaveBeenCalled();
  });

  it('a routed role resolves to its connector and alias', () => {
    const m = makeRouter();
    routeOpenAi(m, ['chat', 'reranker']);
    expect(m.router.resolve('chat')).toMatchObject({ via: 'router', alias: 'ark-chat', model: 'qwen3', connector: { id: 'compat-1' } });
    expect(m.router.resolve('reranker')).toMatchObject({ via: 'router', alias: 'ark-reranker' });
    expect(m.router.resolve('embeddings')).toEqual({ via: 'local' });
  });
});

describe('embeddings through LiteLLM', () => {
  it('posts to /v1/embeddings with the master key and the ark-embeddings alias, keeping the order', async () => {
    const m = makeRouter({ respond: () => ({ status: 200, body: { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] } }) });
    routeOpenAi(m, ['embeddings']);
    const out = await m.router.embed(['a', 'b'], async () => { throw new Error('local must not run'); });
    expect(out).toEqual({ embeddings: [[1, 0], [0, 1]], error: null });
    expect(m.requests[0]).toMatchObject({ url: 'http://127.0.0.1:47600/v1/embeddings', auth: 'Bearer sk-ark-master-1', body: { model: 'ark-embeddings', input: ['a', 'b'] } });
  });

  it('hands LiteLLM the generated config and the connector keys through the sidecar spec', async () => {
    const m = makeRouter({ respond: () => ({ status: 200, body: { data: [{ index: 0, embedding: [1] }] } }) });
    m.store.upsertConnector({ id: 'openai', kind: 'openai', name: 'OpenAI' });
    m.store.setKey('openai', 'sk-proj-ROUTERTESTKEY');
    m.store.recordTest('openai', { ok: true, at: 1, latencyMs: 5, role: 'embeddings', model: 'e', message: 'ok' });
    m.store.setRoute('embeddings', 'openai', 'text-embedding-3-small');
    await m.router.embed(['a'], async () => ({ embeddings: [], error: null }));
    const spec = m.sidecar.ensureCalls[0]!;
    expect(Object.values(spec.env)).toContain('sk-proj-ROUTERTESTKEY');
    expect(JSON.stringify(spec.config)).not.toContain('ROUTERTESTKEY');
  });

  it('show-error: a failing provider returns the error, with retries per the policy', async () => {
    const m = makeRouter({ policy: { onFail: 'show-error', retries: 2 }, respond: () => ({ status: 503, body: { error: { message: 'overloaded' } } }) });
    routeOpenAi(m, ['embeddings']);
    const out = await m.router.embed(['a'], async () => { throw new Error('no fallback in show-error'); });
    expect(out.embeddings).toEqual([null]);
    expect(out.error).toMatchObject({ kind: 'http', status: 503, message: 'overloaded' });
    expect(m.requests).toHaveLength(3); // 1 + 2 retries
    expect(m.router.status().fault).toMatchObject({ role: 'embeddings' });
  });

  it('a 4xx answer is not retried', async () => {
    const m = makeRouter({ policy: { retries: 2 }, respond: () => ({ status: 401, body: { error: { message: 'Incorrect API key' } } }) });
    routeOpenAi(m, ['embeddings']);
    const out = await m.router.embed(['a'], async () => ({ embeddings: [], error: null }));
    expect(out.error).toMatchObject({ kind: 'http', status: 401 });
    expect(m.requests).toHaveLength(1);
  });

  it('retry-once adds one more attempt', async () => {
    let n = 0;
    const m = makeRouter({ policy: { onFail: 'retry-once', retries: 0 }, respond: () => (++n === 1 ? new Error('socket hang up') : { status: 200, body: { data: [{ index: 0, embedding: [7] }] } }) });
    routeOpenAi(m, ['embeddings']);
    expect(await m.router.embed(['a'], async () => ({ embeddings: [], error: null }))).toEqual({ embeddings: [[7]], error: null });
    expect(m.requests).toHaveLength(2);
  });

  it('use-fallback: a query-only embed against the still-current built-in vectors is answered by the local backend', async () => {
    const m = makeRouter({ policy: { onFail: 'use-fallback', retries: 0 }, respond: () => ({ status: 500, body: {} }) });
    routeOpenAi(m, ['embeddings']);
    // The embeddings route moved but the cached vectors are still the built-in model's.
    expect(m.store.vectorsModel()).toBe('snowflake-arctic-embed2');
    const local = vi.fn(async () => ({ embeddings: [[3, 3]], error: null }));
    expect(await m.router.embed(['a'], local, { queryOnly: true })).toEqual({ embeddings: [[3, 3]], error: null });
    expect(local).toHaveBeenCalledTimes(1);
  });

  it('use-fallback never writes built-in vectors into a cache that is being rebuilt for the new model', async () => {
    const m = makeRouter({ policy: { onFail: 'use-fallback', retries: 0 }, respond: () => ({ status: 429, body: {} }) });
    routeOpenAi(m, ['embeddings']);
    expect(m.store.rebuild()).not.toBeNull();
    const local = vi.fn(async () => ({ embeddings: [[3, 3]], error: null }));
    const out = await m.router.embed(['a'], local);
    expect(local).not.toHaveBeenCalled();
    expect(out.error).not.toBeNull();
  });

  it('use-fallback never mixes two embedding models: once the vectors were rebuilt, the error is returned', async () => {
    const m = makeRouter({ policy: { onFail: 'use-fallback', retries: 0 }, respond: () => ({ status: 500, body: {} }) });
    routeOpenAi(m, ['embeddings']);
    m.store.acknowledgeRebuild(); // vectors are now the routed model's
    const local = vi.fn(async () => ({ embeddings: [[3, 3]], error: null }));
    const out = await m.router.embed(['a'], local);
    expect(local).not.toHaveBeenCalled();
    expect(out.error?.message).toMatch(/mix two embedding models/);
  });

  it('the sidecar being down (Python unhealthy) is not retried and falls back like any other failure', async () => {
    const m = makeRouter({ policy: { onFail: 'use-fallback', retries: 2 } });
    routeOpenAi(m, ['embeddings']);
    m.sidecar.failWith = new Error('LiteLLM did not become healthy');
    const local = vi.fn(async () => ({ embeddings: [[5]], error: null }));
    expect(await m.router.embed(['a'], local, { queryOnly: true })).toEqual({ embeddings: [[5]], error: null });
    expect(m.sidecar.ensureCalls).toHaveLength(1);
    expect(m.router.status().fault?.message).toMatch(/AI router is not running/);
  });

  it('an empty batch needs no request', async () => {
    const m = makeRouter();
    routeOpenAi(m, ['embeddings']);
    expect(await m.router.embed([], async () => ({ embeddings: [], error: null }))).toEqual({ embeddings: [], error: null });
    expect(m.fetchFn).not.toHaveBeenCalled();
  });
});

describe('reranking through LiteLLM', () => {
  it('posts to /v1/rerank and returns the rows', async () => {
    const m = makeRouter({ respond: () => ({ status: 200, body: { results: [{ index: 1, relevance_score: 0.9 }] } }) });
    routeOpenAi(m, ['reranker']);
    const out = await m.router.rerank('q', ['a', 'b'], undefined, localRerank);
    expect(out).toMatchObject({ code: 'ok', rows: [{ index: 1, relevance_score: 0.9 }] });
    expect(m.requests[0]).toMatchObject({ url: 'http://127.0.0.1:47600/v1/rerank', body: { model: 'ark-reranker', query: 'q', documents: ['a', 'b'], top_n: 2 } });
  });

  it('the sidecar being down: use-fallback answers from the built-in reranker; show-error reports router_down', async () => {
    const fb = makeRouter({ policy: { onFail: 'use-fallback' } });
    routeOpenAi(fb, ['reranker']);
    fb.sidecar.failWith = new Error('boom');
    expect(await fb.router.rerank('q', ['a'], undefined, localRerank)).toMatchObject({ code: 'ok', message: 'local' });

    const se = makeRouter({ policy: { onFail: 'show-error' } });
    routeOpenAi(se, ['reranker']);
    se.sidecar.failWith = new Error('boom');
    expect(await se.router.rerank('q', ['a'], undefined, localRerank)).toMatchObject({ rows: null, code: 'router_down' });
  });

  it('a renderer cancel is not a failure and does not trigger the fallback', async () => {
    const m = makeRouter({ policy: { onFail: 'use-fallback' }, respond: () => new Error('aborted') });
    routeOpenAi(m, ['reranker']);
    const ac = new AbortController();
    ac.abort();
    expect(await m.router.rerank('q', ['a'], { signal: ac.signal }, localRerank)).toMatchObject({ code: 'cancelled' });
    expect(m.fetchFn).not.toHaveBeenCalled();
  });

  it('a built-in reranker route never starts Python', async () => {
    const m = makeRouter();
    expect(await m.router.rerank('q', ['a'], undefined, localRerank)).toMatchObject({ message: 'local' });
    expect(m.sidecar.ensureCalls).toHaveLength(0);
  });
});

describe('chat', () => {
  it('returns the LiteLLM endpoint, master key and alias for ChatOpenAI', async () => {
    const m = makeRouter();
    routeOpenAi(m, ['chat']);
    const t = await m.router.chatTarget();
    expect(t).toMatchObject({ baseUrl: 'http://127.0.0.1:47600/v1', apiKey: 'sk-ark-master-1', model: 'ark-chat', providerName: 'Server (qwen3)' });
  });

  it('chat has no fallback: a router that is down is reported as the router error', async () => {
    const m = makeRouter({ policy: { onFail: 'use-fallback' } });
    routeOpenAi(m, ['chat']);
    m.sidecar.failWith = new Error('python.exe was blocked');
    await expect(m.router.chatTarget()).rejects.toBeInstanceOf(RouterError);
    await expect(m.router.chatTarget()).rejects.toThrow(/The AI router is not running: python.exe was blocked/);
    expect(m.router.status().fault).toMatchObject({ role: 'chat' });
  });

  it('a route whose connector lost its key explains what to do instead of failing deep inside LiteLLM', async () => {
    const m = makeRouter();
    m.store.upsertConnector({ id: 'anthropic', kind: 'anthropic', name: 'Anthropic' });
    m.store.setKey('anthropic', 'sk-ant-api03-abcdefg');
    m.store.setRoute('chat', 'anthropic', '', { force: true });
    delete m.legacy.slots.anthropic; // removed without the store knowing
    await expect(m.router.chatTarget()).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('connection tests', () => {
  function withOpenAi(respond: Parameters<typeof makeRouter>[0] extends infer O ? NonNullable<O>['respond'] : never) {
    const m = makeRouter({ respond });
    m.store.upsertConnector({ id: 'openai', kind: 'openai', name: 'OpenAI' });
    m.store.setKey('openai', 'sk-proj-abcdefghij');
    return m;
  }

  it('a passing test records result, latency and the model, and arms the connector', async () => {
    const m = withOpenAi(() => ({ status: 200, body: { choices: [{ message: { content: 'OK' } }] } }));
    const r = await m.router.test('openai');
    expect(r).toMatchObject({ ok: true, role: 'chat', model: 'gpt-5' });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(m.requests[0]).toMatchObject({ url: 'http://127.0.0.1:47600/v1/chat/completions', body: { model: 'ark-test-openai' } });
    expect(m.store.connector('openai')!.test).toMatchObject({ ok: true });
    expect(m.store.view().connectors.find((c) => c.id === 'openai')!.state).toBe('armed');
  });

  it('a rejected key is a fault with a clear message', async () => {
    const m = withOpenAi(() => ({ status: 401, body: { error: { message: 'Incorrect API key provided: sk-proj-abcdefghij' } } }));
    const r = await m.router.test('openai');
    expect(r).toMatchObject({ ok: false, message: 'Key rejected (401)' });
    expect(m.store.view().connectors.find((c) => c.id === 'openai')!.state).toBe('fault');
  });

  it('error text from a provider never carries a key into the stored result', async () => {
    const m = withOpenAi(() => ({ status: 400, body: { error: { message: 'bad request for key sk-proj-abcdefghijklmnop' } } }));
    const r = await m.router.test('openai');
    expect(r.message).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(m.disk.text)).not.toContain('abcdefghijklmnop');
  });

  it('without a key the test says so and sends nothing', async () => {
    const m = makeRouter();
    m.store.upsertConnector({ id: 'openai', kind: 'openai', name: 'OpenAI' });
    expect(await m.router.test('openai')).toMatchObject({ ok: false, message: 'No key saved.' });
    expect(m.fetchFn).not.toHaveBeenCalled();
  });

  it('a router that cannot start fails the test with the router error', async () => {
    const m = withOpenAi(() => ({ status: 200, body: {} }));
    m.sidecar.failWith = new Error('no runtime');
    expect(await m.router.test('openai')).toMatchObject({ ok: false, message: expect.stringMatching(/AI router is not running/) });
  });

  it('the built-in connector is tested by the probe, without Python', async () => {
    const m = makeRouter();
    expect(await m.router.test('builtin')).toMatchObject({ ok: true, message: 'ready' });
    expect(m.sidecar.ensureCalls).toHaveLength(0);
  });

  it('concurrent tests of one connector share a run', async () => {
    const m = withOpenAi(() => ({ status: 200, body: {} }));
    await Promise.all([m.router.test('openai'), m.router.test('openai')]);
    expect(m.requests).toHaveLength(1);
  });

  it('Test all covers the built-in connector and configured ones, and skips connectors still missing a key', async () => {
    const m = withOpenAi(() => ({ status: 200, body: {} }));
    m.store.upsertConnector({ id: 'anthropic', kind: 'anthropic', name: 'Anthropic' }); // no key
    const all = await m.router.testAll();
    expect(Object.keys(all).sort()).toEqual(['builtin', 'openai']);
  });

  it('an embeddings-only connector is tested with an embeddings request', async () => {
    const m = makeRouter({ respond: () => ({ status: 200, body: { data: [{ embedding: [1] }] } }) });
    m.store.upsertConnector({ id: '', kind: 'openai-compatible', name: 'Embedder', baseUrl: 'http://127.0.0.1:9000/v1', roles: ['embeddings'] });
    m.store.setRoute('embeddings', 'compat-1', 'nomic', { force: true });
    const r = await m.router.test('compat-1');
    expect(r).toMatchObject({ ok: true, role: 'embeddings', model: 'nomic' });
    expect(m.requests[0]!.url).toMatch(/\/v1\/embeddings$/);
  });
});

describe('scheduled re-check', () => {
  it('only armed connectors are re-tested; the built-in, untested and failed ones are not', async () => {
    const m = makeRouter({ respond: () => ({ status: 200, body: {} }) });
    for (const kind of ['openai', 'anthropic'] as const) {
      m.store.upsertConnector({ id: kind, kind, name: kind });
      m.store.setKey(kind, `sk-${kind}-abcdefghij`);
    }
    m.store.upsertConnector({ id: 'gemini', kind: 'gemini', name: 'Gemini' }); // never tested
    m.store.setKey('gemini', 'AIza-abcdefghijkl');
    m.store.recordTest('openai', { ok: true, at: 1, latencyMs: 1, role: 'chat', model: 'gpt-5', message: 'ok' });
    m.store.recordTest('anthropic', { ok: false, at: 1, latencyMs: 1, role: 'chat', model: 'm', message: 'bad' });
    m.store.setRoute('chat', 'openai', 'gpt-5');
    m.sidecar.state = 'ready';
    expect(await m.router.recheckArmed()).toEqual(['openai']);
  });

  it('a re-check that fails turns the armed connector into a fault and records a router fault', async () => {
    const m = makeRouter({ respond: () => ({ status: 401, body: { error: { message: 'revoked' } } }) });
    m.store.upsertConnector({ id: 'openai', kind: 'openai', name: 'OpenAI' });
    m.store.setKey('openai', 'sk-proj-abcdefghij');
    m.store.recordTest('openai', { ok: true, at: 1, latencyMs: 1, role: 'chat', model: 'gpt-5', message: 'ok' });
    m.store.setRoute('chat', 'openai', 'gpt-5');
    m.sidecar.state = 'ready';
    await m.router.recheckArmed();
    expect(m.store.view().connectors.find((c) => c.id === 'openai')!.state).toBe('fault');
    expect(m.router.status().fault?.message).toMatch(/OpenAI: Key rejected/);
  });

  it('the timer follows the policy: 30 min by default, off, 2 h, and is replaced when it changes', () => {
    const m = makeRouter();
    m.router.startScheduler();
    expect(m.intervals.map((i) => i.ms)).toEqual([30 * 60_000]);
    m.store.setPolicy({ ...m.store.policy(), recheckMin: 0 });
    expect(m.intervals[0]!.cleared).toBe(true);
    expect(m.intervals).toHaveLength(1);
    m.store.setPolicy({ ...m.store.policy(), recheckMin: 120 });
    expect(m.intervals.at(-1)!.ms).toBe(120 * 60_000);
    m.router.stopScheduler();
    expect(m.intervals.at(-1)!.cleared).toBe(true);
  });
});

describe('route changes reach the running sidecar', () => {
  it('changed routes regenerate the config for a running sidecar; nothing left to route stops it', async () => {
    const m = makeRouter({ respond: () => ({ status: 200, body: { choices: [] } }) });
    m.store.upsertConnector({ id: 'openai', kind: 'openai', name: 'OpenAI' });
    m.store.setKey('openai', 'sk-proj-abcdefghij');
    m.store.recordTest('openai', { ok: true, at: 1, latencyMs: 1, role: 'chat', model: 'gpt-5', message: 'ok' });
    m.store.setRoute('chat', 'openai', 'gpt-5');
    await m.router.test('openai'); // starts the sidecar
    const calls = m.sidecar.ensureCalls.length;
    m.store.setKey('openai', 'sk-proj-rotated-key-2');
    await vi.waitFor(() => expect(m.sidecar.ensureCalls.length).toBeGreaterThan(calls));
    expect(Object.values(m.sidecar.ensureCalls.at(-1)!.env)).toContain('sk-proj-rotated-key-2');
    m.store.removeConnector('openai');
    await vi.waitFor(() => expect(m.sidecar.stopped).toBe(1));
  });

  it('saving, editing or testing a connector that is not routed never restarts a running sidecar', async () => {
    const m = makeRouter({ respond: () => ({ status: 200, body: { choices: [] } }) });
    routeOpenAi(m, ['chat']);
    await m.router.chatTarget(); // LiteLLM now serves chat
    const calls = m.sidecar.ensureCalls.length;
    m.store.upsertConnector({ id: 'gemini', kind: 'gemini', name: 'Gemini' });
    m.store.setKey('gemini', 'AIza-abcdefghijklmnop');
    m.store.upsertConnector({ id: 'gemini', kind: 'gemini', name: 'Gemini', baseUrl: 'https://gw.example.com/gemini' });
    m.store.setTestModel('gemini', 'chat', 'gemini-2.5-pro');
    m.store.setPolicy({ ...m.store.policy(), timeoutSec: 60, retries: 0 });
    await Promise.resolve();
    expect(m.sidecar.ensureCalls.length).toBe(calls);
    expect(m.sidecar.stopped).toBe(0);
  });

  it('a change to a routed connector still restarts it', async () => {
    const m = makeRouter({ respond: () => ({ status: 200, body: { choices: [] } }) });
    routeOpenAi(m, ['chat']);
    await m.router.chatTarget();
    const calls = m.sidecar.ensureCalls.length;
    m.store.setRoute('chat', 'compat-1', 'another-model');
    await vi.waitFor(() => expect(m.sidecar.ensureCalls.length).toBeGreaterThan(calls));
  });

  it('the embedding identity callback fires when the embeddings model changes', () => {
    const t = makeStore();
    const seen: string[] = [];
    const router = new AiRouter({ store: t.store, sidecar: new FakeSidecar() as unknown as LitellmSidecar, onEmbeddingIdentity: (i) => seen.push(i) });
    t.store.upsertConnector({ id: 'openai', kind: 'openai', name: 'OpenAI' });
    t.store.setKey('openai', 'sk-proj-abcdefghij');
    t.store.recordTest('openai', { ok: true, at: 1, latencyMs: 1, role: 'embeddings', model: 'e', message: 'ok' });
    t.store.setRoute('embeddings', 'openai', 'text-embedding-3-small');
    expect(seen).toEqual(['openai:text-embedding-3-small']);
    expect(router.embeddingIdentity()).toBe('openai:text-embedding-3-small');
  });
});

describe('scrubMessage', () => {
  it('masks keys and bearer tokens and bounds the length', () => {
    expect(scrubMessage('bad key sk-proj-abcdefghijklmnop here')).toBe('bad key *** here');
    expect(scrubMessage('Authorization: Bearer abcdefghijklmnopqrst')).not.toContain('abcdefghijklmnopqrst');
    expect(scrubMessage('x'.repeat(1000))).toHaveLength(300);
  });
});

describe('scrubMessage shapes', () => {
  it.each([
    ['sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx', 'sk-ant'],
    ['request to https://x.example/v1?key=abcd1234efgh5678&alt=json failed', 'abcd1234efgh5678'],
    ['{"api-key": "0123456789abcdef0123456789abcdef"}', '0123456789abcdef0123456789abcdef'],
    ['api_key: "zzzzyyyyxxxxwwww"', 'zzzzyyyyxxxxwwww'],
    ['token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', 'eyJhbGciOiJIUzI1NiJ9'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_abcdef'],
    ['Authorization: Bearer abc.def-ghi_jkl=', 'abc.def-ghi_jkl'],
  ])('masks %s', (text, secret) => {
    expect(scrubMessage(text)).not.toContain(secret);
  });

  it('leaves ordinary error text alone', () => {
    expect(scrubMessage('The model gemma3 was not found (HTTP 404)')).toBe('The model gemma3 was not found (HTTP 404)');
  });
});

describe('one retry layer', () => {
  it('LiteLLM never retries on its own, so a failing request is attempted exactly the policy count', async () => {
    const m = makeRouter({ policy: { retries: 2, onFail: 'retry-once', timeoutSec: 60 }, respond: () => ({ status: 503, body: { error: 'down' } }) });
    routeOpenAi(m, ['embeddings']);
    await m.router.embed(['a'], async () => ({ embeddings: [[1]], error: null }));
    expect(m.requests).toHaveLength(1 + 2 + 1);
    const cfg = m.sidecar.ensureCalls.at(-1)!.config as { model_list: Array<{ litellm_params: { num_retries: number } }> };
    expect(cfg.model_list.length).toBeGreaterThan(0);
    for (const e of cfg.model_list) expect(e.litellm_params.num_retries).toBe(0);
  });

  it('the retries of one request stop at a deadline of two timeouts', async () => {
    const t = makeStore();
    const sidecar = new FakeSidecar();
    let clock = 0;
    let calls = 0;
    const router = new AiRouter({
      store: t.store,
      sidecar: sidecar as unknown as LitellmSidecar,
      now: () => clock,
      fetchFn: (async () => { calls++; clock += 61_000; return { status: 503, text: async () => '{}' } as unknown as Response; }) as never,
    });
    t.store.upsertConnector({ id: '', kind: 'openai-compatible', name: 'Server', baseUrl: 'http://127.0.0.1:1234/v1', roles: ['embeddings'] });
    t.store.setRoute('embeddings', 'compat-1', 'nomic', { force: true });
    t.store.setPolicy({ ...t.store.policy(), retries: 2, onFail: 'retry-once', timeoutSec: 60 });
    await router.embed(['a'], async () => ({ embeddings: [[1]], error: null }));
    expect(calls).toBe(2);
  });
});

describe('scheduled re-check stays quiet', () => {
  function routedAndReady(m: Made) {
    routeOpenAi(m, ['chat']);
    m.sidecar.state = 'ready';
  }

  it('does not run while Ark is in the tray, unfocused or a game runs', async () => {
    let background = true;
    const m = makeRouter({ background: () => background, respond: () => ({ status: 200, body: {} }) });
    routedAndReady(m);
    expect(await m.router.recheckArmed()).toEqual([]);
    expect(m.requests).toHaveLength(0);
    background = false;
    expect(await m.router.recheckArmed()).toEqual(['compat-1']);
  });

  it('never starts the sidecar', async () => {
    const m = makeRouter({ respond: () => ({ status: 200, body: {} }) });
    routeOpenAi(m, ['chat']);
    expect(m.sidecar.state).toBe('stopped');
    expect(await m.router.recheckArmed()).toEqual([]);
    expect(m.sidecar.ensureCalls).toHaveLength(0);
    expect(m.requests).toHaveLength(0);
  });

  it('spends no request on a connector nobody is routed to, and goes through the route alias', async () => {
    const m = makeRouter({ respond: () => ({ status: 200, body: {} }) });
    routeOpenAi(m, ['chat']);
    await m.router.chatTarget();
    const started = m.sidecar.ensureCalls.length;
    m.store.upsertConnector({ id: 'openai', kind: 'openai', name: 'OpenAI' });
    m.store.setKey('openai', 'sk-proj-abcdefghij');
    m.store.recordTest('openai', { ok: true, at: 1, latencyMs: 1, role: 'chat', model: 'gpt-5', message: 'ok' });
    expect(await m.router.recheckArmed()).toEqual(['compat-1']);
    expect(m.requests).toHaveLength(1);
    expect(m.requests[0]!.body.model).toBe('ark-chat');
    expect(m.sidecar.ensureCalls).toHaveLength(started);
  });
});

describe('built-in connector Test', () => {
  it('checks every role, so a missing reranker model is not hidden behind a ready chat model', async () => {
    const m = makeRouter({
      probe: (role) => role === 'reranker'
        ? { ok: false, message: 'The built-in reranker model (bge) is not downloaded yet.', model: 'bge' }
        : { ok: true, message: 'ready', model: 'm' },
    });
    const r = await m.router.test('builtin');
    expect(r.ok).toBe(false);
    expect(r.role).toBe('reranker');
    expect(r.message).toMatch(/reranker model/);
  });

  it('is ok only when every role is ready', async () => {
    const m = makeRouter();
    expect((await m.router.test('builtin')).ok).toBe(true);
  });
});

describe('the sidecar gets a fresh config for restarts', () => {
  it('registers a spec provider that rebuilds from the store and returns null when nothing is routed', () => {
    const m = makeRouter();
    expect(m.sidecar.specProvider).toBeTypeOf('function');
    expect(m.sidecar.specProvider!()).toBeNull();
    routeOpenAi(m, ['chat']);
    const spec = m.sidecar.specProvider!()!;
    expect(spec.config).toBeTruthy();
    expect(spec.routedHash).toBeTruthy();
  });
});
