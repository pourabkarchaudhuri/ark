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

console.log('Preload script loaded - window.igdb and window.electron exposed');

