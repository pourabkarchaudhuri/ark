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

interface FileDialogSelectExecutableResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

interface FileDialogAPI {
  saveFile: (options: FileDialogSaveOptions) => Promise<FileDialogSaveResult>;
  openFile: (options?: FileDialogOpenOptions) => Promise<FileDialogOpenResult>;
  selectExecutable: () => Promise<FileDialogSelectExecutableResult>;
}

// Electron API types (exposed via Electron preload)
interface ElectronAPI {
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
}

// Session Tracker API types (exposed via Electron preload)
interface SessionTrackerAPI {
  setTrackedGames: (games: Array<{ gameId: number; executablePath: string }>) => Promise<{ success: boolean }>;
  getActiveSessions: () => Promise<Array<{ gameId: number; startTime: string; elapsedMinutes: number }>>;
  onStatusChange: (callback: (data: { gameId: number; status: string }) => void) => () => void;
  onSessionStarted: (callback: (data: { gameId: number; startTime: string }) => void) => () => void;
  onSessionEnded: (callback: (data: { gameId: number; session: import('@/types/game').GameSession }) => void) => () => void;
  removeAllListeners: () => void;
}

declare global {
  interface Window {
    fileDialog?: FileDialogAPI;
    electron?: ElectronAPI;
    sessionTracker?: SessionTrackerAPI;
  }
}

export {};