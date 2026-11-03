/**
 * "Use my own Ollama" in the built-in connector's Advanced (1.0.97 B36, moved by B37): off by
 * default, the address fields appear only when it is on, a refused switch goes back, a half-typed
 * address does not block other saves, and the reranker probe says what it found.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const emb = vi.hoisted(() => ({ resetAvailability: vi.fn(), clearUnavailableVerdict: vi.fn() }));
vi.mock('@/services/embedding-service', () => ({ embeddingService: emb }));

import { ExternalOllamaSection } from '@/components/settings/external-ollama-section';
import { isHttpUrl } from '@/components/settings/use-ollama-settings';
import { installLocalAi, localAiStatus, removeLocalAi, settle } from './settings-fixtures';

const win = window as unknown as { settings?: Record<string, unknown>; ollama?: Record<string, unknown> };

function installSettings() {
  const s = {
    getOllamaSettings: vi.fn(async () => ({
      enabled: true, url: 'http://localhost:11434', model: 'gemma3:12b', useGeminiInstead: false, rerankModel: 'r',
      neighborRerankEnabled: true, oracleRerankEnabled: true, oracleRerankBlend: 0.6, embeddingChunkingEnabled: true,
      chunkAnnMaxSimEnabled: true, embeddingMrl256Enabled: false, embeddingBatchSize: 0,
    })),
    setOllamaSettings: vi.fn(async () => {}),
  };
  win.settings = s;
  return s;
}

const flush = () => settle(act);

beforeEach(() => { vi.clearAllMocks(); installSettings(); });
afterEach(() => { removeLocalAi(); delete win.settings; delete win.ollama; vi.useRealTimers(); });

describe('the switch', () => {
  it('is off by default and hides the Ollama fields', async () => {
    installLocalAi();
    render(<ExternalOllamaSection />);
    await flush();
    expect(screen.getByRole('switch', { name: 'Use my own Ollama' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByLabelText('Ollama address')).not.toBeInTheDocument();
    expect(screen.queryByText(/Download Ollama/)).not.toBeInTheDocument();
  });

  it('turning it on is saved in main, reveals the address and resets the availability check', async () => {
    const la = installLocalAi();
    render(<ExternalOllamaSection />);
    await flush();
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Use my own Ollama' })); });
    expect(la.api.setExternalOllama).toHaveBeenCalledWith({ enabled: true });
    expect(await screen.findByLabelText('Ollama address')).toBeInTheDocument();
    expect(emb.resetAvailability).toHaveBeenCalled();
  });

  it('goes back when main refuses', async () => {
    const la = installLocalAi();
    la.api.setExternalOllama.mockRejectedValueOnce(new Error('nope'));
    render(<ExternalOllamaSection />);
    await flush();
    const sw = screen.getByRole('switch', { name: 'Use my own Ollama' });
    await act(async () => { fireEvent.click(sw); });
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'));
    expect(screen.queryByLabelText('Ollama address')).not.toBeInTheDocument();
  });

  it('shows the fields when the built-in AI is not reporting (no desktop bridge for it)', async () => {
    render(<ExternalOllamaSection />);
    await flush();
    expect(screen.queryByRole('switch', { name: 'Use my own Ollama' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Ollama address')).toBeInTheDocument();
  });
});

describe('the fields', () => {
  const on = () => installLocalAi(localAiStatus({ backend: 'ollama', externalOllama: { enabled: true, url: 'http://localhost:11434' } }));

  it('an address without a scheme is flagged and left out of the save, so other changes still save', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = installSettings();
    on();
    render(<ExternalOllamaSection />);
    await flush();
    fireEvent.change(screen.getByLabelText('Ollama address'), { target: { value: 'localhost:11434' } });
    fireEvent.change(screen.getByLabelText('Chat model'), { target: { value: 'llama3.1:8b' } });
    expect(screen.getByLabelText('Ollama address')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/Enter a full address starting with http/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(s.setOllamaSettings).toHaveBeenCalledTimes(1);
    const payload = (s.setOllamaSettings.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
    expect(payload).not.toHaveProperty('url');
    expect(payload.model).toBe('llama3.1:8b');
    expect(emb.clearUnavailableVerdict).toHaveBeenCalled();
  });

  it('a valid address is saved as typed, and a save main rejects shows why', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = installSettings();
    on();
    render(<ExternalOllamaSection />);
    await flush();
    s.setOllamaSettings.mockRejectedValueOnce(new Error("Error invoking remote method 'settings:setOllamaSettings': Error: disk full"));
    fireEvent.change(screen.getByLabelText('Ollama address'), { target: { value: 'http://10.0.0.2:11434' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(s.setOllamaSettings).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://10.0.0.2:11434' }));
    expect(screen.getByText('Could not save: disk full')).toBeInTheDocument();
  });

  it('a change made just before leaving is flushed on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = installSettings();
    on();
    const { unmount } = render(<ExternalOllamaSection />);
    await flush();
    fireEvent.change(screen.getByLabelText('Reranker model'), { target: { value: 'my-reranker' } });
    unmount();
    expect(s.setOllamaSettings).toHaveBeenCalledWith(expect.objectContaining({ rerankModel: 'my-reranker' }));
  });

  it('Test reranker reports working, a model that is not pulled, or Ollama not running', async () => {
    on();
    const diag = vi.fn()
      .mockResolvedValueOnce({ rerankWorking: true, ollamaUp: true, modelInstalled: true, latencyMs: 41 })
      .mockResolvedValueOnce({ rerankWorking: false, ollamaUp: true, modelInstalled: false, error: 'pull it' })
      .mockResolvedValueOnce({ rerankWorking: false, ollamaUp: false, modelInstalled: false });
    win.ollama = { rerankDiagnostic: diag };
    render(<ExternalOllamaSection />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Test reranker' }));
    expect(await screen.findByText('Reranker working (41ms)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test reranker' }));
    expect(await screen.findByText('Model not pulled: pull it')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test reranker' }));
    expect(await screen.findByText('Local AI not running')).toBeInTheDocument();
  });
});

describe('isHttpUrl', () => {
  it('accepts only absolute http(s) addresses', () => {
    expect(isHttpUrl('http://localhost:11434')).toBe(true);
    expect(isHttpUrl('localhost:11434')).toBe(false);
    expect(isHttpUrl('file:///c')).toBe(false);
  });
});
