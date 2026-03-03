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

interface FileDialogSaveImageOptions {
  dataUrl: string;
  defaultName?: string;
}

interface FileDialogAPI {
  saveFile: (options: FileDialogSaveOptions) => Promise<FileDialogSaveResult>;
  openFile: (options?: FileDialogOpenOptions) => Promise<FileDialogOpenResult>;
  selectExecutable: () => Promise<FileDialogSelectExecutableResult>;
  saveImage: (options: FileDialogSaveImageOptions) => Promise<FileDialogSaveResult>;
}

// Electron API types (exposed via Electron preload)
interface ElectronAPI {
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onMaximizedChange?: (cb: (maximized: boolean) => void) => (() => void);
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
  /** Fetch HTML from a URL via the main process (bypasses CORS). Domain-restricted. */
  fetchHtml: (url: string) => Promise<string | null>;
}

// Session Tracker API types (exposed via Electron preload)
interface SessionTrackerAPI {
  setTrackedGames: (games: Array<{ gameId: string; executablePath: string }>) => Promise<{ success: boolean }>;
  getActiveSessions: () => Promise<Array<{ gameId: string; startTime: string; elapsedMinutes: number }>>;
  onStatusChange: (callback: (data: { gameId: string; status: string }) => void) => () => void;
  onSessionStarted: (callback: (data: { gameId: string; startTime: string }) => void) => () => void;
  onLiveUpdate: (callback: (data: { gameId: string; activeMinutes: number }) => void) => () => void;
  onSessionEnded: (callback: (data: { gameId: string; session: import('@/types/game').GameSession }) => void) => () => void;
  removeAllListeners: () => void;
}

// News API types (exposed via Electron preload)
interface RSSFeedItem {
  id: string;
  title: string;
  summary: string;
  url: string;
  imageUrl?: string;
  publishedAt: number;
  source: string;
}

interface NewsAPI {
  getRSSFeeds: () => Promise<RSSFeedItem[]>;
}

// BrowserView-based inline webview API (exposed via Electron preload)
interface WebviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WebviewAPI {
  open: (url: string, bounds: WebviewBounds) => Promise<{ success: boolean }>;
  close: () => Promise<void>;
  resize: (bounds: WebviewBounds) => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  reload: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  onLoading: (callback: (loading: boolean) => void) => () => void;
  onTitle: (callback: (title: string) => void) => () => void;
  onError: (callback: (error: string) => void) => () => void;
  onNavState: (callback: (state: { canGoBack: boolean; canGoForward: boolean }) => void) => () => void;
}

interface AnalyticsAPI {
  trackEvent: (name: string, params?: Record<string, string | number | boolean>) => Promise<boolean>;
  trackPageView: (page: string) => Promise<boolean>;
}

interface MLUserProfile {
  u_rec_rate: number;
  u_avg_hours: number;
  u_std_hours: number;
  u_n_reviews: number;
  u_avg_helpful: number;
  u_avg_funny: number;
  u_pct_high_hours: number;
  log_products: number;
  log_user_rev: number;
}

interface MLScoreResult {
  gameId: string;
  score: number;
}

interface MLModelAPI {
  load: () => Promise<boolean>;
  status: () => Promise<{
    loaded: boolean;
    modelCount: number;
    gameProfileCount: number;
    tagCount: number;
  }>;
  scoreGames: (userProfile: MLUserProfile, gameIds: string[]) => Promise<MLScoreResult[]>;
  buildUserProfile: (
    games: Array<{ gameId: string; hoursPlayed: number; rating: number; status: string }>,
  ) => Promise<MLUserProfile | null>;
  getGameRecRates: (gameIds: string[]) => Promise<Record<string, number>>;
}

interface DevJournalDay {
  date: string;
  title: string;
  tags: string[];
  narrative: string;
  filesChanged: string[];
  milestones: string[];
  challenges: string[];
  lookingAhead: string | null;
}

interface DevJournalData {
  project: string;
  days: DevJournalDay[];
}

interface DevLogAPI {
  getJournal: () => Promise<DevJournalData | null>;
}

interface ScrapedEventData {
  id: string;
  startDate?: number;
  endDate?: number;
  youtubeUrls: string[];
  twitchUrls: string[];
  scrapedAt: number;
}

interface EventScraperAPI {
  scrapeAll: (events: Array<{ id: string; url?: string }>) => Promise<Record<string, ScrapedEventData>>;
  clearCache: () => Promise<{ success: boolean }>;
}

declare global {
  // Build-time constant injected by Vite from package.json (see vite.config.ts `define`)
  const __APP_VERSION__: string;

  interface Window {
    fileDialog?: FileDialogAPI;
    electron?: ElectronAPI;
    sessionTracker?: SessionTrackerAPI;
    newsApi?: NewsAPI;
    webviewApi?: WebviewAPI;
    analytics?: AnalyticsAPI;
    ml?: MLModelAPI;
    devlog?: DevLogAPI;
    eventScraper?: EventScraperAPI;
  }
}

export {};