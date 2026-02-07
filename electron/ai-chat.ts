/**
 * AI Chat Agent with LangChain.js
 * Uses Google Gemini for LLM and custom tools for game/library operations
 */

import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import http from 'http';
import { steamAPI } from './steam-api.js';
import { chatStore } from './chat-store.js';
import { settingsStore } from './settings-store.js';
import { needsWebSearch, webSearch, formatSearchContext } from './web-search.js';

/**
 * Get the current API key from settings
 * Throws an error if no API key is configured
 */
function getApiKey(): string {
  const storedKey = settingsStore.getGoogleAIKey();
  if (storedKey) {
    console.log('[AI Chat] Using API key from settings');
    return storedKey;
  }
  throw new Error('No API key configured. Please add your Google AI API key in Settings.');
}

// Types
interface GameContext {
  appId: number;
  name: string;
  headerImage?: string;
}

interface LibraryEntry {
  gameId: number;
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

// Current library data (passed from renderer on each request)
let currentLibraryData: LibraryEntry[] = [];
let pendingActions: LibraryAction[] = [];
let chainOfThought: ThoughtStep[] = [];

// Lazy-initialized Gemini model (created on first use with current API key)
let cachedModel: ChatGoogleGenerativeAI | null = null;
let cachedApiKey: string | null = null;

/**
 * Get or create the Gemini model
 * Re-creates the model if the API key has changed
 */
function getModel(): ChatGoogleGenerativeAI {
  const currentKey = getApiKey();
  
  // Re-create model if key changed or model doesn't exist
  if (!cachedModel || cachedApiKey !== currentKey) {
    console.log('[AI Chat] Initializing Gemini model');
    cachedModel = new ChatGoogleGenerativeAI({
      apiKey: currentKey,
      model: 'gemini-2.5-flash',
      temperature: 0.7,
      maxOutputTokens: 2048,
    });
    cachedApiKey = currentKey;
  }
  
  return cachedModel;
}

// Define custom tools for the agent

/**
 * Search Steam games tool
 */
const searchGamesTool = tool(
  async ({ query, limit = 10 }: { query: string; limit?: number }) => {
    console.log(`[AI Tool] searchGames: "${query}" (limit: ${limit})`);
    try {
      const results = await steamAPI.searchGames(query, limit);
      return JSON.stringify(results.map(g => ({
        id: g.id,
        name: g.name,
        type: g.type,
      })));
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
  }
);

/**
 * Get game details tool
 */
const getGameDetailsTool = tool(
  async ({ appId }: { appId: number }) => {
    console.log(`[AI Tool] getGameDetails: ${appId}`);
    try {
      const details = await steamAPI.getAppDetails(appId);
      if (!details) {
        return `Game with ID ${appId} not found`;
      }
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
    description: 'Get detailed information about a specific game by its Steam App ID. Includes description, developers, genres, release date, price, and more.',
    schema: z.object({
      appId: z.number().describe('The Steam App ID of the game'),
    }),
  }
);

/**
 * Get library games tool
 */
const getLibraryGamesTool = tool(
  async () => {
    console.log('[AI Tool] getLibraryGames');
    try {
      if (currentLibraryData.length === 0) {
        return 'The library is empty. No games have been added yet.';
      }
      
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
    } catch (error) {
      return `Error getting library: ${error}`;
    }
  },
  {
    name: 'getLibraryGames',
    description: 'Get all games in the user\'s library with their status (Want to Play, Playing, Completed, etc.) and priority.',
    schema: z.object({}),
  }
);

/**
 * Add game to library tool
 */
const addToLibraryTool = tool(
  async ({ appId, status = 'Want to Play' }: { appId: number; status?: string }) => {
    console.log(`[AI Tool] addToLibrary: ${appId} with status "${status}"`);
    try {
      // Check if already in library
      const existing = currentLibraryData.find(e => e.gameId === appId);
      if (existing) {
        return `Game ${appId} is already in the library with status "${existing.status}"`;
      }
      
      // Get game name for confirmation
      const details = await steamAPI.getAppDetails(appId);
      const gameName = details?.name || `Game ${appId}`;
      
      // Queue the action to be executed by the renderer
      pendingActions.push({
        type: 'add',
        appId,
        status,
        gameName,
      });
      
      return `Successfully queued "${gameName}" to be added to the library with status "${status}". The game will appear in your library shortly.`;
    } catch (error) {
      return `Error adding game to library: ${error}`;
    }
  },
  {
    name: 'addGameToLibrary',
    description: 'Add a game to the user\'s library. Optionally specify the status (Want to Play, Playing, Completed, On Hold). Playing Now is system-managed and should not be set manually.',
    schema: z.object({
      appId: z.number().describe('The Steam App ID of the game to add'),
      status: z.string().optional().describe('Game status: Want to Play, Playing, Completed, or On Hold'),
    }),
  }
);

/**
 * Remove game from library tool
 */
const removeFromLibraryTool = tool(
  async ({ appId }: { appId: number }) => {
    console.log(`[AI Tool] removeFromLibrary: ${appId}`);
    try {
      // Check if in library
      const existing = currentLibraryData.find(e => e.gameId === appId);
      if (!existing) {
        return `Game ${appId} is not in the library`;
      }
      
      // Get game name for confirmation
      const details = await steamAPI.getAppDetails(appId);
      const gameName = details?.name || `Game ${appId}`;
      
      // Queue the action to be executed by the renderer
      pendingActions.push({
        type: 'remove',
        appId,
        gameName,
      });
      
      return `Successfully queued "${gameName}" to be removed from the library. The change will take effect shortly.`;
    } catch (error) {
      return `Error removing game from library: ${error}`;
    }
  },
  {
    name: 'removeGameFromLibrary',
    description: 'Remove a game from the user\'s library by its Steam App ID.',
    schema: z.object({
      appId: z.number().describe('The Steam App ID of the game to remove'),
    }),
  }
);

/**
 * Get game recommendations based on user's library
 */
const getRecommendationsTool = tool(
  async ({ limit = 10 }: { limit?: number }) => {
    console.log(`[AI Tool] getRecommendations based on library (limit: ${limit})`);
    try {
      if (currentLibraryData.length === 0) {
        return 'Cannot provide recommendations - the library is empty. Please add some games to your library first.';
      }

      // Get the library app IDs
      const libraryAppIds = currentLibraryData.map(e => e.gameId);
      
      // Use the first game as the base for recommendations, but consider all library games
      const baseGameId = libraryAppIds[0];
      
      // Get recommendations from Steam API
      const recommendations = await steamAPI.getRecommendations(baseGameId, libraryAppIds, limit);
      
      if (recommendations.length === 0) {
        return 'No recommendations found based on your library. Try adding more games.';
      }

      // Format recommendations nicely
      const formattedRecs = recommendations.map((rec, index) => ({
        rank: index + 1,
        name: rec.name,
        appId: rec.appId,
        matchScore: Math.round(rec.score * 100),
        reasons: rec.reasons.slice(0, 3), // Top 3 reasons
      }));

      return JSON.stringify({
        basedOn: currentLibraryData.map(e => e.name || `Game ${e.gameId}`).slice(0, 5),
        totalLibraryGames: currentLibraryData.length,
        recommendations: formattedRecs,
      });
    } catch (error) {
      return `Error getting recommendations: ${error}`;
    }
  },
  {
    name: 'getGameRecommendations',
    description: 'Get game recommendations based on the games in the user\'s library. Analyzes genres, developers, and categories to find similar games the user might enjoy.',
    schema: z.object({
      limit: z.number().optional().describe('Maximum number of recommendations to return (default 10)'),
    }),
  }
);

// All available tools
const tools = [
  searchGamesTool,
  getGameDetailsTool,
  getLibraryGamesTool,
  addToLibraryTool,
  removeFromLibraryTool,
  getRecommendationsTool,
];

// Tool name to tool map for execution
const toolMap: Record<string, typeof tools[number]> = {};
for (const t of tools) {
  toolMap[t.name] = t;
}

// Cached model with tools
let cachedModelWithTools: ReturnType<ChatGoogleGenerativeAI['bindTools']> | null = null;
let cachedModelWithToolsKey: string | null = null;

/**
 * Get or create the model with tools bound
 * Re-creates if API key has changed
 */
function getModelWithTools() {
  const currentKey = getApiKey();
  
  // Re-create if key changed or doesn't exist
  if (!cachedModelWithTools || cachedModelWithToolsKey !== currentKey) {
    console.log('[AI Chat] Binding tools to model');
    cachedModelWithTools = getModel().bindTools(tools);
    cachedModelWithToolsKey = currentKey;
  }
  
  return cachedModelWithTools;
}

// System prompt for the agent
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

// Cached validation model
let cachedValidationModel: ChatGoogleGenerativeAI | null = null;
let cachedValidationKey: string | null = null;

/**
 * Get or create the Validation Agent model
 * Re-creates if API key has changed
 */
function getValidationModel(): ChatGoogleGenerativeAI {
  const currentKey = getApiKey();
  
  // Re-create if key changed or doesn't exist
  if (!cachedValidationModel || cachedValidationKey !== currentKey) {
    console.log('[AI Chat] Initializing validation model');
    cachedValidationModel = new ChatGoogleGenerativeAI({
      apiKey: currentKey,
      model: 'gemini-2.5-flash',
      temperature: 0.1,
      maxOutputTokens: 512,
    });
    cachedValidationKey = currentKey;
  }
  
  return cachedValidationModel;
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
    
    if (content.startsWith('VALID')) {
      return { isValid: true };
    } else if (content.startsWith('IMPROVE:')) {
      return { isValid: false, improvedResponse: content.substring(8).trim() };
    }
    return { isValid: true }; // Default to valid if unclear
  } catch (error) {
    console.error('[Validation] Error:', error);
    return { isValid: true }; // Skip validation on error
  }
}

/**
 * Process a message using Ollama (main provider)
 * Supports streaming for real-time response updates
 */
async function processWithOllama(
  userMessage: string,
  gameContext?: GameContext,
  libraryData?: LibraryEntry[],
  onStreamChunk?: (chunk: string, fullContent: string) => void
): Promise<{ content: string; model: string }> {
  const ollamaSettings = settingsStore.getOllamaSettings();
  
  console.log(`[AI Chat] Using Ollama at ${ollamaSettings.url}`);
  
  // Build a simple prompt for Ollama (without tool support)
  let systemPrompt = `You are a helpful gaming assistant. Be concise and helpful.`;
  
  if (gameContext) {
    systemPrompt += ` The user is asking about the game: "${gameContext.name}".`;
  }
  
  if (libraryData && libraryData.length > 0) {
    // Build library info with names and status
    const libraryInfo = libraryData.slice(0, 15).map(g => {
      const name = g.name || `Unknown Game (ID: ${g.gameId})`;
      const status = g.status || 'Unknown';
      return `"${name}" (Status: ${status})`;
    }).join(', ');
    systemPrompt += `\n\nThe user's game library contains the following games: ${libraryInfo}${libraryData.length > 15 ? `. They also have ${libraryData.length - 15} more games not listed here` : ''}.`;
    systemPrompt += `\n\nWhen the user asks about their library, only mention games that are actually listed above. Do not invent or guess game names based on IDs.`;
  }

  // Web search grounding: if the question benefits from current data,
  // search DuckDuckGo and inject results into the system prompt
  const shouldSearch = needsWebSearch(userMessage);
  if (shouldSearch) {
    const searchQuery = gameContext
      ? `${gameContext.name} ${userMessage}`
      : userMessage;

    console.log(`[AI Chat] Grounding with web search: "${searchQuery}"`);
    chainOfThought.push({
      type: 'tool_call',
      content: `Searching the web for current information: "${searchQuery}"`,
      toolName: 'webSearch',
      toolArgs: { query: searchQuery },
      timestamp: new Date(),
    });

    const searchResults = await webSearch(searchQuery, 5);

    if (searchResults.length > 0) {
      systemPrompt += formatSearchContext(searchQuery, searchResults);

      chainOfThought.push({
        type: 'tool_result',
        content: `Web search returned ${searchResults.length} results`,
        toolName: 'webSearch',
        toolResult: searchResults.map(r => r.title).join(', '),
        timestamp: new Date(),
      });
    } else {
      chainOfThought.push({
        type: 'tool_result',
        content: 'Web search returned no results — answering from model knowledge only',
        toolName: 'webSearch',
        toolResult: 'No results',
        timestamp: new Date(),
      });
    }
  }
  
  // Parse the Ollama URL to get host and port
  const urlObj = new URL(ollamaSettings.url);
  // Use 127.0.0.1 instead of localhost to avoid DNS resolution issues
  const hostname = urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname;
  const port = parseInt(urlObj.port) || 11434;
  
  console.log(`[AI Chat] Ollama: Connecting to ${hostname}:${port} with model ${ollamaSettings.model}`);
  
  // Use streaming for real-time response
  const useStreaming = !!onStreamChunk;
  
  const requestBody = JSON.stringify({
    model: ollamaSettings.model,
    prompt: userMessage,
    system: systemPrompt,
    stream: useStreaming,
  });
  
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname,
      port,
      path: '/api/generate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
      },
    }, (res) => {
      let fullContent = '';
      let buffer = '';
      
      res.on('data', (chunk) => {
        if (useStreaming) {
          // Streaming mode: process each JSON line as it arrives
          buffer += chunk.toString();
          
          // Split by newlines and process complete JSON objects
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer
          
          for (const line of lines) {
            if (line.trim()) {
              try {
                const parsed = JSON.parse(line) as { response: string; done: boolean };
                if (parsed.response) {
                  fullContent += parsed.response;
                  onStreamChunk(parsed.response, fullContent);
                }
              } catch (e) {
                // Skip malformed JSON lines
                console.warn('[AI Chat] Ollama: skipping malformed chunk');
              }
            }
          }
        } else {
          // Non-streaming mode: collect all data
          buffer += chunk;
        }
      });
      
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`Ollama returned status ${res.statusCode}: ${buffer}`));
            return;
          }
          
          if (useStreaming) {
            // Process any remaining buffer content
            if (buffer.trim()) {
              try {
                const parsed = JSON.parse(buffer) as { response: string; done: boolean };
                if (parsed.response) {
                  fullContent += parsed.response;
                  onStreamChunk(parsed.response, fullContent);
                }
              } catch (e) {
                // Ignore final incomplete chunk
              }
            }
            
            console.log(`[AI Chat] Ollama streaming complete: ${fullContent.length} characters`);
            resolve({
              content: fullContent,
              model: `Ollama ${ollamaSettings.model}`,
            });
          } else {
            // Non-streaming: parse complete response
            const parsed = JSON.parse(buffer) as { response: string };
            console.log(`[AI Chat] Ollama responded with ${parsed.response.length} characters`);
            
            resolve({
              content: parsed.response,
              model: `Ollama ${ollamaSettings.model}`,
            });
          }
        } catch (e) {
          reject(new Error(`Failed to parse Ollama response: ${e}`));
        }
      });
    });
    
    req.on('error', (e) => {
      console.error('[AI Chat] Ollama request error:', e);
      const ollamaSettings = settingsStore.getOllamaSettings();
      reject(new Error(
        `Could not connect to Ollama at ${ollamaSettings.url}. ` +
        `Please ensure Ollama is running, or enable "Use Gemini Instead" in Settings if you have a Google AI API key.`
      ));
    });
    
    // Set socket timeout after request is created (3 minutes for streaming LLM response)
    req.setTimeout(180000, () => {
      req.destroy();
      reject(new Error('Ollama request timed out after 3 minutes'));
    });
    
    req.write(requestBody);
    req.end();
  });
}

/**
 * Process a message using Gemini (when enabled via toggle)
 * Full tool support with iterative tool calling
 */
async function processWithGemini(
  userMessage: string,
  gameContext?: GameContext,
  libraryData?: LibraryEntry[],
  _onStreamChunk?: (chunk: string, fullContent: string) => void // Gemini doesn't use streaming currently
): Promise<{ content: string; toolsUsed: string[]; actions: LibraryAction[]; model: string }> {
  console.log('[AI Chat] Using Gemini with full tool support');
  
  // Get conversation history
  const conversation = chatStore.getActiveConversation();
  const historyMessages = conversation?.messages || [];
  
  // Build messages array
  const messages: (SystemMessage | HumanMessage | AIMessage | ToolMessage)[] = [
    new SystemMessage(SYSTEM_PROMPT),
  ];
  
  // Add game context if provided
  if (gameContext) {
    messages.push(new SystemMessage(
      `The user is currently viewing the game: "${gameContext.name}" (Steam App ID: ${gameContext.appId}). ` +
      `When they ask questions without specifying a game, they're likely asking about this game.`
    ));
    
    chainOfThought.push({
      type: 'thinking',
      content: `Game context provided: ${gameContext.name} (ID: ${gameContext.appId})`,
      timestamp: new Date(),
    });
  }
  
  if (libraryData && libraryData.length > 0) {
    chainOfThought.push({
      type: 'thinking',
      content: `User library contains ${libraryData.length} games`,
      timestamp: new Date(),
    });
  }
  
  // Add conversation history (last 10 messages for context)
  const recentHistory = historyMessages.slice(-10);
  for (const msg of recentHistory) {
    if (msg.role === 'user') {
      messages.push(new HumanMessage(msg.content));
    } else if (msg.role === 'assistant') {
      messages.push(new AIMessage(msg.content));
    }
  }
  
  // Add the current user message
  messages.push(new HumanMessage(userMessage));
  
  const toolsUsed: string[] = [];
  
  // First call - may include tool calls
  const modelWithTools = getModelWithTools();
  let response = await modelWithTools.invoke(messages);
  
  // Handle tool calls iteratively
  let iterations = 0;
  const maxIterations = 5;
  
  while (response.tool_calls && response.tool_calls.length > 0 && iterations < maxIterations) {
    iterations++;
    console.log(`[AI Chat] Tool calls iteration ${iterations}:`, response.tool_calls.map(tc => tc.name));
    
    // Add AI response to messages
    messages.push(response);
    
    // Execute each tool call
    for (const toolCall of response.tool_calls) {
      const toolName = toolCall.name;
      const args = toolCall.args as Record<string, unknown>;
      toolsUsed.push(toolName);
      
      // Log tool call to chain of thought
      chainOfThought.push({
        type: 'tool_call',
        content: `Calling tool: ${toolName}`,
        toolName,
        toolArgs: args,
        timestamp: new Date(),
      });
      
      try {
        let result: string = '';
        
        // Execute the appropriate tool based on name
        switch (toolName) {
          case 'searchSteamGames':
            result = await searchGamesTool.invoke(args as { query: string; limit?: number });
            break;
          case 'getGameDetails':
            result = await getGameDetailsTool.invoke(args as { appId: number });
            break;
          case 'getLibraryGames':
            result = await getLibraryGamesTool.invoke({});
            break;
          case 'addGameToLibrary':
            result = await addToLibraryTool.invoke(args as { appId: number; status?: string });
            break;
          case 'removeGameFromLibrary':
            result = await removeFromLibraryTool.invoke(args as { appId: number });
            break;
          case 'getGameRecommendations':
            result = await getRecommendationsTool.invoke(args as { limit?: number });
            break;
          default:
            result = `Unknown tool: ${toolName}`;
        }
        
        console.log(`[AI Chat] Tool ${toolName} result:`, result.substring(0, 100));
        
        // Log tool result to chain of thought
        chainOfThought.push({
          type: 'tool_result',
          content: `Tool ${toolName} completed successfully`,
          toolName,
          toolResult: result.length > 500 ? result.substring(0, 500) + '...' : result,
          timestamp: new Date(),
        });
        
        // Add tool result message
        messages.push(new ToolMessage({
          content: result,
          tool_call_id: toolCall.id || '',
        }));
      } catch (error) {
        console.error(`[AI Chat] Tool ${toolName} error:`, error);
        
        // Log error to chain of thought
        chainOfThought.push({
          type: 'tool_result',
          content: `Tool ${toolName} failed: ${error}`,
          toolName,
          toolResult: `Error: ${error}`,
          timestamp: new Date(),
        });
        
        messages.push(new ToolMessage({
          content: `Error executing tool: ${error}`,
          tool_call_id: toolCall.id || '',
        }));
      }
    }
    
    // Get next response
    response = await modelWithTools.invoke(messages);
  }
  
  // Extract the final text content
  let content = typeof response.content === 'string' 
    ? response.content 
    : Array.isArray(response.content)
      ? response.content.map(c => typeof c === 'string' ? c : (c as { text?: string }).text || '').join('')
      : '';
  
  // Run validation agent
  chainOfThought.push({
    type: 'validation',
    content: 'Running validation agent to check response quality...',
    timestamp: new Date(),
  });
  
  const validation = await validateResponse(userMessage, content);
  if (!validation.isValid && validation.improvedResponse) {
    console.log('[AI Chat] Response improved by validation agent');
    chainOfThought.push({
      type: 'validation',
      content: 'Response was improved by validation agent',
      timestamp: new Date(),
    });
    content = validation.improvedResponse;
  } else {
    chainOfThought.push({
      type: 'validation',
      content: 'Response passed validation',
      timestamp: new Date(),
    });
  }
  
  return { content, toolsUsed, actions: pendingActions, model: 'Gemini 2.5 Flash' };
}

/**
 * Process a chat message and return the AI response
 * Uses Ollama by default, or Gemini if explicitly enabled in settings
 */
export async function processMessage(
  userMessage: string,
  gameContext?: GameContext,
  libraryData?: LibraryEntry[],
  onStreamChunk?: (chunk: string, fullContent: string) => void
): Promise<{ content: string; toolsUsed: string[]; actions: LibraryAction[]; chainOfThought: ThoughtStep[]; model: string }> {
  console.log(`[AI Chat] Processing message: "${userMessage.substring(0, 50)}..."`);
  
  // Update current library data
  currentLibraryData = libraryData || [];
  pendingActions = [];
  chainOfThought = [];
  
  // Add initial thinking step
  chainOfThought.push({
    type: 'thinking',
    content: `Processing user message: "${userMessage.substring(0, 100)}${userMessage.length > 100 ? '...' : ''}"`,
    timestamp: new Date(),
  });
  
  // Check which provider to use
  const useGemini = settingsStore.shouldUseGemini();
  
  chainOfThought.push({
    type: 'thinking',
    content: useGemini ? 'Using Gemini API (enabled in settings)' : 'Using Ollama (default provider)',
    timestamp: new Date(),
  });
  
  try {
    if (useGemini) {
      // Use Gemini with full tool support
      const result = await processWithGemini(userMessage, gameContext, libraryData, onStreamChunk);
      
      chainOfThought.push({
        type: 'thinking',
        content: `Generated response with ${result.content.length} characters, used ${result.toolsUsed.length} tools, ${result.actions.length} library actions queued`,
        timestamp: new Date(),
      });
      
      console.log(`[AI Chat] Response generated (${result.content.length} chars, ${result.toolsUsed.length} tools used, ${result.actions.length} actions)`);
      
      return { ...result, chainOfThought };
    } else {
      // Use Ollama as main provider
      const ollamaResponse = await processWithOllama(userMessage, gameContext, libraryData, onStreamChunk);
      
      chainOfThought.push({
        type: 'thinking',
        content: `Ollama responded with ${ollamaResponse.content.length} characters`,
        timestamp: new Date(),
      });
      
      console.log(`[AI Chat] Response generated (${ollamaResponse.content.length} chars) using ${ollamaResponse.model}`);
      
      return {
        content: ollamaResponse.content,
        toolsUsed: [],
        actions: [],
        chainOfThought,
        model: ollamaResponse.model,
      };
    }
  } catch (error) {
    console.error('[AI Chat] Error processing message:', error);
    
    // Add error to chain of thought
    chainOfThought.push({
      type: 'thinking',
      content: `Error occurred: ${error}`,
      timestamp: new Date(),
    });
    
    throw error;
  }
}

/**
 * Search games for context selection
 */
export async function searchGamesForContext(query: string): Promise<GameContext[]> {
  try {
    const results = await steamAPI.searchGames(query, 5);
    return results.map(g => ({
      appId: g.id,
      name: g.name,
      headerImage: `https://cdn.akamai.steamstatic.com/steam/apps/${g.id}/header.jpg`,
    }));
  } catch (error) {
    console.error('[AI Chat] Error searching games for context:', error);
    return [];
  }
}

// Export chat store functions
export { chatStore };
