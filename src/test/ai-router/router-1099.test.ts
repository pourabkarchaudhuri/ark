/**
 * 1.0.99 router audit fixes: sidecar port ownership and bind retry, NO_PROXY for local connectors,
 * failed-state recovery and restart budget, chat failure policy, embed/rerank deadlines under LiteLLM's
 * timeout, and connection tests that outlive a connector edit.
 */
import { describe, it, expect, vi } from 'vitest';
import { LitellmSidecar, mergeNoProxy, localConnectorHosts, isLocalNetworkName } from '../../../electron/litellm-sidecar';
import { AiRouter, MAX_CLIENT_TIMEOUT_MS } from '../../../electron/ai-router/router';
import { LITELLM_TIMEOUT_CEILING_SEC } from '../../../electron/ai-router/litellm-config';
import type { LitellmSidecar as SidecarT, SidecarInfo, SidecarSpec, SidecarStatus } from '../../../electron/litellm-sidecar';
import { sidecarDeps, makeStore } from './helpers';

const spec = (hash = 'h1', config: unknown = { model_list: [] }) => ({ config, env: { ARK_KEY_0: 'sk-secret-value' }, hash });

describe('sidecar port ownership and bind retry (#6)', () => {
  it('does not declare ready for a foreign server that answers /health/liveliness but rejects the master key', async () => {
    const t = sidecarDeps({
      startTimeoutMs: 80,
      fetchFn: async (url, init) => {
        if (url.endsWith('/health/liveliness')) return { ok: true, status: 200 };
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        return { ok: auth === 'Bearer never', status: 401 };
      },
    });
    const sc = new LitellmSidecar(t.deps);
    await expect(sc.ensure(spec())).rejects.toMatchObject({ code: 'start_failed' });
    expect(sc.status().state).not.toBe('ready');
  });

  it('retries on another port, without counting a failed start, when the child cannot bind', async () => {
    const t = sidecarDeps();
    t.state.onSpawn = (s) => {
      if (s.args[s.args.indexOf('--port') + 1] === '47600') {
        s.child.stderr.emit('data', 'ERROR: [Errno 10048] error while attempting to bind on address: only one usage of each socket address');
        s.child.crash(1);
      }
    };
    t.deps.fetchFn = async (url) => {
      const port = /:(\d+)\//.exec(url)?.[1];
      const s = [...t.spawned].reverse().find((x) => x.args[x.args.indexOf('--port') + 1] === port);
      const ok = !!s && !s.child.killed && port !== '47600';
      return { ok, status: ok ? 200 : 503 };
    };
    const sc = new LitellmSidecar(t.deps);
    const info = await sc.ensure(spec());
    expect(info.baseUrl).toBe('http://127.0.0.1:47601');
    expect(t.spawned).toHaveLength(2);
    expect(sc.status().state).toBe('ready');
    // The lost race left no failure behind: a later failed start is the first one, not the second.
    sc.stopSync();
  });
});

describe('NO_PROXY for local connectors (#7, #14)', () => {
  it('always bypasses IPv6 loopback and adds the given hosts once', () => {
    expect(mergeNoProxy(undefined)).toBe('127.0.0.1,localhost,::1');
    expect(mergeNoProxy('corp', ['192.168.1.20', 'localhost'])).toBe('corp,127.0.0.1,localhost,::1,192.168.1.20');
  });

  it('classifies LAN, single-label and loopback hosts as local, public ones not', () => {
    for (const h of ['192.168.1.20', '10.1.2.3', '172.20.0.1', 'myserver', 'box.local', 'nas.lan', '::1', '[::1]', 'localhost', 'fd12::1']) expect(isLocalNetworkName(h), h).toBe(true);
    for (const h of ['api.openai.com', '8.8.8.8', '172.32.0.1', 'example.com']) expect(isLocalNetworkName(h), h).toBe(false);
  });

  it('collects only the local-network api_base hosts of the config', () => {
    const config = { model_list: [
      { litellm_params: { api_base: 'http://192.168.1.20:11434' } },
      { litellm_params: { api_base: 'http://[::1]:11434/v1' } },
      { litellm_params: { api_base: 'https://api.openai.com/v1' } },
      { litellm_params: { api_base: 'http://nas:8080' } },
      { litellm_params: { model: 'x' } },
    ] };
    expect(localConnectorHosts(config).sort()).toEqual(['192.168.1.20', '::1', 'nas'].sort());
  });

  it('the child gets those hosts in NO_PROXY next to the injected proxy', async () => {
    const t = sidecarDeps({ proxyEnv: async () => ({ HTTPS_PROXY: 'http://proxy:8080', HTTP_PROXY: 'http://proxy:8080' }) });
    const sc = new LitellmSidecar(t.deps);
    await sc.ensure(spec('h1', { model_list: [{ litellm_params: { api_base: 'http://192.168.1.20:11434' } }] }));
    expect(t.spawned[0]!.env.NO_PROXY).toBe('127.0.0.1,localhost,::1,192.168.1.20');
    sc.stopSync();
  });
});

describe('failed state and restart budget (#26)', () => {
  it('a changed config gets a fresh try after the same config failed too often', async () => {
    let healthy = false;
    const t = sidecarDeps({ startTimeoutMs: 40, maxRestarts: 2, startFailureCooldownMs: [0, 0] });
    t.state.healthy = () => healthy;
    const sc = new LitellmSidecar(t.deps);
    await expect(sc.ensure(spec('bad'))).rejects.toBeTruthy();
    await expect(sc.ensure(spec('bad'))).rejects.toBeTruthy();
    expect(sc.status().state).toBe('failed');
    await expect(sc.ensure(spec('bad'))).rejects.toMatchObject({ code: 'failed_too_often' });
    healthy = true;
    await expect(sc.ensure(spec('fixed'))).resolves.toBeTruthy();
    expect(sc.status().state).toBe('ready');
    sc.stopSync();
  });

  it('a restart refused by the start-failure cooldown does not use up a restart', async () => {
    const t = sidecarDeps({ startTimeoutMs: 30, maxRestarts: 3, backoffMs: [5, 5, 5], startFailureCooldownMs: [120, 120, 120] });
    let healthy = true;
    t.state.healthy = () => healthy;
    const sc = new LitellmSidecar(t.deps);
    await sc.ensure(spec());
    healthy = false;
    t.spawned[0]!.child.crash(1); // crash of a ready run: restart #1 spawns, fails to become healthy, cooldown 120 ms
    await new Promise((r) => setTimeout(r, 90));
    // Only real spawn attempts were counted; the timers that hit the cooldown were re-armed, not charged.
    expect(sc.status().restarts).toBeLessThanOrEqual(2);
    healthy = true;
    await new Promise((r) => setTimeout(r, 400));
    expect(sc.status().state).toBe('ready');
    sc.stopSync();
  });
});

describe('router chat target carries the failure policy (#13)', () => {
  it('exposes the timeout and retry count of the policy', async () => {
    const t = makeStore();
    const sidecar = {
      state: 'ready', onChange: () => () => undefined, setSpecProvider: () => undefined, isRuntimeAvailable: () => true,
      status: (): SidecarStatus => ({ state: 'ready', port: 1, pid: 1, restarts: 0, lastError: null, configHash: null, routedHash: null }),
      peek: (): SidecarInfo => ({ baseUrl: 'http://127.0.0.1:1', masterKey: 'k' }),
      ensure: async (_s: SidecarSpec): Promise<SidecarInfo> => ({ baseUrl: 'http://127.0.0.1:1', masterKey: 'k' }),
    };
    const router = new AiRouter({ store: t.store, sidecar: sidecar as unknown as SidecarT });
    t.store.upsertConnector({ id: '', kind: 'openai-compatible', name: 'S', baseUrl: 'http://127.0.0.1:1234/v1', roles: ['chat', 'embeddings', 'reranker'] });
    t.store.recordTest('compat-1', { ok: true, at: 1, latencyMs: 5, role: 'chat', model: 'm', message: 'ok' });
    t.store.setRoute('chat', 'compat-1', 'qwen3');
    t.store.setPolicy({ ...t.store.policy(), timeoutSec: 10, retries: 0, onFail: 'show-error' });
    const target = await router.chatTarget();
    expect(target).toMatchObject({ timeoutMs: 10_000, maxRetries: 0 });
    t.store.setPolicy({ ...t.store.policy(), timeoutSec: 60, retries: 2 });
    expect(await router.chatTarget()).toMatchObject({ timeoutMs: 60_000, maxRetries: 2 });
  });
});

describe('client deadlines stay under LiteLLM timeout (#24)', () => {
  it('the clamp is below the ceiling and a huge embed batch is clamped to it', async () => {
    expect(MAX_CLIENT_TIMEOUT_MS).toBeLessThan(LITELLM_TIMEOUT_CEILING_SEC * 1000);
    expect(60_000 * 3).toBeLessThanOrEqual(MAX_CLIENT_TIMEOUT_MS); // the longest rerank (3x the 60 s policy)
    expect(60_000 + 50 * 100).toBeLessThanOrEqual(MAX_CLIENT_TIMEOUT_MS);
  });
});

describe('a connection test that outlives an edit is discarded (#25)', () => {
  it('does not record a result against a connector whose address changed meanwhile', async () => {
    const t = makeStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const sidecar = {
      onChange: () => () => undefined, setSpecProvider: () => undefined, isRuntimeAvailable: () => true,
      status: (): SidecarStatus => ({ state: 'ready', port: 1, pid: 1, restarts: 0, lastError: null, configHash: null, routedHash: null }),
      peek: () => null,
      ensure: async (): Promise<SidecarInfo> => { await gate; return { baseUrl: 'http://127.0.0.1:1', masterKey: 'k' }; },
    };
    const fetchFn = vi.fn(async () => ({ status: 200, text: async () => '{}' }) as unknown as Response);
    const router = new AiRouter({ store: t.store, sidecar: sidecar as unknown as SidecarT, fetchFn });
    t.store.upsertConnector({ id: '', kind: 'openai-compatible', name: 'S', baseUrl: 'http://192.168.1.5:1234/v1', roles: ['chat'] });
    const first = router.test('compat-1', { role: 'chat', model: 'm' });
    t.store.upsertConnector({ id: 'compat-1', kind: 'openai-compatible', name: 'S', baseUrl: 'http://192.168.1.99:1234/v1', roles: ['chat'] });
    release();
    const res = await first;
    expect(res.ok).toBe(true);
    expect(t.store.connector('compat-1')?.test).toBeUndefined();
  });

  it('a second test after the edit is not served from the stale in-flight run', async () => {
    const t = makeStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let ensures = 0;
    const sidecar = {
      onChange: () => () => undefined, setSpecProvider: () => undefined, isRuntimeAvailable: () => true,
      status: (): SidecarStatus => ({ state: 'ready', port: 1, pid: 1, restarts: 0, lastError: null, configHash: null, routedHash: null }),
      peek: () => null,
      ensure: async (): Promise<SidecarInfo> => { ensures++; await gate; return { baseUrl: 'http://127.0.0.1:1', masterKey: 'k' }; },
    };
    const router = new AiRouter({ store: t.store, sidecar: sidecar as unknown as SidecarT, fetchFn: (async () => ({ status: 200, text: async () => '{}' })) as never });
    t.store.upsertConnector({ id: '', kind: 'openai-compatible', name: 'S', baseUrl: 'http://192.168.1.5:1234/v1', roles: ['chat'] });
    const a = router.test('compat-1', { role: 'chat', model: 'm' });
    t.store.upsertConnector({ id: 'compat-1', kind: 'openai-compatible', name: 'S', baseUrl: 'http://192.168.1.99:1234/v1', roles: ['chat'] });
    const b = router.test('compat-1', { role: 'chat', model: 'm' });
    release();
    await Promise.all([a, b]);
    expect(a).not.toBe(b);
    expect(ensures).toBeGreaterThanOrEqual(2);
    expect(t.store.connector('compat-1')?.test?.ok).toBe(true);
  });
});
