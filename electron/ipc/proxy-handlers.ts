/**
 * Proxy Fetch IPC Handler
 * Generic HTML fetcher routed through the main process so renderer-side code
 * is not blocked by CORS. Uses Electron's net.fetch (Chromium network stack)
 * to transparently handle Cloudflare challenges, corporate proxies, and TLS.
 * Restricted to a domain allowlist for security.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { logger } from '../safe-logger.js';

const PROXY_FETCH_ALLOWED_DOMAINS = [
  'fitgirl-repacks.site',
];

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MB

function isDomainAllowed(hostname: string): boolean {
  return PROXY_FETCH_ALLOWED_DOMAINS.some(
    d => hostname === d || hostname.endsWith(`.${d}`),
  );
}

async function fetchWithElectronNet(targetUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const fetchFn: typeof globalThis.fetch =
      electron?.net?.fetch ?? globalThis.fetch;

    const res = await fetchFn(targetUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
      signal: controller.signal,
    } as any);

    // Validate redirect target (Chromium follows automatically, check final URL)
    if (res.url && res.url !== targetUrl) {
      try {
        const finalParsed = new URL(res.url);
        if (!isDomainAllowed(finalParsed.hostname)) {
          logger.warn(`[Proxy] Blocked redirect to disallowed domain: ${finalParsed.hostname}`);
          return null;
        }
      } catch {
        // URL parsing failed — allow (Chromium already resolved it)
      }
    }

    if (!res.ok) {
      logger.warn(`[Proxy] HTTP ${res.status} for ${targetUrl}`);
      return null;
    }

    const text = await res.text();
    if (text.length > MAX_RESPONSE_SIZE) {
      logger.warn(`[Proxy] Response exceeded ${MAX_RESPONSE_SIZE} bytes — discarding`);
      return null;
    }
    return text;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      logger.warn(`[Proxy] Request timed out: ${targetUrl}`);
    } else {
      logger.error(`[Proxy] Fetch error for ${targetUrl}:`, err?.message || err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function register(): void {
  ipcMain.handle('proxy:fetchHtml', async (_event: any, url: string) => {
    try {
      if (typeof url !== 'string' || url.length > 2000) return null;
      const parsed = new URL(url);
      if (!isDomainAllowed(parsed.hostname)) {
        logger.warn(`[Proxy] Blocked fetch to disallowed domain: ${parsed.hostname}`);
        return null;
      }
      logger.log(`[Proxy] Fetching: ${url}`);
      const html = await fetchWithElectronNet(url);
      if (html) {
        logger.log(`[Proxy] Success: ${url} (${html.length} bytes)`);
      }
      return html;
    } catch (error) {
      logger.error('[Proxy] fetchHtml error:', error);
      return null;
    }
  });
}
