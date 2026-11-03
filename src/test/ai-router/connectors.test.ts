/**
 * Connector and route store (1.0.97 B35): defaults, key storage (encrypted, no getter in the view,
 * the three legacy slots adopted in place), the "tested before routed" gate, the embedding-model
 * change flag and persistence. The disk and safeStorage are fakes.
 */
import { describe, it, expect } from 'vitest';
import { makeStore, BUILTIN_MODELS } from './helpers';

const openai = { id: 'openai', kind: 'openai' as const, name: 'OpenAI' };
const okTest = { ok: true, at: 5, latencyMs: 40, role: 'chat' as const, model: 'gpt-5', message: 'Connected' };

describe('defaults', () => {
  it('a fresh store has only the built-in connector, routed for every role', () => {
    const { store } = makeStore();
    expect(store.connectors().map((c) => c.id)).toEqual(['builtin']);
    const routes = store.routes();
    for (const role of ['chat', 'embeddings', 'reranker'] as const) expect(routes[role].connectorId).toBe('builtin');
    expect(routes.embeddings.model).toBe(BUILTIN_MODELS.embeddings);
    expect(store.view().connectors[0]).toMatchObject({ id: 'builtin', state: 'live', routedFor: ['chat', 'embeddings', 'reranker'] });
    expect(store.rebuild()).toBeNull();
    expect(store.policy()).toMatchObject({ onFail: 'show-error', timeoutSec: 30, retries: 1, recheckMin: 30 });
  });

  it('a corrupt or foreign file falls back to defaults instead of throwing', () => {
    expect(makeStore({ file: '{not json' }).store.connectors()).toHaveLength(1);
    expect(makeStore({ file: JSON.stringify({ version: 9 }) }).store.connectors()).toHaveLength(1);
  });
});

describe('keys', () => {
  it('a key is stored encrypted, never as plain text, and read back only through getKey', () => {
    const t = makeStore();
    t.store.upsertConnector(openai);
    t.store.setKey('openai', 'sk-proj-SECRETVALUE123');
    expect(t.disk.text).not.toContain('SECRETVALUE123');
    expect(t.disk.text).toContain('"ss:');
    expect(t.store.getKey('openai')).toBe('sk-proj-SECRETVALUE123');
    expect(t.store.hasKey('openai')).toBe(true);
    expect(JSON.stringify(t.store.view())).not.toContain('SECRETVALUE123');
    expect(t.reload().getKey('openai')).toBe('sk-proj-SECRETVALUE123');
  });

  it('refuses to store a key when OS encryption is unavailable', () => {
    const t = makeStore({ safeStorage: null });
    t.store.upsertConnector(openai);
    expect(() => t.store.setKey('openai', 'sk-proj-abcdefgh')).toThrow(/not available/);
    expect(t.disk.text ?? '').not.toContain('abcdefgh');
  });

  it('Gemini, Azure and Anthropic keys stay in their existing encrypted slots (adopted in place)', () => {
    const t = makeStore({ legacy: { googleAI: 'AIzaLegacyKey1234567890', anthropic: 'sk-ant-legacy-0001' } });
    expect(t.store.adoptLegacyKeys()).toBe(true);
    expect(t.store.connectors().map((c) => c.id).sort()).toEqual(['anthropic', 'builtin', 'gemini']);
    expect(t.store.hasKey('gemini')).toBe(true);
    expect(t.store.getKey('anthropic')).toBe('sk-ant-legacy-0001');
    t.store.setKey('anthropic', 'sk-ant-new-key-0002');
    expect(t.legacy.slots.anthropic).toBe('sk-ant-new-key-0002');
    expect(t.disk.text).not.toContain('sk-ant');
    // Adopting again changes nothing.
    expect(t.store.adoptLegacyKeys()).toBe(false);
  });

  it('saving a new key drops the earlier test: the connector has to prove itself again', () => {
    const t = makeStore();
    t.store.upsertConnector(openai);
    t.store.setKey('openai', 'sk-proj-first-key-1');
    t.store.recordTest('openai', okTest);
    expect(t.store.view().connectors.find((c) => c.id === 'openai')!.state).toBe('armed');
    t.store.setKey('openai', 'sk-proj-second-key-2');
    expect(t.store.connector('openai')!.test).toBeUndefined();
    expect(t.store.view().connectors.find((c) => c.id === 'openai')!.state).toBe('off');
  });

  it('clearing a key un-routes the connector; reconcile does the same when the key vanished elsewhere', () => {
    const t = makeStore({ legacy: { anthropic: 'sk-ant-0001-aaaa' } });
    t.store.adoptLegacyKeys();
    t.store.setRoute('chat', 'anthropic', 'claude-sonnet-5-5', { force: true });
    expect(t.store.route('chat').connectorId).toBe('anthropic');
    delete t.legacy.slots.anthropic; // removed through the old Settings field
    expect(t.store.reconcile()).toBe(true);
    expect(t.store.route('chat').connectorId).toBe('builtin');

    t.store.upsertConnector(openai);
    t.store.setKey('openai', 'sk-proj-abcdefghij');
    t.store.recordTest('openai', okTest);
    t.store.setRoute('chat', 'openai', 'gpt-5');
    t.store.clearKey('openai');
    expect(t.store.route('chat').connectorId).toBe('builtin');
    expect(t.store.hasKey('openai')).toBe(false);
  });
});

describe('routes', () => {
  it('a connector is not routed until a test passed', () => {
    const t = makeStore();
    t.store.upsertConnector(openai);
    t.store.setKey('openai', 'sk-proj-abcdefghij');
    const early = t.store.setRoute('chat', 'openai', 'gpt-5');
    expect(early).toMatchObject({ ok: false });
    expect((early as { error: string }).error).toMatch(/Test OpenAI first/);
    t.store.recordTest('openai', okTest);
    expect(t.store.setRoute('chat', 'openai', 'gpt-5')).toMatchObject({ ok: true });
    expect(t.store.route('chat')).toEqual({ connectorId: 'openai', model: 'gpt-5' });
    expect(t.store.view().connectors.find((c) => c.id === 'openai')!).toMatchObject({ state: 'live', routedFor: ['chat'] });
  });

  it('a failed test shows as a fault and blocks routing', () => {
    const t = makeStore();
    t.store.upsertConnector(openai);
    t.store.setKey('openai', 'sk-proj-abcdefghij');
    t.store.recordTest('openai', { ...okTest, ok: false, message: 'Key rejected (401)' });
    expect(t.store.view().connectors.find((c) => c.id === 'openai')!.state).toBe('fault');
    expect(t.store.setRoute('chat', 'openai', 'gpt-5')).toMatchObject({ ok: false });
  });

  it('needs a key where the kind needs one, a model, and a role the connector can serve', () => {
    const t = makeStore();
    t.store.upsertConnector({ id: 'anthropic', kind: 'anthropic', name: 'Anthropic' });
    expect(t.store.view().connectors.find((c) => c.id === 'anthropic')!.state).toBe('nokey');
    expect(t.store.setRoute('chat', 'anthropic', '', { force: true })).toMatchObject({ ok: false, error: expect.stringMatching(/key/i) });
    t.store.setKey('anthropic', 'sk-ant-api03-abcdefg');
    expect(t.store.setRoute('embeddings', 'anthropic', 'x', { force: true })).toMatchObject({ ok: false, error: expect.stringMatching(/cannot serve/) });
    // A default model is filled in when none is given.
    expect(t.store.setRoute('chat', 'anthropic', '', { force: true })).toMatchObject({ ok: true });
    expect(t.store.route('chat').model).toBe('claude-sonnet-5-5');
    // Azure has no default: it routes to its deployment.
    t.store.upsertConnector({ id: 'azure-openai', kind: 'azure-openai', name: 'Azure', endpoint: 'https://a.openai.azure.com', deployment: 'gpt-prod', apiVersion: '2024-12-01-preview' });
    t.store.setKey('azure-openai', 'azurekey123456');
    t.store.setRoute('chat', 'azure-openai', '', { force: true });
    expect(t.store.route('chat').model).toBe('gpt-prod');
  });

  it('the built-in connector always uses its own model names', () => {
    const t = makeStore();
    t.store.setRoute('reranker', 'builtin', 'anything');
    expect(t.store.route('reranker').model).toBe(BUILTIN_MODELS.reranker);
  });

  it('removing a routed connector puts its roles back on the built-in one', () => {
    const t = makeStore();
    t.store.upsertConnector(openai);
    t.store.setKey('openai', 'sk-proj-abcdefghij');
    t.store.recordTest('openai', okTest);
    t.store.setRoute('chat', 'openai', 'gpt-5');
    expect(t.store.removeConnector('openai')).toBe(true);
    expect(t.store.route('chat').connectorId).toBe('builtin');
    expect(t.store.hasKey('openai')).toBe(false);
    expect(t.store.removeConnector('builtin')).toBe(false);
  });

  it('editing the address of a routed connector invalidates its test and un-routes it', () => {
    const t = makeStore();
    t.store.upsertConnector({ id: '', kind: 'openai-compatible', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', roles: ['chat'] });
    expect(t.store.connector('compat-1')).toBeDefined();
    t.store.recordTest('compat-1', okTest);
    t.store.setRoute('chat', 'compat-1', 'qwen3');
    t.store.upsertConnector({ id: 'compat-1', kind: 'openai-compatible', name: 'LM Studio', baseUrl: 'http://127.0.0.1:5678/v1', roles: ['chat'] });
    expect(t.store.connector('compat-1')!.test).toBeUndefined();
    expect(t.store.route('chat').connectorId).toBe('builtin');
  });

  it('renaming only keeps the test and the route, and writes nothing when nothing changed', () => {
    const t = makeStore();
    t.store.upsertConnector({ id: '', kind: 'openai-compatible', name: 'A', baseUrl: 'http://127.0.0.1:1234/v1', roles: ['chat'] });
    t.store.recordTest('compat-1', okTest);
    t.store.setRoute('chat', 'compat-1', 'qwen3');
    const writes = t.disk.writes;
    t.store.upsertConnector({ id: 'compat-1', kind: 'openai-compatible', name: 'A', baseUrl: 'http://127.0.0.1:1234/v1', roles: ['chat'] });
    expect(t.disk.writes).toBe(writes);
    t.store.upsertConnector({ id: 'compat-1', kind: 'openai-compatible', name: 'B', baseUrl: 'http://127.0.0.1:1234/v1', roles: ['chat'] });
    expect(t.store.connector('compat-1')).toMatchObject({ name: 'B', test: { ok: true } });
    expect(t.store.route('chat').connectorId).toBe('compat-1');
  });

  it('routes and tests survive a restart', () => {
    const t = makeStore();
    t.store.upsertConnector(openai);
    t.store.setKey('openai', 'sk-proj-abcdefghij');
    t.store.recordTest('openai', okTest);
    t.store.setRoute('chat', 'openai', 'gpt-5');
    t.store.setPolicy({ ...t.store.policy(), onFail: 'use-fallback', timeoutSec: 60 });
    const again = t.reload();
    expect(again.route('chat')).toEqual({ connectorId: 'openai', model: 'gpt-5' });
    expect(again.connector('openai')!.test?.ok).toBe(true);
    expect(again.policy()).toMatchObject({ onFail: 'use-fallback', timeoutSec: 60 });
  });

  it('a stored route to a connector that is gone reads as built-in', () => {
    const t = makeStore();
    t.store.upsertConnector(openai);
    t.store.setKey('openai', 'sk-proj-abcdefghij');
    t.store.recordTest('openai', okTest);
    t.store.setRoute('chat', 'openai', 'gpt-5');
    const doc = JSON.parse(t.disk.text!);
    doc.connectors = doc.connectors.filter((c: { id: string }) => c.id !== 'openai');
    const again = makeStore({ file: JSON.stringify(doc) }).store;
    expect(again.route('chat').connectorId).toBe('builtin');
  });
});

describe('embedding model change', () => {
  function routedEmbeddings() {
    const t = makeStore();
    t.store.upsertConnector(openai);
    t.store.setKey('openai', 'sk-proj-abcdefghij');
    t.store.recordTest('openai', { ...okTest, role: 'embeddings', model: 'text-embedding-3-small' });
    return t;
  }

  it('switching the embeddings route to another model raises the rebuild flag and keeps the old vectors recorded', () => {
    const t = routedEmbeddings();
    expect(t.store.embeddingIdentity()).toBe('snowflake-arctic-embed2');
    const res = t.store.setRoute('embeddings', 'openai', 'text-embedding-3-small');
    expect(res).toEqual({ ok: true, rebuild: { from: 'snowflake-arctic-embed2', to: 'openai:text-embedding-3-small' } });
    expect(t.store.vectorsModel()).toBe('snowflake-arctic-embed2');
    expect(t.store.rebuild()).toEqual({ from: 'snowflake-arctic-embed2', to: 'openai:text-embedding-3-small' });
  });

  it('the flag stays until the rebuild is acknowledged, then the new model owns the vectors', () => {
    const t = routedEmbeddings();
    t.store.setRoute('embeddings', 'openai', 'text-embedding-3-small');
    expect(t.reload().rebuild()).not.toBeNull();
    t.store.acknowledgeRebuild();
    expect(t.store.rebuild()).toBeNull();
    expect(t.store.vectorsModel()).toBe('openai:text-embedding-3-small');
  });

  it('going back to the model the vectors came from clears the flag without a rebuild', () => {
    const t = routedEmbeddings();
    t.store.setRoute('embeddings', 'openai', 'text-embedding-3-small');
    t.store.setRoute('embeddings', 'builtin', '');
    expect(t.store.rebuild()).toBeNull();
  });

  it('a different model of the same connector counts as a change; changing chat does not', () => {
    const t = routedEmbeddings();
    t.store.setRoute('embeddings', 'openai', 'text-embedding-3-small');
    t.store.acknowledgeRebuild();
    t.store.setRoute('embeddings', 'openai', 'text-embedding-3-large');
    expect(t.store.rebuild()).toEqual({ from: 'openai:text-embedding-3-small', to: 'openai:text-embedding-3-large' });
    t.store.acknowledgeRebuild();
    t.store.recordTest('openai', okTest);
    t.store.setRoute('chat', 'openai', 'gpt-5');
    expect(t.store.rebuild()).toBeNull();
  });

  it('removing the embeddings connector flags a rebuild back to the built-in model', () => {
    const t = routedEmbeddings();
    t.store.setRoute('embeddings', 'openai', 'text-embedding-3-small');
    t.store.acknowledgeRebuild();
    t.store.removeConnector('openai');
    expect(t.store.rebuild()).toEqual({ from: 'openai:text-embedding-3-small', to: 'snowflake-arctic-embed2' });
  });
});

describe('armed connectors (the scheduled re-check set)', () => {
  it('armed = tested ok and configured; built-in, untested and failed ones are not', () => {
    const t = makeStore();
    t.store.upsertConnector(openai);
    t.store.setKey('openai', 'sk-proj-abcdefghij');
    const c = () => t.store.connector('openai')!;
    expect(t.store.isArmed(c())).toBe(false);
    t.store.recordTest('openai', okTest);
    expect(t.store.isArmed(c())).toBe(true);
    t.store.recordTest('openai', { ...okTest, ok: false });
    expect(t.store.isArmed(c())).toBe(false);
    expect(t.store.isArmed(t.store.connector('builtin')!)).toBe(false);
  });
});
