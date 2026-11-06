/**
 * Settings → Game understanding (1.0.97 B37): every control is wired to the setting it stands for
 * (saved after a pause, flushed when leaving, errors shown), the status tiles, and the maintenance
 * jobs with the StatesSystem states: rebuild in progress, interrupted with Resume, graphics memory
 * tight / too high, and the runtime not running. Long-job progress follows the service, so
 * reopening Settings mid-job keeps counting.
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
    migrationState: null as null | Record<string, unknown>,
    catalogProgress: { completed: 0, total: 0 },
    refreshMigrationState: vi.fn(async () => {}),
    subscribe: vi.fn((fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }),
    clearUnavailableVerdict: vi.fn(),
    resetAvailability: vi.fn(),
    clearRechunkSuggestRebuildAnn: vi.fn(),
    cancelRechunkJob: vi.fn(),
    cancelLibraryEmbeddings: vi.fn(),
    cancelCatalogEmbeddings: vi.fn(),
    startRechunkJob: vi.fn(async () => {}),
    rebuildAnnFromCache: vi.fn(async () => 1234),
    forceReindexAll: vi.fn(async () => ({ complete: true })),
    emit() { for (const l of [...listeners]) l(); },
  };
});
const ann = vi.hoisted(() => ({
  isReady: true, isPartial: false, isBuilding: false, vectorCount: 5000, buildProgress: { done: 0, total: 0 },
  subscribe: vi.fn(() => () => {}),
}));

vi.mock('@/services/embedding-service', () => ({ embeddingService: emb }));
vi.mock('@/services/ann-index', () => ({ annIndex: ann }));
vi.mock('@/services/rechunk-job-deps', () => ({ buildRechunkJobDeps: vi.fn(async () => ({})) }));
vi.mock('@/services/catalog-store', () => ({ catalogStore: {} }));
vi.mock('@/services/epic-catalog-store', () => ({ epicCatalogStore: {} }));
vi.mock('@/services/reco-store', () => ({ recoStore: {} }));
vi.mock('@/services/embedding-migration', () => ({ describeReindexAllResult: vi.fn(() => 'Rebuilt everything: 40 library, 900 Steam, 300 Epic') }));

import { GameUnderstandingPage } from '@/components/settings/game-understanding-page';
import {
  builtinConnector, connector, installLocalAi, installRouter, localAiStatus, removeLocalAi, removeRouter, routerState, settle,
} from './settings-fixtures';

const win = window as unknown as { settings?: Record<string, unknown>; ollama?: Record<string, unknown> };

function installSettings(over: Record<string, unknown> = {}) {
  const s = {
    getOllamaSettings: vi.fn(async () => ({
      enabled: true, url: 'http://localhost:11434', model: 'gemma3:12b', useGeminiInstead: false,
      rerankModel: 'r', neighborRerankEnabled: true, oracleRerankEnabled: true, oracleRerankBlend: 0.6,
      embeddingChunkingEnabled: true, chunkAnnMaxSimEnabled: true, embeddingMrl256Enabled: false, embeddingBatchSize: 0,
    })),
    setOllamaSettings: vi.fn(async () => {}),
    ...over,
  };
  win.settings = s;
  return s;
}

async function renderPage(onNavigate = vi.fn()) {
  const view = render(<GameUnderstandingPage onNavigate={onNavigate} />);
  await settle(act);
  return { ...view, onNavigate };
}

const gpu = (over: Record<string, unknown> = {}) => ({ source: 'nvidia-smi', gpuName: 'RTX 4070', vramTotalMB: 12000, vramUsedMB: 4000, modelLoaded: true, modelVramMB: 1500, modelPartialOffload: false, oomStepDowns: 0, ...over });

beforeEach(() => {
  localStorage.clear();
  emb.listeners.clear();
  Object.assign(emb, { isRechunkRunning: false, rechunkMessage: null, rechunkProgress: { completed: 0, total: 0, phase: 'library' }, rechunkSuggestRebuildAnn: false, rechunkStatus: 'idle', isAnnRebuilding: false, isForceReindexRunning: false, isForceReindexAllRunning: false, migrationState: null, catalogProgress: { completed: 0, total: 0 } });
  Object.assign(ann, { isReady: true, isPartial: false, isBuilding: false, vectorCount: 5000 });
  vi.clearAllMocks();
  installSettings();
  win.ollama = { gpuStats: vi.fn(async () => gpu()) };
});
afterEach(() => {
  vi.useRealTimers();
  delete win.settings;
  delete win.ollama;
  removeRouter();
  removeLocalAi();
});

describe('settings wiring', () => {
  it('a toggle changed just before leaving the page is still saved, once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = installSettings();
    const { unmount } = await renderPage();
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    // Opening the page alone saves nothing.
    expect(s.setOllamaSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('switch', { name: 'Rerank similar games' }));
    unmount();
    expect(s.setOllamaSettings).toHaveBeenCalledTimes(1);
    expect(s.setOllamaSettings).toHaveBeenCalledWith(expect.objectContaining({ neighborRerankEnabled: false }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.setOllamaSettings).toHaveBeenCalledTimes(1);
  });

  it('each switch saves the setting it names', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = installSettings();
    await renderPage();
    const save = async (name: string) => {
      s.setOllamaSettings.mockClear();
      fireEvent.click(screen.getByRole('switch', { name }));
      await act(async () => { await vi.advanceTimersByTimeAsync(900); });
      return (s.setOllamaSettings.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
    };
    expect((await save('Detailed reading')).embeddingChunkingEnabled).toBe(false);
    expect((await save('Match on any part')).chunkAnnMaxSimEnabled).toBe(false);
    expect((await save('Compact vectors')).embeddingMrl256Enabled).toBe(true);
    expect((await save('Rerank Oracle shelves')).oracleRerankEnabled).toBe(false);
  });

  it('the batch size slider saves 0 for Auto and the stepped value otherwise', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = installSettings();
    await renderPage();
    const slider = screen.getByLabelText('Batch size') as HTMLInputElement;
    expect(slider.getAttribute('aria-valuetext')).toBe('Auto');
    fireEvent.change(slider, { target: { value: '3' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(s.setOllamaSettings).toHaveBeenCalledWith(expect.objectContaining({ embeddingBatchSize: 64 }));
    expect(screen.getByText('64 at a time')).toBeInTheDocument();
  });

  it('AI influence is a percentage that saves as a fraction, and is off with Rerank Oracle shelves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = installSettings();
    await renderPage();
    const blend = screen.getByLabelText('AI influence on shelves') as HTMLInputElement;
    expect(blend.value).toBe('60');
    fireEvent.change(blend, { target: { value: '25' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(s.setOllamaSettings).toHaveBeenCalledWith(expect.objectContaining({ oracleRerankBlend: 0.25 }));
    fireEvent.click(screen.getByRole('switch', { name: 'Rerank Oracle shelves' }));
    expect(blend).toBeDisabled();
  });

  it('a save main rejects shows the reason instead of staying on Saving', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = installSettings();
    await renderPage();
    s.setOllamaSettings.mockRejectedValueOnce(new Error("Error invoking remote method 'settings:setOllamaSettings': Error: disk full"));
    fireEvent.click(screen.getByRole('switch', { name: 'Rerank similar games' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(screen.getByText('Could not save: disk full')).toBeInTheDocument();
    expect(screen.queryByText(/Saving/)).not.toBeInTheDocument();
  });
});

describe('Reading and Ordering', () => {
  it('shows the routed embedding and reranker models with Change links into AI providers', async () => {
    installRouter(routerState({
      connectors: [builtinConnector({ routedFor: ['chat', 'reranker'] }), connector('openai', { routedFor: ['embeddings'] })],
      routes: { chat: { connectorId: 'builtin', model: 'gemma3:12b' }, embeddings: { connectorId: 'openai', model: 'text-embedding-3-small' }, reranker: { connectorId: 'builtin', model: 'bge-reranker-v2-m3' } },
    }));
    const { onNavigate } = await renderPage();
    expect(screen.getByText('openai/text-embedding-3-small')).toBeInTheDocument();
    expect(screen.getByText('built-in/bge-reranker-v2-m3')).toBeInTheDocument();
    const changes = screen.getAllByRole('button', { name: /Change/ });
    fireEvent.click(changes[0]!);
    expect(onNavigate).toHaveBeenCalledWith('providers', 'route-embeddings');
    fireEvent.click(changes[1]!);
    expect(onNavigate).toHaveBeenCalledWith('providers', 'route-reranker');
  });
});

describe('status tiles', () => {
  it('Ready index with its count, Current data format, and the graphics memory reading', async () => {
    await renderPage();
    const status = screen.getByLabelText('Current status');
    expect(within(status).getByText('Ready')).toBeInTheDocument();
    expect(within(status).getByText('5,000 games indexed')).toBeInTheDocument();
    expect(within(status).getByText('Current')).toBeInTheDocument();
    await waitFor(() => expect(within(status).getByText('OK')).toBeInTheDocument());
    expect(within(status).getByText(/RTX 4070/)).toBeInTheDocument();
  });

  it('an index that is not built says so; an outdated format points at the rebuild', async () => {
    Object.assign(ann, { isReady: false });
    emb.migrationState = { state: 'pending', reason: 'layout' };
    await renderPage();
    const status = screen.getByLabelText('Current status');
    expect(within(status).getByText('Not built')).toBeInTheDocument();
    expect(within(status).getByText('Outdated')).toBeInTheDocument();
    expect(within(status).getByText('Built with an older format. Rebuild below.')).toBeInTheDocument();
  });

  it('graphics memory: Tight under 1.5 GB free and Too high when the AI spilled to RAM, with the advice', async () => {
    win.ollama = { gpuStats: vi.fn(async () => gpu({ vramUsedMB: 11000 })) };
    const view = await renderPage();
    const status = screen.getByLabelText('Current status');
    await waitFor(() => expect(within(status).getByText('Tight')).toBeInTheDocument());
    expect(screen.getByText(/Graphics memory is getting full/)).toBeInTheDocument();
    view.unmount();
    win.ollama = { gpuStats: vi.fn(async () => gpu({ modelPartialOffload: true })) };
    await renderPage();
    await waitFor(() => expect(within(screen.getByLabelText('Current status')).getByText('Too high')).toBeInTheDocument());
    expect(screen.getByText(/Part of the AI spilled into regular memory/)).toBeInTheDocument();
  });

  it('no graphics reading says it appears while the AI is running', async () => {
    win.ollama = { gpuStats: vi.fn(async () => null) };
    await renderPage();
    await waitFor(() => expect(within(screen.getByLabelText('Current status')).getByText('No reading')).toBeInTheDocument());
  });

  it('the built-in runtime not running raises a warning with Scan again', async () => {
    const la = installLocalAi(localAiStatus({ runtime: { available: true, build: 'b1', roles: [{ role: 'embed', state: 'failed', lastError: 'out of memory', cpuFallback: false }] } }));
    await renderPage();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/The built-in AI isn.t running/)).toBeInTheDocument();
    expect(within(alert).getByText(/out of memory/)).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Scan again' }));
    await waitFor(() => expect(la.api.recheck).toHaveBeenCalled());
  });

  it('a healthy runtime shows no warning', async () => {
    installLocalAi();
    await renderPage();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('maintenance', () => {
  it('Rebuild similarity index runs the service job and reports the count', async () => {
    await renderPage();
    const row = screen.getByText('Rebuild similarity index').closest('.row') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Rebuild' }));
    await waitFor(() => expect(emb.rebuildAnnFromCache).toHaveBeenCalledTimes(1));
    expect(await within(row).findByText('Rebuilt — 1,234 games indexed')).toBeInTheDocument();
    expect(emb.clearRechunkSuggestRebuildAnn).toHaveBeenCalled();
  });

  it('a failed index rebuild shows the reason', async () => {
    emb.rebuildAnnFromCache.mockRejectedValueOnce(new Error('index locked'));
    await renderPage();
    const row = screen.getByText('Rebuild similarity index').closest('.row') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Rebuild' }));
    expect(await within(row).findByText('Rebuild failed: index locked')).toBeInTheDocument();
  });

  it('Refresh detailed reading starts the job, needs Detailed reading on, and shows Cancel while it runs', async () => {
    await renderPage();
    const row = () => screen.getByText('Refresh detailed reading').closest('.row') as HTMLElement;
    fireEvent.click(within(row()).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(emb.startRechunkJob).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('switch', { name: 'Detailed reading' }));
    expect(within(row()).getByRole('button', { name: 'Refresh' })).toBeDisabled();
    emb.isRechunkRunning = true;
    emb.rechunkProgress = { completed: 3, total: 10, phase: 'library' };
    act(() => emb.emit());
    expect(within(row()).getByText('library: 3 / 10')).toBeInTheDocument();
    fireEvent.click(within(row()).getByRole('button', { name: 'Cancel' }));
    expect(emb.cancelRechunkJob).toHaveBeenCalled();
  });

  it('Rebuild everything asks first, then re-reads in order and shows the result', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild all' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Rebuild game understanding from scratch?')).toBeInTheDocument();
    expect(emb.forceReindexAll).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rebuild' }));
    await waitFor(() => expect(emb.forceReindexAll).toHaveBeenCalledTimes(1));
    expect(emb.forceReindexAll.mock.calls[0]![0]).toMatchObject({ resume: false });
    expect(await screen.findByText('Rebuilt everything: 40 library, 900 Steam, 300 Epic')).toBeInTheDocument();
  });

  it('in progress: step N of 4 with a meter per stage, counts for the current one, and Cancel', async () => {
    emb.isForceReindexAllRunning = true;
    emb.migrationState = { state: 'running', phase: 'steam', runId: 'r1' };
    emb.catalogProgress = { completed: 400, total: 1000 };
    await renderPage();
    expect(screen.getByText('Rebuilding everything')).toBeInTheDocument();
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Library progress' })).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByRole('progressbar', { name: 'Steam progress' })).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getByRole('progressbar', { name: 'Epic progress' })).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText('Steam · 400/1,000')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(emb.cancelLibraryEmbeddings).toHaveBeenCalled();
    expect(emb.cancelCatalogEmbeddings).toHaveBeenCalled();
    emb.catalogProgress = { completed: 700, total: 1000 };
    act(() => emb.emit());
    expect(screen.getByRole('progressbar', { name: 'Steam progress' })).toHaveAttribute('aria-valuenow', '70');
  });

  it('interrupted: says where it stopped and Resume continues from there', async () => {
    emb.migrationState = { state: 'pending', reason: 'interrupted', runId: 'r1', phase: 'epic' };
    await renderPage();
    expect(screen.getByText('Rebuild stopped at Epic')).toBeInTheDocument();
    expect(screen.getByText('Finished games are skipped when you resume.')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Current status')).getByText('Interrupted')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Resume the interrupted rebuild?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(emb.forceReindexAll).toHaveBeenCalledTimes(1));
    expect(emb.forceReindexAll.mock.calls[0]![0]).toMatchObject({ resume: true });
  });

  it('an outdated data format recommends the rebuild', async () => {
    emb.migrationState = { state: 'pending', reason: 'layout' };
    await renderPage();
    expect(screen.getByText(/Recommended now\./)).toBeInTheDocument();
  });

  it('the matching tune-up test runs and reports without changing anything', async () => {
    await renderPage();
    fireEvent.click(screen.getByText('Advanced: matching tune-up test'));
    fireEvent.click(screen.getByRole('button', { name: 'Run sweep' }));
    expect(await screen.findByText(/MRR/, undefined, { timeout: 15000 })).toBeInTheDocument();
  });
});

describe('long-job progress after reopening Settings', () => {
  it('a remounted page shows re-chunk progress from the service and clears it when done', async () => {
    emb.isRechunkRunning = true;
    emb.rechunkProgress = { completed: 3, total: 10, phase: 'library' };
    const first = await renderPage();
    first.unmount();
    expect(emb.listeners.size).toBe(0);
    await renderPage();
    expect(screen.getByText('library: 3 / 10')).toBeInTheDocument();
    emb.rechunkProgress = { completed: 7, total: 10, phase: 'library' };
    act(() => emb.emit());
    expect(screen.getByText('library: 7 / 10')).toBeInTheDocument();
    emb.isRechunkRunning = false;
    act(() => emb.emit());
    expect(screen.queryByText(/library: \d+ \/ 10/)).not.toBeInTheDocument();
  });

  it('a remounted page shows the full rebuild counts from the service', async () => {
    emb.isForceReindexAllRunning = true;
    emb.migrationState = { state: 'running', phase: 'library', runId: 'r1' };
    emb.catalogProgress = { completed: 5, total: 50 };
    await renderPage();
    expect(screen.getByText('Library · 5/50')).toBeInTheDocument();
    emb.catalogProgress = { completed: 20, total: 50 };
    act(() => emb.emit());
    expect(screen.getByText('Library · 20/50')).toBeInTheDocument();
  });

  it('the similarity index count follows the ann build subscription', async () => {
    emb.isAnnRebuilding = true;
    ann.buildProgress = { done: 20, total: 100 };
    await renderPage();
    // The count comes from the subscription callback; the first sync starts at the service flag only.
    expect(screen.getByText('Building')).toBeInTheDocument();
  });
});
