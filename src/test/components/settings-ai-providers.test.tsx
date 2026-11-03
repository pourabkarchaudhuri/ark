/**
 * Settings → AI providers (1.0.97 B37): the router screen against a fake `window.aiRouter`. Every
 * state of the StatesCore board (live, armed, no key, fault, off, testing; first run; key saved but
 * rejected; scheduled re-check fault; routed connector turned off with Undo; remove-key
 * confirmation) plus routing, adding connectors, models, policy and the embedding rebuild banner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';

vi.mock('@/services/embedding-service', () => ({ embeddingService: { resetAvailability: vi.fn(), clearUnavailableVerdict: vi.fn() } }));
vi.mock('@/lib/ai-key-migration', () => ({ ensureLegacyAiKeysMigrated: vi.fn(async () => {}) }));

import { AiProvidersPage } from '@/components/settings/ai-providers-page';
import {
  builtinConnector, connector, fail, pass, installLocalAi, installRouter, localAiStatus, removeLocalAi, removeRouter, routerState, settle, withChatRoute,
} from './settings-fixtures';

const win = window as unknown as { settings?: Record<string, unknown> };
const flush = () => settle(act);

async function renderPage(state = routerState(), opts: { localAi?: ReturnType<typeof localAiStatus> | null; focusId?: string } = {}) {
  const router = installRouter(state);
  if (opts.localAi !== null) installLocalAi(opts.localAi);
  const onNavigate = vi.fn();
  const view = render(<AiProvidersPage onNavigate={onNavigate} focusId={opts.focusId} />);
  await flush();
  return { ...router, onNavigate, view };
}

const node = (name: string) => screen.getByRole('button', { name: `Settings for ${name}` }).closest('.node') as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  win.settings = { setPreferredChatProvider: vi.fn(async () => ({ success: true })) };
});
afterEach(() => {
  removeRouter();
  removeLocalAi();
  delete win.settings;
});

describe('connector nodes and role tabs', () => {
  it('shows the built-in connector routed for chat and the route on each role tab', async () => {
    await renderPage();
    expect(within(node('Built-in (llama.cpp)')).getByText('Live')).toBeInTheDocument();
    expect(within(node('Built-in (llama.cpp)')).getByRole('button', { name: 'Routed' })).toBeDisabled();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Chat Built-in (llama.cpp)', 'Embeddings Built-in (llama.cpp)', 'Reranker Built-in (llama.cpp)']);
    expect(screen.getByText('Active route')).toBeInTheDocument();
  });

  it('every connector state shows its chip, and the role tab hides connectors that do not offer the role', async () => {
    const state = routerState({
      connectors: [
        builtinConnector({ routedFor: [] }),
        connector('anthropic', { routedFor: ['chat'] }),
        connector('gemini'),
        connector('azure-openai', { hasKey: false, test: undefined }),
        connector('openai', { test: fail }),
        connector('ollama', { enabled: false }),
      ],
    });
    await renderPage(withChatRoute(state, 'anthropic', 'claude-sonnet-5-5'));
    expect(within(node('Anthropic')).getByText('Live')).toBeInTheDocument();
    expect(within(node('Google Gemini')).getByText('Armed')).toBeInTheDocument();
    expect(within(node('Azure OpenAI')).getByText('No key')).toBeInTheDocument();
    expect(within(node('OpenAI')).getByText('Fault')).toBeInTheDocument();
    expect(within(node('Ollama')).getByText('Off')).toBeInTheDocument();
    expect(within(node('Azure OpenAI')).getByRole('button', { name: 'Add key' })).toBeEnabled();
    expect(within(node('OpenAI')).getByRole('button', { name: 'Fix key' })).toBeEnabled();
    fireEvent.click(screen.getByRole('tab', { name: /Reranker/ }));
    expect(screen.queryByRole('button', { name: 'Settings for Anthropic' })).not.toBeInTheDocument();
    expect(screen.getByText(/5 connectors don.t offer reranking\./)).toBeInTheDocument();
    expect(screen.getByText('Connectors that offer reranking')).toBeInTheDocument();
  });

  it('opens on the role a link pointed at (Change on Game understanding)', async () => {
    await renderPage(routerState(), { focusId: 'route-embeddings' });
    expect(screen.getByRole('tab', { name: /Embeddings/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('below 1040 px the graph becomes a list with one gear per connector', async () => {
    const mm = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({ matches: true, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as never;
    try {
      await renderPage(routerState({ connectors: [builtinConnector(), connector('gemini')] }));
      expect(document.querySelector('.stage')).toBeNull();
      expect(screen.getAllByRole('button', { name: /^Settings for / })).toHaveLength(2);
    } finally {
      window.matchMedia = mm;
    }
  });
});

describe('routing', () => {
  it('Route here on an untested connector tests it first, then routes it with its default model', async () => {
    const m = await renderPage(routerState({ connectors: [builtinConnector(), connector('gemini', { test: undefined })] }));
    fireEvent.click(within(node('Google Gemini')).getByRole('button', { name: 'Test and route' }));
    await waitFor(() => expect(m.api.setRoute).toHaveBeenCalledTimes(1));
    expect(m.api.test).toHaveBeenCalledWith({ connectorId: 'gemini', role: 'chat', model: 'gemini-2.5-flash' });
    expect(m.api.setRoute).toHaveBeenCalledWith({ role: 'chat', connectorId: 'gemini', model: 'gemini-2.5-flash' });
    expect(win.settings!.setPreferredChatProvider).toHaveBeenCalledWith('gemini');
  });

  it('a connector that fails its test is not routed and says why', async () => {
    const m = await renderPage(routerState({ connectors: [builtinConnector(), connector('gemini', { test: undefined })] }));
    m.api.test.mockResolvedValueOnce({ success: true, test: { ...fail } } as never);
    fireEvent.click(within(node('Google Gemini')).getByRole('button', { name: 'Test and route' }));
    expect(await screen.findByText(/did not pass its test, so it was not routed/)).toBeInTheDocument();
    expect(m.api.setRoute).not.toHaveBeenCalled();
  });

  it('an armed connector routes with one press, and the built-in one with no model', async () => {
    const state = withChatRoute(routerState({ connectors: [builtinConnector(), connector('anthropic', { routedFor: [] })] }), 'builtin', 'gemma3:12b');
    const m = await renderPage(state);
    fireEvent.click(within(node('Anthropic')).getByRole('button', { name: 'Route here' }));
    await waitFor(() => expect(m.api.setRoute).toHaveBeenCalledWith({ role: 'chat', connectorId: 'anthropic', model: 'claude-sonnet-5-5' }));
    expect(m.api.test).not.toHaveBeenCalled();
  });

  it('routing built-in chat sets the old selector back to the built-in AI', async () => {
    const state = withChatRoute(routerState({ connectors: [builtinConnector({ routedFor: [] }), connector('anthropic')] }), 'anthropic', 'claude-sonnet-5-5');
    const m = await renderPage(state);
    fireEvent.click(within(node('Built-in (llama.cpp)')).getByRole('button', { name: 'Route here' }));
    await waitFor(() => expect(m.api.setRoute).toHaveBeenCalledWith({ role: 'chat', connectorId: 'builtin', model: '' }));
    expect(win.settings!.setPreferredChatProvider).toHaveBeenCalledWith('ollama');
  });

  it('main refusing a route shows its reason', async () => {
    const m = await renderPage(routerState({ connectors: [builtinConnector(), connector('anthropic')] }));
    m.api.setRoute.mockResolvedValueOnce({ success: false, error: 'Anthropic is switched off.' } as never);
    fireEvent.click(within(node('Anthropic')).getByRole('button', { name: 'Route here' }));
    expect(await screen.findByText('Anthropic is switched off.')).toBeInTheDocument();
  });

  it('When a route fails changes the policy in main', async () => {
    const m = await renderPage();
    expect(screen.getByRole('radio', { name: 'Show error' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Retry once' }));
    await waitFor(() => expect(m.api.setPolicy).toHaveBeenCalledWith({ onFail: 'retry-once' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Use built-in AI' }));
    await waitFor(() => expect(m.api.setPolicy).toHaveBeenCalledWith({ onFail: 'use-fallback' }));
  });
});

describe('the connector drawer: key, test and models', () => {
  const noKeyState = () => routerState({ connectors: [builtinConnector(), connector('openai', { hasKey: false, test: undefined })] });

  it('saves a key through main, empties the field and reports a key that main could not use', async () => {
    const m = await renderPage(noKeyState());
    fireEvent.click(screen.getByRole('button', { name: 'Settings for OpenAI' }));
    const input = screen.getByLabelText('API key') as HTMLInputElement;
    expect(input.type).toBe('password');
    m.api.setKey.mockResolvedValueOnce({ success: true, test: { ...fail } } as never);
    fireEvent.change(input, { target: { value: 'sk-test-abcdefghijkl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(m.api.setKey).toHaveBeenCalledWith({ connectorId: 'openai', key: 'sk-test-abcdefghijkl' }));
    expect(await screen.findByText(/Key saved, but OpenAI rejected it\. The connector stays unrouted until a test passes\./)).toBeInTheDocument();
    expect(input.value).toBe('');
  });

  it('a short or empty key cannot be saved, and a saved key is never shown back', async () => {
    const saved = routerState({ connectors: [builtinConnector(), connector('openai')] });
    await renderPage(saved);
    fireEvent.click(screen.getByRole('button', { name: 'Settings for OpenAI' }));
    const input = screen.getByLabelText('API key') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Key saved. Paste a new one to replace it');
    expect(screen.getByRole('button', { name: 'Replace' })).toBeDisabled();
    fireEvent.change(input, { target: { value: 'short' } });
    expect(screen.getByRole('button', { name: 'Replace' })).toBeDisabled();
  });

  it('Remove key asks first, Keep it does nothing and Remove key erases it', async () => {
    const m = await renderPage(routerState({ connectors: [builtinConnector(), connector('openai')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings for OpenAI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    let dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Remove the OpenAI key?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(m.api.clearKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove key' }));
    await waitFor(() => expect(m.api.clearKey).toHaveBeenCalledWith('openai'));
    expect(await screen.findByText('Key removed from this PC.')).toBeInTheDocument();
  });

  it('a fault shows 401 advice, and Run test sends the viewed role and the default model', async () => {
    const m = await renderPage(routerState({ connectors: [builtinConnector(), connector('openai', { test: fail })] }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings for OpenAI' }));
    expect(screen.getAllByText(/Key rejected \(401\)/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Paste a new key/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
    await waitFor(() => expect(m.api.test).toHaveBeenCalledWith({ connectorId: 'openai', role: 'chat', model: 'gpt-5' }));
  });

  it('Test with Smallest picks the cheapest-looking active model', async () => {
    const m = await renderPage(routerState({ connectors: [builtinConnector(), connector('openai')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings for OpenAI' }));
    fireEvent.change(screen.getByLabelText('Add model id'), { target: { value: 'gpt-5-mini' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Smallest' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
    await waitFor(() => expect(m.api.test).toHaveBeenCalledWith({ connectorId: 'openai', role: 'chat', model: 'gpt-5-mini' }));
  });

  it('timeout, retries, re-check and test-on-save go to the policy', async () => {
    const m = await renderPage(routerState({ connectors: [builtinConnector(), connector('openai')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings for OpenAI' }));
    fireEvent.click(screen.getByRole('radio', { name: '60 s' }));
    fireEvent.click(screen.getByRole('radio', { name: '2' }));
    fireEvent.click(screen.getByRole('radio', { name: '2 h' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Test when a key is saved' }));
    await waitFor(() => expect(m.api.setPolicy).toHaveBeenCalledTimes(4));
    expect(m.api.setPolicy.mock.calls.map((c) => c[0])).toEqual([{ timeoutSec: 60 }, { retries: 2 }, { recheckMin: 120 }, { testOnKeySave: false }]);
  });

  it('models: add an id, switch one off, make another the default; the default of a routed connector re-routes at once', async () => {
    const state = withChatRoute(routerState({ connectors: [builtinConnector({ routedFor: [] }), connector('anthropic')] }), 'anthropic', 'claude-sonnet-5-5');
    const m = await renderPage(state);
    fireEvent.click(screen.getByRole('button', { name: 'Settings for Anthropic' }));
    fireEvent.change(screen.getByLabelText('Add model id'), { target: { value: 'claude-haiku-4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('checkbox', { name: 'Use claude-haiku-4' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Make claude-haiku-4 the default' }));
    await waitFor(() => expect(m.api.setRoute).toHaveBeenCalledWith({ role: 'chat', connectorId: 'anthropic', model: 'claude-haiku-4' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use claude-sonnet-5-5' }));
    expect(screen.getByRole('radio', { name: 'Make claude-sonnet-5-5 the default' })).toBeDisabled();
    expect(JSON.parse(localStorage.getItem('ark-router-model-prefs')!).anthropic.chat).toMatchObject({ added: ['claude-haiku-4'], off: ['claude-sonnet-5-5'], def: 'claude-haiku-4' });
  });

  it('a role the connector does not offer says so', async () => {
    await renderPage(routerState({ connectors: [builtinConnector(), connector('anthropic')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings for Anthropic' }));
    fireEvent.click(screen.getByRole('tab', { name: /Embeddings/ }));
    expect(screen.queryByRole('button', { name: 'Settings for Anthropic' })).not.toBeInTheDocument();
  });

  it('Fetch from server adds the ids the server lists, and shows an error when it cannot be reached', async () => {
    const m = await renderPage(routerState({ connectors: [builtinConnector(), connector('openai-compatible', { baseUrl: 'http://h:8000/v1', roles: ['chat'] })] }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings for Home server' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fetch from server' }));
    expect(await screen.findByRole('checkbox', { name: 'Use served-a' })).toBeInTheDocument();
    expect(m.api.fetchModels).toHaveBeenCalledWith('compat-1');
    m.api.fetchModels.mockResolvedValueOnce({ success: false, error: 'Could not reach the server.' } as never);
    fireEvent.click(screen.getByRole('button', { name: 'Fetch from server' }));
    expect(await screen.findByRole('alert', { name: '' }).catch(() => null) ?? await screen.findByText('Could not reach the server.')).toBeTruthy();
  });

  it('Advanced shows the LiteLLM id with the default model and the base URL override saves through Save changes', async () => {
    const m = await renderPage(routerState({ connectors: [builtinConnector(), connector('openai')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings for OpenAI' }));
    expect(screen.getByText('openai/gpt-5')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Base URL override'), { target: { value: 'https://gateway.example.com/v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(m.api.saveConnector).toHaveBeenCalledWith(expect.objectContaining({ kind: 'openai', id: 'openai', baseUrl: 'https://gateway.example.com/v1' })));
  });

  it('the built-in connector shows its downloads and keeps "use my own Ollama" in Advanced', async () => {
    await renderPage();
    expect(await screen.findByTestId('built-in-local-ai')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Use my own Ollama' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByLabelText('Ollama address')).not.toBeInTheDocument();
  });
});

describe('enable switch and Undo', () => {
  it('turning a routed connector off acts at once and offers Undo and another route', async () => {
    const state = withChatRoute(routerState({ connectors: [builtinConnector({ routedFor: [] }), connector('anthropic'), connector('gemini')] }), 'anthropic', 'claude-sonnet-5-5');
    const m = await renderPage(state);
    fireEvent.click(within(node('Anthropic')).getByRole('switch', { name: 'Enable Anthropic' }));
    await waitFor(() => expect(m.api.saveConnector).toHaveBeenCalledWith(expect.objectContaining({ kind: 'anthropic', id: 'anthropic', enabled: false })));
    const bar = await screen.findByText('Anthropic is off. Chat has no route.');
    expect(bar).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Route Google Gemini' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(m.api.setRoute).toHaveBeenCalledWith({ role: 'chat', connectorId: 'anthropic', model: 'claude-sonnet-5-5' }));
    expect(m.api.saveConnector).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'anthropic', enabled: true }));
  });

  it('turning an unrouted connector off says nothing', async () => {
    const m = await renderPage(routerState({ connectors: [builtinConnector(), connector('gemini')] }));
    fireEvent.click(within(node('Google Gemini')).getByRole('switch', { name: 'Enable Google Gemini' }));
    await waitFor(() => expect(m.api.saveConnector).toHaveBeenCalled());
    expect(screen.queryByText(/has no route/)).not.toBeInTheDocument();
  });
});

describe('adding connectors', () => {
  it('lists what can be added and saves a hosted provider with its fixed id', async () => {
    const m = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }));
    const list = screen.getByRole('listbox', { name: 'Available connectors' });
    expect(within(list).getAllByRole('option').length).toBeGreaterThan(5);
    m.api.saveConnector.mockImplementationOnce(async () => { m.set(routerState({ connectors: [builtinConnector(), connector('anthropic', { hasKey: false, test: undefined })] })); return { success: true as const }; });
    fireEvent.click(within(list).getByRole('option', { name: /Anthropic/ }));
    await waitFor(() => expect(m.api.saveConnector).toHaveBeenCalledWith({ kind: 'anthropic', name: 'Anthropic', id: 'anthropic' }));
    expect(await screen.findByRole('heading', { name: 'Anthropic' })).toBeInTheDocument();
  });

  it('an OpenAI-compatible preset sends its address and roles, with no fixed id', async () => {
    const m = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }));
    fireEvent.click(screen.getByRole('option', { name: /LM Studio/ }));
    await waitFor(() => expect(m.api.saveConnector).toHaveBeenCalledWith({ kind: 'openai-compatible', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', roles: ['chat', 'embeddings'] }));
  });

  it('Azure starts as a draft that needs its endpoint and deployment, then saves them', async () => {
    const m = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }));
    fireEvent.click(screen.getByRole('option', { name: /Azure OpenAI/ }));
    expect(m.api.saveConnector).not.toHaveBeenCalled();
    expect(screen.getByLabelText('API key')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'https://r.openai.azure.com/' } });
    fireEvent.change(screen.getByLabelText('Deployment'), { target: { value: 'gpt-prod' } });
    // The header button and the drawer's own submit share a name: the drawer's comes last.
    fireEvent.click(screen.getAllByRole('button', { name: 'Add connector' }).at(-1)!);
    await waitFor(() => expect(m.api.saveConnector).toHaveBeenCalledWith(expect.objectContaining({ kind: 'azure-openai', endpoint: 'https://r.openai.azure.com/', deployment: 'gpt-prod' })));
    expect(localStorage.getItem('ark-azure-deployment')).toBe('gpt-prod');
  });

  it('a save main refuses shows the reason next to the fields', async () => {
    const m = await renderPage(routerState({ connectors: [builtinConnector(), connector('ollama', { baseUrl: 'http://localhost:11434' })] }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings for Ollama' }));
    m.api.saveConnector.mockResolvedValueOnce({ success: false, error: 'The server address is not a valid address.' } as never);
    fireEvent.change(screen.getByLabelText('Server address'), { target: { value: 'not a url' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('The server address is not a valid address.')).toBeInTheDocument();
  });

  it('removing a connector asks first and then removes it in main', async () => {
    const m = await renderPage(routerState({ connectors: [builtinConnector(), connector('gemini')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings for Google Gemini' }));
    fireEvent.click(screen.getByText('Advanced'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove connector' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove connector' }));
    await waitFor(() => expect(m.api.removeConnector).toHaveBeenCalledWith('gemini'));
  });
});

describe('test all and the connection check', () => {
  it('runs every enabled connector and lists result, latency and model per connector', async () => {
    const state = routerState({ connectors: [builtinConnector(), connector('anthropic', { test: { ...fail, role: 'chat', model: 'claude-sonnet-5-5' } }), connector('gemini', { test: { ...pass, latencyMs: 142, model: 'gemini-2.5-flash' } }), connector('ollama', { enabled: false })] });
    const m = await renderPage(state);
    fireEvent.click(screen.getByRole('button', { name: 'Test all' }));
    await waitFor(() => expect(m.api.testAll).toHaveBeenCalledTimes(1));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Connected')).toBeInTheDocument();
    expect(within(table).getByText('Key rejected (401)')).toBeInTheDocument();
    expect(within(table).getByText('142 ms')).toBeInTheDocument();
    expect(within(table).getByText('gemini-2.5-flash')).toBeInTheDocument();
    expect(within(table).queryByText('Ollama')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 2 connected')).toBeInTheDocument();
  });
});

describe('banners and states from the StatesCore board', () => {
  it('first run: nothing armed and the built-in AI not ready, with copy for the built-in runtime', async () => {
    await renderPage(routerState(), { localAi: localAiStatus({ runtime: { available: false, build: '', roles: [] } }) });
    expect(screen.getByText('No AI connected yet')).toBeInTheDocument();
    expect(screen.getByText(/The built-in AI isn.t ready/)).toBeInTheDocument();
    expect(screen.queryByText(/Get Ollama/)).not.toBeInTheDocument();
    expect(screen.queryByText(/localhost:11434/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check the built-in AI' }));
    await waitFor(() => expect((window as unknown as { localAi: { recheck: ReturnType<typeof vi.fn> } }).localAi.recheck).toHaveBeenCalled());
  });

  it('no first-run panel while models download, once the built-in AI is ready, or when a connector is armed', async () => {
    const downloading = localAiStatus();
    downloading.models[0] = { ...downloading.models[0]!, state: 'downloading', pct: 30 };
    const { view } = await renderPage(routerState(), { localAi: downloading });
    expect(screen.queryByText('No AI connected yet')).not.toBeInTheDocument();
    view.unmount();
    removeRouter();
    await renderPage(routerState({ connectors: [builtinConnector(), connector('openai')] }), { localAi: localAiStatus({ runtime: { available: false, build: '', roles: [] } }) });
    expect(screen.queryByText('No AI connected yet')).not.toBeInTheDocument();
  });

  it('embedding model changed: the banner offers Rebuild (opens Game understanding) and Later', async () => {
    const m = await renderPage(routerState({ rebuild: { from: 'snowflake-arctic-embed2', to: 'openai:text-embedding-3-small' } }));
    expect(screen.getByText(/Embedding model changed to openai:text-embedding-3-small\./)).toBeInTheDocument();
    expect(screen.getByText(/Ark keeps the old vectors until the rebuild finishes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }));
    expect(m.onNavigate).toHaveBeenCalledWith('understanding', 'u-rebuild-all');
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByText(/Embedding model changed/)).not.toBeInTheDocument();
  });

  it('a router fault is shown with the Oracle fallback explained, and Re-check clears it in main', async () => {
    const m = await renderPage(routerState({ status: { sidecar: { state: 'ready', lastError: null, restarts: 0 }, runtimeAvailable: true, routedRoles: ['chat'], fault: { role: 'chat', message: 'The AI router is not running: exited', at: 1 } } }));
    expect(screen.getByText('The AI router had a problem.')).toBeInTheDocument();
    expect(screen.getByText(/Embeddings and reranking keep working through the built-in AI/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByText('The AI router had a problem.').closest('.alert') as HTMLElement).getByRole('button', { name: 'Re-check' }));
    await waitFor(() => expect(m.api.recheckRuntime).toHaveBeenCalled());
  });

  it('a connector that turns faulty at the scheduled re-check raises a snackbar with Open, but a healthy one does not', async () => {
    const healthy = routerState({ connectors: [builtinConnector(), connector('gemini'), connector('anthropic')] });
    const m = await renderPage(healthy);
    expect(screen.queryByText(/stopped answering/)).not.toBeInTheDocument();
    await act(async () => { m.push(routerState({ connectors: [builtinConnector(), connector('gemini', { test: { ...fail, message: 'timed out' } }), connector('anthropic')] })); });
    expect(await screen.findByText('Google Gemini stopped answering at the re-check.')).toBeInTheDocument();
    expect(screen.queryByText('Anthropic stopped answering at the re-check.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('heading', { name: 'Google Gemini' })).toBeInTheDocument();
  });

  it('the drawer starts empty when nothing is routed to a connector and Close empties it', async () => {
    await renderPage(routerState({ connectors: [builtinConnector({ routedFor: [] }), connector('gemini')] }));
    expect(screen.getByRole('heading', { name: 'No connector selected' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Settings for Google Gemini' }));
    expect(screen.getByRole('heading', { name: 'Google Gemini' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(screen.getByRole('heading', { name: 'No connector selected' })).toBeInTheDocument();
  });

  it('outside the desktop app it says so instead of showing a broken screen', async () => {
    removeRouter();
    removeLocalAi();
    render(<AiProvidersPage onNavigate={vi.fn()} />);
    await flush();
    expect(screen.getByText('The AI router is available in the desktop app.')).toBeInTheDocument();
  });
});
