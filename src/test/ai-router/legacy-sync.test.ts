/**
 * The current Settings screen against the connector/route store (1.0.97 B35): the chat-provider
 * selector routes chat, the Azure endpoint/deployment from the renderer becomes the Azure
 * connector, and a provider that cannot be routed yet leaves chat on the built-in connector.
 */
import { describe, it, expect } from 'vitest';
import { applyLegacyChatProvider, providerForKind, syncAzureConnector } from '../../../electron/ai-router/legacy-sync';
import { makeStore } from './helpers';

describe('applyLegacyChatProvider', () => {
  it('Ollama means the built-in connector', () => {
    const t = makeStore({ legacy: { googleAI: 'AIza-abcdefghijkl' } });
    applyLegacyChatProvider(t.store, 'gemini');
    expect(t.store.route('chat').connectorId).toBe('gemini');
    expect(applyLegacyChatProvider(t.store, 'ollama')).toMatchObject({ ok: true });
    expect(t.store.route('chat').connectorId).toBe('builtin');
    expect(applyLegacyChatProvider(t.store, 'ollama')).toBeNull(); // nothing to change
  });

  it('Gemini routes with its default model, without needing a test (that UI has none)', () => {
    const t = makeStore({ legacy: { googleAI: 'AIza-abcdefghijkl' } });
    expect(applyLegacyChatProvider(t.store, 'gemini')).toMatchObject({ ok: true });
    expect(t.store.route('chat')).toEqual({ connectorId: 'gemini', model: 'gemini-2.5-flash' });
    expect(t.store.connector('gemini')!.test).toBeUndefined();
  });

  it('a provider without a key is not routed: chat stays on the built-in connector', () => {
    const t = makeStore();
    expect(applyLegacyChatProvider(t.store, 'anthropic')).toMatchObject({ ok: false });
    expect(t.store.route('chat').connectorId).toBe('builtin');
  });

  it('Anthropic takes the model from Settings and keeps a previously chosen one', () => {
    const t = makeStore({ legacy: { anthropic: 'sk-ant-api03-abcdefg' } });
    applyLegacyChatProvider(t.store, 'anthropic', { anthropicModel: 'claude-opus-9' });
    expect(t.store.route('chat')).toEqual({ connectorId: 'anthropic', model: 'claude-opus-9' });
    applyLegacyChatProvider(t.store, 'anthropic', { anthropicModel: 'claude-sonnet-5-5' });
    expect(t.store.route('chat').model).toBe('claude-sonnet-5-5');
    expect(applyLegacyChatProvider(t.store, 'anthropic')).toBeNull();
    const fresh = makeStore({ legacy: { anthropic: 'sk-ant-api03-abcdefg' } });
    applyLegacyChatProvider(fresh.store, 'anthropic');
    expect(fresh.store.route('chat').model).toBe('claude-sonnet-5-5');
  });

  it('Azure needs its connector first; once the renderer described it the route follows with the deployment as model', () => {
    const t = makeStore({ legacy: { azureOpenAI: 'azure-key-abcdef' } });
    expect(applyLegacyChatProvider(t.store, 'azure-openai')).toBeNull();
    expect(t.store.route('chat').connectorId).toBe('builtin');
    expect(syncAzureConnector(t.store, { endpoint: 'https://r.openai.azure.com/', deployment: 'gpt-prod', apiVersion: '2025-04-01-preview' })).toBe(true);
    expect(t.store.connector('azure-openai')).toMatchObject({ endpoint: 'https://r.openai.azure.com', deployment: 'gpt-prod', apiVersion: '2025-04-01-preview' });
    applyLegacyChatProvider(t.store, 'azure-openai');
    expect(t.store.route('chat')).toEqual({ connectorId: 'azure-openai', model: 'gpt-prod' });
  });
});

describe('syncAzureConnector', () => {
  it('only changes the store when something differs, and ignores an incomplete description', () => {
    const t = makeStore({ legacy: { azureOpenAI: 'azure-key-abcdef' } });
    const input = { endpoint: 'https://r.openai.azure.com', deployment: 'gpt-prod', apiVersion: '2025-04-01-preview' };
    expect(syncAzureConnector(t.store, { endpoint: input.endpoint })).toBe(false);
    expect(syncAzureConnector(t.store, input)).toBe(true);
    const writes = t.disk.writes;
    expect(syncAzureConnector(t.store, input)).toBe(false);
    expect(t.disk.writes).toBe(writes);
  });

  it('a new deployment un-routes Azure until it is routed again (its earlier test no longer applies)', () => {
    const t = makeStore({ legacy: { azureOpenAI: 'azure-key-abcdef' } });
    syncAzureConnector(t.store, { endpoint: 'https://r.openai.azure.com', deployment: 'gpt-a' });
    applyLegacyChatProvider(t.store, 'azure-openai');
    expect(t.store.route('chat').model).toBe('gpt-a');
    syncAzureConnector(t.store, { endpoint: 'https://r.openai.azure.com', deployment: 'gpt-b' });
    expect(t.store.route('chat').connectorId).toBe('builtin');
    applyLegacyChatProvider(t.store, 'azure-openai');
    expect(t.store.route('chat').model).toBe('gpt-b');
  });
});

describe('providerForKind', () => {
  it('maps connector kinds onto the local-versus-cloud decisions chat makes', () => {
    expect(providerForKind('builtin')).toBe('ollama');
    expect(providerForKind('ollama')).toBe('ollama');
    expect(providerForKind('gemini')).toBe('gemini');
    expect(providerForKind('azure-openai')).toBe('azure-openai');
    expect(providerForKind('anthropic')).toBe('anthropic');
    expect(providerForKind('openai')).toBe('anthropic'); // cloud-style
  });
});
