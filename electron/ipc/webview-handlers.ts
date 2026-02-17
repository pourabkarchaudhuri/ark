/**
 * WebContentsView-based Inline Webview IPC Handlers
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain, WebContentsView, shell } = electron;
import type { BrowserWindow as BrowserWindowType } from 'electron';
import { logger } from '../safe-logger.js';

let activeWebContentsView: any = null;

function destroyWebContentsView(mainWindow: BrowserWindowType | null) {
  if (!activeWebContentsView || !mainWindow) return;
  try { mainWindow.contentView.removeChildView(activeWebContentsView); } catch { /* already removed */ }
  try { activeWebContentsView.webContents.close(); } catch { /* ignore */ }
  activeWebContentsView = null;
}

function safeBounds(b: any): { x: number; y: number; width: number; height: number } | null {
  if (!b || typeof b !== 'object') return null;
  const x = Number(b.x); const y = Number(b.y);
  const w = Number(b.width); const h = Number(b.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w <= 0 || h <= 0) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

export function register(getMainWindow: () => BrowserWindowType | null): void {
  // Expose destroyWebContentsView for use in main.ts window cleanup
  (register as any).destroyWebContentsView = () => destroyWebContentsView(getMainWindow());

  ipcMain.handle('webview:open', async (_event: any, url: string, bounds: { x: number; y: number; width: number; height: number }) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return { success: false };
    const sb = safeBounds(bounds);
    if (!sb) { logger.warn('[Webview] Invalid bounds for open'); return { success: false }; }
    destroyWebContentsView(mainWindow);

    activeWebContentsView = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    mainWindow.contentView.addChildView(activeWebContentsView);
    activeWebContentsView.setBounds(sb);

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
      wc.insertCSS('::-webkit-scrollbar { display: none !important; } html, body { scrollbar-width: none !important; }').catch((err: any) => { logger.warn('[Webview] CSS inject Non-fatal:', err); });
    };
    wc.on('dom-ready', hideScrollbars);

    // External links open in OS browser
    wc.setWindowOpenHandler(({ url: target }: { url: string }) => {
      if (target.startsWith('http:') || target.startsWith('https:')) {
        shell.openExternal(target);
      }
      return { action: 'deny' as const };
    });

    // Security: only allow http(s) URLs — block javascript:, file:, data:, etc.
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        logger.warn(`[Webview] Blocked URL with disallowed scheme: ${parsed.protocol}`);
        return { success: false, error: 'URL scheme not allowed' };
      }
    } catch {
      logger.warn(`[Webview] Blocked invalid URL: ${url}`);
      return { success: false, error: 'Invalid URL' };
    }

    wc.loadURL(url);
    return { success: true };
  });

  ipcMain.handle('webview:close', async () => destroyWebContentsView(getMainWindow()));

  ipcMain.handle('webview:resize', async (_event: any, bounds: { x: number; y: number; width: number; height: number }) => {
    const sb = safeBounds(bounds);
    if (!sb) return;
    if (activeWebContentsView) {
      activeWebContentsView.setBounds(sb);
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

  ipcMain.handle('webview:open-external', async (_event: any, url: string) => {
    // Security: apply the same protocol whitelist as the main shell:openExternal handler
    try {
      const parsed = new URL(url);
      const allowed = ['http:', 'https:', 'mailto:'];
      if (!allowed.includes(parsed.protocol)) {
        logger.warn(`[Webview] Blocked openExternal with disallowed protocol: ${parsed.protocol}`);
        return;
      }
    } catch {
      logger.warn(`[Webview] Blocked openExternal with invalid URL: ${url}`);
      return;
    }
    shell.openExternal(url);
  });
}
