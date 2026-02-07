import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { app, BrowserWindow, ipcMain, dialog, shell } = electron;
import type { BrowserWindow as BrowserWindowType } from 'electron';
import * as fs from 'fs';
import path from 'path';

// ESM has no __dirname; required for loadFile/preload paths when run as module
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Handle EPIPE errors globally to prevent crashes when stdout/stderr is closed
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') return;
  throw err;
});
process.stderr.on('error', (err) => {
  if (err.code === 'EPIPE') return;
  throw err;
});

// Log startup errors to a file when packaged (app doesn't show console)
function logStartupError(err: unknown) {
  const msg = err instanceof Error ? err.message + '\n' + err.stack : String(err);
  try {
    const userData = app?.getPath?.('userData');
    if (userData) fs.writeFileSync(path.join(userData, 'ark-startup-error.log'), msg, 'utf-8');
  } catch {
    // ignore
  }
  console.error('[Ark] Startup error:', msg);
}

process.on('uncaughtException', (err) => {
  logStartupError(err);
  try {
    if (app.isPackaged) app.quit();
  } catch {
    process.exit(1);
  }
});

import { steamAPI, getSteamCoverUrl, getSteamHeaderUrl } from './steam-api.js';
import { fetchMetacriticReviews, clearMetacriticCache } from './metacritic-api.js';
import { processMessage, searchGamesForContext, chatStore } from './ai-chat.js';
import { settingsStore } from './settings-store.js';
import { initAutoUpdater, registerUpdaterIpcHandlers } from './auto-updater.js';
import { startSessionTracker, stopSessionTracker, setTrackedGames, getActiveSessions } from './session-tracker.js';
let mainWindow: BrowserWindowType | null = null;

// ---------- Data migration: game-tracker → ark ----------
// When we renamed the package from "game-tracker" to "ark", the userData
// directory changed from %APPDATA%/game-tracker to %APPDATA%/ark.
// Copy existing data so users don't lose their library, cache, or settings.
(function migrateUserData() {
  try {
    const newUserData = app.getPath('userData'); // …/ark
    const oldUserData = path.join(path.dirname(newUserData), 'game-tracker');

    if (fs.existsSync(oldUserData) && !fs.existsSync(path.join(newUserData, '.migrated'))) {
      console.log(`[Migration] Migrating user data from ${oldUserData} → ${newUserData}`);
      if (!fs.existsSync(newUserData)) {
        fs.mkdirSync(newUserData, { recursive: true });
      }

      // Copy every file from the old directory (shallow — no subdirs needed)
      const files = fs.readdirSync(oldUserData);
      for (const file of files) {
        const src = path.join(oldUserData, file);
        const dest = path.join(newUserData, file);
        if (fs.statSync(src).isFile() && !fs.existsSync(dest)) {
          fs.copyFileSync(src, dest);
          console.log(`[Migration] Copied ${file}`);
        }
      }

      // Write a marker so we only migrate once
      fs.writeFileSync(path.join(newUserData, '.migrated'), 'migrated from game-tracker', 'utf-8');
      console.log('[Migration] Done');
    }
  } catch (err) {
    console.warn('[Migration] Non-fatal error during data migration:', err);
  }
})();

// Register updater IPC handlers early so the renderer never hits
// "No handler registered" errors — even in dev mode.
registerUpdaterIpcHandlers();

function createWindow() {
  // Resolve paths: when packaged, use app path so loadFile/preload work from installed location
  let preloadPath: string;
  let indexPath: string;
  if (app.isPackaged) {
    const appPath = app.getAppPath();
    indexPath = path.join(appPath, 'dist', 'index.html');
    // Preload is unpacked (asarUnpack) so load from app.asar.unpacked to avoid Windows asar issues
    const resourcesPath = process.resourcesPath;
    preloadPath = path.join(resourcesPath, 'app.asar.unpacked', 'dist-electron', 'electron', 'preload.cjs');
    // Fallback if unpacked path doesn't exist (e.g. older build)
    if (!fs.existsSync(preloadPath)) {
      preloadPath = path.join(appPath, 'dist-electron', 'electron', 'preload.cjs');
    }
  } else {
    preloadPath = path.join(__dirname, 'preload.cjs');
    indexPath = path.join(__dirname, '../../dist/index.html');
  }

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
      preload: preloadPath,
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
    mainWindow.loadFile(indexPath);
  }

  // ---- Navigation guards ----
  // Redirect any link that tries to open a NEW window (target="_blank", window.open, etc.)
  // to the default OS browser instead of spawning an Electron BrowserWindow.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('mailto:')) {
      shell.openExternal(url);
      console.log(`[Navigation] Redirected new-window request to OS browser: ${url}`);
    }
    return { action: 'deny' }; // Never open a child Electron window
  });

  // Prevent the main window from navigating away from the app.
  // Any external http(s) URL is opened in the OS browser instead.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow navigation to the Vite dev server or the local file in production
    const currentUrl = mainWindow?.webContents.getURL() || '';
    const isInternalNav =
      url.startsWith('file://') ||
      url.startsWith('http://localhost') ||
      url.startsWith(currentUrl.split('#')[0]); // hash-based routing

    if (!isInternalNav) {
      event.preventDefault();
      shell.openExternal(url);
      console.log(`[Navigation] Blocked in-window navigation, opened in OS browser: ${url}`);
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    
    // Initialize auto-updater in production mode
    if (app.isPackaged && mainWindow) {
      initAutoUpdater(mainWindow);
    }

    // Start session tracker for game process monitoring
    if (mainWindow) {
      startSessionTracker(mainWindow);
    }
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

// Open external URL in default browser
ipcMain.handle('shell:openExternal', async (_event, url: string) => {
  try {
    // Validate URL to prevent security issues
    const parsedUrl = new URL(url);
    const allowedProtocols = ['http:', 'https:', 'mailto:', 'magnet:'];
    if (!allowedProtocols.includes(parsedUrl.protocol)) {
      console.warn(`[Shell] Blocked attempt to open URL with disallowed protocol: ${parsedUrl.protocol}`);
      return { success: false, error: 'Protocol not allowed' };
    }
    
    await shell.openExternal(url);
    console.log(`[Shell] Opened external URL: ${url}`);
    return { success: true };
  } catch (error) {
    console.error('[Shell] Error opening external URL:', error);
    return { success: false, error: String(error) };
  }
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
 * Get news for a specific game
 */
ipcMain.handle('steam:getNewsForApp', async (_event, appId: number, count: number = 15) => {
  try {
    console.log(`[Steam] Handler: getNewsForApp for appId ${appId}`);
    const news = await steamAPI.getNewsForApp(appId, count);
    return news;
  } catch (error) {
    console.error(`Error fetching news for appId ${appId}:`, error);
    throw error;
  }
});

/**
 * Get current player count for a single game
 */
ipcMain.handle('steam:getPlayerCount', async (_event, appId: number) => {
  return steamAPI.getPlayerCount(appId);
});

/**
 * Get current player counts for multiple games (batched)
 */
ipcMain.handle('steam:getMultiplePlayerCounts', async (_event, appIds: number[]) => {
  return steamAPI.getMultiplePlayerCounts(appIds);
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
// FILE DIALOG IPC HANDLERS
// ============================================================================

/**
 * Show save file dialog and write content to file
 */
ipcMain.handle('dialog:saveFile', async (_event, options: { 
  content: string; 
  defaultName?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: options.defaultName || 'export.json',
      filters: options.filters || [
        { name: 'JSON Files', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    
    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }
    
    fs.writeFileSync(result.filePath, options.content, 'utf-8');
    return { success: true, filePath: result.filePath };
  } catch (error) {
    console.error('[Dialog] Error saving file:', error);
    return { success: false, error: String(error) };
  }
});

/**
 * Show open file dialog and read content from file
 */
ipcMain.handle('dialog:openFile', async (_event, options?: { 
  filters?: Array<{ name: string; extensions: string[] }>;
}) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: options?.filters || [
        { name: 'JSON Files', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    
    const filePath = result.filePaths[0];
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, filePath, content };
  } catch (error) {
    console.error('[Dialog] Error opening file:', error);
    return { success: false, error: String(error) };
  }
});

// ============================================================================
// SESSION TRACKER IPC HANDLERS
// ============================================================================

/**
 * Receive the list of games to track from the renderer
 */
ipcMain.handle('session:setTrackedGames', async (_event, games: Array<{ gameId: number; executablePath: string }>) => {
  setTrackedGames(games);
  return { success: true };
});

/**
 * Get currently active sessions
 */
ipcMain.handle('session:getActive', async () => {
  return getActiveSessions();
});

// ============================================================================
// FILE DIALOG IPC HANDLERS (continued)
// ============================================================================

/**
 * Show open file dialog to select a game executable (returns path only, no content)
 */
ipcMain.handle('dialog:selectExecutable', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Select Game Executable',
      properties: ['openFile'],
      filters: [
        { name: 'Executables', extensions: ['exe', 'lnk', 'bat', 'cmd'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    return { success: true, filePath: result.filePaths[0] };
  } catch (error) {
    console.error('[Dialog] Error selecting executable:', error);
    return { success: false, error: String(error) };
  }
});

// ============================================================================
// APP LIFECYCLE
// ============================================================================

app.whenReady().then(() => {
  try {
    createWindow();
  } catch (err) {
    logStartupError(err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  stopSessionTracker();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
