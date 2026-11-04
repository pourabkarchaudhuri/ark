/**
 * Settings "Built-in local AI" panel, the splash download line and the fill-in after the models
 * finish: every state the plan lists (ready, downloading x%, missing, error with Retry / Continue
 * without local AI, chat model size prompt, remove confirmation) plus the pure helpers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';

const emb = vi.hoisted(() => ({
  clearUnavailableVerdict: vi.fn(),
  isAvailable: vi.fn(async () => true),
}));
vi.mock('@/services/embedding-service', () => ({ embeddingService: emb }));

import { BuiltInLocalAiPanel, orderModels } from '@/components/settings/built-in-local-ai';
import { LocalAiSplashStatus } from '@/components/local-ai-splash-status';
import {
  describeModelState, formatBytes, summarizeAutoDownload, firstAutoError,
  type LocalAiStatus, type LocalAiModelStatus,
} from '@/services/local-ai-types';
import {
  handleModelsSettled, registerCatalogPipelineStarter, initLocalAiFillIn, __resetLocalAiFillInForTests,
} from '@/services/local-ai-fill-in';

function model(over: Partial<LocalAiModelStatus> & { id: string }): LocalAiModelStatus {
  return {
    role: 'embed', label: over.id, file: `${over.id}.gguf`, auto: true, sizeBytes: 1_000_000_000,
    state: 'ready', transferred: 0, pct: 0, source: null, error: null, ...over,
  };
}

function status(over: Partial<LocalAiStatus> = {}): LocalAiStatus {
  return {
    backend: 'builtin',
    runtime: { available: true, build: 'b11780', roles: [] },
    models: [
      model({ id: 'arctic-embed2', label: 'snowflake-arctic-embed2 (embeddings)', role: 'embed', sizeBytes: 1_160_285_024 }),
      model({ id: 'bge-reranker-v2-m3', label: 'bge-reranker-v2-m3 (reranker)', role: 'rerank', state: 'downloading', pct: 40, transferred: 400_000_000 }),
      model({ id: 'gemma3-12b', label: 'gemma3:12b Q4_K_M (local chat)', role: 'chat', auto: false, state: 'missing', sizeBytes: 7_309_830_496 }),
    ],
    modelsDir: 'C:\\Users\\me\\AppData\\Local\\Ark\\models',
    diskUsedBytes: 1_560_285_024,
    diskFreeBytes: 120_000_000_000,
    paused: false,
    declined: false,
    compute: 'gpu', computeDevice: 'NVIDIA GeForce RTX 3070 Ti Laptop GPU', computeVramBytes: 1024 * 1024 * 1024,
    chatModel: { id: 'gemma3-12b', label: 'gemma3:12b Q4_K_M (local chat)', sizeBytes: 7_309_830_496 },
    externalOllama: { enabled: false, url: 'http://localhost:11434' },
    ...over,
  };
}

function installApi(initial: LocalAiStatus, over: Record<string, unknown> = {}) {
  let push: ((s: LocalAiStatus) => void) | null = null;
  const api = {
    status: vi.fn(async () => initial),
    downloadChat: vi.fn(async () => initial),
    recheck: vi.fn(async () => initial),
    retry: vi.fn(async () => initial),
    pause: vi.fn(async () => initial),
    continueWithout: vi.fn(async () => status({ declined: true })),
    removeModels: vi.fn(async () => initial),
    changeFolder: vi.fn(async () => ({ cancelled: false, status: initial })),
    resetFolder: vi.fn(async () => initial),
    setExternalOllama: vi.fn(async () => initial),
    onStatusChanged: vi.fn((cb: (s: LocalAiStatus) => void) => { push = cb; return () => { push = null; }; }),
    onModelsSettled: vi.fn(() => () => undefined),
    ...over,
  };
  (window as unknown as { localAi?: unknown }).localAi = api;
  return { api, push: (s: LocalAiStatus) => act(async () => { push?.(s); }) };
}

async function flush() { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); }

beforeEach(() => { emb.clearUnavailableVerdict.mockClear(); emb.isAvailable.mockClear(); });
afterEach(() => { delete (window as unknown as { localAi?: unknown }).localAi; __resetLocalAiFillInForTests(); });

describe('helpers', () => {
  it('formats sizes and model states for the table', () => {
    expect(formatBytes(1_160_285_024)).toBe('1.2 GB');
    expect(formatBytes(639_150_816)).toBe('639 MB');
    expect(formatBytes(0)).toBe('0 MB');
    expect(describeModelState({ state: 'ready', pct: 100, error: null })).toBe('Ready');
    expect(describeModelState({ state: 'downloading', pct: 42, error: null })).toBe('Downloading 42%');
    expect(describeModelState({ state: 'missing', pct: 0, error: null })).toBe('Not downloaded');
    expect(describeModelState({ state: 'paused', pct: 10, error: null })).toBe('Paused at 10%');
    expect(describeModelState({ state: 'error', pct: 0, error: { code: 'offline', message: 'No connection to the download server' } })).toBe('No connection to the download server');
  });

  it('summarises automatic downloads and ignores the optional chat model', () => {
    const s = status();
    const sum = summarizeAutoDownload(s.models)!;
    expect(sum.label).toMatch(/bge-reranker/);
    expect(sum.pct).toBeGreaterThan(0);
    expect(sum.pct).toBeLessThan(100);
    expect(summarizeAutoDownload([model({ id: 'a' }), model({ id: 'c', auto: false, state: 'downloading' })])).toBeNull();
  });

  it('firstAutoError only reports once nothing is still downloading', () => {
    const failed = model({ id: 'x', state: 'error', error: { code: 'disk_full', message: 'Not enough disk space' } });
    expect(firstAutoError([failed])?.id).toBe('x');
    expect(firstAutoError([failed, model({ id: 'y', state: 'downloading' })])).toBeNull();
  });

  it('lists the automatic models before the optional chat model', () => {
    expect(orderModels(status().models).map((m) => m.id)).toEqual(['arctic-embed2', 'bge-reranker-v2-m3', 'gemma3-12b']);
  });
});

describe('BuiltInLocalAiPanel', () => {
  it('shows runtime, compute, folder, disk and each model state', async () => {
    installApi(status());
    render(<BuiltInLocalAiPanel />);
    await flush();
    expect(screen.getByText('llama.cpp b11780')).toBeInTheDocument();
    expect(screen.getByText(/GPU \(Vulkan\): NVIDIA GeForce RTX 3070 Ti Laptop GPU/)).toBeInTheDocument();
    expect(screen.getByText(/Ark\\models/)).toBeInTheDocument();
    expect(screen.getByTestId('model-state-arctic-embed2')).toHaveTextContent('Ready');
    expect(screen.getByTestId('model-state-bge-reranker-v2-m3')).toHaveTextContent('Downloading 40%');
    expect(screen.getByTestId('model-state-gemma3-12b')).toHaveTextContent('Not downloaded');
    expect(screen.getByText(/Ollama no longer needs installing/)).toBeInTheDocument();
  });

  it('says CPU, and why, when no GPU is in use', async () => {
    installApi(status({ compute: 'cpu', computeDevice: null, computeVramBytes: 0 }));
    render(<BuiltInLocalAiPanel />);
    await flush();
    expect(screen.getByText('CPU (no usable GPU found)')).toBeInTheDocument();
  });

  it('updates live from status pushes', async () => {
    const t = installApi(status());
    render(<BuiltInLocalAiPanel />);
    await flush();
    await t.push(status({ models: status().models.map((m) => (m.id === 'bge-reranker-v2-m3' ? { ...m, state: 'ready' as const, pct: 100 } : m)) }));
    expect(screen.getByTestId('model-state-bge-reranker-v2-m3')).toHaveTextContent('Ready');
  });

  it('the chat model needs the size prompt before anything downloads', async () => {
    const t = installApi(status());
    render(<BuiltInLocalAiPanel />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Download chat model' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/about 7\.3 GB/)).toBeInTheDocument();
    expect(t.api.downloadChat).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: /Download 7\.3 GB/ }));
    await flush();
    expect(t.api.downloadChat).toHaveBeenCalledWith({ confirmed: true });
  });

  it('Remove models asks first, then removes', async () => {
    const t = installApi(status());
    render(<BuiltInLocalAiPanel />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Remove models' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(t.api.removeModels).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove models' }));
    await flush();
    expect(t.api.removeModels).toHaveBeenCalledTimes(1);
  });

  it('Re-check, Change folder and Pause call through; Retry appears only after a failure', async () => {
    const t = installApi(status());
    const { unmount } = render(<BuiltInLocalAiPanel />);
    await flush();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await flush();
    expect(t.api.pause).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    await flush();
    expect(t.api.recheck).toHaveBeenCalled();
    unmount();

    const failed = status({ models: [model({ id: 'arctic-embed2', state: 'error', error: { code: 'offline', message: 'No connection to the download server' } })] });
    const t2 = installApi(failed);
    render(<BuiltInLocalAiPanel />);
    await flush();
    expect(screen.getByTestId('model-state-arctic-embed2')).toHaveTextContent('No connection to the download server');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(t2.api.retry).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Change folder' }));
    await flush();
    expect(t2.api.changeFolder).toHaveBeenCalled();
  });

  it('shows the error when an action fails and says when downloads are off', async () => {
    const t = installApi(status({ declined: true }), { recheck: vi.fn(async () => { throw new Error('disk exploded'); }) });
    render(<BuiltInLocalAiPanel />);
    await flush();
    expect(screen.getByText(/downloads are off for this session/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('disk exploded');
    expect(t.api.recheck).toHaveBeenCalled();
  });

  it('without the desktop bridge it says so instead of crashing', () => {
    render(<BuiltInLocalAiPanel />);
    expect(screen.getByText(/available in the desktop app/)).toBeInTheDocument();
  });
});

describe('LocalAiSplashStatus', () => {
  it('shows download progress and says Ark works without it meanwhile', async () => {
    installApi(status());
    render(<LocalAiSplashStatus />);
    await flush();
    const line = screen.getByTestId('local-ai-splash-progress');
    expect(line).toHaveTextContent(/Downloading bge-reranker-v2-m3/);
    expect(line).toHaveTextContent(/works without it/);
  });

  it('on a failed download offers Retry and "Continue without local AI"', async () => {
    const failed = status({
      models: [model({ id: 'arctic-embed2', state: 'error', error: { code: 'disk_full', message: 'Not enough disk space: 1.7 GB needed' } })],
    });
    const t = installApi(failed);
    render(<LocalAiSplashStatus />);
    await flush();
    expect(screen.getByTestId('local-ai-splash-error')).toHaveTextContent('Not enough disk space');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(t.api.retry).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue without local AI' }));
    await flush();
    expect(t.api.continueWithout).toHaveBeenCalled();
    // After continuing, the error line is gone (declined).
    expect(screen.queryByTestId('local-ai-splash-error')).not.toBeInTheDocument();
  });

  it('is silent when everything is ready, on the user\'s own Ollama, and without the bridge', async () => {
    installApi(status({ models: [model({ id: 'arctic-embed2' })] }));
    const { container, unmount } = render(<LocalAiSplashStatus />);
    await flush();
    expect(container).toBeEmptyDOMElement();
    unmount();
    installApi(status({ backend: 'ollama' }));
    const second = render(<LocalAiSplashStatus />);
    await flush();
    expect(second.container).toBeEmptyDOMElement();
    second.unmount();
    delete (window as unknown as { localAi?: unknown }).localAi;
    const third = render(<LocalAiSplashStatus />);
    expect(third.container).toBeEmptyDOMElement();
  });
});

describe('fill-in after the models finish downloading', () => {
  it('drops the unavailable verdict and starts the catalog pipeline once the embedder works', async () => {
    const starter = vi.fn();
    registerCatalogPipelineStarter(starter);
    expect(await handleModelsSettled({ embeddingReady: true })).toBe(true);
    expect(emb.clearUnavailableVerdict).toHaveBeenCalled();
    expect(starter).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the embedder is still not ready', async () => {
    const starter = vi.fn();
    registerCatalogPipelineStarter(starter);
    expect(await handleModelsSettled({ embeddingReady: false })).toBe(false);
    expect(emb.clearUnavailableVerdict).not.toHaveBeenCalled();
    expect(starter).not.toHaveBeenCalled();
    emb.isAvailable.mockResolvedValueOnce(false);
    expect(await handleModelsSettled({ embeddingReady: true })).toBe(false);
    expect(starter).not.toHaveBeenCalled();
  });

  it('subscribes once per window', () => {
    const onModelsSettled = vi.fn(() => () => undefined);
    (window as unknown as { localAi?: unknown }).localAi = { onModelsSettled };
    initLocalAiFillIn();
    initLocalAiFillIn();
    expect(onModelsSettled).toHaveBeenCalledTimes(1);
  });
});
