/**
 * "Base URL override" in a connector's Advanced section (1.0.97 B37): Gemini, Anthropic and OpenAI
 * can point at a proxy or self-hosted gateway; the address is validated, reaches LiteLLM as
 * `api_base`, and is absent when not set.
 */
import { describe, it, expect } from 'vitest';
import { buildLitellmConfig } from '../../../electron/ai-router/litellm-config';
import { DEFAULT_POLICY, validateConnectorInput, type Connector, type Routes } from '../../../electron/ai-router/types';

describe('validateConnectorInput baseUrl for hosted providers', () => {
  it('accepts a clean http(s) address, trims the trailing slash, and drops an empty one', () => {
    expect(validateConnectorInput({ kind: 'anthropic', baseUrl: 'https://gateway.example.com/anthropic/' })).toMatchObject({ ok: true, value: { baseUrl: 'https://gateway.example.com/anthropic' } });
    const none = validateConnectorInput({ kind: 'openai', baseUrl: '  ' });
    expect(none.ok && 'baseUrl' in none.value).toBe(false);
  });

  it('refuses a bad scheme, credentials in the address or a query', () => {
    expect(validateConnectorInput({ kind: 'gemini', baseUrl: 'ftp://x' })).toMatchObject({ ok: false });
    expect(validateConnectorInput({ kind: 'openai', baseUrl: 'https://u:p@x.com' })).toMatchObject({ ok: false });
    expect(validateConnectorInput({ kind: 'anthropic', baseUrl: 'https://x.com/?k=1' })).toMatchObject({ ok: false });
  });
});

describe('litellm config api_base', () => {
  const builtin: Connector = { id: 'builtin', kind: 'builtin', name: 'Built-in' };
  const routes = (id: string, model: string): Routes => ({
    chat: { connectorId: id, model },
    embeddings: { connectorId: 'builtin', model: 'e' },
    reranker: { connectorId: 'builtin', model: 'r' },
  });

  it('sets api_base for an override and leaves it out otherwise', () => {
    for (const kind of ['gemini', 'anthropic', 'openai'] as const) {
      const withBase: Connector = { id: kind, kind, name: kind, baseUrl: 'https://gw.example.com/v1' };
      const a = buildLitellmConfig({ connectors: [builtin, withBase], routes: routes(kind, 'm'), policy: DEFAULT_POLICY, getKey: () => 'key-1234567' });
      expect(a.config.model_list.find((m) => m.model_name === 'ark-chat')!.litellm_params.api_base).toBe('https://gw.example.com/v1');
      const plain: Connector = { id: kind, kind, name: kind };
      const b = buildLitellmConfig({ connectors: [builtin, plain], routes: routes(kind, 'm'), policy: DEFAULT_POLICY, getKey: () => 'key-1234567' });
      expect(b.config.model_list.find((m) => m.model_name === 'ark-chat')!.litellm_params).not.toHaveProperty('api_base');
    }
  });
});
