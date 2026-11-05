/**
 * Generated LiteLLM config (1.0.97 B35): which roles go through LiteLLM, how each connector maps
 * to LiteLLM parameters, and the rule that no key ever lands in the config (only
 * `os.environ/ARK_KEY_n` references, with the values returned separately for the child's env).
 */
import { describe, it, expect } from 'vitest';
import { buildLitellmConfig, testTarget } from '../../../electron/ai-router/litellm-config';
import { DEFAULT_POLICY, type Connector, type Routes } from '../../../electron/ai-router/types';

const builtin: Connector = { id: 'builtin', kind: 'builtin', name: 'Built-in' };
const builtinRoutes: Routes = {
  chat: { connectorId: 'builtin', model: 'gemma3:12b' },
  embeddings: { connectorId: 'builtin', model: 'snowflake-arctic-embed2' },
  reranker: { connectorId: 'builtin', model: 'bge-reranker-v2-m3' },
};
const keys: Record<string, string> = {
  anthropic: 'sk-ant-api03-SECRET-A', openai: 'sk-proj-SECRET-O', gemini: 'AIzaSECRET-G', 'azure-openai': 'azure-SECRET-Z',
};
const getKey = (id: string) => keys[id] ?? null;

const anthropic: Connector = { id: 'anthropic', kind: 'anthropic', name: 'Anthropic' };
const openai: Connector = { id: 'openai', kind: 'openai', name: 'OpenAI' };
const gemini: Connector = { id: 'gemini', kind: 'gemini', name: 'Gemini' };
const azure: Connector = { id: 'azure-openai', kind: 'azure-openai', name: 'Azure', endpoint: 'https://r.openai.azure.com', deployment: 'gpt-prod', apiVersion: '2025-04-01-preview' };
const ollama: Connector = { id: 'ollama', kind: 'ollama', name: 'Ollama', baseUrl: 'http://10.0.0.4:11434' };
const compat: Connector = { id: 'compat-1', kind: 'openai-compatible', name: 'LM', baseUrl: 'http://127.0.0.1:1234/v1', roles: ['chat', 'embeddings', 'reranker'] };

function build(connectors: Connector[], routes: Partial<Routes> = {}, over: Partial<Parameters<typeof buildLitellmConfig>[0]> = {}) {
  return buildLitellmConfig({ connectors: [builtin, ...connectors], routes: { ...builtinRoutes, ...routes }, policy: DEFAULT_POLICY, getKey, ...over });
}
const entry = (b: ReturnType<typeof build>, name: string) => b.config.model_list.find((m) => m.model_name === name);

describe('what goes through LiteLLM', () => {
  it('nothing: with every role on the built-in connector no role alias exists (only connection-test aliases)', () => {
    const b = build([anthropic, openai]);
    expect(b.routedRoles).toEqual([]);
    expect(entry(b, 'ark-chat')).toBeUndefined();
    expect(b.config.model_list.map((m) => m.model_name)).toEqual(['ark-test-anthropic', 'ark-test-openai']);
    expect(build([]).config.model_list).toEqual([]);
    expect(build([]).env).toEqual({});
  });

  it('only the roles routed to another connector get an alias', () => {
    const b = build([anthropic, openai], { chat: { connectorId: 'anthropic', model: 'claude-sonnet-5-5' }, embeddings: { connectorId: 'openai', model: 'text-embedding-3-small' } });
    expect(b.routedRoles).toEqual(['chat', 'embeddings']);
    expect(entry(b, 'ark-chat')!.litellm_params).toMatchObject({ model: 'anthropic/claude-sonnet-5-5' });
    expect(entry(b, 'ark-embeddings')!.litellm_params).toMatchObject({ model: 'openai/text-embedding-3-small' });
    expect(entry(b, 'ark-reranker')).toBeUndefined();
  });

  it('a route whose connector has lost its key is left out instead of failing at request time', () => {
    const b = build([anthropic], { chat: { connectorId: 'anthropic', model: 'm' } }, { getKey: () => null });
    expect(b.routedRoles).toEqual([]);
  });
});

describe('connector to LiteLLM parameters', () => {
  it('Ollama: ollama_chat for chat, ollama for embeddings, the user address as api_base, no key', () => {
    const b = build([ollama], { chat: { connectorId: 'ollama', model: 'gemma3:12b' }, embeddings: { connectorId: 'ollama', model: 'snowflake-arctic-embed2' } });
    expect(entry(b, 'ark-chat')!.litellm_params).toMatchObject({ model: 'ollama_chat/gemma3:12b', api_base: 'http://10.0.0.4:11434' });
    expect(entry(b, 'ark-embeddings')!.litellm_params).toMatchObject({ model: 'ollama/snowflake-arctic-embed2' });
    expect(entry(b, 'ark-chat')!.litellm_params.api_key).toBeUndefined();
  });

  it('Azure OpenAI: deployment, endpoint and API version', () => {
    const b = build([azure], { chat: { connectorId: 'azure-openai', model: 'gpt-prod' } });
    expect(entry(b, 'ark-chat')!.litellm_params).toMatchObject({
      model: 'azure/gpt-prod', api_base: 'https://r.openai.azure.com', api_version: '2025-04-01-preview', api_key: 'os.environ/ARK_KEY_0',
    });
  });

  it('Gemini and OpenAI-compatible (chat, embeddings, reranker through infinity)', () => {
    const b = build([gemini, compat], {
      chat: { connectorId: 'gemini', model: 'gemini-2.5-flash' },
      embeddings: { connectorId: 'compat-1', model: 'nomic-embed' },
      reranker: { connectorId: 'compat-1', model: 'bge-reranker' },
    }, { getKey: (id) => (id === 'gemini' ? keys.gemini! : null) });
    expect(entry(b, 'ark-chat')!.litellm_params).toMatchObject({ model: 'gemini/gemini-2.5-flash' });
    // The compat server has no key: LiteLLM's OpenAI client still gets a placeholder value.
    expect(entry(b, 'ark-embeddings')!.litellm_params).toMatchObject({ model: 'openai/nomic-embed', api_base: 'http://127.0.0.1:1234/v1', api_key: 'ark-no-key' });
    expect(entry(b, 'ark-reranker')!.litellm_params).toMatchObject({ model: 'infinity/bge-reranker', api_base: 'http://127.0.0.1:1234/v1' });
  });

  it('LiteLLM does not retry (the router does) and its timeout is a fixed ceiling, whatever the policy says', () => {
    const b = build([anthropic], { chat: { connectorId: 'anthropic', model: 'm' } }, { policy: { ...DEFAULT_POLICY, timeoutSec: 10, retries: 2 } });
    expect(entry(b, 'ark-chat')!.litellm_params).toMatchObject({ timeout: 60, num_retries: 0 });
  });

  it('refuses a user-supplied value that LiteLLM would read as an environment reference', () => {
    const evil: Connector = { ...azure, apiVersion: 'os.environ/ARK_KEY_0' };
    const b = build([evil], { chat: { connectorId: 'azure-openai', model: 'gpt-prod' } });
    expect(b.routedRoles).toEqual([]);
    expect(b.config.model_list.some((m) => m.model_name === 'ark-test-azure-openai')).toBe(false);
    const evilBase: Connector = { ...compat, baseUrl: ' os.environ/ARK_KEY_0' };
    expect(build([evilBase], { chat: { connectorId: 'compat-1', model: 'm' } }).routedRoles).toEqual([]);
  });
});

describe('keys stay out of the config', () => {
  it('the config only references environment variables; the values are returned separately', () => {
    const b = build([anthropic, openai], { chat: { connectorId: 'anthropic', model: 'm' }, embeddings: { connectorId: 'openai', model: 'e' } });
    const text = JSON.stringify(b.config);
    for (const secret of Object.values(keys)) expect(text).not.toContain(secret);
    expect(text).toContain('os.environ/ARK_KEY_0');
    expect(b.config.general_settings.master_key).toBe('os.environ/LITELLM_MASTER_KEY');
    expect(Object.values(b.env).sort()).toEqual([keys.anthropic, keys.openai].sort());
    expect(Object.keys(b.env).every((k) => /^ARK_KEY_\d+$/.test(k))).toBe(true);
  });

  it('a connector used by two roles shares one variable', () => {
    const b = build([openai], { chat: { connectorId: 'openai', model: 'gpt-5' }, embeddings: { connectorId: 'openai', model: 'e' } });
    expect(Object.keys(b.env)).toEqual(['ARK_KEY_0']);
  });

  it('the hash changes when a route, a key or the policy changes, and only then', () => {
    const base = build([anthropic], { chat: { connectorId: 'anthropic', model: 'm1' } });
    expect(build([anthropic], { chat: { connectorId: 'anthropic', model: 'm1' } }).hash).toBe(base.hash);
    expect(build([anthropic], { chat: { connectorId: 'anthropic', model: 'm2' } }).hash).not.toBe(base.hash);
    expect(build([anthropic], { chat: { connectorId: 'anthropic', model: 'm1' } }, { getKey: () => 'sk-ant-rotated-key' }).hash).not.toBe(base.hash);
    // The policy is applied by the router's client, not by LiteLLM: changing it needs no restart.
    expect(build([anthropic], { chat: { connectorId: 'anthropic', model: 'm1' } }, { policy: { ...DEFAULT_POLICY, timeoutSec: 10 } }).hash).toBe(base.hash);
    // The hash itself reveals nothing about the key.
    expect(base.hash).not.toContain('SECRET');
  });
});

describe('routed hash', () => {
  const routes = { chat: { connectorId: 'anthropic', model: 'm1' } };
  it('ignores connectors that are not routed: their keys, addresses and test models', () => {
    const base = build([anthropic, openai], routes);
    const otherKey = build([anthropic, openai], routes, { getKey: (id) => (id === 'openai' ? 'sk-other-key-for-openai' : getKey(id)) });
    expect(otherKey.hash).not.toBe(base.hash);
    expect(otherKey.routedHash).toBe(base.routedHash);
    const moved = build([anthropic, { ...openai, baseUrl: 'https://gw.example.com/v1' }, gemini], routes);
    expect(moved.routedHash).toBe(base.routedHash);
    const tested = build([anthropic, { ...openai, testModel: { role: 'chat', model: 'gpt-5-mini' } }], routes);
    expect(tested.routedHash).toBe(base.routedHash);
  });

  it('changes with a routed route, model or key', () => {
    const base = build([anthropic, openai], routes);
    expect(build([anthropic, openai], { chat: { connectorId: 'anthropic', model: 'm2' } }).routedHash).not.toBe(base.routedHash);
    expect(build([anthropic, openai], routes, { getKey: (id) => (id === 'anthropic' ? 'sk-ant-rotated-key' : getKey(id)) }).routedHash).not.toBe(base.routedHash);
  });
});

describe('connection-test aliases', () => {
  it('every configured connector gets ark-test-<id>, even when it is not routed', () => {
    const b = build([anthropic, openai]);
    expect(entry(b, 'ark-test-anthropic')!.litellm_params).toMatchObject({ model: 'anthropic/claude-sonnet-5-5', num_retries: 0 });
    expect(entry(b, 'ark-test-openai')!.litellm_params).toMatchObject({ model: 'openai/gpt-5' });
  });

  it('a connector without a key (where one is needed) or without a usable model has no test alias', () => {
    expect(entry(build([anthropic], {}, { getKey: () => null }), 'ark-test-anthropic')).toBeUndefined();
    const noModel: Connector = { id: 'compat-2', kind: 'openai-compatible', name: 'x', baseUrl: 'http://x', roles: ['chat'] };
    expect(entry(build([noModel]), 'ark-test-compat-2')).toBeUndefined();
  });

  it('the test target is the routed role and model first, else the first role with a default', () => {
    expect(testTarget(openai, { ...builtinRoutes, embeddings: { connectorId: 'openai', model: 'text-embedding-3-large' } })).toEqual({ role: 'embeddings', model: 'text-embedding-3-large' });
    expect(testTarget(openai, builtinRoutes)).toEqual({ role: 'chat', model: 'gpt-5' });
    expect(testTarget(azure, builtinRoutes)).toEqual({ role: 'chat', model: 'gpt-prod' });
  });
});
