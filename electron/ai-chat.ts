/**
 * AI Chat Agent — Unified LLM Proxy
 *
 * Routes all chat through LangChain.js so that every provider (Ollama, Gemini,
 * future additions) shares the same message format, tool-calling interface,
 * streaming behaviour, and error handling.  The rest of the app never touches
 * raw provider APIs — it only talks to `processMessage()`.
 *
 * Supported providers:
 *   • Local    — built-in llama.cpp server via @langchain/openai (ChatOpenAI), or the user's own
 *                Ollama via @langchain/ollama (ChatOllama) when "Use my own Ollama" is on
 *   • AI router — when the chat route is a connector other than Built-in (Gemini, Azure OpenAI,
 *                Anthropic, OpenAI, Ollama URL, OpenAI-compatible): the bundled LiteLLM sidecar,
 *                reached as an OpenAI-compatible endpoint through ChatOpenAI (1.0.97 B35)
 *   • Gemini   — cloud, via @langchain/google-genai (ChatGoogleGenerativeAI), when no router route is set
 *   • Azure OpenAI — cloud, via @langchain/openai (AzureChatOpenAI), when no router route is set
 */

import { createHash } from 'node:crypto';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOllama } from '@langchain/ollama';
import { AzureChatOpenAI, ChatOpenAI } from '@langchain/openai';
import {
  HumanMessage,
  AIMessage,
  AIMessageChunk,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { steamAPI } from './steam-api.js';
import { epicAPI } from './epic-api.js';
import { getHltbClient } from './hltb-api.js';
import { getGgDealsClient, normalizeRegion } from './ggdeals-api.js';
import { fetchMetacriticReviews } from './metacritic-api.js';
import { chatStore } from './chat-store.js';
import { settingsStore, DEFAULT_CHAT_NUM_CTX, type PreferredChatProvider } from './settings-store.js';
import { needsWebSearch, webSearchOutcome, formatSearchContext } from './web-search.js';
import { logger } from './safe-logger.js';
import { makeNetFetch, withKeepAlive, bridgeGlobalFetchForHosts } from './net-fetch.js';
import { useBuiltinBackend, getBuiltinBackend } from './local-ai/backend.js';
import { getAiRouter } from './ai-router/service.js';
import { providerForKind } from './ai-router/legacy-sync.js';
import type { ChatTarget } from './ai-router/router.js';
import { getModelForRole } from './local-ai/manifest.js';
import { normalizeGameStatus } from '../src/lib/game-status-normalize.js';
import { pickRecommendationSeed, librarySignature, steamAppIdOf } from './ai-reco-seed.js';

// ── Types ──────────────────────────────────────────────────────────────────────

interface GameContext {
  appId: number;
  name: string;
  headerImage?: string;
}

interface LibraryEntry {
  gameId: string;
  name?: string;
  status: string;
  priority: string;
  addedAt?: string;
  /** Used to pick the recommendation seed (most played / highest rated). */
  hoursPlayed?: number;
  rating?: number;
}

interface LibraryAction {
  type: 'add' | 'remove';
  appId: number;
  /** Explicit gameId (e.g. steam-123) so renderer gets a stable id across IPC */
  gameId?: string;
  status?: string;
  gameName?: string;
}

interface ThoughtStep {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'validation';
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  timestamp: Date;
}

// Per-request mutable state (reset at the start of every processMessage call)
let currentLibraryData: LibraryEntry[] = [];
let pendingActions: LibraryAction[] = [];
let chainOfThought: ThoughtStep[] = [];

// ── API Key Helper ─────────────────────────────────────────────────────────────

function getApiKey(): string {
  const storedKey = settingsStore.getGoogleAIKey();
  if (storedKey) return storedKey;
  throw new Error('No API key configured. Please add your Google AI API key in Settings.');
}

// ── Unified Model Factory ──────────────────────────────────────────────────────
//
// Both providers are exposed as LangChain BaseChatModel instances so the rest
// of the pipeline (messages, tools, streaming) is completely provider-agnostic.

export interface AzureProviderOptions {
  endpoint: string;
  apiKey: string;
  deployment: string;
  /** API version (e.g. 2025-04-01-preview). From AZURE_OPENAI_KEY_VERSION or AZURE_OPENAI_API_VERSION. */
  apiVersion?: string;
}

export type ChatProviderOptions = { azure?: AzureProviderOptions };

type ChatModel = ChatGoogleGenerativeAI | ChatOllama | AzureChatOpenAI | ChatOpenAI;

/** Thrown when local chat is picked but its model is not on disk yet; the UI offers the download. */
export const LOCAL_CHAT_MODEL_MISSING = 'LOCAL_CHAT_MODEL_MISSING';

/** Chat server of the built-in runtime, filled by `prepareBuiltinChat` before each local turn. */
let builtinChat: { baseUrl: string; apiKey: string; numCtx: number } | null = null;

/**
 * Start (or reuse) the built-in chat server for this turn. getModelForProvider is synchronous, so
 * the endpoint is resolved here, once, and read from `builtinChat` there.
 */
async function prepareBuiltinChat(): Promise<void> {
  const numCtx = settingsStore.getOllamaSettings().chatNumCtx || DEFAULT_CHAT_NUM_CTX;
  const backend = getBuiltinBackend();
  if (!backend.isModelReady('chat')) {
    const err = new Error(
      'The local chat model is not downloaded yet. Open Settings > AI providers > Built-in and choose Download chat model, or pick another model in the Chat panel.',
    );
    (err as Error & { code?: string }).code = LOCAL_CHAT_MODEL_MISSING;
    throw err;
  }
  const endpoint = await backend.chatEndpoint(numCtx);
  builtinChat = { ...endpoint, numCtx };
  backend.markChatUsed();
}

/** Longest a single chat request (headers plus the streamed body) may run. */
const CHAT_REQUEST_CEILING_MS = 10 * 60_000;

/** The Gemini SDK has no fetch option: send only its API host through Chromium's network stack. */
function bridgeGeminiNetwork(): void {
  bridgeGlobalFetchForHosts(['generativelanguage.googleapis.com'], { timeoutMs: CHAT_REQUEST_CEILING_MS });
}

/** Local chat requests refresh the server's idle timer at start, while streaming and at the end. */
const builtinChatFetch: typeof fetch = withKeepAlive(
  (input, init) => fetch(input, init),
  () => { try { getBuiltinBackend().markChatUsed(); } catch { /* backend not available */ } },
);

/** Chat endpoint of the AI router (LiteLLM), filled by `prepareRouterChat` before each turn that uses it. */
let routerChat: ChatTarget | null = null;

/**
 * Resolve the router endpoint for this turn when the chat route is a connector other than Built-in.
 * Starting the sidecar can fail (Python missing, bad config): that error is shown to the user as it
 * is, because chat has no fallback; embeddings and reranking do.
 */
async function prepareRouterChat(): Promise<void> {
  routerChat = null;
  let router: ReturnType<typeof getAiRouter>;
  try { router = getAiRouter(); } catch { return; } // no Electron (unit tests): local chat only
  if (!router.chatUsesRouter()) return;
  routerChat = await router.chatTarget();
}

let cachedModel: ChatModel | null = null;
let cachedModelKey: string | null = null;

/** Short, non-reversible fingerprint of an API key so a rotated key gets a new client
 *  without the raw key ever sitting in a cache key. */
function keyFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

/** Test seam: drop the cached chat and reviewer models. */
export function __resetAiChatCachesForTests(): void {
  builtinChat = null;
  routerChat = null;
  cachedModel = null;
  cachedModelKey = null;
  cachedValidationModel = null;
  cachedValidationKey = null;
}

/** True for provider errors that mean the key itself was rejected (401/403). */
function isAuthError(error: unknown): boolean {
  const e = error as { status?: unknown; statusCode?: unknown; code?: unknown; response?: { status?: unknown } } | null;
  const status = Number(e?.status ?? e?.statusCode ?? e?.response?.status ?? NaN);
  return status === 401 || status === 403;
}

/**
 * Get the LangChain chat model for the preferred provider from Settings.
 * Provider is always read from the store (single source of truth); the returned
 * `provider` is the effective id the turn actually talks to.
 */
export function getModelForProvider(providerOptions?: ChatProviderOptions): { model: ChatModel; providerName: string; provider: PreferredChatProvider } {
  const effective = settingsStore.getPreferredChatProvider();

  // AI router: the chat route names a connector other than Built-in, so ChatOpenAI talks to LiteLLM.
  // `provider` only decides local-versus-cloud behaviour below (web search grounding, message wrapping).
  if (routerChat) {
    const t = routerChat;
    const configKey = `router:${t.baseUrl}:${t.connector.id}:${t.model}:${t.providerName}:${keyFingerprint(t.apiKey)}`;
    const provider = providerForKind(t.connector.kind);
    if (cachedModel && cachedModelKey === configKey) {
      return { model: cachedModel as ChatOpenAI, providerName: t.providerName, provider };
    }
    logger.log(`[AI Proxy] Creating AI router chat model (${t.providerName})`);
    cachedModel = new ChatOpenAI({
      model: t.model,
      apiKey: t.apiKey,
      configuration: { baseURL: t.baseUrl },
      temperature: 0.7,
    });
    cachedModelKey = configKey;
    return { model: cachedModel, providerName: t.providerName, provider };
  }

  if (effective === 'azure-openai') {
    if (!providerOptions?.azure?.endpoint || !providerOptions?.azure?.apiKey || !providerOptions?.azure?.deployment) {
      throw new Error(
        'Azure OpenAI is selected but credentials were not provided. Add Endpoint, API Key, and Deployment in Settings > AI providers > Azure OpenAI, then try again.',
      );
    }
    const { endpoint, apiKey, deployment, apiVersion } = providerOptions.azure;
    const baseUrl = endpoint.replace(/\/+$/, '');
    const version = apiVersion?.trim() || '2024-12-01-preview';
    const configKey = `azure:${baseUrl}:${deployment}:${version}:${keyFingerprint(apiKey)}`;
    if (cachedModel && cachedModelKey === configKey) {
      return { model: cachedModel as AzureChatOpenAI, providerName: `Azure OpenAI (${deployment})`, provider: effective };
    }
    logger.log('[AI Proxy] Creating Azure OpenAI model:', deployment, 'api-version:', version);
    cachedModel = new AzureChatOpenAI({
      azureOpenAIEndpoint: baseUrl,
      azureOpenAIApiKey: apiKey,
      azureOpenAIApiDeploymentName: deployment,
      model: deployment, // required so LangChain uses max_completion_tokens for reasoning models (e.g. gpt-5.2)
      azureOpenAIApiVersion: version,
      // Chromium's network stack (system certificates and proxy); the SDK keeps its own request timeout.
      configuration: { fetch: makeNetFetch({ timeoutMs: CHAT_REQUEST_CEILING_MS }) },
      temperature: 0.7,
      maxCompletionTokens: 2048,
    });
    cachedModelKey = configKey;
    return { model: cachedModel, providerName: `Azure OpenAI (${deployment})`, provider: effective };
  }

  if (effective === 'anthropic') {
    // Anthropic chat only runs through the AI router: reaching here means its connector is not routed.
    throw new Error(
      'Anthropic (Claude) is selected but not ready. Save your Anthropic key in Settings and try again.',
    );
  }

  if (effective === 'gemini') {
    let geminiKey: string;
    try {
      geminiKey = getApiKey();
    } catch {
      throw new Error(
        'Gemini is selected but no API key is configured. Add your Google AI API key in Settings > AI providers > Google Gemini, or choose another model in the Chat panel.',
      );
    }
    const configKey = `gemini:${keyFingerprint(geminiKey)}`;
    if (cachedModel && cachedModelKey === configKey) {
      return { model: cachedModel as ChatGoogleGenerativeAI, providerName: 'Gemini 2.5 Flash', provider: effective };
    }
    logger.log('[AI Proxy] Creating Gemini model');
    bridgeGeminiNetwork();
    cachedModel = new ChatGoogleGenerativeAI({
      apiKey: geminiKey,
      model: 'gemini-2.5-flash',
      temperature: 0.7,
      maxOutputTokens: 2048,
    });
    cachedModelKey = configKey;
    return { model: cachedModel, providerName: 'Gemini 2.5 Flash', provider: effective };
  }

  // Built-in local chat: ChatOpenAI against the llama-server started by prepareBuiltinChat.
  if (useBuiltinBackend()) {
    if (!builtinChat) {
      throw new Error('The built-in local chat server is not running. Try again, or pick another model in the Chat panel.');
    }
    const { baseUrl, apiKey, numCtx } = builtinChat;
    const label = getModelForRole('chat')?.id ?? 'local chat';
    const configKey = `builtin:${baseUrl}:${numCtx}:${keyFingerprint(apiKey)}`;
    if (cachedModel && cachedModelKey === configKey) {
      return { model: cachedModel as ChatOpenAI, providerName: `Local ${label}`, provider: 'ollama' };
    }
    logger.log(`[AI Proxy] Creating built-in local chat model (${label}, ctx ${numCtx})`);
    cachedModel = new ChatOpenAI({
      model: label,
      apiKey,
      // Keeps the chat server's idle timer from unloading the model during a long turn.
      configuration: { baseURL: baseUrl, fetch: builtinChatFetch },
      temperature: 0.7,
    });
    cachedModelKey = configKey;
    return { model: cachedModel, providerName: `Local ${label}`, provider: 'ollama' };
  }

  // ollama or any other → use Ollama from settings
  const ollamaSettings = settingsStore.getOllamaSettings();
  const baseUrl = ollamaSettings.url.replace(/\/$/, '');
  const numCtx = ollamaSettings.chatNumCtx || DEFAULT_CHAT_NUM_CTX;
  const configKey = `ollama:${baseUrl}:${ollamaSettings.model}:${numCtx}`;
  if (cachedModel && cachedModelKey === configKey) {
    return { model: cachedModel as ChatOllama, providerName: `Ollama ${ollamaSettings.model}`, provider: 'ollama' };
  }
  logger.log(`[AI Proxy] Creating Ollama model (${ollamaSettings.model} @ ${baseUrl}, num_ctx ${numCtx})`);
  cachedModel = new ChatOllama({
    model: ollamaSettings.model,
    baseUrl,
    temperature: 0.7,
    numCtx,
  });
  cachedModelKey = configKey;
  return { model: cachedModel, providerName: `Ollama ${ollamaSettings.model}`, provider: 'ollama' };
}

// Separate validation model (always Gemini — needs an API key)
let cachedValidationModel: ChatGoogleGenerativeAI | null = null;
let cachedValidationKey: string | null = null;

function getValidationModel(): ChatGoogleGenerativeAI {
  const currentKey = getApiKey();
  const fingerprint = keyFingerprint(currentKey);
  if (cachedValidationModel && cachedValidationKey === fingerprint) return cachedValidationModel;

  // 512 tokens cut rewrites off mid-list; a full answer plus follow-ups needs room.
  // Thinking is off: the reviewer only checks format, and thought tokens count
  // against maxOutputTokens on 2.5 Flash.
  bridgeGeminiNetwork();
  cachedValidationModel = new ChatGoogleGenerativeAI({
    apiKey: currentKey,
    model: 'gemini-2.5-flash',
    temperature: 0.1,
    maxOutputTokens: 4096,
    thinkingConfig: { thinkingBudget: 0 },
  });
  cachedValidationKey = fingerprint;
  return cachedValidationModel;
}

// ── Tools ──────────────────────────────────────────────────────────────────────

function isSteamSearchNetworkError(error: unknown): boolean {
  const err = error instanceof Error ? error : new Error(String(error));
  const cause = (err as unknown as { cause?: unknown }).cause;
  const causeMsg = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  const msg = err.message + ' ' + causeMsg;
  const lower = msg.toLowerCase();
  return (
    lower.includes('fetch failed') ||
    lower.includes('certificate') ||
    lower.includes('self signed') ||
    lower.includes('econnrefused') ||
    lower.includes('etimedout') ||
    lower.includes('network') ||
    lower.includes('enotfound')
  );
}

const STEAM_SEARCH_NETWORK_ERROR_MESSAGE =
  'Steam search failed due to a connection or network error (e.g. certificate or proxy). ' +
  "When users search in the app's Browse tab, games do show up — the data is there. If the Browse search works, the game is available and the issue is only with this connection. " +
  "Tell the user they can add the game from the Browse tab, or try again when the connection is fixed.";

const searchGamesTool = tool(
  async ({ query, limit = 10 }: { query: string; limit?: number }) => {
    logger.log(`[AI Tool] searchGames: "${query}" (limit: ${limit})`);
    try {
      const results = await steamAPI.searchGames(query, limit);
      return JSON.stringify(results.map(g => ({ id: g.id, name: g.name, type: g.type })));
    } catch (error) {
      if (isSteamSearchNetworkError(error)) {
        return STEAM_SEARCH_NETWORK_ERROR_MESSAGE;
      }
      return `Error searching games: ${error}`;
    }
  },
  {
    name: 'searchSteamGames',
    description: 'Search for games on Steam by name. Returns a list with id and name. ALWAYS call this first when the user mentions a game by name (e.g. "Add Cyberpunk 2077", "review Hades") to get the Steam App ID before using addGameToLibrary, removeGameFromLibrary, or getGameDetails. If the tool returns a connection/network error, the same games may still appear when searching in the app\'s Browse tab — the data is there; the issue is the connection.',
    schema: z.object({
      query: z.string().describe('The search query for game name'),
      limit: z.number().optional().describe('Maximum number of results (default 10)'),
    }),
  },
);

const getGameDetailsTool = tool(
  async ({ appId }: { appId: number }) => {
    logger.log(`[AI Tool] getGameDetails: ${appId}`);
    try {
      const details = await steamAPI.getAppDetails(appId);
      if (!details) return `Game with ID ${appId} not found`;
      return JSON.stringify({
        name: details.name,
        appId: details.steam_appid,
        description: details.short_description,
        developers: details.developers,
        publishers: details.publishers,
        genres: details.genres?.map(g => g.description),
        releaseDate: details.release_date?.date,
        metacriticScore: details.metacritic?.score,
        price: details.is_free ? 'Free' : details.price_overview?.final_formatted,
        platforms: {
          windows: details.platforms?.windows,
          mac: details.platforms?.mac,
          linux: details.platforms?.linux,
        },
        categories: details.categories?.map(c => c.description),
      });
    } catch (error) {
      return `Error getting game details: ${error}`;
    }
  },
  {
    name: 'getGameDetails',
    description: 'Get detailed information about a specific game by its Steam App ID (use searchSteamGames first to get appId from a game name). Returns name, description, developers, publishers, genres, release date, Metacritic score, price, platforms.',
    schema: z.object({
      appId: z.number().describe('The Steam App ID of the game (from searchSteamGames)'),
    }),
  },
);

/**
 * Parse a Steam app id the model passed: a positive integer, a numeric string or
 * 'steam-<digits>'. Anything else (epic/custom ids, 0, junk) is null, so the
 * add/remove tools can refuse instead of coercing to app 0.
 */
export function parseSteamAppId(v: unknown): number | null {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const m = v.trim().match(/^(?:steam-)?(\d{1,10})$/);
    if (!m) return null;
    n = Number(m[1]);
  } else return null;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** getLibraryGames output cap (characters of JSON), so a big library never floods the context. */
export const LIBRARY_TOOL_MAX_CHARS = 10_000;
const LIBRARY_TOOL_DEFAULT_PER_STATUS = 50;
const LIBRARY_TOOL_MAX_MATCHES = 25;

/**
 * Build the getLibraryGames tool result: names grouped by status (no ids, dates or
 * priorities), at most `limit` per status plus a '+N more' marker, hard-capped at
 * LIBRARY_TOOL_MAX_CHARS. `nameQuery` instead returns matching entries with their
 * gameId / steamAppId so removals can target the exact entry.
 */
export function buildLibraryToolPayload(
  entries: LibraryEntry[],
  opts: { status?: string; limit?: number; nameQuery?: string },
): string {
  const statusFilter = opts.status?.trim().toLowerCase();
  const pool = statusFilter ? entries.filter(e => e.status.toLowerCase() === statusFilter) : entries;

  const query = opts.nameQuery?.trim().toLowerCase();
  if (query) {
    const matches = pool
      .filter(e => (e.name || '').toLowerCase().includes(query))
      .slice(0, LIBRARY_TOOL_MAX_MATCHES)
      .map(e => ({
        name: (e.name || 'Unknown').slice(0, 120),
        gameId: e.gameId,
        steamAppId: e.gameId.startsWith('steam-') ? parseSteamAppId(e.gameId) : null,
        status: e.status,
      }));
    return JSON.stringify({ totalGames: entries.length, query: opts.nameQuery, matches });
  }

  const groups = new Map<string, string[]>();
  for (const e of pool) {
    const list = groups.get(e.status) ?? [];
    list.push((e.name || 'Unknown').slice(0, 120));
    groups.set(e.status, list);
  }

  const build = (perStatus: number) => {
    const byStatus: Record<string, { count: number; games: string[]; more?: string }> = {};
    for (const [status, names] of groups) {
      const games = names.slice(0, perStatus);
      byStatus[status] = { count: names.length, games, ...(names.length > games.length && { more: `+${names.length - games.length} more` }) };
    }
    return JSON.stringify({ totalGames: entries.length, byStatus });
  };

  let perStatus = Math.max(1, Math.min(opts.limit && opts.limit > 0 ? opts.limit : LIBRARY_TOOL_DEFAULT_PER_STATUS, 200));
  let out = build(perStatus);
  while (out.length > LIBRARY_TOOL_MAX_CHARS && perStatus > 1) {
    perStatus = Math.max(1, Math.floor(perStatus * 0.7));
    out = build(perStatus);
  }
  return out;
}

const getLibraryGamesTool = tool(
  async ({ status, limit, nameQuery }: { status?: string; limit?: number; nameQuery?: string }) => {
    logger.log('[AI Tool] getLibraryGames');
    if (currentLibraryData.length === 0) return 'The library is empty.';
    return buildLibraryToolPayload(currentLibraryData, { status, limit, nameQuery });
  },
  {
    name: 'getLibraryGames',
    description: "Get the user's library: game names grouped by status (count, up to `limit` names per status, '+N more' when truncated). Pass `status` to list one status, or `nameQuery` to find specific games — matches include the gameId needed by removeGameFromLibrary. When you reply, use one ### header per status and bullets with game names only; never paste store IDs.",
    schema: z.object({
      status: z.string().optional().describe('Only this status: Want to Play, Playing, Completed, or On Hold'),
      limit: z.number().optional().describe('Max names per status (default 50)'),
      nameQuery: z.string().optional().describe('Find library games whose name contains this text; returns gameId and steamAppId'),
    }),
  },
);

const addToLibraryTool = tool(
  async ({ appId, status: rawStatus }: { appId: number; status?: string }) => {
    // Normalize before queueing so the confirmation the model repeats names the status actually saved.
    const status = normalizeGameStatus(rawStatus);
    logger.log(`[AI Tool] addToLibrary: ${appId} with status "${status}"`);
    try {
      if (!Number.isSafeInteger(appId) || appId <= 0) return 'Invalid appId; call searchSteamGames first.';
      const stringId = `steam-${appId}`;
      const existing = currentLibraryData.find(e => e.gameId === stringId || e.gameId === String(appId));
      if (existing) return `Game ${appId} is already in the library with status "${existing.status}"`;

      const details = await steamAPI.getAppDetails(appId);
      if (!details) return `Steam app ${appId} was not found; call searchSteamGames to get a valid appId. Nothing was added.`;
      const gameName = details.name || `Game ${appId}`;
      pendingActions.push({ type: 'add', appId, gameId: stringId, status, gameName });
      return `Successfully queued "${gameName}" to be added to the library with status "${status}".`;
    } catch (error) {
      return `Error adding game to library: ${error}`;
    }
  },
  {
    name: 'addGameToLibrary',
    description: "Add a game to the user's library. You MUST get the Steam App ID first via searchSteamGames when the user names a game (e.g. 'Add Elden Ring'). Use the 'id' from search results as appId. If the user says 'add this game' and no game context is provided, ask which game they mean.",
    schema: z.object({
      appId: z.number().describe('The Steam App ID from searchSteamGames'),
      status: z.string().optional().describe('Want to Play, Playing, Playing Now, Completed, or On Hold'),
    }),
  },
);

const removeFromLibraryTool = tool(
  async ({ appId, gameId }: { appId?: number; gameId?: string }) => {
    logger.log(`[AI Tool] removeFromLibrary: ${gameId ?? appId}`);
    try {
      const existing = gameId
        ? currentLibraryData.find(e => e.gameId === gameId)
        : appId
          ? currentLibraryData.find(e => e.gameId === `steam-${appId}` || e.gameId === String(appId))
          : undefined;
      if (!existing) return `Game ${gameId ?? appId} is not in the library`;

      const steamAppId = existing.gameId.startsWith('steam-') ? parseSteamAppId(existing.gameId) : null;
      const gameName = existing.name || `Game ${existing.gameId}`;
      pendingActions.push({ type: 'remove', appId: steamAppId ?? 0, gameId: existing.gameId, gameName });
      return `Successfully queued "${gameName}" to be removed from the library.`;
    } catch (error) {
      return `Error removing game from library: ${error}`;
    }
  },
  {
    name: 'removeGameFromLibrary',
    description: "Remove a game from the user's library. Prefer `gameId` from getLibraryGames (call it with nameQuery, e.g. 'Remove Hollow Knight' → nameQuery 'hollow knight'); this works for Steam, Epic and custom entries. A Steam `appId` from searchSteamGames also works for Steam games.",
    schema: z.object({
      gameId: z.string().optional().describe('The library gameId from getLibraryGames (nameQuery matches)'),
      appId: z.number().optional().describe('A Steam App ID, for Steam games only'),
    }),
  },
);

/**
 * getGameRecommendations results per library signature (seed + limit + sorted Steam ids): each
 * uncached call costs Steam store requests, and repeated "what should I play?" questions used
 * to burst ~60 of them per message into a 429.
 */
const RECO_TOOL_CACHE_TTL = 30 * 60 * 1000;
const recoToolCache = new Map<string, { result: string; until: number }>();

const getRecommendationsTool = tool(
  async ({ limit = 10 }: { limit?: number }) => {
    logger.log(`[AI Tool] getRecommendations (limit: ${limit})`);
    if (currentLibraryData.length === 0) return 'Cannot provide recommendations — the library is empty.';

    const steamAppIds = currentLibraryData
      .map(e => steamAppIdOf(e.gameId))
      .filter((id): id is number => id !== null);

    if (steamAppIds.length === 0) return 'No Steam games found in the library.';

    // Seed from the most played / highest rated game, not whichever entry happens to be first.
    const seed = pickRecommendationSeed(currentLibraryData) ?? steamAppIds[0];
    const signature = librarySignature(steamAppIds, seed, limit);
    const cachedResult = recoToolCache.get(signature);
    if (cachedResult && cachedResult.until > Date.now()) return cachedResult.result;

    try {
      const recommendations = await steamAPI.getRecommendations(seed, steamAppIds, limit);
      if (recommendations.length === 0) return 'No recommendations found.';
      const result = JSON.stringify({
        basedOn: currentLibraryData.map(e => e.name || `Game ${e.gameId}`).slice(0, 5),
        totalLibraryGames: currentLibraryData.length,
        recommendations: recommendations.map((rec, i) => ({
          rank: i + 1,
          name: rec.name,
          appId: rec.appId,
          matchScore: Math.round(rec.score * 100),
          reasons: rec.reasons.slice(0, 3),
        })),
      });
      if (recoToolCache.size >= 20) recoToolCache.clear(); // bound memory in long sessions
      recoToolCache.set(signature, { result, until: Date.now() + RECO_TOOL_CACHE_TTL });
      return result;
    } catch (error) {
      return `Error getting recommendations: ${error}`;
    }
  },
  {
    name: 'getGameRecommendations',
    description: "Get personalized game recommendations based on the user's library. Use when the user asks 'what should I play' or 'games like X'. When presenting suggestions, prefer and highlight games that are released and playable now; do not suggest unreleased/upcoming games as 'play this'—mention those only as upcoming if relevant. If the library is empty, say so.",
    schema: z.object({
      limit: z.number().optional().describe('Maximum number of recommendations (default 10)'),
    }),
  },
);

const searchEpicGamesTool = tool(
  async ({ query, limit = 10 }: { query: string; limit?: number }) => {
    logger.log(`[AI Tool] searchEpicGames: "${query}" limit=${limit}`);
    try {
      const results = await epicAPI.searchGames(safeString(query), limit);
      if (results.length === 0) return 'No Epic Games Store results found.';
      return JSON.stringify({
        count: results.length,
        games: results.map((g) => ({
          title: g.title,
          namespace: g.namespace,
          offerId: g.id,
          developer: g.developer || g.seller?.name,
          urlSlug: g.urlSlug || g.catalogNs?.mappings?.[0]?.pageSlug,
        })),
      });
    } catch (error) {
      return `Error searching Epic: ${error}`;
    }
  },
  {
    name: 'searchEpicGames',
    description: 'Search the Epic Games Store by game name. Returns title, namespace, offerId, developer, urlSlug. Use for "Epic store", "on Epic", or when the user wants Epic games. Use getEpicGameDetails with namespace and offerId for full details.',
    schema: z.object({
      query: z.string().describe('Game name or search query'),
      limit: z.number().optional().describe('Max results (default 10)'),
    }),
  },
);

const getEpicGameDetailsTool = tool(
  async ({ namespace, offerId }: { namespace: string; offerId: string }) => {
    logger.log(`[AI Tool] getEpicGameDetails: ${namespace}/${offerId}`);
    try {
      const details = await epicAPI.getGameDetails(namespace, offerId);
      if (!details) return `Epic game ${namespace}/${offerId} not found.`;
      return JSON.stringify({
        title: details.title,
        description: details.description || details.longDescription,
        developer: details.developer || details.seller?.name,
        publisher: details.publisher,
        genres: details.tags?.filter((t) => t.groupName === 'genre').map((t) => t.name),
        releaseDate: details.effectiveDate,
        price: details.price?.totalPrice?.fmtPrice?.discountPrice ?? details.price?.totalPrice?.fmtPrice?.originalPrice ?? 'Unknown',
        urlSlug: details.urlSlug || details.catalogNs?.mappings?.[0]?.pageSlug,
      });
    } catch (error) {
      return `Error getting Epic game details: ${error}`;
    }
  },
  {
    name: 'getEpicGameDetails',
    description: 'Get details for a game on the Epic Games Store. Use namespace and offerId from searchEpicGames results.',
    schema: z.object({
      namespace: z.string().describe('Namespace from searchEpicGames'),
      offerId: z.string().describe('offerId from searchEpicGames'),
    }),
  },
);

const getSteamReviewsTool = tool(
  async ({ appId, limit = 5 }: { appId: number; limit?: number }) => {
    logger.log(`[AI Tool] getSteamReviews: ${appId} limit=${limit}`);
    try {
      const res = await steamAPI.getGameReviews(appId, Math.min(limit, 10));
      const summary = res.query_summary;
      const reviews = (res.reviews || []).slice(0, limit).map((r: { review: string; voted_up: boolean; author: { steamid: string } }) => ({
        review: r.review?.slice(0, 300),
        voted_up: r.voted_up,
      }));
      return JSON.stringify({
        totalReviews: summary?.total_reviews ?? 0,
        reviewScore: summary?.review_score ?? 0,
        reviewScoreDesc: summary?.review_score_desc ?? '',
        sampleReviews: reviews,
      });
    } catch (error) {
      return `Error fetching Steam reviews: ${error}`;
    }
  },
  {
    name: 'getSteamReviews',
    description: 'Get Steam user reviews for a game by Steam App ID. Use searchSteamGames first to get appId. Returns review score and sample reviews. Use when the user asks what players think, Steam reviews, or is it worth it.',
    schema: z.object({
      appId: z.number().describe('Steam App ID from searchSteamGames'),
      limit: z.number().optional().describe('Number of sample reviews (default 5, max 10)'),
    }),
  },
);

const getMetacriticReviewsTool = tool(
  async ({ gameName }: { gameName: string }) => {
    logger.log(`[AI Tool] getMetacriticReviews: "${gameName}"`);
    try {
      const data = await fetchMetacriticReviews(safeString(gameName));
      if (!data) return `No Metacritic data found for "${gameName}".`;
      return JSON.stringify({
        title: data.title,
        score: data.score,
        user_score: data.user_score,
        release_date: data.release_date,
        reviews: (data.reviews || []).slice(0, 5).map((r) => ({
          critic: r.review_critic,
          grade: r.review_grade,
          excerpt: r.review?.slice(0, 200),
        })),
      });
    } catch (error) {
      return `Error fetching Metacritic reviews: ${error}`;
    }
  },
  {
    name: 'getMetacriticReviews',
    description: 'Get Metacritic critic and user scores plus critic reviews by game name. Use when the user asks about critic reviews, Metacritic score, or "what do critics say".',
    schema: z.object({
      gameName: z.string().describe('Game name to look up on Metacritic'),
    }),
  },
);

const getHowLongToBeatTool = tool(
  async ({ gameName, year }: { gameName: string; year?: number }) => {
    logger.log(`[AI Tool] getHowLongToBeat: "${gameName}"`);
    try {
      const client = await getHltbClient();
      const t = await client.getTimes({ title: safeString(gameName, 200), year: typeof year === 'number' ? year : undefined });
      if (!t) return `No HowLongToBeat data found for "${gameName}".`;
      return JSON.stringify({
        title: t.name,
        year: t.year,
        mainStoryHours: t.mainHours,
        mainPlusExtrasHours: t.mainExtraHours,
        completionistHours: t.completionistHours,
        allStylesHours: t.allStylesHours,
        source: t.url,
      });
    } catch (error) {
      return `Error fetching HowLongToBeat times: ${error}`;
    }
  },
  {
    name: 'getHowLongToBeat',
    description: 'Get how long a game takes to beat (main story, main + extras, completionist hours) from HowLongToBeat, by game name. Use for "how long is X", "how long to beat", "is X short".',
    schema: z.object({
      gameName: z.string().describe('Game name to look up on HowLongToBeat'),
      year: z.number().optional().describe('Release year, to tell remakes and sequels apart'),
    }),
  },
);

/**
 * The deals tool is built per request so the user's gg.deals region (Settings →
 * Prices) reaches getPrices without a module global; the default instance is only
 * used for tool binding (same schema).
 */
const makeGameDealsTool = (region: string) => tool(
  async ({ appId }: { appId: number }) => {
    logger.log(`[AI Tool] getGameDeals: ${appId} (${region})`);
    try {
      const { prices, error } = await (await getGgDealsClient()).getPrices([appId], region);
      const p = prices[appId];
      if (!p) {
        return error === 'no-key'
          ? 'Prices are not set up: the user can add a gg.deals API key in Settings → Prices.'
          : `No gg.deals price data found for Steam app ${appId}.`;
      }
      return JSON.stringify({
        title: p.title,
        currency: p.currency,
        officialStoresNow: p.currentRetail,
        officialAllTimeLow: p.historicalRetail,
        keyResellersNow: p.currentKeyshops,
        keyResellersAllTimeLow: p.historicalKeyshops,
        source: p.url,
      });
    } catch (error) {
      return `Error fetching prices: ${error}`;
    }
  },
  {
    name: 'getGameDeals',
    description: 'Get current best prices and all-time low prices for a Steam game from gg.deals (official stores and key resellers), by Steam App ID. Use for "is X on sale", "cheapest price", "best deal".',
    schema: z.object({
      appId: z.number().describe('Steam App ID (from searchSteamGames)'),
    }),
  },
);

const getGameDealsTool = makeGameDealsTool('us');

const allTools = [
  searchGamesTool,
  getGameDetailsTool,
  getLibraryGamesTool,
  addToLibraryTool,
  removeFromLibraryTool,
  getRecommendationsTool,
  searchEpicGamesTool,
  getEpicGameDetailsTool,
  getSteamReviewsTool,
  getMetacriticReviewsTool,
  getHowLongToBeatTool,
  getGameDealsTool,
];

const toolMap: Record<string, typeof allTools[number]> = {};
for (const t of allTools) toolMap[t.name] = t;

// ── System Prompt (production: exhaustive for well-formatted, reasoned, contextual answers) ─

export const SYSTEM_PROMPT = `You are the assistant for "Ark", a game library and discovery app. Your answers must be well-formatted, reasoned, and grounded in context.

**Your role**
1. **Discover**: Search Steam/Epic, recommend from the user's library, and give accurate game info.
2. **Manage the library**: Add/remove games by name and confirm every action clearly (e.g. "Added Elden Ring to your library with status Want to Play").
3. **Answer gaming questions**: Genres, developers, release dates, reviews, walkthroughs, NPCs, puzzles, and in-game help. Use tools for scores, reviews and prices; use your knowledge for walkthroughs and codes.

**Context and reasoning (mandatory)**
- Consider what the user asked, their game or library context, and what any tools returned. Ground the reply in tool results; never invent scores, IDs, prices, release dates or review text.
- Resolve "add it" / "that game" from the conversation and tool results. If you cannot, ask once which game they mean.
- Continue the thread coherently; do not repeat or contradict earlier replies. Prefer a concrete answer over asking for more information when the intent is clear.
- News and release dates: use injected web search results when present; do not invent.

**Tools (use in strict sequences)**
- **Add by name**: searchSteamGames(query) → addGameToLibrary(appId) using \`id\` from the results. Never add without resolving the name first; if "add this" has no context, ask which game.
- **Remove**: getLibraryGames(nameQuery) → removeGameFromLibrary(gameId) using the match's \`gameId\` (works for Steam, Epic and custom games).
- **Library list**: getLibraryGames, optionally with \`status\`. When a status says "+N more" and the user wants everything, call it again for that status with a higher \`limit\`.
- **Reviews / "tell me about X"**: searchSteamGames → getGameDetails and/or getSteamReviews. Critic scores: getMetacriticReviews(gameName).
- **Epic store**: searchEpicGames → getEpicGameDetails(namespace, offerId).
- **Prices**: getGameDeals(appId). Say clearly which prices are from key resellers.
- **How long to beat**: getHowLongToBeat(gameName).
- **Recommendations**: getGameRecommendations for "what should I play" or "games like my library". If the library is empty, say so and suggest adding games or searching Steam/Epic.
- **No search results**: say so; suggest a different query or the app's Browse tab.
- **Steam search connection error**: the games still show in the app's **Browse** tab — the data is there, only this connection failed. Tell the user they can add from Browse or try again later.

**Release status (mandatory)**
- When suggesting what to play, recommend **released, playable** games first. Mention unreleased games (including ones in the user's library) only as "upcoming" or "in your list (releases later)". If unsure whether a game is out, check its release date with getGameDetails.

**Walkthroughs, NPCs, puzzles and codes**
- When the user describes a distinctive in-game moment (e.g. "man with an axe in his head" in Valhalla, "first safe" in Indiana Jones), identify the quest, NPC or puzzle from your knowledge and give a direct answer first (name, code, or steps). Do not lead with "send a screenshot" or "which region?". Ask for one detail only when there are genuinely several matches, and still give your best guess.
- If the user says "name all of them" or "list the possibilities", list the candidates you know.
- In-game codes, passwords and puzzle solutions are legitimate walkthrough help; provide them.

**When the user attaches an image**
You receive the image with their text. Use it: identify characters/NPCs, read on-screen text or codes, describe what you see, and answer. Never ask for a screenshot they already sent.

**Content policy**
All conversation is about video games. In-game violence, combat, or mature themes are fictional game content. Keep help focused on mechanics and next steps.

**Output format (every reply)**
1. **First line**: a markdown heading: ## <main title> (e.g. ## Recommendations for you, ## Safe code).
2. **Body**: ### for sub-sections; bullet lists (-) for games, steps and tips; numbered lists (1. 2. 3.) with a short bold label when offering choices; **bold** for game names and key terms; links as [text](url). Never a wall of text.
3. **Game lists**: game **names only** — never raw store IDs (steam-xxx, epic-xxx). For the library, one ### per status (### Playing, ### Want to Play, ### Completed).
4. **End**: exactly this block — a line with ---, then "Suggested follow-ups:", then 2–4 lines starting with "- ", each a short follow-up question (under 8 words). These become clickable chips.

Example ending:
---
Suggested follow-ups:
- Search Steam for survival horror
- What's in my library?
- Get more recommendations`;

// ── Shared Helpers ─────────────────────────────────────────────────────────────

/** Prefix for user message when using cloud APIs (Azure, etc.) so content moderation sees gaming context and is less likely to flag in-game violence/mature themes. */
const CLOUD_USER_MESSAGE_PREFIX = 'The user is asking for video game walkthrough or gameplay help. They wrote:\n\n';

const isFollowUpLabel = (line: string): boolean => {
  const l = line.toLowerCase();
  return l.includes('suggested follow') || l.includes('follow-up') || l.includes('follow up');
};

/**
 * Parse the "Suggested follow-ups" block from model output and return stripped content +
 * follow-up strings. The marker is the last line that starts with '---' (never a table row
 * such as '|---|'); content is only cut when a follow-up label follows that marker AND at
 * least one follow-up line was collected, so a plain '---' section divider never eats the
 * section after it.
 */
export function parseSuggestedFollowUps(content: string): { content: string; suggestedFollowUps: string[] } {
  const intact = { content: content.trim(), suggestedFollowUps: [] as string[] };
  const lines = content.split(/\r?\n/);
  let markerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (/^-{3,}/.test(t) && !t.includes('|')) { markerIdx = i; break; }
  }
  if (markerIdx === -1) return intact;

  // The label may sit on the marker line itself ("--- Suggested follow-ups:").
  const block = [lines[markerIdx].trim().replace(/^-{3,}\s*/, ''), ...lines.slice(markerIdx + 1)];
  const followUps: string[] = [];
  let collecting = false;
  for (const line of block) {
    const t = line.trim();
    if (!collecting) {
      if (isFollowUpLabel(t)) collecting = true;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const text = t.replace(/^\s*[-*]\s+/, '').replace(/^\s*\d+[.)]\s+/, '').trim();
      if (text.length > 0 && text.length < 120) followUps.push(text);
    } else if (t.length > 0) break;
  }
  if (followUps.length === 0) return intact;
  return { content: lines.slice(0, markerIdx).join('\n').trim(), suggestedFollowUps: followUps.slice(0, 6) };
}

/** Generate 2–4 fallback follow-up questions when the model did not output a follow-ups block. */
function fallbackSuggestedFollowUps(content: string): string[] {
  const c = content.toLowerCase();
  const out: string[] = [];
  if (c.includes('steam') || c.includes('search')) out.push('Search Steam for more games');
  if (c.includes('library') || c.includes('your library') || c.includes('in ark')) out.push("What's in my library?");
  if (c.includes('recommend') || c.includes('play') || c.includes('suggest')) out.push('Get recommendations');
  if (c.includes('add') || c.includes('app id') || c.includes('appid')) out.push('Add a game to my library');
  if (out.length < 2) {
    if (!out.includes("What's in my library?")) out.push("What's in my library?");
    if (!out.includes('Search Steam for more games')) out.push('Search Steam for more games');
  }
  return [...new Set(out)].slice(0, 4);
}

/** Post-process model output so responses render with clear headings and bullets even when the model returns plain text. */
function structureResponseMarkdown(content: string): string {
  if (!content || !content.trim()) return content;
  let text = content.trim();

  // 1) Ensure first line is a top-level heading
  if (!text.startsWith('#')) text = `## Reply\n\n${text}`;

  // 2) Turn "1) Section title" / "2) ..." lines into ### subheadings (numbered sections)
  text = text.replace(/(^|\n)(\d+\)\s+[^\n]+)/g, '$1### $2');

  // 3) Bulletize list lines: after a heading (## or ###) or after a bullet, lines that don't start with #, -, *, or "n)" become bullets
  const lines = text.split('\n');
  const out: string[] = [];
  let inListBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const startsWithHeading = /^#{1,6}\s/.test(trimmed);
    const startsWithBullet = /^[-*]\s+/.test(trimmed);
    const startsWithNumbered = /^\d+[.)]\s+/.test(trimmed);
    const isBlank = trimmed.length === 0;

    if (startsWithHeading) {
      inListBlock = true;
      out.push(line);
      continue;
    }
    if (isBlank) {
      inListBlock = false;
      out.push(line);
      continue;
    }
    if (startsWithBullet || startsWithNumbered) {
      inListBlock = true;
      out.push(line);
      continue;
    }
    if (inListBlock && trimmed.length > 0 && trimmed.length < 200 && !trimmed.endsWith('?')) {
      out.push(line.replace(/^\s*/, '- '));
      continue;
    }
    inListBlock = false;
    out.push(line);
  }
  return out.join('\n');
}

function buildMessages(
  userMessage: string,
  gameContext?: GameContext,
  libraryData?: LibraryEntry[],
  wrapForCloudContentPolicy?: boolean,
  imageAttachment?: string,
): BaseMessage[] {
  const messages: BaseMessage[] = [new SystemMessage(SYSTEM_PROMPT)];

  if (gameContext) {
    messages.push(new SystemMessage(
      `The user is currently viewing the game: "${gameContext.name}" (Steam App ID: ${gameContext.appId}). ` +
      `When they ask questions without specifying a game, they're likely asking about this game.`,
    ));
    chainOfThought.push({ type: 'thinking', content: `Game context: ${gameContext.name} (ID: ${gameContext.appId})`, timestamp: new Date() });
  }

  if (libraryData && libraryData.length > 0) {
    const info = libraryData.slice(0, 15).map(g => {
      const name = g.name || `Unknown Game (ID: ${g.gameId})`;
      return `"${name}" (Status: ${g.status})`;
    }).join(', ');
    messages.push(new SystemMessage(
      `The user's game library contains: ${info}${libraryData.length > 15 ? `. Plus ${libraryData.length - 15} more.` : ''}.\n\nOnly mention games that are actually listed above. Do not invent or guess game names.`,
    ));
    chainOfThought.push({ type: 'thinking', content: `Library: ${libraryData.length} games`, timestamp: new Date() });
  }

  // Conversation history (last 10 turns for context)
  const conversation = chatStore.getActiveConversation();
  const recent = (conversation?.messages || []).slice(-10);
  for (const msg of recent) {
    if (msg.role === 'user') {
      const text = wrapForCloudContentPolicy ? CLOUD_USER_MESSAGE_PREFIX + msg.content : msg.content;
      messages.push(new HumanMessage(text));
    } else if (msg.role === 'assistant') {
      messages.push(new AIMessage(msg.content));
    }
  }

  const finalUserMessage = wrapForCloudContentPolicy
    ? CLOUD_USER_MESSAGE_PREFIX + userMessage
    : userMessage;

  if (imageAttachment && wrapForCloudContentPolicy) {
    logger.log(`[AI Proxy] Building user message with image attachment (${(imageAttachment.length / 1024).toFixed(1)} KB)`);
    messages.push(
      new HumanMessage({
        content: [
          { type: 'text', text: finalUserMessage },
          { type: 'image_url', image_url: { url: imageAttachment } },
        ],
      }) as BaseMessage,
    );
  } else {
    messages.push(new HumanMessage(finalUserMessage));
  }
  return messages;
}

async function addWebSearchContext(userMessage: string, gameContext: GameContext | undefined, messages: BaseMessage[]): Promise<void> {
  if (!needsWebSearch(userMessage)) return;

  const query = gameContext ? `${gameContext.name} ${userMessage}` : userMessage;
  logger.log(`[AI Proxy] Web search grounding: "${query}"`);
  chainOfThought.push({ type: 'tool_call', content: `Searching the web: "${query}"`, toolName: 'webSearch', toolArgs: { query }, timestamp: new Date() });

  const { results, error: searchError } = await webSearchOutcome(query, 5);
  if (results.length > 0) {
    const contextBlock = formatSearchContext(query, results);
    // After the stable system prefix (prompt + game/library context), not at index 1,
    // so the long system prompt stays a reusable prefix for the provider's prompt cache.
    let insertAt = 0;
    while (insertAt < messages.length && messages[insertAt] instanceof SystemMessage) insertAt++;
    messages.splice(insertAt, 0, new SystemMessage(contextBlock));
    chainOfThought.push({ type: 'tool_result', content: `Web search: ${results.length} results`, toolName: 'webSearch', toolResult: results.map(r => r.title).join(', '), timestamp: new Date() });
  } else if (searchError) {
    chainOfThought.push({ type: 'tool_result', content: 'Web search unavailable (network or certificate problem), answering from what I already know', toolName: 'webSearch', toolResult: 'Unavailable', timestamp: new Date() });
  } else {
    chainOfThought.push({ type: 'tool_result', content: 'Web search: no results', toolName: 'webSearch', toolResult: 'No results', timestamp: new Date() });
  }
}

function extractContent(response: AIMessage | AIMessageChunk): string {
  if (typeof response.content === 'string') return response.content;
  if (Array.isArray(response.content)) {
    return response.content
      .map(c => (typeof c === 'string' ? c : (c as { text?: string }).text || ''))
      .join('');
  }
  return '';
}

function extractUsage(response: AIMessage | AIMessageChunk): { inputTokens: number; outputTokens: number; totalTokens: number } | undefined {
  const msg = response as {
    usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    response_metadata?: { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
  };
  const um = msg.usage_metadata ?? msg.response_metadata?.usage;
  if (!um) return undefined;
  const u = um as Record<string, number | undefined>;
  const input = u.input_tokens ?? u.prompt_tokens ?? 0;
  const output = u.output_tokens ?? u.completion_tokens ?? 0;
  const total = (u.total_tokens ?? (input + output)) || 0;
  if (input === 0 && output === 0 && total === 0) return undefined;
  return { inputTokens: input, outputTokens: output, totalTokens: total || input + output };
}

// Input sanitisers for LLM-provided tool arguments
const safeString = (v: unknown, max = 500): string =>
  typeof v === 'string' ? v.slice(0, max) : '';
const safeInt = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

const INVALID_APP_ID_MESSAGE = 'Invalid appId; call searchSteamGames first.';

/** Per-request values the tools need that must not live in module globals. */
interface ToolContext {
  ggRegion: string;
}

/** Tools that change the library; they run one at a time, after the read-only ones, in call order. */
const MUTATING_TOOLS = new Set(['addGameToLibrary', 'removeGameFromLibrary']);

async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext = { ggRegion: 'us' }): Promise<string> {
  switch (name) {
    case 'searchSteamGames':
      return searchGamesTool.invoke({ query: safeString(args.query), limit: safeInt(args.limit, 10) });
    case 'getGameDetails':
      return getGameDetailsTool.invoke({ appId: safeInt(args.appId) });
    case 'getLibraryGames':
      return getLibraryGamesTool.invoke({
        status: safeString(args.status, 50) || undefined,
        limit: safeInt(args.limit) || undefined,
        nameQuery: safeString(args.nameQuery, 200) || undefined,
      });
    case 'addGameToLibrary': {
      const appId = parseSteamAppId(args.appId);
      if (appId === null) return INVALID_APP_ID_MESSAGE;
      return addToLibraryTool.invoke({ appId, status: safeString(args.status, 50) || undefined });
    }
    case 'removeGameFromLibrary': {
      // A gameId (any store) wins when it names a library entry; else fall back to a Steam app id.
      const gameId = safeString(args.gameId, 300);
      if (gameId && currentLibraryData.some(e => e.gameId === gameId)) return removeFromLibraryTool.invoke({ gameId });
      const appId = parseSteamAppId(args.appId ?? args.gameId);
      if (appId === null) {
        return gameId
          ? `Game ${gameId} is not in the library; call getLibraryGames with nameQuery to get its gameId.`
          : INVALID_APP_ID_MESSAGE;
      }
      return removeFromLibraryTool.invoke({ appId });
    }
    case 'getGameRecommendations':
      return getRecommendationsTool.invoke({ limit: safeInt(args.limit, 10) });
    case 'searchEpicGames':
      return searchEpicGamesTool.invoke({ query: safeString(args.query), limit: safeInt(args.limit, 10) });
    case 'getEpicGameDetails':
      return getEpicGameDetailsTool.invoke({ namespace: safeString(args.namespace), offerId: safeString(args.offerId) });
    case 'getSteamReviews':
      return getSteamReviewsTool.invoke({ appId: safeInt(args.appId), limit: safeInt(args.limit, 5) });
    case 'getMetacriticReviews':
      return getMetacriticReviewsTool.invoke({ gameName: safeString(args.gameName) });
    case 'getGameDeals':
      return makeGameDealsTool(ctx.ggRegion).invoke({ appId: safeInt(args.appId) });
    case 'getHowLongToBeat':
      return getHowLongToBeatTool.invoke({ gameName: safeString(args.gameName, 200), year: safeInt(args.year) || undefined });
    default:
      return `Unknown tool: ${name}`;
  }
}

// Production reviewer agent: exhaustive criteria so final answers are well-formatted, reasoned, and contextual.
const REVIEWER_SYSTEM_PROMPT = `You are the response reviewer for a gaming assistant app ("Ark"). You do not answer the user; you only judge the assistant's reply and optionally rewrite it.

**Your task**
Review the assistant's response against the user's question. Decide if it is production-ready or needs improvement.

**Criteria (all must hold for VALID)**
1. **Addresses the question**: The reply directly answers what the user asked (recommendations, library list, add/remove, walkthrough, etc.).
2. **Accurate**: No invented scores, IDs, or release dates. If the reply mentions reviews or Metacritic/Steam, it should be grounded in tool results, not made up.
3. **Contextual**: Suggestions and lists are relevant (e.g. released games when suggesting "what to play"; game names only, no raw steam-xxx/epic-xxx in the body).
4. **Well-formatted**: Has a clear ## heading at the start; uses ### and bullet lists for structure; not a wall of text.
5. **Has follow-ups**: The reply ends with a "Suggested follow-ups:" block (--- then 2–4 short bullet questions). If it is missing, you must IMPROVE and add it.
6. **Appropriately concise**: Helpful and scannable; not overly long or vague.

**Output**
- If the response meets all criteria above, reply with exactly: VALID
- If it does not, reply with: IMPROVE: [your full improved version of the reply]

**When you IMPROVE**
- Preserve the meaning and any correct facts from the original.
- Fix formatting: ensure ## heading, ### sub-sections, bullet lists, and a proper "Suggested follow-ups:" block at the end (--- then "Suggested follow-ups:" then 2–4 lines like "- Question here").
- Do not add raw store IDs (steam-xxx, epic-xxx). Use game names only.
- Keep the improved reply as a single block of text the user will see. Do not add meta-commentary like "I added headings."`;

const FOLLOW_UPS_LABEL = 'suggested follow-ups:';

/** Cheap local check: a reply that already has a ## heading and a parsed follow-ups block
 *  needs no reviewer round trip. */
export function passesLocalFormatChecks(content: string): boolean {
  return /^##\s/.test(content.trim()) && parseSuggestedFollowUps(content).suggestedFollowUps.length > 0;
}

/**
 * Accept a reviewer rewrite only when it is complete: not cut off by MAX_TOKENS, at least
 * ~70% of the original length, starts with '## ', and keeps the follow-ups block when the
 * original had one. Otherwise the original answer stands.
 */
export function acceptReviewerRewrite(original: string, rewrite: string, finishReason?: string): boolean {
  if (finishReason && /max_tokens|length/i.test(finishReason)) return false;
  const r = rewrite.trim();
  if (r.length < original.trim().length * 0.7) return false;
  if (!r.startsWith('## ')) return false;
  if (original.toLowerCase().includes(FOLLOW_UPS_LABEL) && !r.toLowerCase().includes(FOLLOW_UPS_LABEL)) return false;
  return true;
}

function finishReasonOf(msg: AIMessage | AIMessageChunk): string | undefined {
  const meta = (msg as { response_metadata?: Record<string, unknown> }).response_metadata ?? {};
  const r = meta.finishReason ?? meta.finish_reason;
  return typeof r === 'string' ? r : undefined;
}

async function validateResponse(userMessage: string, aiResponse: string): Promise<{ isValid: boolean; improvedResponse?: string }> {
  try {
    const userPrompt = `User asked: ${JSON.stringify(userMessage)}

Assistant responded: ${JSON.stringify(aiResponse)}

Reply with VALID or IMPROVE: [full improved version].`;

    const result = await getValidationModel().invoke([
      new SystemMessage(REVIEWER_SYSTEM_PROMPT),
      new HumanMessage(userPrompt),
    ]);
    const content = typeof result.content === 'string' ? result.content : '';

    if (content.startsWith('VALID')) return { isValid: true };
    if (content.startsWith('IMPROVE:')) {
      const improved = content.substring(8).trim();
      if (acceptReviewerRewrite(aiResponse, improved, finishReasonOf(result))) return { isValid: false, improvedResponse: improved };
      logger.log('[Reviewer] Rewrite rejected (truncated, too short or missing heading/follow-ups) — keeping original');
      return { isValid: true };
    }
    return { isValid: true };
  } catch (error) {
    logger.error('[Reviewer] Error:', error);
    return { isValid: true };
  }
}

// ── Unified Pipeline ───────────────────────────────────────────────────────────
//
// Both Ollama and Gemini flow through the same stages:
//   1. Build messages  (system prompt + context + history)
//   2. Web search grounding  (if the question benefits from current data)
//   3. Invoke model with tools  (streaming when requested)
//   4. Tool-calling loop  (iterative, max 5 rounds; read-only tools run in parallel)
//   5. Reviewer agent  (Gemini provider only, and only when the answer fails local format checks)

const MAX_TOOL_ITERATIONS = 5;

/**
 * Invoke the model, optionally streaming text tokens to the UI.
 *
 * When streaming, we use LangChain's `.stream()` — this works identically for
 * ChatOllama and ChatGoogleGenerativeAI, giving both providers real
 * token-by-token output.  Tool-call chunks produce no visible text so the
 * callback is only fired for actual content tokens.
 */
async function invokeModel(
  model: BaseChatModel,
  messages: BaseMessage[],
  onStreamChunk?: (chunk: string, fullContent: string) => void,
): Promise<AIMessage | AIMessageChunk> {
  if (!onStreamChunk) {
    return model.invoke(messages) as Promise<AIMessage>;
  }

  // Streaming path — accumulate chunks and forward text to the UI
  const stream = await model.stream(messages);
  let accumulated: AIMessageChunk | undefined;
  let fullContent = '';

  for await (const chunk of stream) {
    accumulated = accumulated ? accumulated.concat(chunk) : chunk;
    const text = typeof chunk.content === 'string' ? chunk.content : '';
    if (text) {
      fullContent += text;
      onStreamChunk(text, fullContent);
    }
  }

  if (!accumulated) throw new Error('Model returned empty stream');
  return accumulated;
}

/**
 * Process a chat message through the unified LLM proxy.
 *
 * The caller doesn't need to know which provider is active — the proxy handles
 * model selection, message formatting, tool binding, streaming, and validation.
 */
export async function processMessage(
  userMessage: string,
  gameContext?: GameContext,
  libraryData?: LibraryEntry[],
  onStreamChunk?: (chunk: string, fullContent: string) => void,
  _provider?: string,
  providerOptions?: ChatProviderOptions,
  imageAttachment?: string,
  /** gg.deals region from Settings → Prices (renderer `getGgRegion()`); normalised, default 'us'. */
  ggRegion?: string,
): Promise<{
  content: string;
  suggestedFollowUps: string[];
  toolsUsed: string[];
  actions: LibraryAction[];
  chainOfThought: ThoughtStep[];
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}> {
  const provider = settingsStore.getPreferredChatProvider();
  logger.log(`[AI Proxy] Processing: "${userMessage.substring(0, 50)}..." provider=${provider}`);

  // Reset per-request state
  currentLibraryData = libraryData || [];
  pendingActions = [];
  chainOfThought = [];

  await prepareRouterChat();
  if (!routerChat && provider === 'ollama' && useBuiltinBackend()) await prepareBuiltinChat();
  const { model, providerName, provider: effectiveProvider } = getModelForProvider(providerOptions);
  const usedOllama = effectiveProvider === 'ollama';
  const toolCtx: ToolContext = { ggRegion: normalizeRegion(ggRegion) };
  const ollamaSettings = settingsStore.getOllamaSettings();

  chainOfThought.push({ type: 'thinking', content: `Provider: ${providerName}`, timestamp: new Date() });

  try {
    // 1. Model (already resolved above)

    // 2. Messages (imageAttachment only used for Azure/cloud vision)
    const wrapForCloud = !usedOllama;
    const messages = buildMessages(userMessage, gameContext, libraryData, wrapForCloud, wrapForCloud ? imageAttachment : undefined);

    // 3. Web search grounding (Ollama only — cloud LLMs reason without grounding)
    if (usedOllama) await addWebSearchContext(userMessage, gameContext, messages);

    // 4. Bind tools and invoke
    let modelWithTools: BaseChatModel;
    try {
      modelWithTools = model.bindTools(allTools) as BaseChatModel;
    } catch {
      logger.warn('[AI Proxy] Tool binding unsupported — falling back to plain model');
      modelWithTools = model;
    }

    let response = await invokeModel(modelWithTools, messages, onStreamChunk);
    const toolsUsed: string[] = [];
    let iterations = 0;

    // 5. Tool-calling loop
    while (response.tool_calls && response.tool_calls.length > 0 && iterations < MAX_TOOL_ITERATIONS) {
      iterations++;
      logger.log(`[AI Proxy] Tool iteration ${iterations}:`, response.tool_calls.map(tc => tc.name));

      messages.push(response as AIMessage);

      const calls = response.tool_calls;
      for (const tc of calls) {
        toolsUsed.push(tc.name);
        chainOfThought.push({ type: 'tool_call', content: `Calling: ${tc.name}`, toolName: tc.name, toolArgs: tc.args as Record<string, unknown>, timestamp: new Date() });
      }

      // Read-only tools run concurrently; add/remove run afterwards one at a time in call
      // order so pendingActions stays deterministic. Results are reported in call order.
      const runOne = (tc: (typeof calls)[number]) => executeTool(tc.name, tc.args as Record<string, unknown>, toolCtx);
      const settled: PromiseSettledResult<string>[] = new Array(calls.length);
      const readOnly = calls.map((tc, i) => ({ tc, i })).filter(({ tc }) => !MUTATING_TOOLS.has(tc.name));
      const readResults = await Promise.allSettled(readOnly.map(({ tc }) => runOne(tc)));
      readOnly.forEach(({ i }, k) => { settled[i] = readResults[k]; });
      for (let i = 0; i < calls.length; i++) {
        if (!MUTATING_TOOLS.has(calls[i].name)) continue;
        try {
          settled[i] = { status: 'fulfilled', value: await runOne(calls[i]) };
        } catch (reason) {
          settled[i] = { status: 'rejected', reason };
        }
      }

      calls.forEach((tc, i) => {
        const name = tc.name;
        const outcome = settled[i];
        if (outcome.status === 'fulfilled') {
          const result = outcome.value;
          logger.log(`[AI Proxy] Tool ${name} →`, result.substring(0, 100));
          chainOfThought.push({ type: 'tool_result', content: `${name}: OK`, toolName: name, toolResult: result.length > 500 ? result.substring(0, 500) + '...' : result, timestamp: new Date() });
          messages.push(new ToolMessage({ content: result, tool_call_id: tc.id || '' }));
        } else {
          const error = outcome.reason;
          logger.error(`[AI Proxy] Tool ${name} error:`, error);
          chainOfThought.push({ type: 'tool_result', content: `${name}: FAILED`, toolName: name, toolResult: `Error: ${error}`, timestamp: new Date() });
          messages.push(new ToolMessage({ content: `Error executing tool: ${error}`, tool_call_id: tc.id || '' }));
        }
      });

      // Next round — stream the response (text tokens arrive here for the final iteration)
      response = await invokeModel(modelWithTools, messages, onStreamChunk);
    }

    // 6. Extract content
    let content = extractContent(response);

    // 6b. If model used tools but returned no text (e.g. some reasoning models, or the
    // tool-iteration cap was hit), ask once for a user-facing summary.
    if (content.length === 0 && toolsUsed.length > 0) {
      logger.log('[AI Proxy] Final response was empty after tool use — requesting summary');
      // A capped turn still carries tool_calls with no results; Azure/Gemini reject a
      // history with unanswered tool_calls, so that message is left out.
      if (!response.tool_calls?.length) messages.push(response as AIMessage);
      messages.push(new HumanMessage(
        'Based on the tool results above, write a short, user-friendly reply. Summarize what you found (e.g. recommendations or library list) in clear Markdown. Use headers and bullet lists. Do not include raw JSON or store IDs (steam-xxx, epic-xxx) in the reply—only game names and your message.',
      ));
      // Unbound model: the summary must be text, not another tool round.
      const summaryResponse = await invokeModel(model as BaseChatModel, messages, onStreamChunk);
      content = extractContent(summaryResponse);
      if (content.length > 0) {
        response = summaryResponse;
      }
    }

    // 7. Reviewer — only when Gemini itself is the chosen provider (user decision
    // 2026-10-30: no other provider is ever called behind the user's back), and only
    // when the answer fails the cheap local format checks.
    const runReviewer = effectiveProvider === 'gemini' && !!settingsStore.getGoogleAIKey() && !passesLocalFormatChecks(content);
    if (runReviewer) {
      chainOfThought.push({ type: 'validation', content: 'Running reviewer agent...', timestamp: new Date() });
      const validation = await validateResponse(userMessage, content);
      if (!validation.isValid && validation.improvedResponse) {
        logger.log('[AI Proxy] Response improved by reviewer');
        chainOfThought.push({ type: 'validation', content: 'Improved by reviewer', timestamp: new Date() });
        content = validation.improvedResponse;
      } else {
        chainOfThought.push({ type: 'validation', content: 'Passed reviewer', timestamp: new Date() });
      }
    }

    chainOfThought.push({ type: 'thinking', content: `Done — ${content.length} chars, ${toolsUsed.length} tools, ${pendingActions.length} actions`, timestamp: new Date() });

    const { content: mainContent, suggestedFollowUps: parsed } = parseSuggestedFollowUps(content);
    const suggestedFollowUps = parsed.length > 0 ? parsed : fallbackSuggestedFollowUps(mainContent);
    const formatted = structureResponseMarkdown(mainContent);
    const usage = extractUsage(response);
    return { content: formatted, suggestedFollowUps, toolsUsed, actions: pendingActions, chainOfThought, model: providerName, ...(usage && { usage }) };
  } catch (error: any) {
    chainOfThought.push({ type: 'thinking', content: `Error: ${error}`, timestamp: new Date() });

    // A rejected key must not stay cached: the next call rebuilds the client with
    // whatever key Settings holds by then.
    if (isAuthError(error)) {
      cachedModel = null;
      cachedModelKey = null;
    }

    // The router's own endpoint stopped answering (LiteLLM crashed or was restarted mid-turn).
    if (routerChat && (error?.code === 'ECONNREFUSED' || error?.message?.includes('fetch failed') || error?.cause?.code === 'ECONNREFUSED')) {
      routerChat = null;
      cachedModel = null;
      cachedModelKey = null;
      throw new Error(
        'The AI router stopped answering. Try again, or check the router status in Settings > AI providers.',
      );
    }

    // Friendly error only when we actually used Ollama and it's a connection failure
    if (!routerChat && usedOllama && useBuiltinBackend() && (error?.code === 'ECONNREFUSED' || error?.message?.includes('fetch failed') || error?.cause?.code === 'ECONNREFUSED')) {
      builtinChat = null;
      cachedModel = null;
      cachedModelKey = null;
      throw new Error(
        'The built-in local chat server stopped answering. Try again, or select a different model (e.g. Azure OpenAI or Gemini) in the Chat panel.',
      );
    }
    if (!routerChat && usedOllama && (error?.code === 'ECONNREFUSED' || error?.message?.includes('fetch failed') || error?.cause?.code === 'ECONNREFUSED')) {
      throw new Error(
        `Could not connect to Ollama at ${ollamaSettings.url}. ` +
        `Please ensure Ollama is running, or select a different model (e.g. Azure OpenAI or Gemini) in the Chat panel.`,
      );
    }
    throw error;
  }
}

// ── Context Search (unchanged) ─────────────────────────────────────────────────

export async function searchGamesForContext(query: string): Promise<GameContext[]> {
  try {
    const results = await steamAPI.searchGames(query, 5);
    return results.map(g => ({
      appId: g.id,
      name: g.name,
      headerImage: `https://cdn.akamai.steamstatic.com/steam/apps/${g.id}/header.jpg`,
    }));
  } catch (error) {
    logger.error('[AI Proxy] Context search error:', error);
    return [];
  }
}

export { chatStore };
