/**
 * Pure logic of the AI providers page (1.0.97 B37): how each connector state shows, the route
 * button, model lists and the default, the test result messages from the StatesCore board, the
 * catalog and the graph layout.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AiConnector } from '@/services/ai-router-types';
import {
  CONNECTOR_CATALOG, DEFAULT_MODELS_UI, availableCatalog, countStates, describeNode, describeTest, graphLayout, loadModelPrefs,
  markTesting, modelList, routeCta, routeRequest, saveModelPrefs, smallestModel, testFor,
} from '@/components/settings/ai-providers-logic';
import { DEFAULT_MODELS } from '../../../electron/ai-router/types';

const conn = (over: Partial<AiConnector>): AiConnector => ({
  id: 'openai', kind: 'openai', name: 'OpenAI', hasKey: true, needsKey: true, state: 'armed', routedFor: [], serves: ['chat', 'embeddings'],
  test: { ok: true, at: 1, latencyMs: 80, role: 'chat', model: 'gpt-5', message: 'ok' }, ...over,
});

describe('describeNode: the states of the StatesCore board', () => {
  it('live when routed, with the route button saying Routed and doing nothing', () => {
    const d = describeNode(conn({ routedFor: ['chat'] }), 'chat');
    expect(d).toMatchObject({ tone: 'live', chip: 'Live', routed: true, routeLabel: 'Routed', canAct: false });
  });

  it('armed when the key passed its test, with Route here', () => {
    expect(describeNode(conn({}), 'chat')).toMatchObject({ tone: 'armed', chip: 'Armed', routeLabel: 'Route here', canAct: true });
  });

  it('untested but configured: routing runs the test first', () => {
    const d = describeNode(conn({ test: undefined }), 'chat');
    expect(d).toMatchObject({ tone: 'armed', chip: 'Untested', routeLabel: 'Test and route' });
  });

  it('no key: Add key opens the drawer instead of routing', () => {
    expect(describeNode(conn({ hasKey: false, test: undefined }), 'chat')).toMatchObject({ tone: 'nokey', chip: 'No key', routeLabel: 'Add key', opensDrawer: true });
  });

  it('fault (a failed test): Fix key, never routed even if the route still points at it', () => {
    const d = describeNode(conn({ routedFor: ['chat'], test: { ok: false, at: 1, latencyMs: 5, role: 'chat', model: 'gpt-5', message: '401 unauthorized' } }), 'chat');
    expect(d).toMatchObject({ tone: 'fault', chip: 'Fault', routeLabel: 'Fix key', opensDrawer: true, routed: false });
  });

  it('off when switched off: nothing can be done from the node, routed or not', () => {
    expect(describeNode(conn({ enabled: false, routedFor: ['chat'] }), 'chat')).toMatchObject({ tone: 'off', chip: 'Off', routed: false, canAct: false });
  });

  it('testing: other controls stay usable, the route button waits', () => {
    expect(describeNode(conn({}), 'chat', { testing: true })).toMatchObject({ tone: 'armed', chip: 'Testing', canAct: false });
  });

  it('the built-in connector is Ready, Live when routed, and Not running when its runtime is down', () => {
    const b = conn({ id: 'builtin', kind: 'builtin', hasKey: false, needsKey: false, test: undefined, serves: ['chat', 'embeddings', 'reranker'] });
    expect(describeNode(b, 'embeddings')).toMatchObject({ tone: 'armed', chip: 'Ready' });
    expect(describeNode({ ...b, routedFor: ['embeddings'] }, 'embeddings')).toMatchObject({ tone: 'live', chip: 'Live' });
    expect(describeNode(b, 'embeddings', { builtinDown: true })).toMatchObject({ tone: 'fault', chip: 'Not running' });
  });

  it('a connector that does not serve the viewed role is not routable there', () => {
    expect(describeNode(conn({ kind: 'anthropic', serves: ['chat'] }), 'embeddings')).toMatchObject({ tone: 'off', chip: 'Not offered', canAct: false });
  });

  it('counts armed, fault and off for the router node', () => {
    const items = [conn({}), conn({ enabled: false }), conn({ hasKey: true, test: { ok: false, at: 1, latencyMs: 1, role: 'chat', model: 'x', message: 'x' } })]
      .map((c) => ({ display: describeNode(c, 'chat') }));
    expect(countStates(items)).toEqual({ armed: 1, fault: 1, off: 1 });
  });
});

describe('routeCta', () => {
  it('says why it cannot route, and what it will do when it can', () => {
    const cta = (c: AiConnector) => routeCta(c, 'chat', 'chat', describeNode(c, 'chat'));
    expect(cta(conn({ routedFor: ['chat'] }))).toEqual({ label: 'Routed for chat', disabled: true });
    expect(cta(conn({ enabled: false }))).toEqual({ label: 'Enable to route', disabled: true });
    expect(cta(conn({ hasKey: false, test: undefined }))).toEqual({ label: 'Save a key to route', disabled: true });
    expect(cta(conn({ test: { ok: false, at: 1, latencyMs: 1, role: 'chat', model: 'x', message: 'x' } }))).toEqual({ label: 'Fix the key to route', disabled: true });
    expect(cta(conn({}))).toEqual({ label: 'Route chat here', disabled: false });
    expect(cta(conn({ test: undefined }))).toEqual({ label: 'Test and route chat here', disabled: false });
    expect(routeCta(conn({ kind: 'anthropic', serves: ['chat'] }), 'embeddings', 'embeddings', describeNode(conn({ kind: 'anthropic', serves: ['chat'] }), 'embeddings')))
      .toEqual({ label: 'Doesn’t offer embeddings', disabled: true });
  });
});

describe('describeTest: the connection test results of the StatesCore board', () => {
  const t = (message: string, ok = false) => describeTest({ ok, latencyMs: 142, message });
  it('connected shows the latency', () => expect(t('ok', true)).toEqual({ tone: 'live', text: 'Connected · 142 ms', advice: null }));
  it('401 is a rejected key with advice to paste a new one', () => {
    expect(t('Request failed with status 401 Unauthorized')).toMatchObject({ tone: 'fault', text: 'Key rejected (401)', advice: expect.stringContaining('Paste a new key') });
  });
  it('429 means the key works but is throttled', () => expect(t('429 rate limit exceeded')).toMatchObject({ tone: 'nokey', text: 'Rate limited (429)' }));
  it('a timeout points at the timeout setting', () => expect(t('Request timed out')).toMatchObject({ tone: 'fault', advice: expect.stringContaining('timeout') }));
  it('a missing model asks to pick another default', () => expect(t('model not found')).toMatchObject({ tone: 'nokey', text: 'Model not found' }));
  it('anything else shows the message, shortened', () => {
    const long = 'x'.repeat(200);
    expect(t(long).text.length).toBeLessThanOrEqual(91);
  });
});

describe('model lists', () => {
  beforeEach(() => localStorage.clear());

  it('the renderer copy of the default models equals the main process one', () => {
    expect(DEFAULT_MODELS_UI).toEqual(DEFAULT_MODELS);
  });

  it('lists the kind default, the routed model and added ids, with the routed model as default', () => {
    const c = conn({ kind: 'anthropic', id: 'anthropic', serves: ['chat'], testModel: { role: 'chat', model: 'claude-haiku-9' } });
    const list = modelList(c, 'chat', { connectorId: 'anthropic', model: 'claude-opus-9' }, { added: ['claude-extra'], off: [] });
    expect(list.rows.map((r) => r.id)).toEqual(['claude-sonnet-5-5', 'claude-opus-9', 'claude-haiku-9', 'claude-extra']);
    expect(list.def).toBe('claude-opus-9');
  });

  it('a saved default wins while it is checked, and falls back when it is unchecked', () => {
    const c = conn({});
    expect(modelList(c, 'chat', undefined, { added: ['gpt-5-mini'], off: [], def: 'gpt-5-mini' }).def).toBe('gpt-5-mini');
    expect(modelList(c, 'chat', undefined, { added: ['gpt-5-mini'], off: ['gpt-5-mini'], def: 'gpt-5-mini' }).def).toBe('gpt-5');
    expect(modelList(c, 'chat', undefined, { added: [], off: ['gpt-5'] }).def).toBeNull();
  });

  it('Azure has exactly its deployment, and a server with nothing has an empty list', () => {
    expect(modelList(conn({ kind: 'azure-openai', deployment: 'gpt-prod' }), 'chat', undefined, undefined)).toEqual({ rows: [{ id: 'gpt-prod', active: true }], def: 'gpt-prod' });
    expect(modelList(conn({ kind: 'openai-compatible', id: 'compat-1' }), 'chat', undefined, undefined)).toEqual({ rows: [], def: null });
  });

  it('routeRequest sends the default model, and nothing for built-in and Azure (main picks theirs)', () => {
    expect(routeRequest(conn({}), 'chat', { rows: [], def: 'gpt-5' })).toEqual({ role: 'chat', connectorId: 'openai', model: 'gpt-5' });
    expect(routeRequest(conn({ kind: 'builtin', id: 'builtin' }), 'chat', { rows: [], def: 'x' }).model).toBe('');
    expect(routeRequest(conn({ kind: 'azure-openai', id: 'azure-openai' }), 'chat', { rows: [], def: 'x' }).model).toBe('');
  });

  it('smallestModel prefers an id that looks cheap, else the first', () => {
    expect(smallestModel(['gpt-5', 'gpt-5-mini', 'gpt-5-nano'])).toBe('gpt-5-mini');
    expect(smallestModel(['claude-opus-4', 'claude-haiku-4'])).toBe('claude-haiku-4');
    expect(smallestModel(['alpha', 'beta'])).toBe('alpha');
    expect(smallestModel([])).toBeNull();
  });

  it('model choices round-trip through storage and a corrupt entry is ignored', () => {
    saveModelPrefs({ openai: { chat: { added: ['a'], off: ['b'], def: 'a' } } });
    expect(loadModelPrefs()).toEqual({ openai: { chat: { added: ['a'], off: ['b'], def: 'a' } } });
    localStorage.setItem('ark-router-model-prefs', '{nope');
    expect(loadModelPrefs()).toEqual({});
  });
});

describe('catalog and layout', () => {
  it('offers each fixed provider once but any number of compatible servers', () => {
    const none = availableCatalog([]).map((i) => i.id);
    expect(none).toContain('anthropic');
    const withAnthropic = availableCatalog([{ kind: 'anthropic' }, { kind: 'openai-compatible' }]).map((i) => i.id);
    expect(withAnthropic).not.toContain('anthropic');
    expect(withAnthropic).toContain('compat');
    expect(withAnthropic).toContain('lmstudio');
  });

  it('every compatible preset has an address and the roles it serves', () => {
    for (const i of CONNECTOR_CATALOG.filter((c) => c.connectorKind === 'openai-compatible')) {
      expect(i.baseUrl).toMatch(/^https?:\/\//);
      expect(i.roles && i.roles.length).toBeGreaterThan(0);
    }
  });

  it('the stage grows with the connectors and the router sits at its middle', () => {
    const small = graphLayout(2, 0);
    const big = graphLayout(8, 1);
    expect(small.stageH).toBe(560);
    expect(big.stageH).toBe(32 + 8 * 118 + 56);
    expect(big.routerTop).toBe(Math.round(big.stageH / 2 - 105));
    expect(big.nodeY(3)).toBe(32 + 3 * 118);
    expect(big.wire(0)).toMatch(/^M252 \d+ C292 \d+ 288 \d+ 320 \d+$/);
    expect(big.deckWires).toHaveLength(2);
  });
});

describe('a test counts for the role it ran for (1.0.98 F5)', () => {
  const embedFail = { ok: false, at: 2, latencyMs: 5, role: 'embeddings' as const, model: 'text-embedding-3-small', message: 'model not found (404)' };

  it('testFor returns the test only for its own role, but a refused key holds for every role', () => {
    expect(testFor(conn({}), 'chat')?.ok).toBe(true);
    expect(testFor(conn({}), 'embeddings')).toBeUndefined();
    expect(testFor(conn({ test: embedFail }), 'chat')).toBeUndefined();
    const keyFail = { ...embedFail, message: 'Request failed with status 401 Unauthorized' };
    expect(testFor(conn({ test: keyFail }), 'chat')).toBe(keyFail);
  });

  it('a chat pass leaves embeddings Untested, so Route here tests first', () => {
    const c = conn({});
    const d = describeNode(c, 'embeddings');
    expect(d).toMatchObject({ tone: 'armed', chip: 'Untested', routeLabel: 'Test and route' });
    expect(routeCta(c, 'embeddings', 'embeddings', d)).toEqual({ label: 'Test and route embeddings here', disabled: false });
  });

  it('a failed embeddings test does not make the chat route a Fault', () => {
    const c = conn({ test: embedFail });
    expect(describeNode(c, 'chat')).toMatchObject({ tone: 'armed', chip: 'Untested' });
    expect(describeNode(c, 'embeddings')).toMatchObject({ tone: 'fault', chip: 'Fault' });
    expect(routeCta(c, 'chat', 'chat', describeNode(c, 'chat')).disabled).toBe(false);
  });

  it('markTesting merges: starting and finishing a batch leaves other running tests alone', () => {
    const running = { single: true };
    const started = markTesting(running, ['a', 'b'], true);
    expect(started).toEqual({ single: true, a: true, b: true });
    expect(markTesting(started, ['a', 'b'], false)).toEqual({ single: true });
    expect(running).toEqual({ single: true });
  });
});
