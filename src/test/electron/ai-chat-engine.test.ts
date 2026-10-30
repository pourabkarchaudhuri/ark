/**
 * AI chat engine (main process, 1.0.97 B12): model cache keys, library tool
 * payload and ids, parallel tool execution, the tool-cap summary, Gemini
 * reviewer gating and rewrite acceptance, system prompt size, Ollama numCtx,
 * follow-up parsing and the gg.deals region passed to the price tool.
 *
 * The LangChain chat model classes are replaced with scripted fakes; the real
 * @langchain/core message classes are used so the message list the engine
 * builds is the one a provider would receive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';

type Responder = (info: { kind: string; opts: Record<string, unknown>; bound: boolean; messages: BaseMessage[] }) => Promise<AIMessage> | AIMessage;

const h = vi.hoisted(() => ({
  ctor: [] as Array<{ kind: string; opts: Record<string, unknown> }>,
  calls: [] as Array<{ kind: string; bound: boolean; opts: Record<string, unknown>; messages: unknown[] }>,
  responder: null as null | ((info: any) => any),
  settings: {
    provider: 'ollama' as string,
    googleKey: null as string | null,
    ollama: { url: 'http://localhost:11434', model: 'gemma3:12b', chatNumCtx: 8192 } as Record<string, unknown>,
  },
  steam: {
    getAppDetails: null as null | ((id: number) => Promise<unknown>),
    getGameReviews: null as null | ((id: number, n: number) => Promise<unknown>),
  },
  getPrices: null as null | ((ids: number[], region: string) => Promise<unknown>),
}));

function fakeModelClass(kind: string) {
  return class FakeModel {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      h.ctor.push({ kind, opts });
    }
    private async run(bound: boolean, messages: unknown[]) {
      h.calls.push({ kind, bound, opts: this.opts, messages: [...messages] });
      if (!h.responder) throw new Error('no responder');
      return h.responder({ kind, opts: this.opts, bound, messages });
    }
    invoke(messages: unknown[]) { return this.run(false, messages); }
    bindTools() {
      return { invoke: (messages: unknown[]) => this.run(true, messages) };
    }
  };
}

vi.mock('@langchain/openai', () => ({ AzureChatOpenAI: fakeModelClass('azure') }));
vi.mock('@langchain/google-genai', () => ({ ChatGoogleGenerativeAI: fakeModelClass('gemini') }));
vi.mock('@langchain/ollama', () => ({ ChatOllama: fakeModelClass('ollama') }));

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../electron/settings-store.js', () => ({
  DEFAULT_CHAT_NUM_CTX: 8192,
  settingsStore: {
    getPreferredChatProvider: () => h.settings.provider,
    getGoogleAIKey: () => h.settings.googleKey,
    getOllamaSettings: () => h.settings.ollama,
  },
}));
vi.mock('../../../electron/chat-store.js', () => ({
  chatStore: { getActiveConversation: () => null },
}));
vi.mock('../../../electron/steam-api.js', () => ({
  steamAPI: {
    getAppDetails: (id: number) => (h.steam.getAppDetails ? h.steam.getAppDetails(id) : Promise.resolve({ name: `Steam ${id}`, steam_appid: id })),
    getGameReviews: (id: number, n: number) => (h.steam.getGameReviews ? h.steam.getGameReviews(id, n) : Promise.resolve({ query_summary: {}, reviews: [] })),
    searchGames: async () => [],
    getRecommendations: async () => [],
  },
}));
vi.mock('../../../electron/epic-api.js', () => ({ epicAPI: { searchGames: async () => [], getGameDetails: async () => null } }));
vi.mock('../../../electron/hltb-api.js', () => ({ getHltbClient: async () => ({ getTimes: async () => null }) }));
vi.mock('../../../electron/metacritic-api.js', () => ({ fetchMetacriticReviews: async () => null }));
vi.mock('../../../electron/ggdeals-api.js', () => ({
  getGgDealsClient: async () => ({
    getPrices: (ids: number[], region: string) => (h.getPrices ? h.getPrices(ids, region) : Promise.resolve({ prices: {} })),
  }),
  normalizeRegion: (r: unknown) => (typeof r === 'string' && ['us', 'gb', 'eu', 'de', 'au', 'ca'].includes(r) ? r : 'us'),
}));
vi.mock('../../../electron/web-search.js', () => ({
  needsWebSearch: () => false,
  webSearch: async () => [],
  formatSearchContext: () => '',
}));

import {
  processMessage,
  getModelForProvider,
  parseSuggestedFollowUps,
  parseSteamAppId,
  buildLibraryToolPayload,
  passesLocalFormatChecks,
  acceptReviewerRewrite,
  SYSTEM_PROMPT,
  LIBRARY_TOOL_MAX_CHARS,
  __resetAiChatCachesForTests,
} from '../../../electron/ai-chat';

const GOOD_ANSWER = '## Answer\n\n- **Hades** is great\n\n---\nSuggested follow-ups:\n- What else is good?\n- Show my library';

function toolCall(name: string, args: Record<string, unknown>, id: string) {
  return { name, args, id, type: 'tool_call' as const };
}
function aiWithTools(calls: ReturnType<typeof toolCall>[], content = '') {
  return new AIMessage({ content, tool_calls: calls });
}

function setResponder(fn: Responder) { h.responder = fn; }

/** Script the bound (tool-capable) chat model: one reply per round, last reply repeats. */
function scriptChat(replies: AIMessage[], opts: { reviewer?: string } = {}) {
  let i = 0;
  setResponder(({ kind, opts: o, bound }) => {
    if (kind === 'gemini' && o.temperature === 0.1) return new AIMessage(opts.reviewer ?? 'VALID');
    if (!bound) return new AIMessage('## Summary\n\n- unbound');
    const r = replies[Math.min(i, replies.length - 1)];
    i++;
    return r;
  });
}

const azureOpts = (apiKey = 'key-1') => ({ azure: { endpoint: 'https://x.openai.azure.com/', apiKey, deployment: 'gpt', apiVersion: '2024-12-01-preview' } });

beforeEach(() => {
  h.ctor.length = 0;
  h.calls.length = 0;
  h.responder = null;
  h.settings.provider = 'ollama';
  h.settings.googleKey = null;
  h.settings.ollama = { url: 'http://localhost:11434', model: 'gemma3:12b', chatNumCtx: 8192 };
  h.steam.getAppDetails = null;
  h.steam.getGameReviews = null;
  h.getPrices = null;
  __resetAiChatCachesForTests();
});

// ── main-core#7 ────────────────────────────────────────────────────────────────

describe('model cache key', () => {
  it('builds a new Azure client when the key changes and reuses it for the same key', () => {
    h.settings.provider = 'azure-openai';
    const a = getModelForProvider(azureOpts('key-1')).model;
    const b = getModelForProvider(azureOpts('key-1')).model;
    const c = getModelForProvider(azureOpts('key-2')).model;
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(h.ctor.filter(x => x.kind === 'azure')).toHaveLength(2);
  });

  it('never keeps the raw key in the cache key (Gemini uses the hashed form too)', () => {
    h.settings.provider = 'gemini';
    h.settings.googleKey = 'AIzaSECRET';
    const m1 = getModelForProvider().model;
    expect(getModelForProvider().model).toBe(m1);
    h.settings.googleKey = 'AIzaOTHER';
    expect(getModelForProvider().model).not.toBe(m1);
  });

  it('clears the cached model after a 401 so a fixed key is picked up', async () => {
    h.settings.provider = 'azure-openai';
    setResponder(() => { const e = new Error('Unauthorized') as Error & { status: number }; e.status = 401; throw e; });
    await expect(processMessage('hi', undefined, [], undefined, undefined, azureOpts())).rejects.toThrow('Unauthorized');
    scriptChat([new AIMessage(GOOD_ANSWER)]);
    await processMessage('hi', undefined, [], undefined, undefined, azureOpts());
    expect(h.ctor.filter(x => x.kind === 'azure')).toHaveLength(2);
  });

  it('reports the effective provider id', () => {
    h.settings.provider = 'ollama';
    expect(getModelForProvider().provider).toBe('ollama');
    h.settings.provider = 'azure-openai';
    expect(getModelForProvider(azureOpts()).provider).toBe('azure-openai');
  });
});

// ── main-apis#49 ───────────────────────────────────────────────────────────────

describe('system prompt and Ollama context window', () => {
  it('keeps one copy of each section and stays compact', () => {
    expect(SYSTEM_PROMPT.length).toBeLessThan(7000);
    expect(SYSTEM_PROMPT).not.toContain('You have access to the following tools');
    expect(SYSTEM_PROMPT.match(/Suggested follow-ups:/g)?.length).toBeLessThanOrEqual(2);
    expect(SYSTEM_PROMPT.match(/When the user attaches an image/gi)?.length).toBe(1);
    // The example ending must be parseable by parseSuggestedFollowUps.
    const example = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf('---\nSuggested follow-ups:'));
    expect(parseSuggestedFollowUps('## X\n\nbody\n' + example.split('\n\n')[0]).suggestedFollowUps.length).toBeGreaterThanOrEqual(2);
  });

  it('passes numCtx to ChatOllama and rebuilds the model when the setting changes', () => {
    const a = getModelForProvider().model;
    expect(h.ctor.at(-1)).toMatchObject({ kind: 'ollama', opts: { numCtx: 8192 } });
    expect(getModelForProvider().model).toBe(a);
    h.settings.ollama = { ...h.settings.ollama, chatNumCtx: 16384 };
    expect(getModelForProvider().model).not.toBe(a);
    expect(h.ctor.at(-1)).toMatchObject({ kind: 'ollama', opts: { numCtx: 16384 } });
  });
});

// ── main-apis#32 / main-apis#6 ─────────────────────────────────────────────────

const STATUSES = ['Playing', 'Want to Play', 'Completed', 'On Hold'];
function bigLibrary(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    gameId: `steam-${1000 + i}`,
    name: `Some Fairly Long Game Title Number ${i}`,
    status: STATUSES[i % STATUSES.length],
    priority: 'Medium',
    addedAt: '2026-01-01T00:00:00.000Z',
  }));
}

describe('getLibraryGames payload', () => {
  it('stays under the size cap for a 2000-game library and drops ids/dates', () => {
    const out = buildLibraryToolPayload(bigLibrary(2000), {});
    expect(out.length).toBeLessThanOrEqual(LIBRARY_TOOL_MAX_CHARS);
    const parsed = JSON.parse(out);
    expect(parsed.totalGames).toBe(2000);
    expect(Object.keys(parsed.byStatus).sort()).toEqual([...STATUSES].sort());
    expect(parsed.byStatus.Playing.count).toBe(500);
    expect(parsed.byStatus.Playing.more).toMatch(/^\+\d+ more$/);
    expect(out).not.toContain('addedAt');
    expect(out).not.toContain('steam-');
  });

  it('filters by status', () => {
    const parsed = JSON.parse(buildLibraryToolPayload(bigLibrary(40), { status: 'completed' }));
    expect(Object.keys(parsed.byStatus)).toEqual(['Completed']);
    expect(parsed.byStatus.Completed.games).toHaveLength(10);
  });

  it('nameQuery returns gameId and steamAppId for matches', () => {
    const lib = [
      ...bigLibrary(5),
      { gameId: 'epic-ns:offer', name: 'Hollow Knight', status: 'Playing', priority: 'Medium' },
      { gameId: 'custom-4', name: 'Hollow Hills', status: 'On Hold', priority: 'Low' },
    ];
    const parsed = JSON.parse(buildLibraryToolPayload(lib, { nameQuery: 'hollow' }));
    expect(parsed.matches).toEqual([
      { name: 'Hollow Knight', gameId: 'epic-ns:offer', steamAppId: null, status: 'Playing' },
      { name: 'Hollow Hills', gameId: 'custom-4', steamAppId: null, status: 'On Hold' },
    ]);
    const steam = JSON.parse(buildLibraryToolPayload(lib, { nameQuery: 'number 3' }));
    expect(steam.matches[0]).toMatchObject({ gameId: 'steam-1003', steamAppId: 1003 });
  });
});

describe('parseSteamAppId', () => {
  it('accepts numbers, numeric strings and steam-<digits>', () => {
    expect(parseSteamAppId(123)).toBe(123);
    expect(parseSteamAppId('123')).toBe(123);
    expect(parseSteamAppId('steam-123')).toBe(123);
    expect(parseSteamAppId(0)).toBeNull();
    expect(parseSteamAppId(-4)).toBeNull();
    expect(parseSteamAppId('abc')).toBeNull();
    expect(parseSteamAppId('epic-ns:offer')).toBeNull();
    expect(parseSteamAppId(1.5)).toBeNull();
  });
});

describe('add/remove library tools', () => {
  const lib = [
    { gameId: 'steam-123', name: 'Hades', status: 'Playing', priority: 'High' },
    { gameId: 'epic-ns:offer', name: 'Alan Wake 2', status: 'Want to Play', priority: 'Medium' },
  ];

  async function runTools(calls: ReturnType<typeof toolCall>[]) {
    scriptChat([aiWithTools(calls), new AIMessage(GOOD_ANSWER)]);
    const res = await processMessage('do it', undefined, lib);
    const toolMsgs = (h.calls[1].messages as BaseMessage[]).filter((m): m is ToolMessage => m instanceof ToolMessage);
    return { res, toolMsgs };
  }

  it("removes the right entry for a 'steam-123' appId", async () => {
    const { res } = await runTools([toolCall('removeGameFromLibrary', { appId: 'steam-123' }, 't1')]);
    expect(res.actions).toEqual([expect.objectContaining({ type: 'remove', appId: 123, gameId: 'steam-123' })]);
  });

  it('removes an Epic entry by gameId', async () => {
    const { res } = await runTools([toolCall('removeGameFromLibrary', { gameId: 'epic-ns:offer' }, 't1')]);
    expect(res.actions).toEqual([expect.objectContaining({ type: 'remove', gameId: 'epic-ns:offer', gameName: 'Alan Wake 2' })]);
  });

  it('rejects invalid add ids and queues nothing', async () => {
    const { res, toolMsgs } = await runTools([
      toolCall('addGameToLibrary', { appId: 'abc' }, 't1'),
      toolCall('addGameToLibrary', { appId: 0 }, 't2'),
    ]);
    expect(res.actions).toEqual([]);
    expect(String(toolMsgs[0].content)).toMatch(/Invalid appId; call searchSteamGames first/);
    expect(String(toolMsgs[1].content)).toMatch(/Invalid appId/);
  });

  it('queues nothing when Steam has no details for the app', async () => {
    h.steam.getAppDetails = async () => null;
    const { res, toolMsgs } = await runTools([toolCall('addGameToLibrary', { appId: 999 }, 't1')]);
    expect(res.actions).toEqual([]);
    expect(String(toolMsgs[0].content)).toMatch(/not found/i);
  });
});

// ── main-apis#47 ───────────────────────────────────────────────────────────────

describe('parallel tool execution', () => {
  it('runs read-only tools concurrently, keeps ToolMessage order and add/remove call order', async () => {
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
    h.steam.getAppDetails = async (id) => { await delay(200); return { name: `Steam ${id}`, steam_appid: id }; };
    h.steam.getGameReviews = async () => { await delay(200); return { query_summary: { total_reviews: 1 }, reviews: [] }; };
    const lib = [
      { gameId: 'steam-1', name: 'One', status: 'Playing', priority: 'High' },
      { gameId: 'steam-2', name: 'Two', status: 'Playing', priority: 'High' },
    ];
    scriptChat([
      aiWithTools([
        toolCall('removeGameFromLibrary', { gameId: 'steam-2' }, 'a'),
        toolCall('getGameDetails', { appId: 10 }, 'b'),
        toolCall('addGameToLibrary', { appId: 50 }, 'c'),
        toolCall('getSteamReviews', { appId: 10 }, 'd'),
        toolCall('removeGameFromLibrary', { gameId: 'steam-1' }, 'e'),
      ]),
      new AIMessage(GOOD_ANSWER),
    ]);
    const t0 = Date.now();
    const res = await processMessage('go', undefined, lib);
    const elapsed = Date.now() - t0;
    // Sequential: details 200 + reviews 200 + add's details lookup 200 = 600 ms.
    // Parallel read-only then sequential add: 200 + 200 = 400 ms.
    expect(elapsed).toBeLessThan(540);
    const ids = (h.calls[1].messages as BaseMessage[]).filter((m): m is ToolMessage => m instanceof ToolMessage).map(m => m.tool_call_id);
    expect(ids).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(res.actions.map(a => `${a.type}:${a.gameId}`)).toEqual(['remove:steam-2', 'add:steam-50', 'remove:steam-1']);
    const callSteps = res.chainOfThought.filter(s => s.type === 'tool_call').map(s => s.toolName);
    expect(callSteps).toEqual(['removeGameFromLibrary', 'getGameDetails', 'addGameToLibrary', 'getSteamReviews', 'removeGameFromLibrary']);
  });
});

// ── main-apis#35 ───────────────────────────────────────────────────────────────

describe('tool-iteration cap summary', () => {
  it('sends no dangling tool_calls and uses the unbound model', async () => {
    let n = 0;
    setResponder(({ bound }) => {
      if (!bound) return new AIMessage('## Summary\n\n- done');
      n++;
      return aiWithTools([toolCall('getLibraryGames', {}, `t${n}`)]);
    });
    const res = await processMessage('loop', undefined, [{ gameId: 'steam-1', name: 'One', status: 'Playing', priority: 'High' }]);
    const summaryCall = h.calls.at(-1)!;
    expect(summaryCall.bound).toBe(false);
    const msgs = summaryCall.messages as BaseMessage[];
    const answered = new Set(msgs.filter((m): m is ToolMessage => m instanceof ToolMessage).map(m => m.tool_call_id));
    for (const m of msgs) {
      if (m instanceof AIMessage) for (const tc of m.tool_calls ?? []) expect(answered.has(tc.id!)).toBe(true);
    }
    expect(res.content).toContain('## Summary');
  });
});

// ── main-apis#19 / main-apis#48 ───────────────────────────────────────────────

describe('Gemini reviewer', () => {
  const reviewerCalls = () => h.calls.filter(c => c.kind === 'gemini' && c.opts.temperature === 0.1);

  it('never runs for Ollama even when a Gemini key is stored', async () => {
    h.settings.googleKey = 'AIzaKEY';
    scriptChat([new AIMessage('plain text answer')]);
    await processMessage('hi', undefined, []);
    expect(h.calls.some(c => c.kind === 'gemini')).toBe(false);
    expect(h.ctor.some(c => c.kind === 'gemini')).toBe(false);
  });

  it('never runs for Azure even when a Gemini key is stored', async () => {
    h.settings.provider = 'azure-openai';
    h.settings.googleKey = 'AIzaKEY';
    scriptChat([new AIMessage('plain text answer')]);
    await processMessage('hi', undefined, [], undefined, undefined, azureOpts());
    expect(h.ctor.some(c => c.kind === 'gemini')).toBe(false);
  });

  it('runs when Gemini is the chosen provider and the answer fails local checks', async () => {
    h.settings.provider = 'gemini';
    h.settings.googleKey = 'AIzaKEY';
    scriptChat([new AIMessage('plain text answer')]);
    await processMessage('hi', undefined, []);
    const reviewer = h.ctor.find(c => c.kind === 'gemini' && c.opts.temperature === 0.1);
    expect(reviewer).toBeDefined();
    expect(Number(reviewer!.opts.maxOutputTokens)).toBeGreaterThanOrEqual(4096);
    expect(reviewerCalls().length).toBeGreaterThan(0);
  });

  it('skips the reviewer call for a well-formed answer', async () => {
    h.settings.provider = 'gemini';
    h.settings.googleKey = 'AIzaKEY';
    scriptChat([new AIMessage(GOOD_ANSWER)]);
    await processMessage('hi', undefined, []);
    expect(h.calls.filter(c => c.kind === 'gemini')).toHaveLength(1); // the chat call only
  });

  it('keeps the original when the rewrite is truncated or too short', async () => {
    h.settings.provider = 'gemini';
    h.settings.googleKey = 'AIzaKEY';
    const original = '## Long answer\n\n' + '- point about the game that matters\n'.repeat(20);
    scriptChat([new AIMessage(original)], { reviewer: 'IMPROVE: ## Short\n\n- one' });
    const res = await processMessage('hi', undefined, []);
    expect(res.content).toContain('## Long answer');
  });
});

describe('reviewer rewrite acceptance', () => {
  const original = '## Title\n\n' + '- a fairly long line of content\n'.repeat(10) + '\n---\nSuggested follow-ups:\n- More?';
  it('rejects MAX_TOKENS, short, headless or follow-up-dropping rewrites', () => {
    const good = original.replace('Title', 'Better title');
    expect(acceptReviewerRewrite(original, good, 'STOP')).toBe(true);
    expect(acceptReviewerRewrite(original, good, 'MAX_TOKENS')).toBe(false);
    expect(acceptReviewerRewrite(original, '## T\n\n- x', 'STOP')).toBe(false);
    expect(acceptReviewerRewrite(original, good.replace('## ', ''), 'STOP')).toBe(false);
    expect(acceptReviewerRewrite(original, good.replace('Suggested follow-ups:', 'Next:'), 'STOP')).toBe(false);
  });

  it('local format check needs a ## heading and a follow-ups block', () => {
    expect(passesLocalFormatChecks(GOOD_ANSWER)).toBe(true);
    expect(passesLocalFormatChecks('plain')).toBe(false);
    expect(passesLocalFormatChecks('## Heading only\n\n- x')).toBe(false);
  });
});

// ── main-apis#17 ───────────────────────────────────────────────────────────────

describe('parseSuggestedFollowUps', () => {
  it('keeps content after a --- divider when there is no follow-up block', () => {
    const text = '## Options\n\n### Option A\n- a\n\n---\n### Option B\n- b';
    expect(parseSuggestedFollowUps(text)).toEqual({ content: text, suggestedFollowUps: [] });
  });

  it('never treats table separator rows as the marker', () => {
    const text = '## Table\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    expect(parseSuggestedFollowUps(text).content).toBe(text);
  });

  it('keeps content when a follow-up label has no bullet lines', () => {
    const text = '## A\n\nbody\n---\nSuggested follow-ups: none today';
    expect(parseSuggestedFollowUps(text).content).toBe(text);
  });

  it('still parses a normal follow-up block', () => {
    const res = parseSuggestedFollowUps(GOOD_ANSWER);
    expect(res.content).toBe('## Answer\n\n- **Hades** is great');
    expect(res.suggestedFollowUps).toEqual(['What else is good?', 'Show my library']);
  });

  it('parses a bold label', () => {
    const res = parseSuggestedFollowUps('## A\n\nbody\n\n---\n**Suggested follow-ups:**\n- One\n- Two');
    expect(res.suggestedFollowUps).toEqual(['One', 'Two']);
    expect(res.content).toBe('## A\n\nbody');
  });
});

// ── main-apis#43 ───────────────────────────────────────────────────────────────

describe('gg.deals region', () => {
  it('passes the request region to getPrices', async () => {
    const getPrices = vi.fn(async () => ({ prices: {} }));
    h.getPrices = getPrices;
    scriptChat([aiWithTools([toolCall('getGameDeals', { appId: 620 }, 't1')]), new AIMessage(GOOD_ANSWER)]);
    await processMessage('price?', undefined, [], undefined, undefined, undefined, undefined, 'gb');
    expect(getPrices).toHaveBeenCalledWith([620], 'gb');
  });

  it("defaults to 'us' for a missing or unknown region", async () => {
    const getPrices = vi.fn(async () => ({ prices: {} }));
    h.getPrices = getPrices;
    scriptChat([aiWithTools([toolCall('getGameDeals', { appId: 620 }, 't1')]), new AIMessage(GOOD_ANSWER)]);
    await processMessage('price?', undefined, [], undefined, undefined, undefined, undefined, 'zz');
    expect(getPrices).toHaveBeenCalledWith([620], 'us');
  });
});
