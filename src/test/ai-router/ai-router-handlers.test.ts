/**
 * AI router IPC controller (1.0.97 B35): payload validation, the key rules (set / clear / has, never
 * read), "test when a key is saved", the route gate and the policy. The router is a real AiRouter
 * over a fake sidecar and fetch; nothing touches Electron.
 */
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../electron/settings-store.js', () => ({ settingsStore: {} }));
vi.mock('../../../electron/safe-logger.js', () => ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { AiRouterController } from '../../../electron/ipc/ai-router-handlers';
import { AiRouter } from '../../../electron/ai-router/router';
import type { LitellmSidecar } from '../../../electron/litellm-sidecar';
import { makeStore } from './helpers';

function make(respond: () => { status: number; body: unknown } = () => ({ status: 200, body: { choices: [] } })) {
  const t = makeStore();
  const sidecar = {
    isRuntimeAvailable: () => true,
    status: () => ({ state: 'ready', port: 1, pid: 1, restarts: 0, lastError: null, configHash: null }),
    onChange: () => () => undefined,
    ensure: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:47600', masterKey: 'sk-ark-master-1' })),
    stop: vi.fn(async () => undefined),
    reset: vi.fn(),
  };
  const fetchFn = vi.fn(async () => {
    const r = respond();
    return { status: r.status, text: async () => JSON.stringify(r.body) } as unknown as Response;
  });
  const router = new AiRouter({ store: t.store, sidecar: sidecar as unknown as LitellmSidecar, fetchFn: fetchFn as never, builtinProbe: async () => ({ ok: true, message: 'ready', model: 'm' }) });
  return { ...t, router, sidecar, fetchFn, ctl: new AiRouterController(() => router) };
}

describe('connectors', () => {
  it('saves a valid connector and refuses anything else', () => {
    const m = make();
    expect(m.ctl.saveConnector({ kind: 'ollama', baseUrl: 'http://10.0.0.2:11434' })).toEqual({ success: true });
    expect(m.store.connector('ollama')).toMatchObject({ baseUrl: 'http://10.0.0.2:11434' });
    expect(m.ctl.saveConnector({ kind: 'ollama', baseUrl: 'javascript:alert(1)' })).toMatchObject({ success: false });
    expect(m.ctl.saveConnector({ kind: 'builtin' })).toMatchObject({ success: false });
    expect(m.ctl.saveConnector('nope')).toMatchObject({ success: false });
  });

  it('a key smuggled into saveConnector is ignored', () => {
    const m = make();
    m.ctl.saveConnector({ kind: 'openai', apiKey: 'sk-should-never-be-stored-1234' });
    expect(m.disk.text).not.toContain('sk-should-never-be-stored');
    expect(m.store.hasKey('openai')).toBe(false);
  });

  it('removes a connector but never the built-in one or a malformed id', () => {
    const m = make();
    m.ctl.saveConnector({ kind: 'ollama', baseUrl: 'http://x:1' });
    expect(m.ctl.removeConnector('ollama')).toEqual({ success: true });
    expect(m.ctl.removeConnector('builtin')).toMatchObject({ success: false });
    expect(m.ctl.removeConnector('../etc')).toMatchObject({ success: false });
    expect(m.ctl.removeConnector('ollama')).toMatchObject({ success: false });
  });

  it('getState exposes whether a key exists and never the key', async () => {
    const m = make();
    m.ctl.saveConnector({ kind: 'openai' });
    await m.ctl.setKey({ connectorId: 'openai', key: 'sk-proj-VISIBLE-NEVER-12345' });
    const state = JSON.stringify(m.ctl.getState());
    expect(state).toContain('"hasKey":true');
    expect(state).not.toContain('VISIBLE-NEVER');
  });
});

describe('keys', () => {
  it('rejects malformed keys, the built-in connector and unknown connectors', async () => {
    const m = make();
    m.ctl.saveConnector({ kind: 'openai' });
    expect(await m.ctl.setKey({ connectorId: 'openai', key: 'two words here' })).toMatchObject({ success: false });
    expect(await m.ctl.setKey({ connectorId: 'builtin', key: 'sk-abcdefghij' })).toMatchObject({ success: false });
    expect(await m.ctl.setKey({ connectorId: 'ghost', key: 'sk-abcdefghij' })).toMatchObject({ success: false });
    expect(await m.ctl.setKey(null)).toMatchObject({ success: false });
    expect(m.store.hasKey('openai')).toBe(false);
  });

  it('with "test when a key is saved" on (default) the saved key is tested straight away', async () => {
    const m = make();
    m.ctl.saveConnector({ kind: 'openai' });
    const r = await m.ctl.setKey({ connectorId: 'openai', key: 'sk-proj-abcdefghij' });
    expect(r).toMatchObject({ success: true, test: { ok: true, role: 'chat' } });
    expect(m.store.connector('openai')!.test?.ok).toBe(true);
  });

  it('with it off the key is only saved', async () => {
    const m = make();
    m.ctl.setPolicy({ testOnKeySave: false });
    m.ctl.saveConnector({ kind: 'openai' });
    const r = await m.ctl.setKey({ connectorId: 'openai', key: 'sk-proj-abcdefghij' });
    expect(r).toEqual({ success: true });
    expect(m.fetchFn).not.toHaveBeenCalled();
    expect(m.store.connector('openai')!.test).toBeUndefined();
  });

  it('a key the provider rejects is saved but shows as a fault, and cannot be routed', async () => {
    const m = make(() => ({ status: 401, body: { error: { message: 'no' } } }));
    m.ctl.saveConnector({ kind: 'openai' });
    const r = await m.ctl.setKey({ connectorId: 'openai', key: 'sk-proj-abcdefghij' });
    expect(r).toMatchObject({ success: true, test: { ok: false } });
    expect(m.ctl.setRoute({ role: 'chat', connectorId: 'openai', model: 'gpt-5' })).toMatchObject({ success: false });
  });

  it('clearing a key removes it and un-routes the connector', async () => {
    const m = make();
    m.ctl.saveConnector({ kind: 'openai' });
    await m.ctl.setKey({ connectorId: 'openai', key: 'sk-proj-abcdefghij' });
    m.ctl.setRoute({ role: 'chat', connectorId: 'openai', model: 'gpt-5' });
    expect(m.ctl.clearKey('openai')).toEqual({ success: true });
    expect(m.store.hasKey('openai')).toBe(false);
    expect(m.store.route('chat').connectorId).toBe('builtin');
    expect(m.ctl.clearKey('builtin')).toMatchObject({ success: false });
  });
});

describe('routes, policy, tests', () => {
  it('routes only after a passing test; the answer carries the rebuild flag for embeddings', async () => {
    const m = make();
    m.ctl.saveConnector({ kind: 'openai' });
    expect(m.ctl.setRoute({ role: 'embeddings', connectorId: 'openai', model: 'text-embedding-3-small' })).toMatchObject({ success: false });
    await m.ctl.setKey({ connectorId: 'openai', key: 'sk-proj-abcdefghij' });
    expect(m.ctl.setRoute({ role: 'embeddings', connectorId: 'openai', model: 'text-embedding-3-small' }))
      .toEqual({ success: true, rebuild: { from: 'snowflake-arctic-embed2', to: 'openai:text-embedding-3-small' } });
    expect(m.ctl.acknowledgeEmbeddingRebuild()).toEqual({ success: true });
    expect(m.store.rebuild()).toBeNull();
  });

  it('refuses malformed routes and an unknown role', () => {
    const m = make();
    expect(m.ctl.setRoute({ role: 'speech', connectorId: 'openai', model: 'x' })).toMatchObject({ success: false });
    expect(m.ctl.setRoute({ role: 'chat', connectorId: 'openai', model: 'bad model' })).toMatchObject({ success: false });
    expect(m.ctl.setRoute(undefined)).toMatchObject({ success: false });
  });

  it('policy changes are validated and persisted', () => {
    const m = make();
    expect(m.ctl.setPolicy({ onFail: 'use-fallback', timeoutSec: 10, retries: 0, recheckMin: 120 })).toEqual({ success: true });
    expect(m.store.policy()).toMatchObject({ onFail: 'use-fallback', timeoutSec: 10, retries: 0, recheckMin: 120 });
    expect(m.ctl.setPolicy({ timeoutSec: 999 })).toMatchObject({ success: false });
    expect(m.store.policy().timeoutSec).toBe(10);
  });

  it('test and testAll answer with results; an unknown connector is an error', async () => {
    const m = make();
    expect(await m.ctl.test('ghost')).toMatchObject({ success: false });
    expect(await m.ctl.test(42)).toMatchObject({ success: false });
    expect(await m.ctl.test('builtin')).toMatchObject({ success: true, test: { ok: true } });
    expect(await m.ctl.testAll()).toMatchObject({ success: true, tests: { builtin: { ok: true } } });
  });

  it('recheckRuntime clears a failed sidecar and the remembered fault', () => {
    const m = make();
    const state = m.ctl.recheckRuntime();
    expect(m.sidecar.reset).toHaveBeenCalled();
    expect(state.status.fault).toBeNull();
  });
});
