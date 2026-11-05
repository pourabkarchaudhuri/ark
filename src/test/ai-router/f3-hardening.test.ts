/**
 * 1.0.98 F3: AI router hardening. Circuit breaker for failed LiteLLM starts, proxy / CA environment
 * for the child, restarts only when a routed role changed, restart from the current config,
 * keys bound to the address they were saved for, the legacy-slot prototype lookup, Azure sync
 * validation, blocked hosts and redirects for "Fetch from server", the sender-frame guard and the
 * secret shapes.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LitellmSidecar, defaultBaseEnv, mergeNoProxy, type SidecarSpec } from '../../../electron/litellm-sidecar';
import { proxyEnvFromResolved, resolveSessionProxyEnv } from '../../../electron/ai-router/proxy-env';
import { legacySlotOf } from '../../../electron/ai-router/connectors';
import { syncAzureConnector } from '../../../electron/ai-router/legacy-sync';
import { isBlockedHost, isLocalNetworkHost, validateHttpUrl, validateConnectorInput, failed } from '../../../electron/ai-router/types';
import { AiRouterController } from '../../../electron/ipc/ai-router-handlers';
import { isMainAppFrame } from '../../../electron/ipc/sender-guard';
import { scrubSecrets } from '../../../electron/secret-scrub';
import { sidecarDeps, makeStore } from './helpers';
import type { AiRouter } from '../../../electron/ai-router/router';

const spec = (hash = 'h1', routedHash = 'r1', env: Record<string, string> = { ARK_KEY_0: 'sk-ant-api03-TOPSECRET' }, extra: Partial<SidecarSpec> = {}): SidecarSpec => ({
  config: { model_list: [{ model_name: 'ark-chat', litellm_params: { model: 'anthropic/x', api_key: 'os.environ/ARK_KEY_0' } }] },
  env, hash, routedHash, ...extra,
});

function make(over = {}) {
  const t = sidecarDeps(over);
  return { ...t, sidecar: new LitellmSidecar(t.deps) };
}

describe('circuit breaker for failed starts', () => {
  it('a start that just failed is not repeated: queued callers fail fast instead of each spawning Python', async () => {
    const t = make({ startFailureCooldownMs: [60_000] });
    t.state.healthy = () => false;
    await expect(t.sidecar.ensure(spec())).rejects.toThrow(/did not become healthy/);
    expect(t.spawned).toHaveLength(1);
    const results = await Promise.allSettled([t.sidecar.ensure(spec()), t.sidecar.ensure(spec()), t.sidecar.ensure(spec())]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(t.spawned).toHaveLength(1);
  });

  it('a different config may try at once, and Re-check (reset) clears the cooldown', async () => {
    const t = make({ startFailureCooldownMs: [60_000] });
    t.state.healthy = () => false;
    await expect(t.sidecar.ensure(spec('h1'))).rejects.toBeTruthy();
    await expect(t.sidecar.ensure(spec('h2'))).rejects.toBeTruthy();
    expect(t.spawned).toHaveLength(2);
    t.sidecar.reset();
    t.state.healthy = () => true;
    await t.sidecar.ensure(spec('h2'));
    expect(t.sidecar.status().state).toBe('ready');
  });

  it('after three failed starts in a row the sidecar is failed, so the UI offers Re-check', async () => {
    const t = make({ startFailureCooldownMs: [0] });
    t.state.healthy = () => false;
    for (let i = 0; i < 3; i++) await expect(t.sidecar.ensure(spec())).rejects.toBeTruthy();
    expect(t.sidecar.status().state).toBe('failed');
    await expect(t.sidecar.ensure(spec())).rejects.toMatchObject({ code: 'failed_too_often' });
    expect(t.spawned).toHaveLength(3);
  });

  it('a missing runtime is not counted (it is cheap and cannot heal by waiting)', async () => {
    const t = make({ fileExists: () => false, startFailureCooldownMs: [60_000] });
    for (let i = 0; i < 4; i++) await expect(t.sidecar.ensure(spec())).rejects.toMatchObject({ code: 'no_runtime' });
    expect(t.sidecar.status().state).toBe('stopped');
  });

  it('a successful start forgets earlier failures', async () => {
    const t = make({ startFailureCooldownMs: [0] });
    t.state.healthy = () => false;
    await expect(t.sidecar.ensure(spec())).rejects.toBeTruthy();
    await expect(t.sidecar.ensure(spec())).rejects.toBeTruthy();
    t.state.healthy = () => true;
    await t.sidecar.ensure(spec());
    t.state.healthy = () => false;
    await t.sidecar.stop();
    await expect(t.sidecar.ensure(spec())).rejects.toBeTruthy();
    expect(t.sidecar.status().state).toBe('stopped');
  });
});

describe('restart only for routed changes', () => {
  it('the same routed hash keeps the process even when the full hash changed', async () => {
    const t = make();
    await t.sidecar.ensure(spec('h1', 'r1'));
    await t.sidecar.ensure(spec('h2', 'r1'));
    expect(t.spawned).toHaveLength(1);
    expect(t.sidecar.status()).toMatchObject({ routedHash: 'r1', configHash: 'h1' });
  });

  it('a different routed hash restarts', async () => {
    const t = make();
    await t.sidecar.ensure(spec('h1', 'r1'));
    await t.sidecar.ensure(spec('h3', 'r2'));
    expect(t.spawned).toHaveLength(2);
  });

  it('a caller that needs the exact config (a connection test) restarts on any difference', async () => {
    const t = make();
    await t.sidecar.ensure(spec('h1', 'r1'));
    await t.sidecar.ensure(spec('h2', 'r1', undefined, { exact: true }));
    expect(t.spawned).toHaveLength(2);
    await t.sidecar.ensure(spec('h2', 'r1', undefined, { exact: true }));
    expect(t.spawned).toHaveLength(2);
  });
});

describe('restart after a crash uses the current config', () => {
  it('asks the provider, not the spec of the last request', async () => {
    const t = make();
    t.sidecar.setSpecProvider(() => spec('h-new', 'r-new', { ARK_KEY_0: 'sk-ant-api03-FRESHKEY' }));
    await t.sidecar.ensure(spec('h-old', 'r-old', { ARK_KEY_0: 'sk-ant-api03-REMOVEDKEY' }));
    t.spawned[0]!.child.crash(1);
    await vi.waitFor(() => expect(t.sidecar.status().state).toBe('ready'), { timeout: 1000 });
    expect(t.spawned).toHaveLength(2);
    expect(t.spawned[1]!.env.ARK_KEY_0).toBe('sk-ant-api03-FRESHKEY');
  });

  it('does not restart when nothing needs LiteLLM any more', async () => {
    const t = make();
    t.sidecar.setSpecProvider(() => null);
    await t.sidecar.ensure(spec());
    t.spawned[0]!.child.crash(1);
    await new Promise((r) => setTimeout(r, 120));
    expect(t.spawned).toHaveLength(1);
    expect(t.sidecar.status().state).toBe('stopped');
  });
});

describe('proxy and certificate environment for the child', () => {
  it('passes the proxy the session resolved, and the user own variables win', async () => {
    const a = make({ proxyEnv: async () => ({ HTTPS_PROXY: 'http://session-proxy:8080', HTTP_PROXY: 'http://session-proxy:8080' }) });
    await a.sidecar.ensure(spec());
    expect(a.spawned[0]!.env.HTTPS_PROXY).toBe('http://session-proxy:8080');
    const b = make({
      proxyEnv: async () => ({ HTTPS_PROXY: 'http://session-proxy:8080' }),
      baseEnv: () => ({ SystemRoot: 'C:\\Windows', HTTPS_PROXY: 'http://corp:3128', SSL_CERT_FILE: 'C:\\certs\\corp.pem' }),
    });
    await b.sidecar.ensure(spec());
    expect(b.spawned[0]!.env.HTTPS_PROXY).toBe('http://corp:3128');
    expect(b.spawned[0]!.env.SSL_CERT_FILE).toBe('C:\\certs\\corp.pem');
  });

  it('a proxy lookup that throws never stops the start', async () => {
    const t = make({ proxyEnv: async () => { throw new Error('no session'); } });
    await t.sidecar.ensure(spec());
    expect(t.sidecar.status().state).toBe('ready');
  });

  it('keeps the user NO_PROXY and adds loopback', async () => {
    expect(mergeNoProxy(undefined)).toBe('127.0.0.1,localhost,::1');
    expect(mergeNoProxy('corp.local, 10.0.0.0/8')).toBe('corp.local,10.0.0.0/8,127.0.0.1,localhost,::1');
    expect(mergeNoProxy('localhost')).toBe('localhost,127.0.0.1,::1');
    const t = make({ baseEnv: () => ({ SystemRoot: 'C:\\Windows', NO_PROXY: 'corp.local' }) });
    await t.sidecar.ensure(spec());
    expect(t.spawned[0]!.env.NO_PROXY).toBe('corp.local,127.0.0.1,localhost,::1');
  });

  it('the default environment forwards the proxy and CA variables from the app environment, nothing else', () => {
    const keep = { ...process.env };
    try {
      process.env.HTTPS_PROXY = 'http://corp:3128';
      process.env.https_proxy = 'http://corp:3128';
      process.env.REQUESTS_CA_BUNDLE = 'C:\\certs\\corp.pem';
      process.env.SSL_CERT_FILE = 'C:\\certs\\corp.pem';
      process.env.ARK_SECRET_SHOULD_NOT_LEAK = 'x';
      const env = defaultBaseEnv();
      expect(env.HTTPS_PROXY).toBe('http://corp:3128');
      expect(env.https_proxy).toBe('http://corp:3128');
      expect(env.REQUESTS_CA_BUNDLE).toBe('C:\\certs\\corp.pem');
      expect(env.SSL_CERT_FILE).toBe('C:\\certs\\corp.pem');
      expect(env.ARK_SECRET_SHOULD_NOT_LEAK).toBeUndefined();
    } finally {
      for (const k of ['HTTPS_PROXY', 'https_proxy', 'REQUESTS_CA_BUNDLE', 'SSL_CERT_FILE', 'ARK_SECRET_SHOULD_NOT_LEAK']) {
        if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
      }
    }
  });

  it('maps the Electron proxy answer to environment variables, http(s) proxies only', () => {
    expect(proxyEnvFromResolved('PROXY proxy.corp:8080; DIRECT')).toEqual({ HTTPS_PROXY: 'http://proxy.corp:8080', HTTP_PROXY: 'http://proxy.corp:8080' });
    expect(proxyEnvFromResolved('HTTPS secure.corp:443')).toEqual({ HTTPS_PROXY: 'https://secure.corp:443', HTTP_PROXY: 'https://secure.corp:443' });
    expect(proxyEnvFromResolved('DIRECT')).toEqual({});
    expect(proxyEnvFromResolved('SOCKS5 s:1080')).toEqual({});
    expect(proxyEnvFromResolved('PROXY evil;calc.exe:80')).toEqual({});
    expect(proxyEnvFromResolved(undefined)).toEqual({});
  });

  it('resolveSessionProxyEnv leaves an explicit proxy alone, survives errors and gives up on a hung lookup', async () => {
    const lookup = vi.fn(async () => 'PROXY p:1');
    expect(await resolveSessionProxyEnv(lookup, { HTTPS_PROXY: 'http://mine:1' })).toEqual({});
    expect(lookup).not.toHaveBeenCalled();
    expect(await resolveSessionProxyEnv(async () => { throw new Error('x'); }, {})).toEqual({});
    expect(await resolveSessionProxyEnv(() => new Promise<string>(() => undefined), {}, 20)).toEqual({});
    expect(await resolveSessionProxyEnv(lookup, {})).toEqual({ HTTPS_PROXY: 'http://p:1', HTTP_PROXY: 'http://p:1' });
  });

  it('the launcher trusts the Windows certificate store before LiteLLM is imported', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../scripts/litellm/ark_litellm.py'), 'utf8');
    const trust = src.indexOf('truststore.inject_into_ssl()');
    expect(trust).toBeGreaterThan(0);
    expect(trust).toBeLessThan(src.indexOf('from litellm.proxy.proxy_cli import run_server'));
  });
});

describe('a key belongs to the address it was saved for', () => {
  it('changing the host of a keyed connector removes its key and its routes', () => {
    const t = makeStore();
    t.store.upsertConnector({ id: '', kind: 'openai-compatible', name: 'Home', baseUrl: 'http://192.168.1.20:8000/v1', roles: ['chat'] });
    t.store.setKey('compat-1', 'sk-home-key-123456');
    t.store.recordTest('compat-1', { ok: true, at: 1, latencyMs: 1, role: 'chat', model: 'm', message: 'ok' });
    t.store.setRoute('chat', 'compat-1', 'qwen');
    t.store.upsertConnector({ id: 'compat-1', kind: 'openai-compatible', name: 'Home', baseUrl: 'https://attacker.example/v1', roles: ['chat'] });
    expect(t.store.getKey('compat-1')).toBeNull();
    expect(t.store.route('chat').connectorId).toBe('builtin');
  });

  it('a path-only edit or a rename keeps the key', () => {
    const t = makeStore();
    t.store.upsertConnector({ id: '', kind: 'openai-compatible', name: 'Home', baseUrl: 'http://192.168.1.20:8000/v1', roles: ['chat'] });
    t.store.setKey('compat-1', 'sk-home-key-123456');
    t.store.upsertConnector({ id: 'compat-1', kind: 'openai-compatible', name: 'Study', baseUrl: 'http://192.168.1.20:8000/openai/v1', roles: ['chat'] });
    expect(t.store.getKey('compat-1')).toBe('sk-home-key-123456');
  });

  it('pointing a hosted connector (legacy key slot) at another host clears that slot', () => {
    const t = makeStore({ legacy: { anthropic: 'sk-ant-saved-key-1' } });
    t.store.adoptLegacyKeys();
    expect(t.store.hasKey('anthropic')).toBe(true);
    t.store.upsertConnector({ id: 'anthropic', kind: 'anthropic', name: 'Anthropic', baseUrl: 'https://evil.example' });
    expect(t.legacy.slots.anthropic).toBeUndefined();
    expect(t.store.hasKey('anthropic')).toBe(false);
  });

  it('a connector created over an existing Settings key does not inherit it unless the Settings bridge says so', () => {
    const t = makeStore({ legacy: { azureOpenAI: 'azure-key-from-settings-0123456789ab' } });
    t.store.upsertConnector({ id: 'azure-openai', kind: 'azure-openai', name: 'Azure', endpoint: 'https://evil.example', deployment: 'd', apiVersion: '2024-12-01-preview' });
    expect(t.legacy.slots.azureOpenAI).toBeUndefined();
    const u = makeStore({ legacy: { azureOpenAI: 'azure-key-from-settings-0123456789ab' } });
    u.store.upsertConnector({ id: 'azure-openai', kind: 'azure-openai', name: 'Azure', endpoint: 'https://r.openai.azure.com', deployment: 'd', apiVersion: '2024-12-01-preview' }, { keepExistingKey: true });
    expect(u.legacy.slots.azureOpenAI).toBe('azure-key-from-settings-0123456789ab');
  });
});

describe('prototype keys are not connector ids', () => {
  it('legacySlotOf only knows the three real slots', () => {
    expect(legacySlotOf('anthropic')).toBe('anthropic');
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) expect(legacySlotOf(id)).toBeUndefined();
  });

  it('clearKey("constructor") does not wipe the Anthropic key, and unknown connectors are refused', () => {
    const t = makeStore({ legacy: { anthropic: 'sk-ant-saved-key-1' } });
    expect(() => t.store.clearKey('constructor')).toThrow(/Unknown connector/);
    expect(t.legacy.slots.anthropic).toBe('sk-ant-saved-key-1');
    expect(t.store.getKey('constructor')).toBeNull();
    expect(() => t.store.setKey('constructor', 'sk-whatever-123456')).toThrow(/Unknown connector/);
    const ctl = new AiRouterController(() => ({ store: t.store }) as unknown as AiRouter);
    expect(ctl.clearKey('constructor')).toMatchObject({ success: false });
    expect(t.legacy.slots.anthropic).toBe('sk-ant-saved-key-1');
  });
});

describe('Settings Azure sync validates like the providers screen', () => {
  const good = { endpoint: 'https://r.openai.azure.com/', deployment: 'gpt-prod', apiVersion: '2025-04-01-preview' };

  it('accepts a valid payload', () => {
    const t = makeStore();
    expect(syncAzureConnector(t.store, good)).toBe(true);
    expect(t.store.connector('azure-openai')).toMatchObject({ endpoint: 'https://r.openai.azure.com', deployment: 'gpt-prod' });
  });

  it.each([
    ['an os.environ reference as the API version', { ...good, apiVersion: 'os.environ/ARK_KEY_0' }],
    ['an endpoint with credentials', { ...good, endpoint: 'https://u:p@r.openai.azure.com' }],
    ['an endpoint with a query', { ...good, endpoint: 'https://r.openai.azure.com/?x=1' }],
    ['a file: endpoint', { ...good, endpoint: 'file:///c:/secret' }],
    ['a metadata endpoint', { ...good, endpoint: 'http://169.254.169.254/latest' }],
    ['a deployment with a slash', { ...good, deployment: 'a/b' }],
  ])('rejects %s and keeps what was there', (_name, payload) => {
    const t = makeStore();
    syncAzureConnector(t.store, good);
    expect(syncAzureConnector(t.store, payload)).toBe(false);
    expect(t.store.connector('azure-openai')).toMatchObject({ endpoint: 'https://r.openai.azure.com', apiVersion: '2025-04-01-preview' });
  });

  it('moving the endpoint to another host removes the Azure key; the first sync keeps the key from Settings', () => {
    const t = makeStore({ legacy: { azureOpenAI: 'azure-key-from-settings-0123456789ab' } });
    syncAzureConnector(t.store, good);
    expect(t.legacy.slots.azureOpenAI).toBe('azure-key-from-settings-0123456789ab');
    syncAzureConnector(t.store, { ...good, endpoint: 'https://other.openai.azure.com' });
    expect(t.legacy.slots.azureOpenAI).toBeUndefined();
  });
});

describe('addresses a connector may use', () => {
  it('refuses link-local and cloud metadata hosts', () => {
    for (const h of ['169.254.169.254', '169.254.0.1', 'metadata.google.internal', '100.100.100.200', '168.63.129.16', 'fe80::1', '[fd00:ec2::254]', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:6464:64c8', '0.0.0.0']) {
      expect(isBlockedHost(h), h).toBe(true);
    }
    for (const h of ['127.0.0.1', 'localhost', '10.0.0.2', 'api.openai.com', '::1', '192.168.1.5']) expect(isBlockedHost(h), h).toBe(false);
  });

  it('plain http only for this PC and the own network', () => {
    expect(isLocalNetworkHost('localhost')).toBe(true);
    expect(isLocalNetworkHost('192.168.1.20')).toBe(true);
    expect(isLocalNetworkHost('172.20.0.1')).toBe(true);
    expect(isLocalNetworkHost('172.32.0.1')).toBe(false);
    expect(isLocalNetworkHost('myserver')).toBe(true);
    expect(isLocalNetworkHost('example.com')).toBe(false);
    expect(failed(validateHttpUrl('http://example.com/v1', 'The address'))).toBe(true);
    expect(failed(validateHttpUrl('https://example.com/v1', 'The address'))).toBe(false);
    expect(failed(validateHttpUrl('http://192.168.1.20:8000/v1', 'The address'))).toBe(false);
    expect(failed(validateHttpUrl('http://169.254.169.254/latest', 'The address'))).toBe(true);
    expect(failed(validateHttpUrl('https://[::ffff:169.254.169.254]/latest', 'The address'))).toBe(true);
    expect(failed(validateHttpUrl('https://metadata.google.internal/', 'The address'))).toBe(true);
  });

  it('saveConnector refuses them', () => {
    expect(failed(validateConnectorInput({ kind: 'openai-compatible', baseUrl: 'http://169.254.169.254/v1', roles: ['chat'] }))).toBe(true);
    expect(failed(validateConnectorInput({ kind: 'anthropic', baseUrl: 'http://evil.example' }))).toBe(true);
  });
});

describe('Fetch from server', () => {
  it('never asks a stored link-local address and never sends the key there', async () => {
    const f = vi.fn();
    // A value that predates validation (an old settings file) is still refused when asked.
    const file = JSON.stringify({
      version: 1,
      connectors: [{ id: 'builtin', kind: 'builtin', name: 'B' }, { id: 'compat-1', kind: 'openai-compatible', name: 'S', baseUrl: 'http://169.254.169.254/latest', roles: ['chat'] }],
      routes: {}, policy: {}, secrets: {}, vectorsModel: null, rebuild: null,
    });
    const t = makeStore({ file });
    const c = new AiRouterController(() => ({ store: t.store }) as unknown as AiRouter, f as never);
    expect(await c.fetchModels('compat-1')).toMatchObject({ success: false });
    expect(f).not.toHaveBeenCalled();
  });

  it('does not follow redirects (the key would go along)', async () => {
    const t = makeStore();
    t.store.upsertConnector({ id: 'compat-1', kind: 'openai-compatible', name: 'S', baseUrl: 'http://192.168.1.20:8000/v1', roles: ['chat'] });
    t.store.setKey('compat-1', 'sk-compat-key-123456');
    const f = vi.fn(async () => ({ ok: false, status: 302, json: async () => ({}) }));
    const c = new AiRouterController(() => ({ store: t.store }) as unknown as AiRouter, f as never);
    expect(await c.fetchModels('compat-1')).toMatchObject({ success: false });
    expect((f.mock.calls[0] as unknown as [string, { redirect: string }])[1]).toMatchObject({ redirect: 'manual' });
  });
});

describe('sender frame guard', () => {
  const top = { parent: null, routingId: 1, processId: 7 };
  const win = { webContents: { id: 3, mainFrame: top, isDestroyed: () => false }, isDestroyed: () => false };

  it('accepts only the top frame of the main window', () => {
    expect(isMainAppFrame({ sender: { id: 3 }, senderFrame: top }, win)).toBe(true);
    expect(isMainAppFrame({ sender: { id: 3 }, senderFrame: { parent: top, routingId: 9, processId: 7 } }, win)).toBe(false);
  });

  it('refuses another web contents, a missing frame and a closed window', () => {
    expect(isMainAppFrame({ sender: { id: 4 }, senderFrame: top }, win)).toBe(false);
    expect(isMainAppFrame({ sender: { id: 3 }, senderFrame: null }, win)).toBe(false);
    expect(isMainAppFrame({ sender: { id: 3 }, senderFrame: top }, null)).toBe(false);
    expect(isMainAppFrame({ sender: { id: 3 }, senderFrame: top }, { webContents: { id: 3, mainFrame: top, isDestroyed: () => true } })).toBe(false);
    expect(isMainAppFrame(null, win)).toBe(false);
  });
});

describe('secret shapes', () => {
  it('scrubSecrets masks keys in the shapes provider errors echo', () => {
    expect(scrubSecrets('https://x/v1?key=AIzaSyA1234567890abcdefgh&alt=json')).not.toContain('AIzaSyA1234567890abcdefgh');
    expect(scrubSecrets('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig12345678')).not.toContain('eyJhbGci');
    expect(scrubSecrets('plain text about gemma3')).toBe('plain text about gemma3');
  });
});
