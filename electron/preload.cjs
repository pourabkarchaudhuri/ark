const { contextBridge, ipcRenderer } = require('electron');

// Expose window controls to renderer
contextBridge.exposeInMainWorld('electron', {
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  // Open URL in default OS browser
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
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
  
  // Get game recommendations based on current game and library
  getRecommendations: (currentAppId, libraryAppIds, limit) => 
    ipcRenderer.invoke('steam:getRecommendations', currentAppId, libraryAppIds, limit),
  
  // Helper: Get cover image URL (600x900 vertical)
  getCoverUrl: (appId) => 
    `${STEAM_CDN_BASE}/${appId}/library_600x900.jpg`,
  
  // Helper: Get header image URL (460x215 horizontal)
  getHeaderUrl: (appId) => 
    `${STEAM_CDN_BASE}/${appId}/header.jpg`,
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
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('updater:checking');
    ipcRenderer.removeAllListeners('updater:update-available');
    ipcRenderer.removeAllListeners('updater:update-not-available');
    ipcRenderer.removeAllListeners('updater:download-progress');
    ipcRenderer.removeAllListeners('updater:update-downloaded');
    ipcRenderer.removeAllListeners('updater:error');
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
});

// Expose Installed Games API to renderer
contextBridge.exposeInMainWorld('installedGames', {
  // Get all installed games from the system
  getInstalled: (forceRefresh) => 
    ipcRenderer.invoke('games:getInstalled', forceRefresh),
  
  // Get array of installed Steam AppIDs for quick lookup
  getInstalledAppIds: () => 
    ipcRenderer.invoke('games:getInstalledAppIds'),
  
  // Clear the installed games cache
  clearCache: () => 
    ipcRenderer.invoke('games:clearInstalledCache'),
});

console.log('Preload script loaded - window.steam, window.metacritic, window.aiChat, window.settings, window.electron, window.updater, window.fileDialog and window.installedGames exposed');
