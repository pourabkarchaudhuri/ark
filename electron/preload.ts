import { contextBridge, ipcRenderer } from 'electron';

// Expose window controls to renderer
contextBridge.exposeInMainWorld('electron', {
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
});

// Expose IGDB API to renderer
contextBridge.exposeInMainWorld('igdb', {
  getPopularGames: (limit: number, offset: number) => 
    ipcRenderer.invoke('igdb:getPopularGames', limit, offset),
  searchGames: (query: string, limit: number) => 
    ipcRenderer.invoke('igdb:searchGames', query, limit),
  getGameById: (id: number) => 
    ipcRenderer.invoke('igdb:getGameById', id),
  getGamesByIds: (ids: number[]) => 
    ipcRenderer.invoke('igdb:getGamesByIds', ids),
  getGenres: () => 
    ipcRenderer.invoke('igdb:getGenres'),
  getPlatforms: () => 
    ipcRenderer.invoke('igdb:getPlatforms'),
  getQueueStatus: () => 
    ipcRenderer.invoke('igdb:getQueueStatus'),
  onRateLimitWarning: (callback: (queueSize: number) => void) => {
    ipcRenderer.on('igdb:rateLimitWarning', (_event, queueSize) => callback(queueSize));
  },
});

// Expose auto-updater API to renderer
contextBridge.exposeInMainWorld('updater', {
  // Check for updates manually
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  
  // Download the available update
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  
  // Quit and install the downloaded update
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  
  // Get current app version
  getVersion: () => ipcRenderer.invoke('updater:getVersion'),
  
  // Event listeners for update status
  onChecking: (callback: () => void) => {
    ipcRenderer.on('updater:checking', () => callback());
  },
  
  onUpdateAvailable: (callback: (info: { version: string; releaseDate?: string; releaseNotes?: string }) => void) => {
    ipcRenderer.on('updater:update-available', (_event, info) => callback(info));
  },
  
  onUpdateNotAvailable: (callback: (info: { version: string }) => void) => {
    ipcRenderer.on('updater:update-not-available', (_event, info) => callback(info));
  },
  
  onDownloadProgress: (callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) => {
    ipcRenderer.on('updater:download-progress', (_event, progress) => callback(progress));
  },
  
  onUpdateDownloaded: (callback: (info: { version: string; releaseDate?: string; releaseNotes?: string }) => void) => {
    ipcRenderer.on('updater:update-downloaded', (_event, info) => callback(info));
  },
  
  onError: (callback: (error: { message: string }) => void) => {
    ipcRenderer.on('updater:error', (_event, error) => callback(error));
  },
  
  // Remove all listeners (for cleanup)
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('updater:checking');
    ipcRenderer.removeAllListeners('updater:update-available');
    ipcRenderer.removeAllListeners('updater:update-not-available');
    ipcRenderer.removeAllListeners('updater:download-progress');
    ipcRenderer.removeAllListeners('updater:update-downloaded');
    ipcRenderer.removeAllListeners('updater:error');
  },
});

console.log('Preload script loaded - window.igdb, window.electron, and window.updater exposed');

