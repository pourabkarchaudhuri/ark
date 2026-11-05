/**
 * AI chat through the AI router (1.0.97 B35): when the chat route is a connector other than
 * Built-in, ChatOpenAI talks to the LiteLLM sidecar (its URL, the per-launch master key and the
 * ark-chat alias); a built-in route never asks the router; a router that is down is reported to the
 * user (chat has no fallback) and a connection that dies mid-turn gets a clear message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage } from '@langchain/core/messages';

const h = vi.hoisted(() => ({
  ctor: [] as Array<{ kind: string; opts: Record<string, any> }>,
  responder: null as null | (() => unknown),
  provider: 'ollama' as string,
  router: {
    usesRouter: false,
    target: null as null | Record<string, any>,
    targetError: null as Error | null,
    chatTargetCalls: 0,
  },
}));

function fakeModelClass(kind: string) {
  return class FakeModel {
    opts: Record<string, any>;
    constructor(opts: Record<string, any>) { this.opts = opts; h.ctor.push({ kind, opts }); }
    invoke() { return Promise.resolve(h.responder!()); }
    bindTools() { return { invoke: () => Promise.resolve(h.responder!()) }; }
  };
}

vi.mock('@langchain/openai', () => ({ AzureChatOpenAI: fakeModelClass('azure'), ChatOpenAI: fakeModelClass('openai') }));
vi.mock('@langchain/google-genai', () => ({ ChatGoogleGenerativeAI: fakeModelClass('gemini') }));
vi.mock('@langchain/ollama', () => ({ ChatOllama: fakeModelClass('ollama') }));
vi.mock('../../../electron/safe-logger.js', () => ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../electron/settings-store.js', () => ({
  DEFAULT_CHAT_NUM_CTX: 8192,
  settingsStore: {
    getPreferredChatProvider: () => h.provider,
    getGoogleAIKey: () => null,
    getOllamaSettings: () => ({ url: 'http://localhost:11434', model: 'gemma3:12b', chatNumCtx: 8192 }),
    getLocalAiSettings: () => ({ useExternalOllama: true, modelsDir: null }),
  },
}));
vi.mock('../../../electron/chat-store.js', () => ({ chatStore: { getActiveConversation: () => null } }));
vi.mock('../../../electron/steam-api.js', () => ({ steamAPI: { getAppDetails: async () => null, getGameReviews: async () => ({}), searchGames: async () => [], getRecommendations: async () => [] } }));
vi.mock('../../../electron/epic-api.js', () => ({ epicAPI: { searchGames: async () => [], getGameDetails: async () => null } }));
vi.mock('../../../electron/hltb-api.js', () => ({ getHltbClient: async () => ({ getTimes: async () => null }) }));
vi.mock('../../../electron/metacritic-api.js', () => ({ fetchMetacriticReviews: async () => null }));
vi.mock('../../../electron/ggdeals-api.js', () => ({ getGgDealsClient: async () => ({ getPrices: async () => ({ prices: {} }) }), normalizeRegion: () => 'us' }));
vi.mock('../../../electron/web-search.js', () => ({ needsWebSearch: () => false, webSearch: async () => [], webSearchOutcome: async () => ({ results: [] }), formatSearchContext: () => '' }));
vi.mock('../../../electron/ai-router/service.js', () => ({
  getAiRouter: () => ({
    chatUsesRouter: () => h.router.usesRouter,
    chatTarget: async () => {
      h.router.chatTargetCalls++;
      if (h.router.targetError) throw h.router.targetError;
      return h.router.target;
    },
  }),
}));

import { processMessage, getModelForProvider, __resetAiChatCachesForTests } from '../../../electron/ai-chat';

const GOOD = '## Answer\n\n- **Hades** is great\n\n---\nSuggested follow-ups:\n- What else?\n- Show my library';
const target = (over: Record<string, unknown> = {}) => ({
  baseUrl: 'http://127.0.0.1:47600/v1', apiKey: 'sk-ark-master-1', model: 'ark-chat', providerName: 'Anthropic (claude-sonnet-5-5)',
  connector: { id: 'anthropic', kind: 'anthropic', name: 'Anthropic' }, ...over,
});

beforeEach(() => {
  h.ctor.length = 0;
  h.responder = () => new AIMessage(GOOD);
  h.provider = 'anthropic';
  h.router.usesRouter = true;
  h.router.target = target();
  h.router.targetError = null;
  h.router.chatTargetCalls = 0;
  __resetAiChatCachesForTests();
});

describe('router chat', () => {
  it('builds ChatOpenAI against LiteLLM with the master key and the ark-chat alias', async () => {
    const res = await processMessage('What should I play?');
    expect(h.ctor).toHaveLength(1);
    expect(h.ctor[0]).toMatchObject({ kind: 'openai', opts: { model: 'ark-chat', apiKey: 'sk-ark-master-1', configuration: { baseURL: 'http://127.0.0.1:47600/v1' } } });
    expect(res.model).toBe('Anthropic (claude-sonnet-5-5)');
    expect(res.content).toContain('Hades');
  });

  it('reuses the client while the endpoint is unchanged and builds a new one when the sidecar restarted', async () => {
    await processMessage('one');
    await processMessage('two');
    expect(h.ctor).toHaveLength(1);
    h.router.target = target({ baseUrl: 'http://127.0.0.1:47633/v1', apiKey: 'sk-ark-master-2' });
    await processMessage('three');
    expect(h.ctor).toHaveLength(2);
    expect(h.ctor[1]!.opts).toMatchObject({ apiKey: 'sk-ark-master-2' });
  });

  it('a built-in chat route never asks the router', async () => {
    h.router.usesRouter = false;
    h.provider = 'ollama';
    await processMessage('hello').catch(() => undefined);
    expect(h.router.chatTargetCalls).toBe(0);
    expect(h.ctor.some((c) => c.kind === 'openai' && c.opts.model === 'ark-chat')).toBe(false);
  });

  it('a router that is down is reported as it is: chat has no fallback', async () => {
    h.router.targetError = new Error('The AI router is not running: python.exe was blocked');
    await expect(processMessage('hello')).rejects.toThrow('The AI router is not running: python.exe was blocked');
    expect(h.ctor).toHaveLength(0);
  });

  it('a connection that dies mid-turn becomes a router message and drops the cached client', async () => {
    h.responder = () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    await expect(processMessage('hello')).rejects.toThrow(/The AI router stopped answering/);
    h.responder = () => new AIMessage(GOOD);
    await processMessage('again');
    expect(h.ctor).toHaveLength(2);
  });

  it('Anthropic selected but not routed explains what is missing', () => {
    h.router.usesRouter = false;
    expect(() => getModelForProvider()).toThrow(/Anthropic \(Claude\) is selected but not ready/);
  });
});
