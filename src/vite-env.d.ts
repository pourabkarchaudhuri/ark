/// <reference types="vite/client" />

// File Dialog API types (exposed via Electron preload)
interface FileDialogSaveOptions {
  content: string;
  defaultName?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

interface FileDialogOpenOptions {
  filters?: Array<{ name: string; extensions: string[] }>;
}

interface FileDialogSaveResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

interface FileDialogOpenResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  content?: string;
  error?: string;
}

interface FileDialogAPI {
  saveFile: (options: FileDialogSaveOptions) => Promise<FileDialogSaveResult>;
  openFile: (options?: FileDialogOpenOptions) => Promise<FileDialogOpenResult>;
}

// Installed Games API types (exposed via Electron preload)
interface InstalledGame {
  appId: number;
  name: string;
  installPath: string;
  platform: 'steam' | 'epic' | 'other';
  sizeOnDisk?: number;
}

interface InstalledGamesAPI {
  getInstalled: (forceRefresh?: boolean) => Promise<InstalledGame[]>;
  getInstalledAppIds: () => Promise<number[]>;
  clearCache: () => Promise<boolean>;
}

// Electron API types (exposed via Electron preload)
interface ElectronAPI {
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
}

declare global {
  interface Window {
    fileDialog?: FileDialogAPI;
    installedGames?: InstalledGamesAPI;
    electron?: ElectronAPI;
  }
}

export {};