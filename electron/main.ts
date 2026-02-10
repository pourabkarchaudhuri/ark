import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, net, session, Tray, Menu, nativeImage } = electron;
import type { BrowserWindow as BrowserWindowType } from 'electron';
import * as fs from 'fs';
import * as https from 'https';
import path from 'path';

let tray: any = null;
let isQuitting = false;
import { FiltersEngine, Request } from '@ghostery/adblocker';
import fetch from 'cross-fetch';

// ESM has no __dirname; required for loadFile/preload paths when run as module
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Set Node.js process title — visible in system monitors and some task managers
process.title = 'Ark';

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
import { epicAPI } from './epic-api.js';
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

// Set the app name early — affects window titles, tray labels, and process
// descriptions where the runtime can influence them.
app.name = 'Ark';
app.setAppUserModelId('com.ark.gametracker');

// ---------------------------------------------------------------------------
// Single Instance Lock — prevent multiple instances from running
// ---------------------------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another instance already owns the lock — quit immediately.
  // The 'second-instance' event on the first instance will focus its window.
  app.quit();
} else {
  app.on('second-instance', () => {
    // A second instance was attempted — bring the existing window to front
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Suppress noisy Chromium/Electron errors on Windows
// ---------------------------------------------------------------------------
// GPU shader disk cache causes "Unable to move the cache: Access is denied"
// and "Gpu Cache Creation failed" on Windows due to file locking conflicts.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
// Reduce quota database errors ("Could not open the quota database, resetting")
// caused by stale locks when multiple Electron instances fight over storage.
app.commandLine.appendSwitch('disable-features', 'ServiceWorkerBypassFetchHandler');

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

  // Resolve the window icon — use the ICO for Windows taskbar / ALT+TAB.
  // In dev mode the icon lives in build/; in production electron-builder embeds it.
  const projectRoot = path.join(__dirname, '../..');
  let windowIcon;
  if (app.isPackaged) {
    const icoCandidates = [
      path.join(process.resourcesPath, 'icons', 'icon.ico'),
      path.join(process.resourcesPath, 'icons', 'icon-256.png'),
    ];
    const found = icoCandidates.find((p) => fs.existsSync(p));
    if (found) windowIcon = nativeImage.createFromPath(found);
  } else {
    const icoCandidates = [
      path.join(projectRoot, 'build', 'icon.ico'),
      path.join(projectRoot, 'build', 'icon.png'),
    ];
    const found = icoCandidates.find((p) => fs.existsSync(p));
    if (found) windowIcon = nativeImage.createFromPath(found);
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    title: 'Ark',
    ...(windowIcon && !windowIcon.isEmpty() ? { icon: windowIcon } : {}),
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
    // If launched with --hidden (auto-start), stay hidden in tray
    if (!process.argv.includes('--hidden')) {
      mainWindow?.show();
    } else {
      console.log('[Startup] Launched with --hidden flag, staying in tray');
    }
    
    // Initialize auto-updater in production mode
    if (app.isPackaged && mainWindow) {
      initAutoUpdater(mainWindow);
    }

    // Start session tracker for game process monitoring
    if (mainWindow) {
      startSessionTracker(mainWindow);
    }
  });

  // Intercept close to hide to tray instead of quitting
  mainWindow.on('close', (e: any) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    destroyWebContentsView();
    mainWindow = null;
  });
}

// IPC handlers for window controls
ipcMain.handle('window-minimize', () => {
  if (mainWindow) {
    mainWindow.hide();
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
 * Get full Steam app list (for Catalog A–Z browsing)
 */
ipcMain.handle('steam:getAppList', async () => {
  try {
    console.log('[Steam IPC] getAppList called');
    const apps = await steamAPI.getAppList();
    console.log(`[Steam IPC] getAppList returned ${apps.length} apps`);
    return apps;
  } catch (error) {
    console.error('[Steam IPC] Error fetching app list:', error);
    throw error;
  }
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

/**
 * Get upcoming releases: combines Coming Soon + New Releases with enriched details.
 * Batch-fetches getAppDetails for each game to get release_date, genres, platforms.
 * Cached for 1 hour to avoid repeated batch fetches.
 */
let upcomingReleasesCache: { data: any[]; timestamp: number } | null = null;
const UPCOMING_CACHE_TTL = 60 * 60 * 1000; // 1 hour

ipcMain.handle('steam:getUpcomingReleases', async () => {
  try {
    // Return cached data if still fresh
    if (upcomingReleasesCache && (Date.now() - upcomingReleasesCache.timestamp < UPCOMING_CACHE_TTL)) {
      console.log('[Steam IPC] getUpcomingReleases returning cached data');
      return upcomingReleasesCache.data;
    }

    console.log('[Steam IPC] getUpcomingReleases called');

    // Fetch coming soon and new releases in parallel
    const [comingSoon, newReleases] = await Promise.all([
      steamAPI.getComingSoon().catch(() => []),
      steamAPI.getNewReleases().catch(() => []),
    ]);

    // Merge and deduplicate by id
    const allGamesMap = new Map<number, { id: number; name: string; image: string }>();
    for (const game of [...comingSoon, ...newReleases]) {
      if (!allGamesMap.has(game.id)) {
        allGamesMap.set(game.id, game);
      }
    }

    const allGames = Array.from(allGamesMap.values());
    console.log(`[Steam IPC] getUpcomingReleases: ${comingSoon.length} coming soon, ${newReleases.length} new releases, ${allGames.length} unique`);

    // Batch-fetch details (5 at a time to respect rate limits)
    const enriched: Array<{
      id: number;
      name: string;
      image: string;
      releaseDate: string;
      comingSoon: boolean;
      genres: string[];
      platforms: { windows: boolean; mac: boolean; linux: boolean };
    }> = [];

    const batchSize = 5;
    for (let i = 0; i < allGames.length; i += batchSize) {
      const batch = allGames.slice(i, i + batchSize);
      const detailsResults = await Promise.allSettled(
        batch.map(async (game) => {
          try {
            const details = await steamAPI.getAppDetails(game.id);
            return {
              id: game.id,
              name: details?.name || game.name,
              image: details?.header_image || game.image,
              releaseDate: details?.release_date?.date || 'Coming Soon',
              comingSoon: details?.release_date?.coming_soon ?? true,
              genres: details?.genres?.map((g: any) => g.description) || [],
              platforms: details?.platforms || { windows: true, mac: false, linux: false },
            };
          } catch {
            return {
              id: game.id,
              name: game.name,
              image: game.image,
              releaseDate: 'Coming Soon',
              comingSoon: true,
              genres: [] as string[],
              platforms: { windows: true, mac: false, linux: false },
            };
          }
        })
      );

      for (const result of detailsResults) {
        if (result.status === 'fulfilled') {
          enriched.push(result.value);
        }
      }

      // Delay between batches to avoid Steam 429 rate limits
      if (i + batchSize < allGames.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Cache the result for 1 hour
    upcomingReleasesCache = { data: enriched, timestamp: Date.now() };

    console.log(`[Steam IPC] getUpcomingReleases returning ${enriched.length} enriched games`);
    return enriched;
  } catch (error) {
    console.error('[Steam IPC] Error fetching upcoming releases:', error);
    return [];
  }
});

// ============================================================================
// EPIC GAMES STORE IPC HANDLERS
// ============================================================================

/**
 * Search Epic Games Store by keyword
 */
ipcMain.handle('epic:searchGames', async (_event, query: string, limit: number = 20) => {
  try {
    console.log(`[Epic IPC] searchGames: "${query}" (limit ${limit})`);
    return await epicAPI.searchGames(query, limit);
  } catch (error) {
    console.error('[Epic IPC] Error searching games:', error);
    return [];
  }
});

/**
 * Get details for a single Epic game by namespace + offerId
 */
ipcMain.handle('epic:getGameDetails', async (_event, namespace: string, offerId: string) => {
  try {
    console.log(`[Epic IPC] getGameDetails: ${namespace} / ${offerId}`);
    return await epicAPI.getGameDetails(namespace, offerId);
  } catch (error) {
    console.error('[Epic IPC] Error getting game details:', error);
    return null;
  }
});

/**
 * Get new releases from Epic Games Store
 */
ipcMain.handle('epic:getNewReleases', async () => {
  try {
    console.log('[Epic IPC] getNewReleases');
    return await epicAPI.getNewReleases();
  } catch (error) {
    console.error('[Epic IPC] Error fetching new releases:', error);
    return [];
  }
});

/**
 * Get coming soon games from Epic Games Store
 */
ipcMain.handle('epic:getComingSoon', async () => {
  try {
    console.log('[Epic IPC] getComingSoon');
    return await epicAPI.getComingSoon();
  } catch (error) {
    console.error('[Epic IPC] Error fetching coming soon:', error);
    return [];
  }
});

/**
 * Get current free games on Epic Games Store
 */
ipcMain.handle('epic:getFreeGames', async () => {
  try {
    console.log('[Epic IPC] getFreeGames');
    return await epicAPI.getFreeGames();
  } catch (error) {
    console.error('[Epic IPC] Error fetching free games:', error);
    return [];
  }
});

/**
 * Get upcoming releases from Epic (combined new + coming soon, enriched)
 */
ipcMain.handle('epic:getUpcomingReleases', async () => {
  try {
    console.log('[Epic IPC] getUpcomingReleases');
    return await epicAPI.getUpcomingReleases();
  } catch (error) {
    console.error('[Epic IPC] Error fetching upcoming releases:', error);
    return [];
  }
});

/**
 * Browse the full Epic catalog (paginated, no date filter — returns 200+ games)
 */
ipcMain.handle('epic:browseCatalog', async (_event, limit: number = 0) => {
  try {
    console.log(`[Epic IPC] browseCatalog (limit ${limit || 'ALL'})`);
    return await epicAPI.browseCatalog(limit);
  } catch (error) {
    console.error('[Epic IPC] Error browsing catalog:', error);
    return [];
  }
});

/**
 * Get cover URL for an Epic game (returns cached image URL or null)
 */
ipcMain.handle('epic:getCoverUrl', async (_event, namespace: string, offerId: string) => {
  return epicAPI.getCoverUrl(namespace, offerId);
});

/**
 * Clear Epic API cache
 */
ipcMain.handle('epic:clearCache', async () => {
  epicAPI.clearCache();
  return true;
});

/**
 * Get Epic cache statistics
 */
ipcMain.handle('epic:getCacheStats', async () => {
  return epicAPI.getCacheStats();
});

/**
 * Get rich product page content (full About description + system requirements)
 * from the Epic CMS REST endpoint.
 */
ipcMain.handle('epic:getProductContent', async (_event, slug: string) => {
  try {
    return await epicAPI.getProductContent(slug);
  } catch (error) {
    console.error('[Epic IPC] getProductContent error:', error);
    return null;
  }
});

// ============================================================================
// RSS FEED IPC HANDLERS (Gaming news sites)
// ============================================================================

/** RSS feed sources for gaming news. */
const RSS_FEEDS = [
  { url: 'https://www.pcgamer.com/rss/', source: 'PC Gamer' },
  { url: 'https://www.rockpapershotgun.com/feed', source: 'Rock Paper Shotgun' },
  { url: 'https://www.eurogamer.net/feed', source: 'Eurogamer' },
  { url: 'https://feeds.feedburner.com/ign/all', source: 'IGN' },
  { url: 'https://feeds.arstechnica.com/arstechnica/gaming', source: 'Ars Technica' },
];

/**
 * Minimal RSS/Atom XML parser using regex.
 * Extracts title, link, description, pubDate, and first image from each item.
 */
function parseRSSItems(xml: string, source: string, limit: number): Array<{
  id: string;
  title: string;
  summary: string;
  url: string;
  imageUrl?: string;
  publishedAt: number;
  source: string;
}> {
  const items: Array<{
    id: string;
    title: string;
    summary: string;
    url: string;
    imageUrl?: string;
    publishedAt: number;
    source: string;
  }> = [];

  // Match RSS <item> or Atom <entry> blocks
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>|<entry[\s>]([\s\S]*?)<\/entry>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
    const block = match[1] || match[2] || '';

    // Title
    const titleMatch = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(block);
    const title = (titleMatch?.[1] ?? '').replace(/<[^>]+>/g, '').trim();
    if (!title) continue;

    // Link — RSS uses <link>url</link>, Atom uses <link href="url"/>
    let url = '';
    const linkHrefMatch = /<link[^>]+href=["']([^"']+)["']/i.exec(block);
    const linkTextMatch = /<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i.exec(block);
    const guidMatch = /<guid[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/guid>/i.exec(block);
    url = linkHrefMatch?.[1] || linkTextMatch?.[1]?.trim() || guidMatch?.[1]?.trim() || '';
    if (!url) continue;

    // Description / summary / content
    const descMatch =
      /<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i.exec(block) ||
      /<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/i.exec(block) ||
      /<content[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/i.exec(block);
    const rawDesc = descMatch?.[1] ?? '';

    // Extract image from description HTML or media tags
    let imageUrl: string | undefined;
    const mediaMatch =
      /<media:content[^>]+url=["']([^"']+)["']/i.exec(block) ||
      /<media:thumbnail[^>]+url=["']([^"']+)["']/i.exec(block) ||
      /<enclosure[^>]+url=["']([^"']+\.(?:jpg|jpeg|png|gif|webp)[^"']*)["']/i.exec(block) ||
      /<img[^>]+src=["']([^"']+)["']/i.exec(rawDesc) ||
      /<img[^>]+src=["']([^"']+)["']/i.exec(block);
    if (mediaMatch) imageUrl = mediaMatch[1].replace(/&amp;/g, '&');

    // Strip HTML from description for summary text
    const summary = rawDesc
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);

    // Published date
    const dateMatch =
      /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i.exec(block) ||
      /<published[^>]*>([\s\S]*?)<\/published>/i.exec(block) ||
      /<updated[^>]*>([\s\S]*?)<\/updated>/i.exec(block) ||
      /<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i.exec(block);
    const dateStr = dateMatch?.[1]?.trim() ?? '';
    const publishedAt = dateStr ? Math.floor(new Date(dateStr).getTime() / 1000) : Math.floor(Date.now() / 1000);

    // Generate a stable ID from URL
    const id = `rss-${source.toLowerCase().replace(/\s+/g, '-')}-${Buffer.from(url).toString('base64url').slice(0, 16)}`;

    items.push({
      id,
      title,
      summary,
      url,
      imageUrl,
      publishedAt: isNaN(publishedAt) ? Math.floor(Date.now() / 1000) : publishedAt,
      source,
    });
  }

  return items;
}

/**
 * Fetch RSS feeds from gaming news sites.
 * Runs in the main process to avoid CORS issues.
 */
ipcMain.handle('news:getRSSFeeds', async () => {
  try {
    console.log(`[News] Fetching RSS feeds from ${RSS_FEEDS.length} sources`);
    const allItems: Array<{
      id: string;
      title: string;
      summary: string;
      url: string;
      imageUrl?: string;
      publishedAt: number;
      source: string;
    }> = [];

    const promises = RSS_FEEDS.map(async ({ url, source }) => {
      try {
        const response = await net.fetch(url, {
          headers: {
            'User-Agent': 'ArkGameTracker/1.0 (Electron Desktop App)',
            'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          },
        });
        if (!response.ok) {
          console.warn(`[News] RSS ${source} returned ${response.status}`);
          return;
        }
        const xml = await response.text();
        const items = parseRSSItems(xml, source, 10);
        allItems.push(...items);
        console.log(`[News] RSS ${source}: got ${items.length} items`);
      } catch (err) {
        console.warn(`[News] RSS ${source} failed:`, err);
      }
    });

    await Promise.allSettled(promises);
    console.log(`[News] RSS total: ${allItems.length} items from all feeds`);
    return allItems;
  } catch (error) {
    console.error('[News] RSS fetch error:', error);
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
// PROXY FETCH IPC HANDLER
// ============================================================================
// Generic HTML fetcher routed through the main process so renderer-side code
// is not blocked by CORS.  Restricted to a domain allowlist for security.

const PROXY_FETCH_ALLOWED_DOMAINS = [
  'fitgirl-repacks.site',
];

ipcMain.handle('proxy:fetchHtml', async (_event, url: string) => {
  try {
    const parsed = new URL(url);
    const allowed = PROXY_FETCH_ALLOWED_DOMAINS.some(
      d => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`),
    );
    if (!allowed) {
      console.warn(`[Proxy] Blocked fetch to disallowed domain: ${parsed.hostname}`);
      return null;
    }

    // Use Node.js https directly so we can set rejectUnauthorized: false
    // for sites with self-signed / intermediate certificate issues.
    const html = await new Promise<string | null>((resolve) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        rejectUnauthorized: false,
      }, (res) => {
        if (!res.statusCode || res.statusCode >= 400) { resolve(null); res.resume(); return; }
        // Follow redirects (301/302)
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          https.get(res.headers.location, { rejectUnauthorized: false }, (rRes) => {
            let data = '';
            rRes.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            rRes.on('end', () => resolve(data));
            rRes.on('error', () => resolve(null));
          }).on('error', () => resolve(null));
          res.resume();
          return;
        }
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve(data));
        res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    });
    return html;
  } catch (error) {
    console.error('[Proxy] fetchHtml error:', error);
    return null;
  }
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

ipcMain.handle('settings:getAutoLaunch', async () => {
  try {
    return settingsStore.getAutoLaunch();
  } catch (error) {
    console.error('[Settings] Error getting auto-launch setting:', error);
    return true; // Default to enabled
  }
});

ipcMain.handle('settings:setAutoLaunch', async (_event, enabled: boolean) => {
  try {
    settingsStore.setAutoLaunch(enabled);
    return { success: true };
  } catch (error) {
    console.error('[Settings] Error setting auto-launch:', error);
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
ipcMain.handle('session:setTrackedGames', async (_event, games: Array<{ gameId: string; executablePath: string }>) => {
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
// WEBCONTENTSVIEW-BASED INLINE WEBVIEW
// ============================================================================

let activeWebContentsView: any = null;

function destroyWebContentsView() {
  if (!activeWebContentsView || !mainWindow) return;
  try { mainWindow.contentView.removeChildView(activeWebContentsView); } catch { /* already removed */ }
  try { activeWebContentsView.webContents.close(); } catch { /* ignore */ }
  activeWebContentsView = null;
}

ipcMain.handle('webview:open', async (_event, url: string, bounds: { x: number; y: number; width: number; height: number }) => {
  if (!mainWindow) return { success: false };
  destroyWebContentsView();

  activeWebContentsView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.contentView.addChildView(activeWebContentsView);
  activeWebContentsView.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  });

  const wc = activeWebContentsView.webContents;

  // Forward lifecycle events to the renderer
  wc.on('did-start-loading', () => mainWindow?.webContents.send('webview:loading', true));
  wc.on('did-stop-loading', () => mainWindow?.webContents.send('webview:loading', false));
  wc.on('page-title-updated', (_e: any, title: string) => mainWindow?.webContents.send('webview:title', title));
  wc.on('did-fail-load', (_e: any, code: number, desc: string, _u: string, isMain: boolean) => {
    if (!isMain || code === -3) return;
    mainWindow?.webContents.send('webview:error', desc || 'Failed to load page');
  });
  const sendNavState = () => {
    try {
      mainWindow?.webContents.send('webview:nav-state', {
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      });
    } catch { /* ignore */ }
  };
  wc.on('did-navigate', sendNavState);
  wc.on('did-navigate-in-page', sendNavState);

  // Hide scrollbars on every page load
  const hideScrollbars = () => {
    wc.insertCSS('::-webkit-scrollbar { display: none !important; } html, body { scrollbar-width: none !important; }').catch(() => {});
  };
  wc.on('dom-ready', hideScrollbars);

  // External links open in OS browser
  wc.setWindowOpenHandler(({ url: target }: { url: string }) => {
    if (target.startsWith('http:') || target.startsWith('https:')) {
      shell.openExternal(target);
    }
    return { action: 'deny' as const };
  });

  wc.loadURL(url);
  return { success: true };
});

ipcMain.handle('webview:close', async () => destroyWebContentsView());

ipcMain.handle('webview:resize', async (_event, bounds: { x: number; y: number; width: number; height: number }) => {
  if (activeWebContentsView) {
    activeWebContentsView.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  }
});

ipcMain.handle('webview:go-back', async () => {
  if (activeWebContentsView?.webContents.navigationHistory.canGoBack()) activeWebContentsView.webContents.navigationHistory.goBack();
});

ipcMain.handle('webview:go-forward', async () => {
  if (activeWebContentsView?.webContents.navigationHistory.canGoForward()) activeWebContentsView.webContents.navigationHistory.goForward();
});

ipcMain.handle('webview:reload', async () => {
  activeWebContentsView?.webContents.reload();
});

ipcMain.handle('webview:open-external', async (_event, url: string) => {
  shell.openExternal(url);
});

// ============================================================================
// APP LIFECYCLE
// ============================================================================

app.whenReady().then(async () => {
  // Apply auto-launch setting on startup
  try {
    const autoLaunchEnabled = settingsStore.getAutoLaunch();
    app.setLoginItemSettings({
      openAtLogin: autoLaunchEnabled,
      args: autoLaunchEnabled ? ['--hidden'] : [],
    });
    console.log(`[Startup] Auto-launch is ${autoLaunchEnabled ? 'enabled' : 'disabled'}`);
  } catch (err) {
    console.warn('[Startup] Failed to apply auto-launch setting:', err);
  }

  // Initialize ad blocker using core engine + session.webRequest (compatible with all Electron versions)
  try {
    const cachePath = path.join(app.getPath('userData'), 'adblocker-engine.bin');
    let engine: FiltersEngine;

    // Try loading from cache first for fast startup
    if (fs.existsSync(cachePath)) {
      const buf = await fs.promises.readFile(cachePath);
      engine = FiltersEngine.deserialize(buf);
      console.log('[AdBlocker] Loaded engine from cache');
    } else {
      // Download filter lists (EasyList + EasyPrivacy)
      const lists = await Promise.all([
        fetch('https://easylist.to/easylist/easylist.txt').then((r: any) => r.text()),
        fetch('https://easylist.to/easylist/easyprivacy.txt').then((r: any) => r.text()),
      ]);
      engine = FiltersEngine.parse(lists.join('\n'));
      // Cache for faster startup next time
      await fs.promises.writeFile(cachePath, Buffer.from(engine.serialize()));
      console.log('[AdBlocker] Downloaded filter lists and cached engine');
    }

    // Block matching network requests via session.webRequest
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details: any, callback: any) => {
      const { url, resourceType, referrer } = details;
      // Don't block the main page navigation itself
      if (resourceType === 'mainFrame') {
        callback({ cancel: false });
        return;
      }
      const request = Request.fromRawDetails({ url, type: resourceType || 'other', sourceUrl: referrer || '' });
      const { match } = engine.match(request);
      if (match) {
        callback({ cancel: true });
      } else {
        callback({ cancel: false });
      }
    });

    console.log('[AdBlocker] Initialized and enabled');
  } catch (err) {
    console.warn('[AdBlocker] Failed to initialize (non-fatal):', err);
  }

  try {
    createWindow();
  } catch (err) {
    logStartupError(err);
    app.quit();
  }

  // ---- Epic Cloudflare clearance (background, non-blocking) ----
  // Epic's GraphQL API is behind Cloudflare JS challenge.  We solve it once
  // at startup using a hidden BrowserWindow so all Epic catalog queries work.
  epicAPI.initCloudflare().then(ok => {
    if (ok) console.log('[Startup] Epic Cloudflare clearance ready');
    else console.warn('[Startup] Epic Cloudflare clearance failed — REST fallback active');
  }).catch(() => {});

  // ---- System Tray ----
  try {
    // Build candidate list for the tray icon.
    // Prefer the pre-made 16×16 PNG (exact tray size, no resize needed).
    // Avoid .ico — Electron's nativeImage.createFromPath + resize can produce
    // a blank image from multi-size ICO files on Windows.
    const candidates: string[] = [];
    const projectRoot = path.join(__dirname, '../..');

    if (app.isPackaged) {
      // extraResources copies icons to <resourcesPath>/icons/
      const iconsDir = path.join(process.resourcesPath, 'icons');
      candidates.push(
        path.join(iconsDir, 'icon-16.png'),   // exact tray size — no resize needed
        path.join(iconsDir, 'icon-32.png'),
        path.join(iconsDir, 'icon-256.png'),
      );
    } else {
      candidates.push(
        path.join(projectRoot, 'build', 'icon-16.png'),
        path.join(projectRoot, 'build', 'icon-32.png'),
        path.join(projectRoot, 'build', 'icon.png'),
        path.join(projectRoot, 'build', 'icon-256.png'),
      );
    }

    let iconPath = candidates.find((p) => fs.existsSync(p));
    console.log('[Tray] Icon candidates:', candidates, '| resolved:', iconPath);

    let trayIcon;
    if (iconPath) {
      const raw = nativeImage.createFromPath(iconPath);
      const size = raw.getSize();
      console.log('[Tray] Loaded icon:', iconPath, '| size:', size.width, 'x', size.height, '| empty:', raw.isEmpty());
      // Only resize if the image isn't already 16×16
      trayIcon = (size.width === 16 && size.height === 16) ? raw : raw.resize({ width: 16, height: 16 });
    } else {
      console.warn('[Tray] No icon file found in any candidate path - using empty icon');
      trayIcon = nativeImage.createEmpty();
    }

    tray = new Tray(trayIcon);
    tray.setToolTip('Ark');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Ark',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);

    tray.setContextMenu(contextMenu);

    // Double-click to show window
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });

    console.log('[Tray] System tray initialized');
  } catch (err) {
    console.warn('[Tray] Failed to create system tray (non-fatal):', err);
  }
});

// Set isQuitting flag before quit so close interceptor lets through
app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  // Don't quit on window-all-closed; app stays in tray
  // Only stop session tracker if actually quitting
  if (isQuitting) {
    stopSessionTracker();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});
