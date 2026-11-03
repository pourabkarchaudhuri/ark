/**
 * Settings → AI Models / General (v1.0.97): the hidden Gemini key can no longer be
 * overwritten with its masked copy, pending debounced saves survive leaving the tab,
 * a half-typed Ollama address does not block toggles, auto-launch rolls back on a
 * failed save, the provider list leaves out Anthropic, the key-storage copy is
 * accurate, and long-job progress follows the service after Settings remounts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';

const emb = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    isRechunkRunning: false,
    rechunkMessage: null as string | null,
    rechunkProgress: { completed: 0, total: 0, phase: 'library' },
    rechunkSuggestRebuildAnn: false,
    rechunkStatus: 'idle',
    isAnnRebuilding: false,
    isForceReindexRunning: false,
    isForceReindexAllRunning: false,
    migrationState: null,
    catalogProgress: { completed: 0, total: 0 },
    refreshMigrationState: vi.fn(async () => {}),
    subscribe: vi.fn((fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }),
    clearUnavailableVerdict: vi.fn(),
    resetAvailability: vi.fn(),
    clearRechunkSuggestRebuildAnn: vi.fn(),
    cancelRechunkJob: vi.fn(),
    startRechunkJob: vi.fn(async () => {}),
    rebuildAnnFromCache: vi.fn(async () => 0),
    forceReindexAll: vi.fn(),
    emit() { for (const l of [...listeners]) l(); },
  };
});

vi.mock('@/services/embedding-service', () => ({ embeddingService: emb }));
vi.mock('@/services/ann-index', () => ({ annIndex: { subscribe: vi.fn(() => () => {}), buildProgress: { done: 0, total: 0 } } }));
vi.mock('@/services/rechunk-job-deps', () => ({ buildRechunkJobDeps: vi.fn(async () => ({})) }));
vi.mock('@/services/catalog-store', () => ({ catalogStore: {} }));
vi.mock('@/services/epic-catalog-store', () => ({ epicCatalogStore: {} }));
vi.mock('@/services/reco-store', () => ({ recoStore: {} }));
vi.mock('@/services/embedding-migration', () => ({ describeReindexAllResult: vi.fn(() => '') }));
// General renders LibraryDataSection (B16), which asks for the last import snapshot on mount.
vi.mock('@/services/library-store', () => ({ libraryStore: { getLastImportSnapshot: vi.fn(() => null) } }));
vi.mock('@/services/game-service', () => ({ gameService: {} }));
vi.mock('@/components/year-wrapped', () => ({ YearWrapped: () => null }));
vi.mock('@/components/settings/embedding-batch-size', () => ({ EmbeddingBatchSizeControl: () => null }));

import { AIModelsTab, GeneralTab, API_KEY_STORAGE_NOTE, KEY_SAVED_PLACEHOLDER, isHttpUrl } from '@/components/settings-screen';
import { listConfiguredChatProviders } from '@/lib/chat-providers';
import { resetLegacyAiKeyMigrationForTests } from '@/lib/ai-key-migration';

const win = window as unknown as { settings?: Record<string, unknown> };

function installSettings(over: Record<string, unknown> = {}) {
  const s = {
    hasApiKey: vi.fn(async () => true),
    setApiKey: vi.fn(async () => ({ success: true })),
    removeApiKey: vi.fn(async () => {}),
    hasAzureKey: vi.fn(async () => false),
    setAzureKey: vi.fn(async () => ({ success: true })),
    clearAzureKey: vi.fn(async () => ({ success: true })),
    testAzureConnection: vi.fn(async () => ({ ok: true, message: 'ok' })),
    hasAnthropicKey: vi.fn(async () => false),
    setAnthropicKey: vi.fn(async () => ({ success: true })),
    clearAnthropicKey: vi.fn(async () => ({ success: true })),
    getOllamaSettings: vi.fn(async () => ({
      enabled: true, url: 'http://localhost:11434', model: 'gemma3:12b', useGeminiInstead: false,
      rerankModel: 'r', neighborRerankEnabled: true, oracleRerankEnabled: true, oracleRerankBlend: 0.6,
      embeddingChunkingEnabled: true, chunkAnnMaxSimEnabled: true, embeddingMrl256Enabled: false, embeddingBatchSize: 0,
    })),
    setOllamaSettings: vi.fn(async () => {}),
    getPreferredChatProvider: vi.fn(async () => 'ollama'),
    setPreferredChatProvider: vi.fn(async () => ({ success: true })),
    getAutoLaunch: vi.fn(async () => true),
    setAutoLaunch: vi.fn(async () => ({ success: true })),
    getBetaFeatures: vi.fn(async () => true),
    setBetaFeatures: vi.fn(async () => ({ success: true })),
    ...over,
  };
  win.settings = s;
  return s;
}

async function renderLoaded() {
  const view = render(<AIModelsTab />);
  // The load effect resolves several promises; let it finish before interacting.
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
  return view;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ark-beta-features', '1');
  resetLegacyAiKeyMigrationForTests();
  emb.listeners.clear();
  emb.isRechunkRunning = false;
  emb.rechunkProgress = { completed: 0, total: 0, phase: 'library' };
  emb.isForceReindexAllRunning = false;
  emb.catalogProgress = { completed: 0, total: 0 };
});
afterEach(() => {
  vi.useRealTimers();
  delete win.settings;
});

describe('Gemini key field', () => {
  it('with a saved key, typing or Backspace never sends the masked string', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = installSettings();
    await renderLoaded();
    const input = await screen.findByLabelText('Gemini API Key') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe(KEY_SAVED_PLACEHOLDER);
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.change(input, { target: { value: '' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    for (const call of s.setApiKey.mock.calls as unknown as string[][]) expect(call[0]).not.toContain('•');
    expect(s.setApiKey).not.toHaveBeenCalled();
  });

  it('pasting a new key saves exactly that key', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = installSettings();
    await renderLoaded();
    fireEvent.change(await screen.findByLabelText('Gemini API Key'), { target: { value: 'AIzaSyNEWKEY_123' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(s.setApiKey).toHaveBeenCalledTimes(1);
    expect(s.setApiKey).toHaveBeenCalledWith('AIzaSyNEWKEY_123');
  });

  it('a key main rejects shows an error instead of Saved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installSettings({ setApiKey: vi.fn(async () => ({ success: false, error: 'That does not look like an API key.' })) });
    await renderLoaded();
    const input = await screen.findByLabelText('Gemini API Key');
    fireEvent.change(input, { target: { value: 'bad' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    const card = within(input.closest('.space-y-4') as HTMLElement);
    expect(card.getByText('That does not look like an API key.')).toBeInTheDocument();
    expect(card.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('a key typed just before leaving the tab is saved in full', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = installSettings({ hasApiKey: vi.fn(async () => false) });
    const { unmount } = await renderLoaded();
    const input = await screen.findByLabelText('Gemini API Key');
    fireEvent.change(input, { target: { value: 'AIza' } });
    fireEvent.change(input, { target: { value: 'AIzaSyFULLKEY' } });
    unmount();
    expect(s.setApiKey).toHaveBeenCalledTimes(1);
    expect(s.setApiKey).toHaveBeenCalledWith('AIzaSyFULLKEY');
  });
});

describe('Ollama settings saves', () => {
  it('a toggle changed just before leaving the tab is still saved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = installSettings();
    const { unmount } = await renderLoaded();
    await act(async () => { await vi.advanceTimersByTimeAsync(900); }); // post-load save
    s.setOllamaSettings.mockClear();
    fireEvent.click(screen.getByRole('switch', { name: 'Rerank similar games' }));
    unmount();
    expect(s.setOllamaSettings).toHaveBeenCalledTimes(1);
    expect(s.setOllamaSettings).toHaveBeenCalledWith(expect.objectContaining({ neighborRerankEnabled: false }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.setOllamaSettings).toHaveBeenCalledTimes(1);
  });

  it('an address without a scheme is left out so toggles still save, and is flagged', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = installSettings();
    await renderLoaded();
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    s.setOllamaSettings.mockClear();
    fireEvent.change(screen.getByPlaceholderText('http://localhost:11434'), { target: { value: 'localhost:11434' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Rerank similar games' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(s.setOllamaSettings).toHaveBeenCalledTimes(1);
    const payload = (s.setOllamaSettings.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(payload).not.toHaveProperty('url');
    expect(payload.neighborRerankEnabled).toBe(false);
    expect(screen.getByText(/Enter a full address starting with http/)).toBeInTheDocument();
  });

  it('a save main rejects shows an error instead of staying on Saving...', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = installSettings();
    await renderLoaded();
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    s.setOllamaSettings.mockRejectedValueOnce(new Error("Error invoking remote method 'settings:setOllamaSettings': Error: disk full"));
    fireEvent.click(screen.getByRole('switch', { name: 'Rerank similar games' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(screen.getByText('Could not save: disk full')).toBeInTheDocument();
    expect(screen.queryByText('Saving...')).not.toBeInTheDocument();
  });
});

describe('providers and key storage', () => {
  it('the provider list never includes Anthropic', () => {
    expect(listConfiguredChatProviders({ ollamaUrl: 'http://x', betaFeatures: true, hasGeminiKey: true, azureConfigured: true }))
      .toEqual(['ollama', 'gemini', 'azure-openai']);
  });

  it('keys go to main, not localStorage, and the copy says how they are stored', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = installSettings();
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('API Key', { selector: '#azure-api-key' }), { target: { value: 'azurekey123' } });
    fireEvent.change(screen.getByLabelText('API Key', { selector: '#anthropic-api-key' }), { target: { value: 'sk-ant-api03-x' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(s.setAzureKey).toHaveBeenCalledWith('azurekey123');
    expect(s.setAnthropicKey).toHaveBeenCalledWith('sk-ant-api03-x');
    expect(localStorage.getItem('ark-azure-key')).toBeNull();
    expect(localStorage.getItem('ark-anthropic-key')).toBeNull();
    expect(screen.getByText((t) => t.includes(API_KEY_STORAGE_NOTE))).toBeInTheDocument();
    expect(screen.queryByText(/All API keys are stored securely/)).not.toBeInTheDocument();
    expect(API_KEY_STORAGE_NOTE).toMatchInlineSnapshot(`"Gemini, Azure OpenAI and Anthropic keys are stored encrypted on this computer and are only sent to that provider. A saved key is never shown again."`);
  });

  it('Azure test connection runs in main without sending a key', async () => {
    installSettings({ hasAzureKey: vi.fn(async () => true) });
    localStorage.setItem('ark-azure-endpoint', 'https://x.openai.azure.com');
    localStorage.setItem('ark-azure-deployment', 'gpt-4o');
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Test connection/ }));
    await waitFor(() => expect(win.settings!.testAzureConnection).toHaveBeenCalledWith({ endpoint: 'https://x.openai.azure.com', deployment: 'gpt-4o', apiVersion: '' }));
  });

  it('isHttpUrl accepts only absolute http(s) addresses', () => {
    expect(isHttpUrl('http://localhost:11434')).toBe(true);
    expect(isHttpUrl('localhost:11434')).toBe(false);
    expect(isHttpUrl('file:///c')).toBe(false);
  });
});

describe('long-job progress after reopening Settings', () => {
  it('a remounted tab shows re-chunk progress from the service and clears it when done', async () => {
    installSettings();
    emb.isRechunkRunning = true;
    emb.rechunkProgress = { completed: 3, total: 10, phase: 'library' };
    const first = await renderLoaded();
    first.unmount();
    expect(emb.listeners.size).toBe(0);
    await renderLoaded();
    expect(screen.getByText('library: 3 / 10')).toBeInTheDocument();
    emb.rechunkProgress = { completed: 7, total: 10, phase: 'library' };
    act(() => emb.emit());
    expect(screen.getByText('library: 7 / 10')).toBeInTheDocument();
    emb.isRechunkRunning = false;
    act(() => emb.emit());
    expect(screen.queryByText(/library: \d+ \/ 10/)).not.toBeInTheDocument();
  });

  it('a remounted tab shows force re-index counts from the service', async () => {
    installSettings();
    emb.isForceReindexAllRunning = true;
    emb.catalogProgress = { completed: 5, total: 50 };
    await renderLoaded();
    expect(screen.getByText('5 / 50 games')).toBeInTheDocument();
    emb.catalogProgress = { completed: 20, total: 50 };
    act(() => emb.emit());
    expect(screen.getByText('20 / 50 games')).toBeInTheDocument();
  });
});

describe('General → Launch on startup', () => {
  it('reverts the toggle when main reports success:false', async () => {
    const s = installSettings({ setAutoLaunch: vi.fn(async () => ({ success: false, error: 'x' })) });
    render(<GeneralTab />);
    const sw = await screen.findByRole('switch', { name: 'Launch on startup' });
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    await act(async () => { fireEvent.click(sw); });
    expect(s.setAutoLaunch).toHaveBeenCalledWith(false);
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
  });
});


describe('AI Models → built-in local AI and "use my own Ollama" (1.0.97 B36)', () => {
  const localAiStatus = (enabled: boolean) => ({
    backend: enabled ? 'ollama' : 'builtin',
    runtime: { available: true, build: 'b11780', roles: [] },
    models: [],
    modelsDir: 'C:\models',
    diskUsedBytes: 0,
    diskFreeBytes: null,
    paused: false,
    declined: false,
    compute: null,
    chatModel: { id: 'gemma3-12b', label: 'gemma3', sizeBytes: 7e9 },
    externalOllama: { enabled, url: 'http://localhost:11434' },
  });

  afterEach(() => { delete (window as unknown as { localAi?: unknown }).localAi; });

  it('shows the built-in section and hides the Ollama fields while the switch is off', async () => {
    installSettings();
    (window as unknown as { localAi?: unknown }).localAi = {
      status: vi.fn(async () => localAiStatus(false)),
      onStatusChanged: vi.fn(() => () => {}),
      setExternalOllama: vi.fn(),
    };
    await renderLoaded();
    expect(await screen.findByTestId('built-in-local-ai')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Use my own Ollama' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText('Ollama address')).not.toBeInTheDocument();
    expect(screen.queryByText(/Download Ollama/)).not.toBeInTheDocument();
  });

  it('turning the switch on saves it in main and reveals the Ollama address', async () => {
    installSettings();
    const setExternalOllama = vi.fn(async () => localAiStatus(true));
    (window as unknown as { localAi?: unknown }).localAi = {
      status: vi.fn(async () => localAiStatus(false)),
      onStatusChanged: vi.fn(() => () => {}),
      setExternalOllama,
    };
    await renderLoaded();
    const sw = await screen.findByRole('switch', { name: 'Use my own Ollama' });
    await act(async () => { fireEvent.click(sw); });
    expect(setExternalOllama).toHaveBeenCalledWith({ enabled: true });
    expect(await screen.findByText('Ollama address')).toBeInTheDocument();
    expect(emb.resetAvailability).toHaveBeenCalled();
  });

  it('puts the switch back when main refuses', async () => {
    installSettings();
    (window as unknown as { localAi?: unknown }).localAi = {
      status: vi.fn(async () => localAiStatus(false)),
      onStatusChanged: vi.fn(() => () => {}),
      setExternalOllama: vi.fn(async () => { throw new Error('nope'); }),
    };
    await renderLoaded();
    const sw = await screen.findByRole('switch', { name: 'Use my own Ollama' });
    await act(async () => { fireEvent.click(sw); });
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'));
    expect(screen.queryByText('Ollama address')).not.toBeInTheDocument();
  });
});
