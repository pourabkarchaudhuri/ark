/**
 * AI Chat Agent — Unified LLM Proxy
 *
 * Routes all chat through LangChain.js so that every provider (Ollama, Gemini,
 * future additions) shares the same message format, tool-calling interface,
 * streaming behaviour, and error handling.  The rest of the app never touches
 * raw provider APIs — it only talks to `processMessage()`.
 *
 * Supported providers:
 *   • Ollama   — local, via @langchain/ollama   (ChatOllama)
 *   • Gemini   — cloud, via @langchain/google-genai (ChatGoogleGenerativeAI)
 *   • Azure OpenAI — cloud, via @langchain/openai (AzureChatOpenAI)
 */

import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOllama } from '@langchain/ollama';
import { AzureChatOpenAI } from '@langchain/openai';
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
import { fetchMetacriticReviews } from './metacritic-api.js';
import { chatStore } from './chat-store.js';
import { settingsStore } from './settings-store.js';
import { needsWebSearch, webSearch, formatSearchContext } from './web-search.js';
import { logger } from './safe-logger.js';

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

type ChatModel = ChatGoogleGenerativeAI | ChatOllama | AzureChatOpenAI;

let cachedModel: ChatModel | null = null;
let cachedModelKey: string | null = null;

/**
 * Get the LangChain chat model for the preferred provider from Settings.
 * Provider is always read from the store (single source of truth).
 */
function getModelForProvider(providerOptions?: ChatProviderOptions): { model: ChatModel; providerName: string } {
  const effective = settingsStore.getPreferredChatProvider();

  if (effective === 'azure-openai') {
    if (!providerOptions?.azure?.endpoint || !providerOptions?.azure?.apiKey || !providerOptions?.azure?.deployment) {
      throw new Error(
        'Azure OpenAI is selected but credentials were not provided. Add Endpoint, API Key, and Deployment in Settings > AI Models > Azure OpenAI, then try again.',
      );
    }
    const { endpoint, apiKey, deployment, apiVersion } = providerOptions.azure;
    const baseUrl = endpoint.replace(/\/+$/, '');
    const version = apiVersion?.trim() || '2024-12-01-preview';
    const configKey = `azure:${baseUrl}:${deployment}:${version}`;
    if (cachedModel && cachedModelKey === configKey) {
      return { model: cachedModel as AzureChatOpenAI, providerName: `Azure OpenAI (${deployment})` };
    }
    logger.log('[AI Proxy] Creating Azure OpenAI model:', deployment, 'api-version:', version);
    cachedModel = new AzureChatOpenAI({
      azureOpenAIEndpoint: baseUrl,
      azureOpenAIApiKey: apiKey,
      azureOpenAIApiDeploymentName: deployment,
      model: deployment, // required so LangChain uses max_completion_tokens for reasoning models (e.g. gpt-5.2)
      azureOpenAIApiVersion: version,
      temperature: 0.7,
      maxCompletionTokens: 2048,
    });
    cachedModelKey = configKey;
    return { model: cachedModel, providerName: `Azure OpenAI (${deployment})` };
  }

  if (effective === 'anthropic') {
    throw new Error(
      'Anthropic (Claude) is not yet supported for chat. Please select Azure OpenAI, Gemini, or Ollama in the Chat panel.',
    );
  }

  if (effective === 'gemini') {
    let geminiKey: string;
    try {
      geminiKey = getApiKey();
    } catch {
      throw new Error(
        'Gemini is selected but no API key is configured. Add your Google AI API key in Settings > AI Models > Google Gemini, or choose another model in the Chat panel.',
      );
    }
    const configKey = `gemini:${geminiKey}`;
    if (cachedModel && cachedModelKey === configKey) {
      return { model: cachedModel as ChatGoogleGenerativeAI, providerName: 'Gemini 2.5 Flash' };
    }
    logger.log('[AI Proxy] Creating Gemini model');
    cachedModel = new ChatGoogleGenerativeAI({
      apiKey: geminiKey,
      model: 'gemini-2.5-flash',
      temperature: 0.7,
      maxOutputTokens: 2048,
    });
    cachedModelKey = configKey;
    return { model: cachedModel, providerName: 'Gemini 2.5 Flash' };
  }

  // ollama or any other → use Ollama from settings
  const ollamaSettings = settingsStore.getOllamaSettings();
  const baseUrl = ollamaSettings.url.replace(/\/$/, '');
  const configKey = `ollama:${baseUrl}:${ollamaSettings.model}`;
  if (cachedModel && cachedModelKey === configKey) {
    return { model: cachedModel as ChatOllama, providerName: `Ollama ${ollamaSettings.model}` };
  }
  logger.log(`[AI Proxy] Creating Ollama model (${ollamaSettings.model} @ ${baseUrl})`);
  cachedModel = new ChatOllama({
    model: ollamaSettings.model,
    baseUrl,
    temperature: 0.7,
  });
  cachedModelKey = configKey;
  return { model: cachedModel, providerName: `Ollama ${ollamaSettings.model}` };
}

// Separate validation model (always Gemini — needs an API key)
let cachedValidationModel: ChatGoogleGenerativeAI | null = null;
let cachedValidationKey: string | null = null;

function getValidationModel(): ChatGoogleGenerativeAI {
  const currentKey = getApiKey();
  if (cachedValidationModel && cachedValidationKey === currentKey) return cachedValidationModel;

  cachedValidationModel = new ChatGoogleGenerativeAI({
    apiKey: currentKey,
    model: 'gemini-2.5-flash',
    temperature: 0.1,
    maxOutputTokens: 512,
  });
  cachedValidationKey = currentKey;
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

const getLibraryGamesTool = tool(
  async () => {
    logger.log('[AI Tool] getLibraryGames');
    if (currentLibraryData.length === 0) return 'The library is empty.';
    return JSON.stringify({
      totalGames: currentLibraryData.length,
      games: currentLibraryData.map(entry => ({
        appId: entry.gameId,
        name: entry.name || 'Unknown',
        status: entry.status,
        priority: entry.priority,
        addedAt: entry.addedAt,
      })),
    });
  },
  {
    name: 'getLibraryGames',
    description: "Get all games in the user's library with name, status, and priority. When you reply to the user, format as clean Markdown: one header per status (e.g. ### Playing), then bullets with game name only. Do not paste store IDs (steam-xxx, epic-xxx) in your reply—only game titles.",
    schema: z.object({}),
  },
);

const addToLibraryTool = tool(
  async ({ appId, status = 'Want to Play' }: { appId: number; status?: string }) => {
    logger.log(`[AI Tool] addToLibrary: ${appId} with status "${status}"`);
    try {
      const stringId = `steam-${appId}`;
      const existing = currentLibraryData.find(e => e.gameId === stringId || e.gameId === String(appId));
      if (existing) return `Game ${appId} is already in the library with status "${existing.status}"`;

      const details = await steamAPI.getAppDetails(appId);
      const gameName = details?.name || `Game ${appId}`;
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
      status: z.string().optional().describe('Want to Play, Playing, Completed, or On Hold'),
    }),
  },
);

const removeFromLibraryTool = tool(
  async ({ appId }: { appId: number }) => {
    logger.log(`[AI Tool] removeFromLibrary: ${appId}`);
    try {
      const stringId = `steam-${appId}`;
      const existing = currentLibraryData.find(e => e.gameId === stringId || e.gameId === String(appId));
      if (!existing) return `Game ${appId} is not in the library`;

      const details = await steamAPI.getAppDetails(appId);
      const gameName = details?.name || `Game ${appId}`;
      pendingActions.push({ type: 'remove', appId, gameId: stringId, gameName });
      return `Successfully queued "${gameName}" to be removed from the library.`;
    } catch (error) {
      return `Error removing game from library: ${error}`;
    }
  },
  {
    name: 'removeGameFromLibrary',
    description: "Remove a game from the user's library. Get the Steam App ID via searchSteamGames when the user names a game (e.g. 'Remove Hollow Knight'), or from getLibraryGames if they refer to a game already in the library.",
    schema: z.object({
      appId: z.number().describe('The Steam App ID from searchSteamGames or getLibraryGames'),
    }),
  },
);

const getRecommendationsTool = tool(
  async ({ limit = 10 }: { limit?: number }) => {
    logger.log(`[AI Tool] getRecommendations (limit: ${limit})`);
    if (currentLibraryData.length === 0) return 'Cannot provide recommendations — the library is empty.';

    const steamAppIds = currentLibraryData
      .map(e => { const m = e.gameId.match(/^(?:steam-)?(\d+)$/); return m ? Number(m[1]) : null; })
      .filter((id): id is number => id !== null);

    if (steamAppIds.length === 0) return 'No Steam games found in the library.';

    try {
      const recommendations = await steamAPI.getRecommendations(steamAppIds[0], steamAppIds, limit);
      if (recommendations.length === 0) return 'No recommendations found.';
      return JSON.stringify({
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
];

const toolMap: Record<string, typeof allTools[number]> = {};
for (const t of allTools) toolMap[t.name] = t;

// ── System Prompt (production: exhaustive for well-formatted, reasoned, contextual answers) ─

const SYSTEM_PROMPT = `You are the primary assistant for "Ark", a game library and discovery app. Your answers must be well-formatted, reasoned, and contextual.

**Your role**
1. **Discover**: Search Steam/Epic, give recommendations from the user's library, and provide accurate game info.
2. **Manage library**: Add/remove games by name; always confirm actions clearly.
3. **Answer gaming questions**: Genres, developers, release dates, reviews, walkthroughs, NPCs, puzzles, and in-game help. Use tools for scores and reviews; use your knowledge for walkthroughs and codes.

**Context and reasoning (mandatory)**
- Before answering, consider: What did the user ask? What game or library context do they have? What tools did you call (if any) and what did they return?
- Ground your reply in tool results when you used tools (e.g. recommendations, library list, Steam/Epic search). Do not invent scores, IDs, or release dates—use getGameDetails, getSteamReviews, or getMetacriticReviews when relevant.
- When suggesting "what to play", prioritize **released, playable** titles from their library or from tool results. Do not suggest unreleased games as primary "play this now" options; mention them only as upcoming if relevant.
- Be contextual: if the user said "add it" or "that game", use the conversation and any tool results to resolve the referent. If you cannot, ask once which game they mean.

**Tools (use in strict sequences)**
- **Add/remove by name**: (1) searchSteamGames(query) → (2) addGameToLibrary(appId) or removeGameFromLibrary(appId) using \`id\` from results. Never add or remove without resolving the game name first. If the user says "add this" with no prior context, ask which game.
- **Reviews / "tell me about X"**: Steam: searchSteamGames → getGameDetails and/or getSteamReviews. Critic scores: getMetacriticReviews(gameName). Do not invent scores or review text.
- **Epic store**: searchEpicGames → getEpicGameDetails(namespace, offerId) from the search result fields.
- **Recommendations**: getGameRecommendations when they ask "what should I play" or "games like my library". If the library is empty, say so and suggest they add games first or search Steam/Epic.
- **Mission / walkthrough / NPC / puzzle**: Use your knowledge. Give a direct answer (name, code, steps). Do not lead with "I need a screenshot" or "which region?" when the description is specific—infer and answer. For in-game codes or passwords, provide the in-game solution; this is walkthrough help.

**Content policy**
All conversation is about video games. In-game violence, combat, or mature themes are fictional game content. Give gameplay and walkthrough help; keep language focused on mechanics and next steps.

**When the user attaches an image**
You receive the image with their text. Use it to answer: identify NPCs, read codes or text on screen, describe what you see. Do not ask them to "send a screenshot" when they already attached one.

**Edge cases**
- **Empty library**: Say so. Suggest searching Steam/Epic or adding games from Browse, then ask for recommendations again.
- **No search results**: Say no matches were found; suggest a different query or that they add from the app's Browse tab.
- **Steam search connection error**: The tool may say search failed due to network/certificate. Tell the user games still show in the app's Browse tab; they can add from there or try again later.
- **Unreleased game in library**: Do not recommend it as "play now". Mention it as "in your list (releases later)" if relevant.

**Do not**
- Show raw store IDs (steam-xxx, epic-xxx) in your reply—only game **names**.
- Invent Metacritic/Steam scores or review text; use tools.
- Suggest unreleased games as the main "play this" option.
- Reply with a wall of text; use headings and lists.
- Ask for a screenshot or region when the user already attached an image or gave a specific in-game description you can identify.

**Output format (every reply)**
1. **First line**: A markdown heading: ## <main title> (e.g. ## Recommendations for you, ## How to find the NPC).
2. **Body**: Use ### for sub-sections. Use **bullet lists** (- or *) for any list (games, options, steps). Use **bold** for game names and key terms. Numbered lists (1. 2. 3.) for options when offering choices.
3. **End**: Exactly this block on a new line: --- then newline then "Suggested follow-ups:" then newline then 2–4 lines each starting with "- " and a short follow-up question (under 8 words). These become clickable chips.

Example ending:
---
Suggested follow-ups:
- Search Steam for survival horror
- What's in my library?
- Get more recommendations

**Confirmation and tone**
- After add/remove: confirm clearly (e.g. "Added Elden Ring to your library with status Want to Play").
- Be concise, scannable, and actionable. Prefer concrete answers over asking for more info when the user's intent is clear.

- News and release dates: use injected web search context when present; do not invent.

You have access to the following tools:
- searchSteamGames: Search Steam by game name → returns id and name. Use first when a game is mentioned and the user cares about Steam.
- getGameDetails: Full Steam details (description, Metacritic, price, etc.) by Steam App ID.
- getLibraryGames: List games in the user's library with status and name. When replying with a library list, use clean Markdown: headers by status (e.g. ### Playing, ### Want to Play), then bullet lists with the game **name only**. Never show raw store IDs (steam-xxx, epic-xxx) in your reply—only game titles.
- addGameToLibrary / removeGameFromLibrary: By Steam App ID (from searchSteamGames or getLibraryGames).
- getGameRecommendations: Recommendations based on the user's library.
- searchEpicGames: Search the Epic Games Store by name → returns title, namespace, offerId. Use for "Epic", "on Epic", or Epic store questions.
- getEpicGameDetails: Full Epic game details by namespace and offerId (from searchEpicGames).
- getSteamReviews: Steam user reviews by Steam App ID (from searchSteamGames). Use for "what do players think", "Steam reviews", "worth it".
- getMetacriticReviews: Critic and user scores plus critic reviews by game name. Use for "Metacritic", "critic reviews", "what do critics say".

**Workflow (follow strictly):**
1. **Add/remove by name**: searchSteamGames → use \`id\` as appId for addGameToLibrary or removeGameFromLibrary. If "add this game" with no context, ask which game.
2. **Reviews / "tell me about X"**: For Steam: searchSteamGames → getGameDetails and/or getSteamReviews. For critic scores/reviews: getMetacriticReviews(gameName). Do not invent scores.
3. **Epic store**: Use searchEpicGames then getEpicGameDetails with namespace and offerId when the user asks about Epic games.
4. **Recommendations**: getGameRecommendations when they ask "what should I play" or "games like my library". If library empty, say so.
5. **News, release dates**: Rely on injected web search context; do not invent dates or news.
6. **Mission help / walkthroughs / NPC names / puzzle answers**: When the user describes a specific in-game moment (e.g. "man with axe in his head" in Valhalla, "first safe" in a game), use your knowledge to identify the quest, NPC, or puzzle and **give a direct answer first** (name, code, or steps). Do not lead with "I need more info" or "send region/screenshot"—infer from distinctive details and answer. Only ask for one clarifying detail if there are genuinely multiple different matches; in that case still give your best guess and the most likely answer.

**Release status and context (mandatory):**
- When the user asks for suggestions, "what should I play", or "games like X", recommend games that are **released and playable now**. Do not suggest unreleased or upcoming games as primary "play this" options.
- If a game in the user's library (or in tool results) is **not yet released**, do not present it as a suggestion to play now. You may mention it as "also in your list (releases later)" or "upcoming" only if relevant, and prioritize **released** titles first.
- When you are not sure whether a game is released, prefer games you know are out (or use getGameDetails for release_date when needed). Do not blindly list titles from the library or tools without considering release status—give contextual, actionable answers (things they can actually play now).

**When Steam search fails with a connection/network error:** The tool may return a message that the search failed due to connection or certificate issues. In the app, when users search in the **Browse** tab, games do show up — the catalog data is there. So if the user says "I can see it in Browse" or similar, the game exists; the issue is only this connection. Tell them they can add the game from the Browse tab or try again later.

**Formatting (mandatory — every reply must be well-structured):**
- Start with a **main heading** (##) that summarizes the answer (e.g. ## RPGs in your library, ## How to find the NPC, ## Safe code).
- Use **subheadings** (###) for distinct sections (e.g. ### From your library, ### On Steam, ### Recommendations).
- When offering **options or choices**, use a **numbered list** (1. 2. 3.) with a short bold label per option, then a line or bullet under each (e.g. **1. From your library** — then bullets of games).
- Use **bullet lists** for any list of items (games, steps, tips). Use **bold** for game names and key terms.
- For links use [text](url). Do not reply with a wall of text—break content into clear blocks with headings and lists so it is easy to scan.
- When listing the user's library or "full list" of games: use ### per status (### Playing, ### Want to Play, ### Completed), then bullets with the **game name only**. No store IDs in the reply.
- For recommendations or any list of games: game names only, no raw IDs. Always use headings and bullets so the message looks polished and scannable.
- Prefer structure over prose: use a heading and a list instead of a long paragraph. Example: after "Which option do you want?" use numbered options (1. From your library 2. On Steam 3. Recommendations) with brief bullets under each, not a single block of text.

**Suggested follow-ups (required at end of reply):**
- End every reply with 2–4 short, clickable follow-up questions the user might ask next. Use this exact format on a new line: --- then **Suggested follow-ups:** then on separate lines one bullet per question, e.g. "- Search Steam for survival horror" and "- What horror games are in my library?". Keep each question short (under 8 words when possible). These will be shown as button chips below your message.

**Mission / walkthrough / NPC / puzzle behaviour:**
- When the user describes a distinctive in-game moment (e.g. "man with an axe in his head" with a choice in Valhalla, "first safe" in Indiana Jones), **use your knowledge** to identify the quest, NPC name, or puzzle and give a direct answer. Do not default to "I need the region" or "send a screenshot" when the description is specific enough—many moments are uniquely identifiable. Give your best answer (NPC name, world event name, code, or steps); only ask for one detail if there are genuinely several different matches.
- If the user says "name all of them" or "list the possibilities", list the options you know from your knowledge. Do not refuse with "I can't reliably name all"; provide the candidates (quest names, NPC names, or events) so the user can pick.
- **In-game codes, passwords, and puzzle solutions**: When the user asks for a code, password, or solution that exists **in the game** (e.g. "password for the first safe in Indiana Jones the Golden Circle"), they are asking for walkthrough help. Provide the in-game answer. Do not refuse on "bypass" or "cheating" grounds—this is a games assistant; in-game puzzle solutions are legitimate help.

**When the user attaches an image:**
- You receive the image in the same message as their text. **Use the image to answer**: identify characters/NPCs, read visible text or codes, describe what you see, and answer their question. Do not ask them to "upload a screenshot" or "send the region" when they have already attached an image—analyze the image and respond with the NPC name, code, or guidance.

**Other rules:**
- Always confirm add/remove actions and give clear feedback (e.g. "Added Elden Ring to your library with status Want to Play").
- Continue the thread coherently; do not repeat or contradict prior replies.
- Be conversational, helpful, and concise. Use game context when provided.
- Give contextual, actionable answers: prefer released games when suggesting what to play; do not blindly list library or tool results without considering what the user can actually play now.
- Prefer giving a concrete answer from your knowledge (NPC name, in-game code, quest name, steps) over asking for more information when the user's question or description is specific enough. Only ask for one extra detail when you truly cannot narrow it down.

**Reply structure (use this every time):**
- First line must be a markdown heading: ## Your main title (e.g. ## Horror games on Steam, ## What you can do in Ark).
- Use ### for sub-sections. Use - or * for every list (games, options, steps). Never reply with plain lines only—use real markdown.
- End with exactly: a newline, then ---, then a newline, then "Suggested follow-ups:", then newline, then 2–4 lines each starting with "- " and a short question (e.g. "- Search Steam for survival horror").`;

// ── Shared Helpers ─────────────────────────────────────────────────────────────

/** Prefix for user message when using cloud APIs (Azure, etc.) so content moderation sees gaming context and is less likely to flag in-game violence/mature themes. */
const CLOUD_USER_MESSAGE_PREFIX = 'The user is asking for video game walkthrough or gameplay help. They wrote:\n\n';

/** Parse "Suggested follow-ups" block from model output and return stripped content + follow-up strings. */
function parseSuggestedFollowUps(content: string): { content: string; suggestedFollowUps: string[] } {
  const marker = '\n---\n';
  let idx = content.lastIndexOf(marker);
  if (idx === -1) idx = content.lastIndexOf('\n--- ');
  if (idx === -1) idx = content.lastIndexOf('---\n');
  if (idx === -1) return { content: content.trim(), suggestedFollowUps: [] };
  const fromMarker = content.slice(idx);
  const block = fromMarker.includes('\n') ? fromMarker.split('\n').slice(1).join('\n').trim() : '';
  const lower = block.toLowerCase();
  const hasFollowUpLabel = lower.includes('suggested follow-up') || lower.includes('suggested follow up') || lower.includes('follow-up') || lower.includes('follow up');
  if (!hasFollowUpLabel) return { content: content.slice(0, idx).trim(), suggestedFollowUps: [] };
  const lines = block.split(/\n/);
  const followUps: string[] = [];
  let collecting = false;
  for (const line of lines) {
    const t = line.trim();
    if (hasFollowUpLabel && (t.toLowerCase().includes('suggested follow') || t.toLowerCase().includes('follow-up') || t.toLowerCase().includes('follow up'))) { collecting = true; continue; }
    if (collecting && (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line))) {
      const text = t.replace(/^\s*[-*]\s+/, '').replace(/^\s*\d+[.)]\s+/, '').trim();
      if (text.length > 0 && text.length < 120) followUps.push(text);
    } else if (collecting && t.length > 0) break;
  }
  return { content: content.slice(0, idx).trim(), suggestedFollowUps: followUps.slice(0, 6) };
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

  const results = await webSearch(query, 5);
  if (results.length > 0) {
    const contextBlock = formatSearchContext(query, results);
    messages.splice(1, 0, new SystemMessage(contextBlock));
    chainOfThought.push({ type: 'tool_result', content: `Web search: ${results.length} results`, toolName: 'webSearch', toolResult: results.map(r => r.title).join(', '), timestamp: new Date() });
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

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'searchSteamGames':
      return searchGamesTool.invoke({ query: safeString(args.query), limit: safeInt(args.limit, 10) });
    case 'getGameDetails':
      return getGameDetailsTool.invoke({ appId: safeInt(args.appId) });
    case 'getLibraryGames':
      return getLibraryGamesTool.invoke({});
    case 'addGameToLibrary':
      return addToLibraryTool.invoke({ appId: safeInt(args.appId), status: safeString(args.status, 50) || undefined });
    case 'removeGameFromLibrary':
      return removeFromLibraryTool.invoke({ appId: safeInt(args.appId) });
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
    if (content.startsWith('IMPROVE:')) return { isValid: false, improvedResponse: content.substring(8).trim() };
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
//   4. Tool-calling loop  (iterative, max 5 rounds)
//   5. Reviewer agent  (when Gemini API key is available: checks format, accuracy, follow-ups; can rewrite)

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

  const { model, providerName } = getModelForProvider(providerOptions);
  const usedOllama = provider === 'ollama';
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

      for (const tc of response.tool_calls) {
        const name = tc.name;
        const args = tc.args as Record<string, unknown>;
        toolsUsed.push(name);

        chainOfThought.push({ type: 'tool_call', content: `Calling: ${name}`, toolName: name, toolArgs: args, timestamp: new Date() });

        try {
          const result = await executeTool(name, args);
          logger.log(`[AI Proxy] Tool ${name} →`, result.substring(0, 100));
          chainOfThought.push({ type: 'tool_result', content: `${name}: OK`, toolName: name, toolResult: result.length > 500 ? result.substring(0, 500) + '...' : result, timestamp: new Date() });
          messages.push(new ToolMessage({ content: result, tool_call_id: tc.id || '' }));
        } catch (error) {
          logger.error(`[AI Proxy] Tool ${name} error:`, error);
          chainOfThought.push({ type: 'tool_result', content: `${name}: FAILED`, toolName: name, toolResult: `Error: ${error}`, timestamp: new Date() });
          messages.push(new ToolMessage({ content: `Error executing tool: ${error}`, tool_call_id: tc.id || '' }));
        }
      }

      // Next round — stream the response (text tokens arrive here for the final iteration)
      response = await invokeModel(modelWithTools, messages, onStreamChunk);
    }

    // 6. Extract content
    let content = extractContent(response);

    // 6b. If model used tools but returned no text (e.g. some reasoning models), ask once for a user-facing summary
    if (content.length === 0 && toolsUsed.length > 0) {
      logger.log('[AI Proxy] Final response was empty after tool use — requesting summary');
      messages.push(response as AIMessage);
      messages.push(new HumanMessage(
        'Based on the tool results above, write a short, user-friendly reply. Summarize what you found (e.g. recommendations or library list) in clear Markdown. Use headers and bullet lists. Do not include raw JSON or store IDs (steam-xxx, epic-xxx) in the reply—only game names and your message.',
      ));
      const summaryResponse = await invokeModel(modelWithTools, messages, onStreamChunk);
      content = extractContent(summaryResponse);
      if (content.length > 0) {
        response = summaryResponse;
      }
    }

    // 7. Validation (requires a Gemini API key)
    const hasGeminiKey = !!settingsStore.getGoogleAIKey();
    if (hasGeminiKey) {
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

    // Friendly error only when we actually used Ollama and it's a connection failure
    if (usedOllama && (error?.code === 'ECONNREFUSED' || error?.message?.includes('fetch failed') || error?.cause?.code === 'ECONNREFUSED')) {
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
