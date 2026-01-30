import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { steamAPI, getSteamCoverUrl, getSteamHeaderUrl } from './steam-api.js';
import { fetchMetacriticReviews, clearMetacriticCache } from './metacritic-api.js';
import { processMessage, searchGamesForContext, chatStore } from './ai-chat.js';
import { settingsStore } from './settings-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    title: 'Ark',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#000000',
    show: false,
  });

  // Start maximized
  mainWindow.maximize();

  // In development, load from Vite dev server
  const isDev = process.env.NODE_ENV === 'development';
  const isTest = process.env.NODE_ENV === 'test';
  const isProd = process.env.NODE_ENV === 'production';
  
  if (isDev || (!app.isPackaged && !isProd && !isTest)) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools();
  } else {
    // In production or test, load the built files
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC handlers for window controls
ipcMain.handle('window-minimize', () => {
  if (mainWindow) {
    mainWindow.minimize();
  }
});

ipcMain.handle('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.handle('window-close', () => {
  if (mainWindow) {
    mainWindow.close();
  }
});

ipcMain.handle('window-is-maximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

// ============================================================================
// STEAM API IPC HANDLERS
// ============================================================================

/**
 * Get cover URL for a Steam game
 */
ipcMain.handle('steam:getCoverUrl', async (_event, appId: number) => {
  return getSteamCoverUrl(appId);
});

/**
 * Get header URL for a Steam game
 */
ipcMain.handle('steam:getHeaderUrl', async (_event, appId: number) => {
  return getSteamHeaderUrl(appId);
});

/**
 * Get most played games from Steam Charts
 * Returns top 100 most played games with player counts
 */
ipcMain.handle('steam:getMostPlayedGames', async () => {
  try {
    console.log('[Steam IPC] getMostPlayedGames called');
    const games = await steamAPI.getMostPlayedGames();
    console.log(`[Steam IPC] getMostPlayedGames returned ${games.length} games`);
    return games;
  } catch (error) {
    console.error('[Steam IPC] Error fetching most played games:', error);
    throw error;
  }
});

/**
 * Get app details for a specific game
 */
ipcMain.handle('steam:getAppDetails', async (_event, appId: number) => {
  try {
    console.log(`[Steam IPC] getAppDetails for appId: ${appId}`);
    const details = await steamAPI.getAppDetails(appId);
    if (details) {
      console.log(`[Steam IPC] getAppDetails success: ${details.name}`);
    } else {
      console.log(`[Steam IPC] getAppDetails returned null for ${appId}`);
    }
    return details;
  } catch (error) {
    console.error(`[Steam IPC] Error fetching app details for ${appId}:`, error);
    throw error;
  }
});

/**
 * Get app details for multiple games (batched)
 */
ipcMain.handle('steam:getMultipleAppDetails', async (_event, appIds: number[]) => {
  try {
    console.log(`[Steam IPC] getMultipleAppDetails for ${appIds.length} games: [${appIds.slice(0, 5).join(', ')}${appIds.length > 5 ? '...' : ''}]`);
    const detailsMap = await steamAPI.getMultipleAppDetails(appIds);
    
    // Convert Map to array for IPC serialization
    const results: Array<{ appId: number; details: any }> = [];
    detailsMap.forEach((details, appId) => {
      results.push({ appId, details });
    });
    
    console.log(`[Steam IPC] getMultipleAppDetails returned ${results.length} results`);
    return results;
  } catch (error) {
    console.error('[Steam IPC] Error fetching multiple app details:', error);
    throw error;
  }
});

/**
 * Search games on Steam Store
 */
ipcMain.handle('steam:searchGames', async (_event, query: string, limit: number = 20) => {
  try {
    console.log(`[Steam IPC] searchGames for "${query}" (limit: ${limit})`);
    const results = await steamAPI.searchGames(query, limit);
    console.log(`[Steam IPC] searchGames returned ${results.length} results`);
    return results;
  } catch (error) {
    console.error('[Steam IPC] Error searching games:', error);
    throw error;
  }
});

/**
 * Get new releases
 */
ipcMain.handle('steam:getNewReleases', async () => {
  try {
    console.log('[Steam] Handler: getNewReleases');
    const releases = await steamAPI.getNewReleases();
    return releases;
  } catch (error) {
    console.error('Error fetching new releases:', error);
    throw error;
  }
});

/**
 * Get top sellers
 */
ipcMain.handle('steam:getTopSellers', async () => {
  try {
    console.log('[Steam] Handler: getTopSellers');
    const sellers = await steamAPI.getTopSellers();
    return sellers;
  } catch (error) {
    console.error('Error fetching top sellers:', error);
    throw error;
  }
});

/**
 * Get coming soon games
 */
ipcMain.handle('steam:getComingSoon', async () => {
  try {
    console.log('[Steam] Handler: getComingSoon');
    const comingSoon = await steamAPI.getComingSoon();
    return comingSoon;
  } catch (error) {
    console.error('Error fetching coming soon games:', error);
    throw error;
  }
});

/**
 * Get featured categories (includes new releases, top sellers, etc.)
 */
ipcMain.handle('steam:getFeaturedCategories', async () => {
  try {
    console.log('[Steam] Handler: getFeaturedCategories');
    const categories = await steamAPI.getFeaturedCategories();
    return categories;
  } catch (error) {
    console.error('Error fetching featured categories:', error);
    throw error;
  }
});

/**
 * Get game reviews
 */
ipcMain.handle('steam:getGameReviews', async (_event, appId: number, limit: number = 10) => {
  try {
    console.log(`[Steam] Handler: getGameReviews for appId ${appId}`);
    const reviews = await steamAPI.getGameReviews(appId, limit);
    return reviews;
  } catch (error) {
    console.error('Error fetching game reviews:', error);
    throw error;
  }
});

/**
 * Get queue status for rate limiting feedback
 */
ipcMain.handle('steam:getQueueStatus', async () => {
  return steamAPI.getQueueStatus();
});

/**
 * Clear Steam API cache
 */
ipcMain.handle('steam:clearCache', async () => {
  steamAPI.clearCache();
  return true;
});

/**
 * Prefetch game details in background (for faster navigation)
 */
ipcMain.handle('steam:prefetchGameDetails', async (_event, appIds: number[]) => {
  console.log(`[Steam IPC] prefetchGameDetails for ${appIds.length} games`);
  steamAPI.prefetchGameDetails(appIds);
  return true;
});

/**
 * Check if a game's details are cached
 */
ipcMain.handle('steam:isCached', async (_event, appId: number) => {
  return steamAPI.isCached(appId);
});

/**
 * Get cache statistics
 */
ipcMain.handle('steam:getCacheStats', async () => {
  return steamAPI.getCacheStats();
});

/**
 * Get cached game names for multiple app IDs
 */
ipcMain.handle('steam:getCachedGameNames', async (_event, appIds: number[]) => {
  return steamAPI.getCachedGameNames(appIds);
});

/**
 * Get game recommendations based on a game and user's library
 */
ipcMain.handle('steam:getRecommendations', async (_event, currentAppId: number, libraryAppIds: number[], limit: number = 10) => {
  try {
    console.log(`[Steam IPC] getRecommendations for appId ${currentAppId} with ${libraryAppIds.length} library games`);
    const recommendations = await steamAPI.getRecommendations(currentAppId, libraryAppIds, limit);
    return recommendations;
  } catch (error) {
    console.error('Error getting recommendations:', error);
    return [];
  }
});

// ============================================================================
// METACRITIC API IPC HANDLERS
// ============================================================================

/**
 * Get game reviews from Metacritic
 */
ipcMain.handle('metacritic:getGameReviews', async (_event, gameName: string) => {
  try {
    console.log(`[Metacritic] Handler: getGameReviews for "${gameName}"`);
    const reviews = await fetchMetacriticReviews(gameName);
    return reviews;
  } catch (error) {
    console.error('Error fetching Metacritic reviews:', error);
    return null;
  }
});

/**
 * Clear Metacritic cache
 */
ipcMain.handle('metacritic:clearCache', async () => {
  clearMetacriticCache();
  return true;
});

// ============================================================================
// AI CHAT IPC HANDLERS
// ============================================================================

/**
 * Send a message to the AI chat
 * Supports streaming responses via 'ai:streamChunk' event
 */
ipcMain.handle('ai:sendMessage', async (event, { message, gameContext, libraryData }) => {
  try {
    console.log(`[AI IPC] sendMessage: "${message.substring(0, 50)}..."`);
    
    // Streaming callback to send chunks to renderer
    const onStreamChunk = (chunk: string, fullContent: string) => {
      event.sender.send('ai:streamChunk', { chunk, fullContent });
    };
    
    const result = await processMessage(message, gameContext, libraryData, onStreamChunk);
    
    // Store the message in chat history
    chatStore.addMessage({ role: 'user', content: message, gameContext });
    chatStore.addMessage({ role: 'assistant', content: result.content, toolCalls: result.toolsUsed.map(name => ({ name, args: {} })) });
    
    return result;
  } catch (error) {
    console.error('[AI IPC] Error sending message:', error);
    throw error;
  }
});

/**
 * Get chat history
 */
ipcMain.handle('ai:getHistory', async () => {
  try {
    return chatStore.getConversations();
  } catch (error) {
    console.error('[AI IPC] Error getting history:', error);
    return [];
  }
});

/**
 * Get active conversation
 */
ipcMain.handle('ai:getActiveConversation', async () => {
  try {
    return chatStore.getActiveConversation();
  } catch (error) {
    console.error('[AI IPC] Error getting active conversation:', error);
    return null;
  }
});

/**
 * Create a new conversation
 */
ipcMain.handle('ai:createNewConversation', async () => {
  try {
    return chatStore.createConversation();
  } catch (error) {
    console.error('[AI IPC] Error creating conversation:', error);
    throw error;
  }
});

/**
 * Clear chat history
 */
ipcMain.handle('ai:clearHistory', async () => {
  try {
    chatStore.clearHistory();
    return true;
  } catch (error) {
    console.error('[AI IPC] Error clearing history:', error);
    throw error;
  }
});

/**
 * Search games for context selection
 */
ipcMain.handle('ai:searchGamesForContext', async (_event, query: string) => {
  try {
    return await searchGamesForContext(query);
  } catch (error) {
    console.error('[AI IPC] Error searching games for context:', error);
    return [];
  }
});

// ============================================================================
// SETTINGS IPC HANDLERS
// ============================================================================

ipcMain.handle('settings:getApiKey', async () => {
  try {
    return settingsStore.getGoogleAIKey();
  } catch (error) {
    console.error('[Settings] Error getting API key:', error);
    return null;
  }
});

ipcMain.handle('settings:setApiKey', async (_event, key: string) => {
  try {
    settingsStore.setGoogleAIKey(key);
    return { success: true };
  } catch (error) {
    console.error('[Settings] Error setting API key:', error);
    throw error;
  }
});

ipcMain.handle('settings:removeApiKey', async () => {
  try {
    settingsStore.removeGoogleAIKey();
    return { success: true };
  } catch (error) {
    console.error('[Settings] Error removing API key:', error);
    throw error;
  }
});

ipcMain.handle('settings:hasApiKey', async () => {
  try {
    return settingsStore.hasGoogleAIKey();
  } catch (error) {
    console.error('[Settings] Error checking API key:', error);
    return false;
  }
});

ipcMain.handle('settings:getOllamaSettings', async () => {
  try {
    return settingsStore.getOllamaSettings();
  } catch (error) {
    console.error('[Settings] Error getting Ollama settings:', error);
    return { enabled: true, url: 'http://localhost:11434', model: 'gemma3:12b' };
  }
});

ipcMain.handle('settings:setOllamaSettings', async (_event, settings: { enabled?: boolean; url?: string; model?: string }) => {
  try {
    settingsStore.setOllamaSettings(settings);
  } catch (error) {
    console.error('[Settings] Error setting Ollama settings:', error);
    throw error;
  }
});

// ============================================================================
// APP LIFECYCLE
// ============================================================================

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
