const { contextBridge, ipcRenderer } = require('electron');

// Expose window controls to renderer
contextBridge.exposeInMainWorld('electron', {
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  // Open URL in default OS browser
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  // Proxy fetch — routes HTTP requests through the main process to bypass CORS.
  // Only allowed for whitelisted domains (see main.ts PROXY_FETCH_ALLOWED_DOMAINS).
  fetchHtml: (url) => ipcRenderer.invoke('proxy:fetchHtml', url),
});

// Steam CDN base URL for constructing image URLs client-side
const STEAM_CDN_BASE = 'https://cdn.akamai.steamstatic.com/steam/apps';

// Expose Steam API to renderer
contextBridge.exposeInMainWorld('steam', {
  // Get top 100 most played games
  getMostPlayedGames: () => 
    ipcRenderer.invoke('steam:getMostPlayedGames'),
  
  // Get details for a single game
  getAppDetails: (appId) => 
    ipcRenderer.invoke('steam:getAppDetails', appId),
  
  // Get details for multiple games (batched)
  getMultipleAppDetails: (appIds) => 
    ipcRenderer.invoke('steam:getMultipleAppDetails', appIds),
  
  // Search games by title
  searchGames: (query, limit) => 
    ipcRenderer.invoke('steam:searchGames', query, limit),
  
  // Get new releases
  getNewReleases: () => 
    ipcRenderer.invoke('steam:getNewReleases'),
  
  // Get top sellers
  getTopSellers: () => 
    ipcRenderer.invoke('steam:getTopSellers'),
  
  // Get coming soon games
  getComingSoon: () => 
    ipcRenderer.invoke('steam:getComingSoon'),
  
  // Get featured categories
  getFeaturedCategories: () => 
    ipcRenderer.invoke('steam:getFeaturedCategories'),
  
  // Get game reviews
  getGameReviews: (appId, limit) => 
    ipcRenderer.invoke('steam:getGameReviews', appId, limit),
  
  // Get queue status for rate limiting
  getQueueStatus: () => 
    ipcRenderer.invoke('steam:getQueueStatus'),
  
  // Clear cache
  clearCache: () => 
    ipcRenderer.invoke('steam:clearCache'),
  
  // Prefetch game details in background (for faster navigation)
  prefetchGameDetails: (appIds) => 
    ipcRenderer.invoke('steam:prefetchGameDetails', appIds),
  
  // Check if a game's details are cached
  isCached: (appId) => 
    ipcRenderer.invoke('steam:isCached', appId),
  
  // Get cache statistics
  getCacheStats: () => 
    ipcRenderer.invoke('steam:getCacheStats'),
  
  // Get cached game names for multiple app IDs (returns Map of appId -> name)
  getCachedGameNames: (appIds) => 
    ipcRenderer.invoke('steam:getCachedGameNames', appIds),
  
  // Get news for a specific game
  getNewsForApp: (appId, count) =>
    ipcRenderer.invoke('steam:getNewsForApp', appId, count),

  // Get current player count for a single game
  getPlayerCount: (appId) =>
    ipcRenderer.invoke('steam:getPlayerCount', appId),

  // Get current player counts for multiple games (batched)
  getMultiplePlayerCounts: (appIds) =>
    ipcRenderer.invoke('steam:getMultiplePlayerCounts', appIds),

  // Get full Steam app list (for Catalog A–Z browsing)
  getAppList: () =>
    ipcRenderer.invoke('steam:getAppList'),

  // Get game recommendations based on current game and library
  getRecommendations: (currentAppId, libraryAppIds, limit) => 
    ipcRenderer.invoke('steam:getRecommendations', currentAppId, libraryAppIds, limit),

  // Get upcoming releases (coming soon + new releases with enriched details)
  getUpcomingReleases: () =>
    ipcRenderer.invoke('steam:getUpcomingReleases'),
  
  // Helper: Get cover image URL (600x900 vertical)
  getCoverUrl: (appId) => 
    `${STEAM_CDN_BASE}/${appId}/library_600x900.jpg`,
  
  // Helper: Get header image URL (460x215 horizontal)
  getHeaderUrl: (appId) => 
    `${STEAM_CDN_BASE}/${appId}/header.jpg`,
});

// Expose Epic Games Store API to renderer
contextBridge.exposeInMainWorld('epic', {
  // Search games by keyword
  searchGames: (query, limit) =>
    ipcRenderer.invoke('epic:searchGames', query, limit),

  // Get details for a single game by namespace + offerId
  getGameDetails: (namespace, offerId) =>
    ipcRenderer.invoke('epic:getGameDetails', namespace, offerId),

  // Get new releases
  getNewReleases: () =>
    ipcRenderer.invoke('epic:getNewReleases'),

  // Get coming soon games
  getComingSoon: () =>
    ipcRenderer.invoke('epic:getComingSoon'),

  // Get current free games
  getFreeGames: () =>
    ipcRenderer.invoke('epic:getFreeGames'),

  // Get upcoming releases (combined new + coming soon, enriched)
  getUpcomingReleases: () =>
    ipcRenderer.invoke('epic:getUpcomingReleases'),

  // Get cover image URL for a game (returns cached URL or null)
  // Browse full Epic catalog (paginated)
  browseCatalog: (limit) =>
    ipcRenderer.invoke('epic:browseCatalog', limit),

  getCoverUrl: (namespace, offerId) =>
    ipcRenderer.invoke('epic:getCoverUrl', namespace, offerId),

  // Clear Epic cache
  clearCache: () =>
    ipcRenderer.invoke('epic:clearCache'),

  // Get cache statistics
  getCacheStats: () =>
    ipcRenderer.invoke('epic:getCacheStats'),

  // Get rich product content (full description + system requirements)
  getProductContent: (slug) =>
    ipcRenderer.invoke('epic:getProductContent', slug),

  // Get news/blog articles related to a game
  getNewsFeed: (keyword, limit) =>
    ipcRenderer.invoke('epic:getNewsFeed', keyword, limit),

  // Get product reviews for a game
  getProductReviews: (slug) =>
    ipcRenderer.invoke('epic:getProductReviews', slug),

  // Get DLC/add-ons by namespace
  getAddons: (namespace, limit) =>
    ipcRenderer.invoke('epic:getAddons', namespace, limit),
});

// Expose Metacritic API to renderer
contextBridge.exposeInMainWorld('metacritic', {
  // Get game reviews from Metacritic
  getGameReviews: (gameName) => 
    ipcRenderer.invoke('metacritic:getGameReviews', gameName),
  
  // Clear Metacritic cache
  clearCache: () => 
    ipcRenderer.invoke('metacritic:clearCache'),
});

// Expose AI Chat API to renderer
contextBridge.exposeInMainWorld('aiChat', {
  // Send a message to the AI
  sendMessage: (request) => 
    ipcRenderer.invoke('ai:sendMessage', request),
  
  // Subscribe to streaming chunks
  onStreamChunk: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('ai:streamChunk', handler);
    // Return unsubscribe function
    return () => ipcRenderer.removeListener('ai:streamChunk', handler);
  },
  
  // Get chat history
  getHistory: () => 
    ipcRenderer.invoke('ai:getHistory'),
  
  // Get active conversation
  getActiveConversation: () => 
    ipcRenderer.invoke('ai:getActiveConversation'),
  
  // Create a new conversation
  createNewConversation: () => 
    ipcRenderer.invoke('ai:createNewConversation'),
  
  // Clear chat history
  clearHistory: () => 
    ipcRenderer.invoke('ai:clearHistory'),
  
  // Search games for context selection
  searchGamesForContext: (query) => 
    ipcRenderer.invoke('ai:searchGamesForContext', query),
});

// Expose Settings API to renderer
contextBridge.exposeInMainWorld('settings', {
  // Get the Google AI API key
  getApiKey: () => 
    ipcRenderer.invoke('settings:getApiKey'),
  
  // Set the Google AI API key
  setApiKey: (key) => 
    ipcRenderer.invoke('settings:setApiKey', key),
  
  // Remove the Google AI API key
  removeApiKey: () => 
    ipcRenderer.invoke('settings:removeApiKey'),
  
  // Check if API key exists
  hasApiKey: () => 
    ipcRenderer.invoke('settings:hasApiKey'),
  
  // Get Ollama settings
  getOllamaSettings: () => 
    ipcRenderer.invoke('settings:getOllamaSettings'),
  
  // Set Ollama settings
  setOllamaSettings: (settings) => 
    ipcRenderer.invoke('settings:setOllamaSettings', settings),

  // Get auto-launch setting
  getAutoLaunch: () =>
    ipcRenderer.invoke('settings:getAutoLaunch'),

  // Set auto-launch setting
  setAutoLaunch: (enabled) =>
    ipcRenderer.invoke('settings:setAutoLaunch', enabled),
});

// Expose auto-updater API to renderer
contextBridge.exposeInMainWorld('updater', {
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getVersion: () => ipcRenderer.invoke('updater:getVersion'),
  
  onChecking: (callback) => {
    ipcRenderer.on('updater:checking', () => callback());
  },
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('updater:update-available', (_event, info) => callback(info));
  },
  onUpdateNotAvailable: (callback) => {
    ipcRenderer.on('updater:update-not-available', (_event, info) => callback(info));
  },
  onDownloadProgress: (callback) => {
    ipcRenderer.on('updater:download-progress', (_event, progress) => callback(progress));
  },
  onUpdateDownloaded: (callback) => {
    ipcRenderer.on('updater:update-downloaded', (_event, info) => callback(info));
  },
  onError: (callback) => {
    ipcRenderer.on('updater:error', (_event, error) => callback(error));
  },
  onAutoDownload: (callback) => {
    ipcRenderer.on('updater:auto-download', (_event, info) => callback(info));
  },
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('updater:checking');
    ipcRenderer.removeAllListeners('updater:update-available');
    ipcRenderer.removeAllListeners('updater:update-not-available');
    ipcRenderer.removeAllListeners('updater:download-progress');
    ipcRenderer.removeAllListeners('updater:update-downloaded');
    ipcRenderer.removeAllListeners('updater:error');
    ipcRenderer.removeAllListeners('updater:auto-download');
  },
});

// Expose File Dialog API to renderer
contextBridge.exposeInMainWorld('fileDialog', {
  // Save content to file with native dialog
  saveFile: (options) => 
    ipcRenderer.invoke('dialog:saveFile', options),
  
  // Open and read file with native dialog
  openFile: (options) => 
    ipcRenderer.invoke('dialog:openFile', options),

  // Open native file explorer to select a game executable (returns path only)
  selectExecutable: () =>
    ipcRenderer.invoke('dialog:selectExecutable'),
});

// Expose Session Tracker API to renderer
contextBridge.exposeInMainWorld('sessionTracker', {
  // Send the list of games with executable paths to track
  setTrackedGames: (games) =>
    ipcRenderer.invoke('session:setTrackedGames', games),

  // Get currently active sessions
  getActiveSessions: () =>
    ipcRenderer.invoke('session:getActive'),

  // Subscribe to live status changes (Playing Now / Playing)
  onStatusChange: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('session:statusChange', handler);
    return () => ipcRenderer.removeListener('session:statusChange', handler);
  },

  // Subscribe to session start events
  onSessionStarted: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('session:started', handler);
    return () => ipcRenderer.removeListener('session:started', handler);
  },

  // Subscribe to live playtime updates (every poll tick while game is running)
  onLiveUpdate: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('session:liveUpdate', handler);
    return () => ipcRenderer.removeListener('session:liveUpdate', handler);
  },

  // Subscribe to completed session events
  onSessionEnded: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('session:ended', handler);
    return () => ipcRenderer.removeListener('session:ended', handler);
  },

  // Cleanup all listeners
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('session:statusChange');
    ipcRenderer.removeAllListeners('session:started');
    ipcRenderer.removeAllListeners('session:liveUpdate');
    ipcRenderer.removeAllListeners('session:ended');
  },
});

// Expose News API to renderer (RSS feeds from gaming news sites)
contextBridge.exposeInMainWorld('newsApi', {
  getRSSFeeds: () =>
    ipcRenderer.invoke('news:getRSSFeeds'),
});

// Expose BrowserView-based inline webview API
contextBridge.exposeInMainWorld('webviewApi', {
  open: (url, bounds) => ipcRenderer.invoke('webview:open', url, bounds),
  close: () => ipcRenderer.invoke('webview:close'),
  resize: (bounds) => ipcRenderer.invoke('webview:resize', bounds),
  goBack: () => ipcRenderer.invoke('webview:go-back'),
  goForward: () => ipcRenderer.invoke('webview:go-forward'),
  reload: () => ipcRenderer.invoke('webview:reload'),
  openExternal: (url) => ipcRenderer.invoke('webview:open-external', url),
  onLoading: (callback) => {
    const handler = (_event, loading) => callback(loading);
    ipcRenderer.on('webview:loading', handler);
    return () => ipcRenderer.removeListener('webview:loading', handler);
  },
  onTitle: (callback) => {
    const handler = (_event, title) => callback(title);
    ipcRenderer.on('webview:title', handler);
    return () => ipcRenderer.removeListener('webview:title', handler);
  },
  onError: (callback) => {
    const handler = (_event, error) => callback(error);
    ipcRenderer.on('webview:error', handler);
    return () => ipcRenderer.removeListener('webview:error', handler);
  },
  onNavState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('webview:nav-state', handler);
    return () => ipcRenderer.removeListener('webview:nav-state', handler);
  },
});

// Only log exposed APIs in development to avoid leaking IPC surface in production
if (process.env.NODE_ENV !== 'production') {
  console.log('Preload script loaded - window.steam, window.epic, window.metacritic, window.aiChat, window.settings, window.electron, window.updater, window.fileDialog, window.sessionTracker, window.newsApi, window.webviewApi exposed');
}
