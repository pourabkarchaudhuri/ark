/**
 * The Settings shell (1.0.97 B37): navigation between the five pages, the sidebar footer (active
 * chat route and version), Ctrl K and Esc, search results that land on the row, toasts, the
 * Settings tour's targets, and the rule that the search index covers every row of every page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';

const emb = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  isRechunkRunning: false, rechunkMessage: null, rechunkProgress: { completed: 0, total: 0, phase: 'library' }, rechunkSuggestRebuildAnn: false,
  rechunkStatus: 'idle', isAnnRebuilding: false, isForceReindexRunning: false, isForceReindexAllRunning: false, migrationState: null,
  catalogProgress: { completed: 0, total: 0 },
  refreshMigrationState: vi.fn(async () => {}),
  subscribe: vi.fn(() => () => {}),
  clearUnavailableVerdict: vi.fn(), resetAvailability: vi.fn(), clearRechunkSuggestRebuildAnn: vi.fn(), cancelRechunkJob: vi.fn(),
}));
vi.mock('@/services/embedding-service', () => ({ embeddingService: emb }));
vi.mock('@/services/ann-index', () => ({ annIndex: { isReady: true, isPartial: false, isBuilding: false, vectorCount: 10, buildProgress: { done: 0, total: 0 }, subscribe: vi.fn(() => () => {}) } }));
vi.mock('@/services/rechunk-job-deps', () => ({ buildRechunkJobDeps: vi.fn(async () => ({})) }));
vi.mock('@/services/catalog-store', () => ({ catalogStore: {} }));
vi.mock('@/services/epic-catalog-store', () => ({ epicCatalogStore: {} }));
vi.mock('@/services/reco-store', () => ({ recoStore: {} }));
vi.mock('@/services/embedding-migration', () => ({ describeReindexAllResult: vi.fn(() => '') }));
vi.mock('@/services/library-store', () => ({ libraryStore: { getLastImportSnapshot: vi.fn(() => null) } }));
vi.mock('@/services/game-service', () => ({ gameService: {} }));
vi.mock('@/components/year-wrapped', () => ({ YearWrapped: () => null }));
vi.mock('@/lib/ai-key-migration', () => ({ ensureLegacyAiKeysMigrated: vi.fn(async () => {}) }));

import { SettingsScreen } from '@/components/settings-screen';
import { GeneralPage } from '@/components/settings/general-page';
import { AiProvidersPage } from '@/components/settings/ai-providers-page';
import { GameUnderstandingPage } from '@/components/settings/game-understanding-page';
import { GuidePage } from '@/components/settings/guide-page';
import { AboutPage } from '@/components/settings/about-page';
import { PAGE_LABELS, SETTINGS_INDEX, searchSettings, type SettingsPageId } from '@/components/settings/search-index';
import { APP_VERSION } from '@/components/changelog-modal';
import {
  builtinConnector, connector, installLocalAi, installRouter, removeLocalAi, removeRouter, routerState, settle, withChatRoute,
} from './settings-fixtures';

const win = window as unknown as { settings?: Record<string, unknown>; analytics?: unknown };
const flush = () => settle(act);

function installSettings() {
  win.settings = {
    getAutoLaunch: vi.fn(async () => true), getOverlayEnabled: vi.fn(async () => false), getOverlayCycleHotkeyRegistered: vi.fn(async () => true),
    getOllamaSettings: vi.fn(async () => ({ enabled: true, url: 'http://localhost:11434', model: 'm', useGeminiInstead: false, rerankModel: 'r', neighborRerankEnabled: true, oracleRerankEnabled: true, oracleRerankBlend: 0.6, embeddingChunkingEnabled: true, chunkAnnMaxSimEnabled: true, embeddingMrl256Enabled: false, embeddingBatchSize: 0 })),
    setOllamaSettings: vi.fn(async () => {}),
    setPreferredChatProvider: vi.fn(async () => ({ success: true })),
  };
}

beforeEach(() => { localStorage.clear(); installSettings(); installLocalAi(); });
afterEach(() => { removeRouter(); removeLocalAi(); delete win.settings; delete win.analytics; delete (window as unknown as { fileDialog?: unknown }).fileDialog; });

async function renderShell(onBack = vi.fn(), onRunGuidedTour: ((id: string) => void) | undefined = vi.fn()) {
  const view = render(<SettingsScreen onBack={onBack} onRunGuidedTour={onRunGuidedTour as never} />);
  await flush();
  return { ...view, onBack };
}

const nav = (name: string) => within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name });

describe('navigation', () => {
  it('has the five pages from the design, General first, and Back leaves Settings', async () => {
    const { onBack } = await renderShell();
    const buttons = within(screen.getByRole('navigation', { name: 'Settings sections' })).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['General', 'AI providers', 'Game understanding', 'Guide', 'About']);
    expect(nav('General')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'General' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('each button opens its page', async () => {
    installRouter(routerState());
    await renderShell();
    for (const [name, heading] of [['AI providers', 'AI providers'], ['Game understanding', 'Game understanding'], ['Guide', 'Guide'], ['About', 'About'], ['General', 'General']] as const) {
      fireEvent.click(nav(name));
      await flush();
      expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
      expect(nav(name)).toHaveAttribute('aria-current', 'page');
    }
  });

  it('the sidebar footer shows the version, and the AI route chat uses', async () => {
    const state = withChatRoute(routerState({ connectors: [builtinConnector({ routedFor: [] }), connector('anthropic')] }), 'anthropic', 'claude-sonnet-5-5');
    installRouter(state);
    await renderShell();
    const foot = document.querySelector('.rail-foot') as HTMLElement;
    expect(within(foot).getByText('AI route')).toBeInTheDocument();
    expect(within(foot).getByText('Anthropic')).toBeInTheDocument();
    expect(within(foot).getByText(APP_VERSION)).toBeInTheDocument();
  });

  it('the Guide page gets the tour launcher from the dashboard', async () => {
    const run = vi.fn();
    await renderShell(vi.fn(), run);
    fireEvent.click(nav('Guide'));
    fireEvent.click(screen.getByRole('button', { name: 'Start Browse tour' }));
    expect(run).toHaveBeenCalledWith('browse');
  });
});

describe('search', () => {
  it('Ctrl K from any page opens General with the search box focused', async () => {
    installRouter(routerState());
    await renderShell();
    fireEvent.click(nav('About'));
    await flush();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(screen.getByRole('heading', { level: 1, name: 'General' })).toBeInTheDocument();
    expect(document.activeElement).toBe(document.getElementById('settings-search'));
  });

  it('Esc clears the box first', async () => {
    await renderShell();
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: 'backup' } });
    expect(screen.getByRole('heading', { name: 'Results' })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('heading', { name: 'Results' })).not.toBeInTheDocument();
  });

  it('a result on another page opens that page and scrolls to the row', async () => {
    const scrolled: Array<string | null> = [];
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = function scroll(this: HTMLElement) { scrolled.push(this.getAttribute('data-setting-id')); };
    await renderShell();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'rebuild index' } });
    const row = screen.getByText('Rebuild similarity index').closest('.row') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Open/ }));
    await flush();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Game understanding' })).toBeInTheDocument());
    await waitFor(() => expect(scrolled).toContain('u-rebuild-index'));
    expect(screen.queryByRole('heading', { name: 'Results' })).not.toBeInTheDocument();
  });

  it('searchSettings needs every word and also matches the page name and keywords', () => {
    expect(searchSettings('').length).toBe(0);
    expect(searchSettings('overlay hotkey').map((s) => s.id)).toEqual(['overlay']);
    expect(searchSettings('vllm').map((s) => s.id)).toEqual(['connector-compat']);
    expect(searchSettings('game understanding').length).toBeGreaterThan(8);
    expect(searchSettings('zzzz')).toEqual([]);
  });
});

describe('density and toasts', () => {
  it('Dense is remembered', async () => {
    const view = await renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Dense' }));
    expect(localStorage.getItem('ark-settings-density')).toBe('dense');
    view.unmount();
    await renderShell();
    expect(screen.getByRole('button', { name: 'Dense' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a failed import is a toast with Try another that stays until dismissed', async () => {
    (window as unknown as { fileDialog?: unknown }).fileDialog = { openFile: vi.fn(async () => ({ success: false, error: 'Nope' })), saveFile: vi.fn() };
    await renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const toast = await screen.findByRole('alert');
    expect(within(toast).getByText('Nope')).toBeInTheDocument();
    expect(within(toast).getByText('Failed')).toBeInTheDocument();
    expect(within(toast).getByRole('button', { name: 'Try another' })).toBeInTheDocument();
    fireEvent.click(within(toast).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a successful export is a status toast that goes away by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      (window as unknown as { fileDialog?: unknown }).fileDialog = { saveFile: vi.fn(async () => ({ success: true })), openFile: vi.fn() };
      (await import('@/services/library-store') as unknown as { libraryStore: Record<string, unknown> }).libraryStore.exportData = () => '{}';
      (await import('@/services/library-store') as unknown as { libraryStore: Record<string, unknown> }).libraryStore.getSize = () => 3;
      await renderShell();
      fireEvent.click(screen.getByRole('button', { name: 'Export' }));
      const toast = await screen.findByRole('status');
      expect(within(toast).getByText(/Saved ark-library-.*\.json · 3 games/)).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
      expect(screen.queryByText(/Saved ark-library-/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the Settings tour', () => {
  it('every target the tour points at exists', async () => {
    const { getTourSteps } = await import('@/components/guided-tour');
    await renderShell();
    const targets = getTourSteps('settings').map((s) => s.target as string).filter((t) => t.includes('settings-') && !t.includes('settings-button'));
    expect(targets.length).toBeGreaterThanOrEqual(3);
    for (const t of targets) expect(document.querySelector(t), t).not.toBeNull();
    fireEvent.click(nav('Guide'));
    expect(document.querySelector('[data-tour="settings-guided-tours"]')).not.toBeNull();
  });
});

describe('the search index covers every row', () => {
  const ids = (root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>('[data-setting-id]')].map((e) => e.getAttribute('data-setting-id')!);
  const indexed = (page: SettingsPageId) => SETTINGS_INDEX.filter((s) => s.page === page).map((s) => s.id);

  it('index entries are unique and each belongs to one real page', () => {
    const all = SETTINGS_INDEX.map((s) => s.id);
    expect(new Set(all).size).toBe(all.length);
    for (const s of SETTINGS_INDEX) expect(PAGE_LABELS[s.page]).toBeTruthy();
  });

  it('General: every rendered row has an entry and every entry has a row', async () => {
    (window as unknown as { ggdeals?: unknown }).ggdeals = { hasKey: vi.fn(async () => false), setKey: vi.fn(), clearKey: vi.fn(), testKey: vi.fn() };
    render(<GeneralPage query="" onQuery={vi.fn()} density="roomy" onDensity={vi.fn()} onToast={vi.fn()} onNavigate={vi.fn()} />);
    await flush();
    const rendered = new Set(ids());
    for (const id of rendered) expect(indexed('general'), id).toContain(id);
    for (const id of indexed('general')) expect(rendered.has(id), id).toBe(true);
    delete (window as unknown as { ggdeals?: unknown }).ggdeals;
  });

  it('Game understanding: the same, both ways', async () => {
    installRouter(routerState());
    render(<GameUnderstandingPage onNavigate={vi.fn()} />);
    await flush();
    const rendered = new Set(ids());
    for (const id of rendered) expect(indexed('understanding'), id).toContain(id);
    for (const id of indexed('understanding')) expect(rendered.has(id), id).toBe(true);
  });

  it('Guide: both tabs together cover the entries', async () => {
    render(<GuidePage onRunGuidedTour={vi.fn()} />);
    const seen = new Set(ids());
    fireEvent.click(screen.getByRole('tab', { name: /Features/ }));
    for (const id of ids()) seen.add(id);
    for (const id of seen) expect(indexed('guide'), id).toContain(id);
    for (const id of indexed('guide')) expect(seen.has(id), id).toBe(true);
  });

  it('About: the same, both ways', () => {
    render(<AboutPage />);
    const rendered = new Set(ids());
    for (const id of rendered) expect(indexed('about'), id).toContain(id);
    for (const id of indexed('about')) expect(rendered.has(id), id).toBe(true);
  });

  it('AI providers: every row has an entry, and the drawers of each kind of connector show the rest', async () => {
    const state = routerState({ connectors: [builtinConnector(), connector('openai'), connector('openai-compatible', { baseUrl: 'http://h/v1', roles: ['chat'] })] });
    installRouter(state);
    render(<AiProvidersPage onNavigate={vi.fn()} />);
    await flush();
    const seen = new Set(ids());
    fireEvent.click(screen.getByRole('button', { name: 'Settings for OpenAI' }));
    for (const id of ids()) seen.add(id);
    fireEvent.click(screen.getByRole('button', { name: 'Settings for Home server' }));
    for (const id of ids()) seen.add(id);
    for (const id of seen) expect(indexed('providers'), id).toContain(id);
    for (const id of indexed('providers')) expect(seen.has(id), id).toBe(true);
  });
});

describe('search results that land (1.0.98 F5)', () => {
  const trackScroll = () => {
    const scrolled: Array<string | null> = [];
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = function scroll(this: HTMLElement) { scrolled.push(this.getAttribute('data-setting-id')); };
    return scrolled;
  };
  const openResult = async (query: string, title: string) => {
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: query } });
    const row = screen.getByText(title).closest('.row') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Open/ }));
    await flush();
  };

  it('Use my own Ollama opens the Providers page, expands Advanced and scrolls to the row', async () => {
    const scrolled = trackScroll();
    installRouter(routerState());
    await renderShell();
    await openResult('ollama', 'Use my own Ollama');
    await waitFor(() => expect(scrolled).toContain('own-ollama'));
    const el = document.querySelector('[data-setting-id="own-ollama"]') as HTMLElement;
    expect(el.closest('details')?.open).toBe(true);
  });

  it('API keys opens a connector that has a key field, then scrolls to it', async () => {
    const scrolled = trackScroll();
    installRouter(routerState({ connectors: [builtinConnector(), connector('gemini')] }));
    await renderShell();
    await openResult('api keys', 'API keys');
    await waitFor(() => expect(scrolled).toContain('connector-keys'));
  });

  it('How the AI works opens the Features tab of the Guide', async () => {
    const scrolled = trackScroll();
    await renderShell();
    await openResult('faq', 'How the AI works');
    await waitFor(() => expect(scrolled).toContain('g-faq'));
    expect(screen.getByRole('tab', { name: 'Features' })).toHaveAttribute('aria-selected', 'true');
  });

  it('Guided tours opens the Tours tab', async () => {
    const scrolled = trackScroll();
    await renderShell();
    await openResult('guided tours', 'Guided tours');
    await waitFor(() => expect(scrolled).toContain('g-tours'));
    expect(screen.getByRole('tab', { name: 'Tours' })).toHaveAttribute('aria-selected', 'true');
  });
});
