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
 */

import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOllama } from '@langchain/ollama';
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

type ChatModel = ChatGoogleGenerativeAI | ChatOllama;

let cachedModel: ChatModel | null = null;
let cachedModelKey: string | null = null;

function getUnifiedModel(): ChatModel {
  const useGemini = settingsStore.shouldUseGemini();
  const ollamaSettings = settingsStore.getOllamaSettings();

  const configKey = useGemini
    ? `gemini:${settingsStore.getGoogleAIKey()}`
    : `ollama:${ollamaSettings.url}:${ollamaSettings.model}`;

  if (cachedModel && cachedModelKey === configKey) return cachedModel;

  if (useGemini) {
    logger.log('[AI Proxy] Creating Gemini model');
    cachedModel = new ChatGoogleGenerativeAI({
      apiKey: getApiKey(),
      model: 'gemini-2.5-flash',
      temperature: 0.7,
      maxOutputTokens: 2048,
    });
  } else {
    const baseUrl = ollamaSettings.url.replace(/\/$/, '');
    logger.log(`[AI Proxy] Creating Ollama model (${ollamaSettings.model} @ ${baseUrl})`);
    cachedModel = new ChatOllama({
      model: ollamaSettings.model,
      baseUrl,
      temperature: 0.7,
    });
  }

  cachedModelKey = configKey;
  return cachedModel;
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

const searchGamesTool = tool(
  async ({ query, limit = 10 }: { query: string; limit?: number }) => {
    logger.log(`[AI Tool] searchGames: "${query}" (limit: ${limit})`);
    try {
      const results = await steamAPI.searchGames(query, limit);
      return JSON.stringify(results.map(g => ({ id: g.id, name: g.name, type: g.type })));
    } catch (error) {
      return `Error searching games: ${error}`;
    }
  },
  {
    name: 'searchSteamGames',
    description: 'Search for games on Steam by name. Returns a list of matching games with their IDs.',
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
    description: 'Get detailed information about a specific game by its Steam App ID.',
    schema: z.object({
      appId: z.number().describe('The Steam App ID of the game'),
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
    description: "Get all games in the user's library with their status and priority.",
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
      pendingActions.push({ type: 'add', appId, status, gameName });
      return `Successfully queued "${gameName}" to be added to the library with status "${status}".`;
    } catch (error) {
      return `Error adding game to library: ${error}`;
    }
  },
  {
    name: 'addGameToLibrary',
    description: "Add a game to the user's library. Optionally specify the status.",
    schema: z.object({
      appId: z.number().describe('The Steam App ID of the game to add'),
      status: z.string().optional().describe('Game status: Want to Play, Playing, Completed, or On Hold'),
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
      pendingActions.push({ type: 'remove', appId, gameName });
      return `Successfully queued "${gameName}" to be removed from the library.`;
    } catch (error) {
      return `Error removing game from library: ${error}`;
    }
  },
  {
    name: 'removeGameFromLibrary',
    description: "Remove a game from the user's library by its Steam App ID.",
    schema: z.object({
      appId: z.number().describe('The Steam App ID of the game to remove'),
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
    description: "Get game recommendations based on the user's library.",
    schema: z.object({
      limit: z.number().optional().describe('Maximum number of recommendations (default 10)'),
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
];

const toolMap: Record<string, typeof allTools[number]> = {};
for (const t of allTools) toolMap[t.name] = t;

// ── System Prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a helpful gaming assistant for a game library management application called "Ark". You help users:

1. **Discover games**: Search for games, get personalized recommendations based on their library, and provide detailed information about games.
2. **Manage their library**: Add games to their library, remove games, and check what's in their library.
3. **Answer gaming questions**: Provide information about game genres, developers, release dates, reviews, and general gaming knowledge.

You have access to the following tools:
- searchSteamGames: Search for games on Steam by name
- getGameDetails: Get detailed info about a specific game (description, price, reviews, etc.)
- getLibraryGames: List all games in the user's library with their status
- addGameToLibrary: Add a game to the user's library
- removeGameFromLibrary: Remove a game from the library
- getGameRecommendations: Get personalized game recommendations based on the user's library

**Important guidelines:**
- When the user asks for recommendations based on their library, ALWAYS use the getGameRecommendations tool
- When the user asks about a specific game, use getGameDetails to get accurate information
- When the user wants to find games by name, use searchSteamGames first, then getGameDetails for more info
- When managing the library, always confirm actions and provide feedback
- Format recommendations nicely with game names, why they're recommended, and match scores

Be conversational, helpful, and concise. Use the game context if provided to give more relevant answers.`;

// ── Shared Helpers ─────────────────────────────────────────────────────────────

function buildMessages(
  userMessage: string,
  gameContext?: GameContext,
  libraryData?: LibraryEntry[],
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
    if (msg.role === 'user') messages.push(new HumanMessage(msg.content));
    else if (msg.role === 'assistant') messages.push(new AIMessage(msg.content));
  }

  messages.push(new HumanMessage(userMessage));
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
    default:
      return `Unknown tool: ${name}`;
  }
}

async function validateResponse(userMessage: string, aiResponse: string): Promise<{ isValid: boolean; improvedResponse?: string }> {
  try {
    const validationPrompt = `You are a response validator. Review this AI response for a gaming assistant app.

User asked: "${userMessage}"
AI responded: "${aiResponse}"

Check if the response:
1. Directly addresses the user's question
2. Is accurate and helpful
3. Is appropriately concise

If the response is good, reply with: VALID
If the response needs improvement, reply with: IMPROVE: [your improved version]`;

    const result = await getValidationModel().invoke([new HumanMessage(validationPrompt)]);
    const content = typeof result.content === 'string' ? result.content : '';

    if (content.startsWith('VALID')) return { isValid: true };
    if (content.startsWith('IMPROVE:')) return { isValid: false, improvedResponse: content.substring(8).trim() };
    return { isValid: true };
  } catch (error) {
    logger.error('[Validation] Error:', error);
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
//   5. Validation agent  (when Gemini API key is available)

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
): Promise<{ content: string; toolsUsed: string[]; actions: LibraryAction[]; chainOfThought: ThoughtStep[]; model: string }> {
  logger.log(`[AI Proxy] Processing: "${userMessage.substring(0, 50)}..."`);

  // Reset per-request state
  currentLibraryData = libraryData || [];
  pendingActions = [];
  chainOfThought = [];

  const useGemini = settingsStore.shouldUseGemini();
  const ollamaSettings = settingsStore.getOllamaSettings();
  const providerName = useGemini ? 'Gemini 2.5 Flash' : `Ollama ${ollamaSettings.model}`;

  chainOfThought.push({ type: 'thinking', content: `Provider: ${providerName}`, timestamp: new Date() });

  try {
    // 1. Model
    const model = getUnifiedModel();

    // 2. Messages
    const messages = buildMessages(userMessage, gameContext, libraryData);

    // 3. Web search grounding (both providers)
    await addWebSearchContext(userMessage, gameContext, messages);

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

    // 7. Validation (requires a Gemini API key)
    const hasGeminiKey = !!settingsStore.getGoogleAIKey();
    if (hasGeminiKey) {
      chainOfThought.push({ type: 'validation', content: 'Running validation agent...', timestamp: new Date() });
      const validation = await validateResponse(userMessage, content);
      if (!validation.isValid && validation.improvedResponse) {
        logger.log('[AI Proxy] Response improved by validator');
        chainOfThought.push({ type: 'validation', content: 'Improved by validator', timestamp: new Date() });
        content = validation.improvedResponse;
      } else {
        chainOfThought.push({ type: 'validation', content: 'Passed validation', timestamp: new Date() });
      }
    }

    chainOfThought.push({ type: 'thinking', content: `Done — ${content.length} chars, ${toolsUsed.length} tools, ${pendingActions.length} actions`, timestamp: new Date() });

    return { content, toolsUsed, actions: pendingActions, chainOfThought, model: providerName };
  } catch (error: any) {
    chainOfThought.push({ type: 'thinking', content: `Error: ${error}`, timestamp: new Date() });

    // Friendly error for Ollama connection failures
    if (!useGemini && (error?.code === 'ECONNREFUSED' || error?.message?.includes('fetch failed') || error?.cause?.code === 'ECONNREFUSED')) {
      throw new Error(
        `Could not connect to Ollama at ${ollamaSettings.url}. ` +
        `Please ensure Ollama is running, or enable "Use Gemini Instead" in Settings if you have a Google AI API key.`,
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
