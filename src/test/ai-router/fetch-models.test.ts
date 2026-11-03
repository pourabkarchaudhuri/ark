/**
 * "Fetch from server" on the AI providers screen (1.0.97 B37): ask an Ollama or OpenAI-compatible
 * server which models it serves. No real network: the fetch is injected.
 */
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../electron/settings-store.js', () => ({ settingsStore: {} }));
vi.mock('../../../electron/safe-logger.js', () => ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { AiRouterController, parseServedModels } from '../../../electron/ipc/ai-router-handlers';
import type { AiRouter } from '../../../electron/ai-router/router';
import { makeStore } from './helpers';

function make(body: unknown, status = 200) {
  const t = makeStore();
  const fetchImpl = vi.fn(async (_url: string, _init: { headers: Record<string, string>; signal: AbortSignal }) => ({ ok: status < 400, status, json: async () => body }));
  const ctl = new AiRouterController(() => ({ store: t.store }) as unknown as AiRouter, fetchImpl);
  return { ...t, ctl, fetchImpl };
}

describe('parseServedModels', () => {
  it('reads Ollama tags and OpenAI model lists, dropping junk and duplicates', () => {
    expect(parseServedModels('ollama', { models: [{ name: 'gemma3:12b' }, { name: 'gemma3:12b' }, { name: '' }, { name: 5 }] })).toEqual(['gemma3:12b']);
    expect(parseServedModels('openai-compatible', { data: [{ id: 'qwen2.5-7b' }, { id: 'bad name!' }] })).toEqual(['qwen2.5-7b']);
    expect(parseServedModels('ollama', null)).toEqual([]);
    expect(parseServedModels('openai-compatible', { data: 'x' })).toEqual([]);
  });
});

describe('fetchModels', () => {
  it('asks an Ollama server for /api/tags without a key', async () => {
    const m = make({ models: [{ name: 'llama3.1:8b' }] });
    m.store.upsertConnector({ id: 'ollama', kind: 'ollama', name: 'Ollama', baseUrl: 'http://10.0.0.2:11434' });
    expect(await m.ctl.fetchModels('ollama')).toEqual({ success: true, models: ['llama3.1:8b'] });
    expect(m.fetchImpl.mock.calls[0]![0]).toBe('http://10.0.0.2:11434/api/tags');
    expect(m.fetchImpl.mock.calls[0]![1].headers.Authorization).toBeUndefined();
  });

  it('sends the saved key of an OpenAI-compatible server as a bearer token, from main only', async () => {
    const m = make({ data: [{ id: 'my-model' }] });
    m.store.upsertConnector({ id: 'compat-1', kind: 'openai-compatible', name: 'Home', baseUrl: 'http://192.168.1.20:8000/v1', roles: ['chat'] });
    m.store.setKey('compat-1', 'secret-key-12345');
    const res = await m.ctl.fetchModels('compat-1');
    expect(res).toEqual({ success: true, models: ['my-model'] });
    expect(JSON.stringify(res)).not.toContain('secret-key');
    expect(m.fetchImpl.mock.calls[0]![0]).toBe('http://192.168.1.20:8000/v1/models');
    expect(m.fetchImpl.mock.calls[0]![1].headers.Authorization).toBe('Bearer secret-key-12345');
  });

  it('reports a clear error for an unknown connector, one with no server, a bad status, an empty list or no answer', async () => {
    const m = make({ data: [] });
    expect(await m.ctl.fetchModels('../x')).toMatchObject({ success: false });
    expect(await m.ctl.fetchModels('ollama')).toMatchObject({ success: false });
    m.store.upsertConnector({ id: 'openai', kind: 'openai', name: 'OpenAI' });
    expect(await m.ctl.fetchModels('openai')).toMatchObject({ success: false, error: 'This connector has no server to ask.' });
    m.store.upsertConnector({ id: 'compat-1', kind: 'openai-compatible', name: 'Home', baseUrl: 'http://h:1/v1', roles: ['chat'] });
    expect(await m.ctl.fetchModels('compat-1')).toMatchObject({ success: false, error: 'The server did not list any models.' });
    const bad = make({}, 401);
    bad.store.upsertConnector({ id: 'compat-1', kind: 'openai-compatible', name: 'Home', baseUrl: 'http://h:1/v1', roles: ['chat'] });
    expect(await bad.ctl.fetchModels('compat-1')).toMatchObject({ success: false, error: 'The server answered 401.' });
    const down = make({});
    down.store.upsertConnector({ id: 'compat-1', kind: 'openai-compatible', name: 'Home', baseUrl: 'http://h:1/v1', roles: ['chat'] });
    down.fetchImpl.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await down.ctl.fetchModels('compat-1')).toEqual({ success: false, error: 'Could not reach the server.' });
  });
});
