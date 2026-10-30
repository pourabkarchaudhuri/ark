/**
 * settings IPC (v1.0.97): key validation, Anthropic rejection as a chat provider (until
 * the AI router serves it), the main-only Azure and Anthropic key slots, and the Azure
 * "Test connection" request that now runs in main.
 * The handler bodies are exported functions; ipcMain wiring is not exercised.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => ({
  setGoogleAIKey: vi.fn(),
  setPreferredChatProvider: vi.fn(),
  setAzureOpenAIKey: vi.fn(),
  clearAzureOpenAIKey: vi.fn(),
  hasAzureOpenAIKey: vi.fn(() => false),
  getAzureOpenAIKey: vi.fn((): string | null => null),
  setAnthropicKey: vi.fn(),
}));

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../electron/settings-store.js', () => ({
  settingsStore: store,
  DEFAULT_OLLAMA_RERANK_MODEL: 'r',
  DEFAULT_OLLAMA_RERANK_QWEN_MODEL: 'q',
}));
vi.mock('../../../electron/rerank-engine.js', () => ({ resetRerankTierCache: vi.fn() }));
vi.mock('../../../electron/ollama-setup.js', () => ({ resetRerankPullAttempts: vi.fn() }));
vi.mock('../../../electron/overlay-window.js', () => ({
  activateOverlay: vi.fn(), deactivateOverlay: vi.fn(), isOverlayCycleHotkeyRegistered: vi.fn(),
}));
vi.mock('../../../electron/session-tracker.js', () => ({ getActiveSessions: vi.fn(() => []), syncOverlayVisibilityLatch: vi.fn() }));
vi.mock('../../../electron/ann-index.js', () => ({ clearIndex: vi.fn(), syncAnnDimsFromSettings: vi.fn() }));

import {
  setGeminiApiKey,
  setPreferredChatProviderIpc,
  setAzureKeyIpc,
  setAnthropicKeyIpc,
  testAzureConnection,
} from '../../../electron/ipc/settings-handlers';

beforeEach(() => {
  vi.clearAllMocks();
  store.getAzureOpenAIKey.mockReturnValue(null);
});

describe('settings:setApiKey', () => {
  it('rejects the masked bullet string and never stores it', async () => {
    expect(await setGeminiApiKey('AIzaSyAB••••••••••••••••wxyz')).toEqual({ success: false, error: expect.any(String) });
    expect(await setGeminiApiKey('')).toMatchObject({ success: false });
    expect(await setGeminiApiKey('has space')).toMatchObject({ success: false });
    expect(store.setGoogleAIKey).not.toHaveBeenCalled();
  });

  it('stores a plausible key', async () => {
    expect(await setGeminiApiKey('AIzaSy_abc-123')).toEqual({ success: true });
    expect(store.setGoogleAIKey).toHaveBeenCalledWith('AIzaSy_abc-123');
  });
});

describe('settings:setPreferredChatProvider', () => {
  it('rejects anthropic and unknown values', async () => {
    expect(await setPreferredChatProviderIpc('anthropic')).toMatchObject({ success: false });
    expect(await setPreferredChatProviderIpc('nope')).toMatchObject({ success: false });
    expect(store.setPreferredChatProvider).not.toHaveBeenCalled();
    expect(await setPreferredChatProviderIpc('gemini')).toEqual({ success: true });
    expect(store.setPreferredChatProvider).toHaveBeenCalledWith('gemini');
  });
});

describe('settings:setAzureKey', () => {
  it('validates and stores the trimmed key', async () => {
    expect(await setAzureKeyIpc('ab••cd')).toMatchObject({ success: false });
    expect(await setAzureKeyIpc('  0123abcdef  ')).toEqual({ success: true });
    expect(store.setAzureOpenAIKey).toHaveBeenCalledWith('0123abcdef');
  });
});

describe('settings:setAnthropicKey', () => {
  it('validates and stores the trimmed key in main', async () => {
    expect(await setAnthropicKeyIpc('sk-ant-••••')).toMatchObject({ success: false });
    expect(await setAnthropicKeyIpc('')).toMatchObject({ success: false });
    expect(store.setAnthropicKey).not.toHaveBeenCalled();
    expect(await setAnthropicKeyIpc(' sk-ant-api03-AbC_d-9 ')).toEqual({ success: true });
    expect(store.setAnthropicKey).toHaveBeenCalledWith('sk-ant-api03-AbC_d-9');
  });
});

describe('settings:testAzureConnection', () => {
  const input = { endpoint: 'https://res.openai.azure.com/', deployment: 'gpt-4o', apiVersion: '' };

  it('needs a saved key and never calls fetch without one', async () => {
    const fetchImpl = vi.fn();
    expect(await testAzureConnection(input, { fetch: fetchImpl as any })).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a non-http endpoint', async () => {
    store.getAzureOpenAIKey.mockReturnValue('k');
    const fetchImpl = vi.fn();
    expect(await testAzureConnection({ ...input, endpoint: 'file:///etc' }, { fetch: fetchImpl as any })).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the stored key from main and reports success', async () => {
    store.getAzureOpenAIKey.mockReturnValue('stored-key');
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '' }));
    const r = await testAzureConnection(input, { fetch: fetchImpl as any });
    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-12-01-preview');
    expect(init.headers['api-key']).toBe('stored-key');
  });

  it('reports the HTTP error body', async () => {
    store.getAzureOpenAIKey.mockReturnValue('stored-key');
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'bad key' }));
    expect(await testAzureConnection(input, { fetch: fetchImpl as any })).toEqual({ ok: false, message: 'bad key' });
  });
});
