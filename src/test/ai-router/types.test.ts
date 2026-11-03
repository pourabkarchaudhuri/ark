/**
 * AI router data model (1.0.97 B35): which connector can serve which role, and the validators that
 * stand between the renderer's IPC payloads and the store.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_POLICY, KIND_ROLES, connectorServes, failed, validateConnectorInput, validateHttpUrl, validateKeyInput,
  validateModelName, validatePolicyInput, validateRouteInput, type Connector,
} from '../../../electron/ai-router/types';

describe('roles per connector kind', () => {
  it('built-in serves all three roles; Anthropic chat only; Ollama no reranker', () => {
    expect(KIND_ROLES.builtin).toEqual(['chat', 'embeddings', 'reranker']);
    expect(KIND_ROLES.anthropic).toEqual(['chat']);
    expect(KIND_ROLES.ollama).not.toContain('reranker');
  });

  it('an OpenAI-compatible server serves exactly the roles it lists', () => {
    const c: Pick<Connector, 'kind' | 'roles'> = { kind: 'openai-compatible', roles: ['embeddings', 'reranker'] };
    expect(connectorServes(c, 'embeddings')).toBe(true);
    expect(connectorServes(c, 'reranker')).toBe(true);
    expect(connectorServes(c, 'chat')).toBe(false);
    expect(connectorServes({ kind: 'openai-compatible' }, 'chat')).toBe(false);
  });
});

describe('validateHttpUrl', () => {
  it('accepts http(s), strips trailing slashes, keeps a path', () => {
    expect(validateHttpUrl('https://api.example.com/v1/', 'x')).toEqual({ ok: true, value: 'https://api.example.com/v1' });
    expect(validateHttpUrl(' http://localhost:11434 ', 'x')).toEqual({ ok: true, value: 'http://localhost:11434' });
  });

  it('rejects other schemes, credentials, queries and junk', () => {
    for (const bad of ['ftp://x.com', 'file:///c:/x', 'https://user:pw@x.com', 'https://x.com/?key=1', 'nonsense', '', 5, null]) {
      expect(failed(validateHttpUrl(bad, 'The address'))).toBe(true);
    }
  });
});

describe('validateModelName / validateKeyInput', () => {
  it('model names: provider-style tags are fine, whitespace and shell characters are not', () => {
    for (const ok of ['gpt-5', 'gemma3:12b', 'dengcao/Qwen3-Reranker-0.6B:Q8_0', 'claude-sonnet-5-5', 'text-embedding-3-small']) {
      expect(validateModelName(ok)).toEqual({ ok: true, value: ok });
    }
    for (const bad of ['', 'a b', 'x;rm', '../x', 'a'.repeat(201), 3]) expect(failed(validateModelName(bad))).toBe(true);
  });

  it('keys: printable, no whitespace, bounded', () => {
    expect(validateKeyInput('  sk-ant-api03-abcdef  ')).toEqual({ ok: true, value: 'sk-ant-api03-abcdef' });
    for (const bad of ['short', 'has space inside1234', 'x'.repeat(501), 'tab\there1234', 42, undefined]) {
      expect(failed(validateKeyInput(bad))).toBe(true);
    }
  });
});

describe('validateConnectorInput', () => {
  it('Ollama needs an address and gets the fixed id', () => {
    const r = validateConnectorInput({ kind: 'ollama', baseUrl: 'http://192.168.1.5:11434/', name: '  Lab box ' });
    expect(r).toEqual({ ok: true, value: { id: 'ollama', kind: 'ollama', name: 'Lab box', baseUrl: 'http://192.168.1.5:11434' } });
    expect(failed(validateConnectorInput({ kind: 'ollama' }))).toBe(true);
  });

  it('Azure OpenAI needs endpoint and deployment and defaults the API version', () => {
    const r = validateConnectorInput({ kind: 'azure-openai', endpoint: 'https://x.openai.azure.com/', deployment: 'gpt-5' });
    expect(r).toMatchObject({ ok: true, value: { id: 'azure-openai', endpoint: 'https://x.openai.azure.com', deployment: 'gpt-5', apiVersion: '2024-12-01-preview' } });
    expect(failed(validateConnectorInput({ kind: 'azure-openai', endpoint: 'https://x.openai.azure.com' }))).toBe(true);
    expect(failed(validateConnectorInput({ kind: 'azure-openai', endpoint: 'https://x.openai.azure.com', deployment: 'a b' }))).toBe(true);
    expect(failed(validateConnectorInput({ kind: 'azure-openai', endpoint: 'https://x.openai.azure.com', deployment: 'd', apiVersion: 'x y' }))).toBe(true);
  });

  it('an OpenAI-compatible server needs address and at least one valid role; extra fields are dropped', () => {
    const r = validateConnectorInput({ kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', roles: ['chat', 'bogus', 'chat'], apiKey: 'sk-should-not-pass' });
    expect(r).toEqual({ ok: true, value: { id: '', kind: 'openai-compatible', name: 'OpenAI-compatible server', baseUrl: 'http://127.0.0.1:1234/v1', roles: ['chat'] } });
    expect(failed(validateConnectorInput({ kind: 'openai-compatible', baseUrl: 'http://x', roles: [] }))).toBe(true);
    expect(JSON.stringify(r)).not.toContain('sk-should-not-pass');
  });

  it('the built-in connector, unknown kinds and a forged compat id are refused', () => {
    expect(failed(validateConnectorInput({ kind: 'builtin' }))).toBe(true);
    expect(failed(validateConnectorInput({ kind: 'mystery' }))).toBe(true);
    expect(failed(validateConnectorInput({ kind: 'openai-compatible', id: 'builtin', baseUrl: 'http://x', roles: ['chat'] }))).toBe(true);
    expect(failed(validateConnectorInput(null))).toBe(true);
  });
});

describe('validateRouteInput / validatePolicyInput', () => {
  it('routes: role, connector id and a clean model', () => {
    expect(validateRouteInput({ role: 'chat', connectorId: 'anthropic', model: 'claude-sonnet-5-5' }))
      .toEqual({ ok: true, value: { role: 'chat', connectorId: 'anthropic', model: 'claude-sonnet-5-5' } });
    expect(validateRouteInput({ role: 'chat', connectorId: 'openai' })).toMatchObject({ ok: true, value: { model: '' } });
    for (const bad of [{ role: 'speech', connectorId: 'x', model: 'm' }, { role: 'chat', connectorId: 'Bad Id', model: 'm' }, { role: 'chat', connectorId: 'x', model: 'a b' }, null]) {
      expect(failed(validateRouteInput(bad))).toBe(true);
    }
  });

  it('policy: only the offered choices are accepted; unspecified fields keep their value', () => {
    expect(validatePolicyInput({ onFail: 'use-fallback', timeoutSec: 60 }, DEFAULT_POLICY)).toEqual({
      ok: true, value: { ...DEFAULT_POLICY, onFail: 'use-fallback', timeoutSec: 60 },
    });
    for (const bad of [{ onFail: 'explode' }, { timeoutSec: 45 }, { retries: 5 }, { recheckMin: 7 }, { testOnKeySave: 'yes' }, 'x']) {
      expect(failed(validatePolicyInput(bad, DEFAULT_POLICY))).toBe(true);
    }
  });
});
