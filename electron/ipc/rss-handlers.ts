/**
 * RSS Feed IPC Handlers (Gaming news sites)
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain, net } = electron;
import { logger } from '../safe-logger.js';

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

export function register(): void {
  /**
   * Fetch RSS feeds from gaming news sites.
   * Runs in the main process to avoid CORS issues.
   */
  ipcMain.handle('news:getRSSFeeds', async () => {
    try {
      logger.log(`[News] Fetching RSS feeds from ${RSS_FEEDS.length} sources`);
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
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15000);
          const response = await net.fetch(url, {
            headers: {
              'User-Agent': 'ArkGameTracker/1.0 (Electron Desktop App)',
              'Accept': 'application/rss+xml, application/xml, text/xml, */*',
            },
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (!response.ok) {
            logger.warn(`[News] RSS ${source} returned ${response.status}`);
            return;
          }
          const xml = await response.text();
          const items = parseRSSItems(xml, source, 10);
          allItems.push(...items);
          logger.log(`[News] RSS ${source}: got ${items.length} items`);
        } catch (err) {
          logger.warn(`[News] RSS ${source} failed:`, err);
        }
      });

      await Promise.allSettled(promises);
      logger.log(`[News] RSS total: ${allItems.length} items from all feeds`);
      return allItems;
    } catch (error) {
      logger.error('[News] RSS fetch error:', error);
      return [];
    }
  });
}
