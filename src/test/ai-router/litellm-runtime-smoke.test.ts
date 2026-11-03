/**
 * The real bundled LiteLLM end to end (1.0.97 B35), with a fake provider on localhost standing in
 * for the cloud: AiRouter -> LitellmSidecar -> python.exe ark_litellm.py -> LiteLLM -> provider.
 * Needs build/litellm-runtime (node scripts/build-litellm-runtime.mjs) and ARK_RUN_LITELLM_SMOKE=1
 * (about a minute: LiteLLM starts twice); otherwise the suite is skipped. Covers what the fakes cannot: the generated config really loads, the three roles work,
 * keys reach the provider only as the connector's own key, a route change restarts LiteLLM, and
 * quitting leaves no process and no config folder behind.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { LitellmSidecar } from '../../../electron/litellm-sidecar';
import { AiRouter } from '../../../electron/ai-router/router';
import { makeStore } from './helpers';

const runtimeDir = path.resolve(__dirname, '../../../build/litellm-runtime');
const available = process.env.ARK_RUN_LITELLM_SMOKE === '1'
  && fs.existsSync(path.join(runtimeDir, 'python', 'python.exe'))
  && fs.existsSync(path.join(runtimeDir, 'ark_litellm.py'));

const seen: Array<{ url: string; auth?: string; body: string }> = [];
let upstream: http.Server;
let upstreamPort = 0;
let work = '';

beforeAll(async () => {
  if (!available) return;
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-lt-smoke-'));
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if ((req.url ?? '').endsWith('/embeddings')) {
        const n = (JSON.parse(body).input as string[]).length;
        res.end(JSON.stringify({ object: 'list', model: 'x', data: Array.from({ length: n }, (_, i) => ({ object: 'embedding', index: i, embedding: [i + 1, 0.5] })), usage: { prompt_tokens: 1, total_tokens: 1 } }));
      } else if ((req.url ?? '').includes('rerank')) {
        res.end(JSON.stringify({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }], model: 'x' }));
      } else {
        res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'hello from the provider' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      }
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
});

afterAll(async () => {
  if (!available) return;
  await new Promise<void>((r) => upstream.close(() => r()));
  fs.rmSync(work, { recursive: true, force: true });
});

// jsdom's AbortController is not accepted by Node's fetch; the real runtime does not need the abort here.
const nodeFetch = (u: string, init?: RequestInit) => fetch(u, { ...init, signal: undefined });

const portOpen = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect({ port, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

describe.skipIf(!available)('bundled LiteLLM end to end', () => {
  it('serves chat, embeddings and reranking, restarts on a route change and leaves nothing behind on quit', async () => {
    const t = makeStore();
    const runDir = path.join(work, 'run');
    const sidecar = new LitellmSidecar({ runtimeDir: () => runtimeDir, workDir: () => runDir, startTimeoutMs: 120_000, fetchFn: nodeFetch as never });
    const router = new AiRouter({ store: t.store, sidecar, fetchFn: nodeFetch as never });
    t.store.upsertConnector({ id: '', kind: 'openai-compatible', name: 'Fake provider', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, roles: ['chat', 'embeddings', 'reranker'] });
    t.store.setKey('compat-1', 'sk-provider-secret-0001');
    try {
      // Connection test through the real sidecar; only then may the connector be routed.
      const test = await router.test('compat-1', { role: 'chat', model: 'chat-v1' });
      expect(test).toMatchObject({ ok: true, role: 'chat' });
      for (const role of ['chat', 'embeddings', 'reranker'] as const) {
        expect(t.store.setRoute(role, 'compat-1', role === 'reranker' ? 'rerank-v1' : role === 'chat' ? 'chat-v1' : 'embed-v1')).toMatchObject({ ok: true });
      }

      // Embeddings and reranking.
      const emb = await router.embed(['a', 'b'], async () => { throw new Error('local must not run'); });
      expect(emb).toEqual({ embeddings: [[1, 0.5], [2, 0.5]], error: null });
      const rr = await router.rerank('q', ['a', 'b'], undefined, async () => { throw new Error('local must not run'); });
      expect(rr).toMatchObject({ code: 'ok', rows: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] });

      // Chat the way ChatOpenAI calls it: the master key, the ark-chat alias.
      const target = (await router.chatTarget())!;
      const res = await fetch(`${target.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${target.apiKey}` },
        body: JSON.stringify({ model: target.model, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      expect(JSON.stringify(await res.json())).toContain('hello from the provider');

      // The provider got the connector's own key and the route's model names, nothing else.
      const calls = seen.filter((s) => /chat\/completions|embeddings|rerank/.test(s.url) && s.body);
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const c of calls) expect(c.auth).toBe('Bearer sk-provider-secret-0001');
      expect(seen.some((s) => s.body.includes('"embed-v1"'))).toBe(true);
      expect(seen.some((s) => s.body.includes('rerank-v1'))).toBe(true);

      // A wrong master key does not get in.
      const denied = await fetch(`${target.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-wrong' },
        body: JSON.stringify({ model: target.model, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(denied.status).toBeGreaterThanOrEqual(400);

      // The config folder exists while running and holds no key.
      const runs = fs.readdirSync(runDir);
      expect(runs).toHaveLength(1);
      const cfg = fs.readFileSync(path.join(runDir, runs[0]!, 'config.yaml'), 'utf8');
      expect(cfg).not.toContain('sk-provider-secret-0001');
      expect(cfg).not.toContain(target.apiKey);

      // A route change regenerates the config and restarts LiteLLM on a new port/key.
      const before = sidecar.status();
      t.store.setRoute('chat', 'compat-1', 'chat-v2');
      await new Promise((r) => setTimeout(r, 200));
      const target2 = (await router.chatTarget())!;
      expect(target2.apiKey).not.toBe(target.apiKey);
      seen.length = 0;
      const res2 = await fetch(`${target2.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${target2.apiKey}` },
        body: JSON.stringify({ model: target2.model, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res2.status).toBe(200);
      expect(seen.some((s) => s.body.includes('chat-v2'))).toBe(true);
      expect(before.state).toBe('ready');
    } finally {
      const port = sidecar.status().port;
      sidecar.stopSync();
      if (port) {
        await new Promise((r) => setTimeout(r, 800));
        expect(await portOpen(port)).toBe(false);
      }
      expect(fs.existsSync(runDir) ? fs.readdirSync(runDir) : []).toEqual([]);
    }
  }, 240_000);
});
