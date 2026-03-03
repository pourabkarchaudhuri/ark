/**
 * News Service
 *
 * Aggregates gaming news from multiple free, keyless sources:
 *   1. Steam News API — news from the user's library games + trending Steam games
 *   2. RSS feeds — PC Gamer, Rock Paper Shotgun, Eurogamer, IGN, Ars Technica
 *
 * Game IDs are resolved dynamically at runtime — nothing is hardcoded.
 * All items are normalised into a common `NewsItem` interface, deduplicated,
 * sorted by date, and cached with a 10-minute TTL.
 */

import { steamService } from './steam-service';
import { libraryStore } from './library-store';
import { journeyStore } from './journey-store';
import { SteamNewsItem } from '@/types/steam';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  source: string;       // e.g. "Steam · Elden Ring", "PC Gamer"
  imageUrl?: string;
  url: string;
  publishedAt: number;  // Unix timestamp in seconds
  /** When multiple sources cover the same story (multiple relays). */
  relayCount?: number;
  relaySources?: { source: string; url: string }[];
  /** True when title/summary matches a game in the user's library. */
  isFromYourFleet?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Max number of game IDs to fetch Steam news for (keeps requests reasonable). */
const MAX_STEAM_NEWS_GAMES = 12;

/** Number of news articles fetched per game. */
const NEWS_PER_GAME = 3;

// ─── Cache ──────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let cache: {
  items: NewsItem[];
  fetchedAt: number;
} | null = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Decode all HTML entities (named + numeric decimal/hex). */
function decodeHTMLEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => { const cp = parseInt(hex, 16); return cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : m; })
    .replace(/&#(\d+);/g, (m, dec) => { const cp = Number(dec); return cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : m; })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rdquo;/g, '\u201C')
    .replace(/&ldquo;/g, '\u201D')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&hellip;/g, '\u2026');
}

/** Strip BBCode tags, HTML entities, and trim to maxLen characters. */
function stripBBCodeAndHTML(raw: string, maxLen: number = 150): string {
  let text = raw;
  // Remove [img]...[/img], [url]...[/url], and other BBCode tags
  text = text.replace(/\[img\].*?\[\/img\]/gi, '');
  text = text.replace(/\[url=.*?\](.*?)\[\/url\]/gi, '$1');
  text = text.replace(/\[\/?\w+.*?\]/g, '');
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, '');
  text = decodeHTMLEntities(text);
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > maxLen) {
    return text.slice(0, maxLen).replace(/\s+\S*$/, '') + '...';
  }
  return text;
}

const TRACKING_HOSTS = ['pixel.', 'track.', 'beacon.', 'analytics.', 'count.', 'stat.'];

function isValidImageUrl(url: string): boolean {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  if (url.startsWith('data:')) return false;
  if (url.length < 12 || url.length > 2048) return false;
  if (TRACKING_HOSTS.some((h) => url.includes(h))) return false;
  if (/[/.](?:1x1|pixel|spacer|blank|clear)\b/i.test(url)) return false;
  return true;
}

/** Extract the first valid image URL from BBCode/HTML content. */
function extractImageFromContent(contents: string): string | undefined {
  // Try [img] BBCode
  const bbMatch = /\[img\](https?:\/\/[^\[]+)\[\/img\]/i.exec(contents);
  if (bbMatch && isValidImageUrl(bbMatch[1])) return bbMatch[1];
  // Try <img src="..."> — collect all matches and pick the first valid one
  const imgMatches = contents.matchAll(/<img\b[^>]*src=["'](https?:\/\/[^"']+)["']/gi);
  for (const m of imgMatches) {
    if (isValidImageUrl(m[1])) return m[1];
  }
  // Try bare image URL
  const urlMatch = /(https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp))/i.exec(contents);
  if (urlMatch && isValidImageUrl(urlMatch[1])) return urlMatch[1];
  return undefined;
}

/** Get a Steam image URL for an appId. Uses header.jpg (460x215) — reliably exists for virtually all games. */
function getSteamImageUrl(appId: number): string {
  return `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`;
}

/** Get fallback Steam header image URL for an appId (460x215). */
export function getSteamHeaderUrl(appId: number): string {
  return `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`;
}

/**
 * Simple heuristic to check if a string is likely English.
 * Checks for high ratio of ASCII-latin characters vs non-latin scripts.
 */
/** Blocklist: non-English or irrelevant news feed sources (matched against feedlabel and URL). */
const BLOCKED_NEWS_FEEDS = ['gamemag.ru', 'gamemag'];

function isBlockedFeed(feedlabel: string, url: string): boolean {
  const label = feedlabel.toLowerCase();
  const link = url.toLowerCase();
  return BLOCKED_NEWS_FEEDS.some(b => label.includes(b) || link.includes(b));
}

function isLikelyEnglish(text: string): boolean {
  if (!text || text.length < 3) return true;
  // Remove URLs and common markup
  const clean = text.replace(/https?:\/\/\S+/g, '').replace(/[^a-zA-Z\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0600-\u06FF]/g, '');
  if (clean.length === 0) return true;
  // Count ASCII-latin characters (a-z, A-Z, and common accented)
  const latinCount = (clean.match(/[a-zA-Z\u00C0-\u024F]/g) || []).length;
  return latinCount / clean.length > 0.7;
}

// ─── Dynamic Game ID Resolution ─────────────────────────────────────────────

/**
 * Build a list of Steam app IDs to fetch news for, with human-readable names.
 *
 * Sources (in priority order, deduplicated):
 *   1. User's library games (most personal / relevant)
 *   2. Steam's current most-played games (trending)
 *
 * Returns up to MAX_STEAM_NEWS_GAMES entries.
 */
async function resolveNewsGameIds(): Promise<{ appId: number; name: string }[]> {
  const seen = new Set<number>();
  const result: { appId: number; name: string }[] = [];

  const addGame = (appId: number, name: string) => {
    if (appId <= 0 || seen.has(appId)) return;
    seen.add(appId);
    result.push({ appId, name });
  };

  // 1. User's library games — journey store has titles
  try {
    const libraryIds = libraryStore.getAllGameIds();
    for (const id of libraryIds) {
      if (result.length >= MAX_STEAM_NEWS_GAMES) break;
      // Extract numeric Steam appId — skip non-Steam entries
      const m = id.match(/^(?:steam-)?(\d+)$/);
      if (!m) continue;
      const numericId = Number(m[1]);
      const journeyEntry = journeyStore.getEntry(id);
      const name = journeyEntry?.title ?? `Game ${id}`;
      addGame(numericId, name);
    }
  } catch {
    // Non-critical
  }

  // 2. Steam most-played games (trending / popular right now)
  if (result.length < MAX_STEAM_NEWS_GAMES) {
    try {
      let trendingIds: number[] = [];

      // Try Electron IPC
      if (typeof window !== 'undefined' && window.steam?.getMostPlayedGames) {
        const mostPlayed = await window.steam.getMostPlayedGames();
        trendingIds = mostPlayed.map((g) => g.appid);
      }

      if (trendingIds.length > 0) {
        // Try to get names from Steam's cached game names
        let nameMap: Record<number, string> = {};
        try {
          if (window.steam?.getCachedGameNames) {
            nameMap = await window.steam.getCachedGameNames(trendingIds);
          }
        } catch {
          // Names are optional — we fall back to "Game {id}"
        }

        for (const id of trendingIds) {
          if (result.length >= MAX_STEAM_NEWS_GAMES) break;
          const name = nameMap[id] || `Game ${id}`;
          addGame(id, name);
        }
      }
    } catch {
      // Non-critical
    }
  }

  return result;
}

// ─── Fetchers ───────────────────────────────────────────────────────────────

/** Fetch news from Steam for dynamically resolved game IDs. */
async function fetchSteamNews(): Promise<NewsItem[]> {
  const gameIds = await resolveNewsGameIds();

  if (gameIds.length === 0) {
    console.warn('[NewsService] No game IDs resolved for Steam news');
    return [];
  }

  console.log(`[NewsService] Fetching Steam news for ${gameIds.length} games:`, gameIds.map((g) => g.name).join(', '));

  const results: NewsItem[] = [];

  // Fetch in parallel — NEWS_PER_GAME items per game
  const promises = gameIds.map(async ({ appId, name }) => {
    try {
      const items: SteamNewsItem[] = await steamService.getNewsForApp(appId, NEWS_PER_GAME);
      for (const item of items) {
        // Filter out blocked feeds and non-English articles
        if (isBlockedFeed(item.feedlabel, item.url)) continue;
        if (!isLikelyEnglish(item.title)) continue;

        // Prefer extracted image from content, then high-res hero, then header
        const contentImage = extractImageFromContent(item.contents ?? '');
        const imageUrl = contentImage || getSteamImageUrl(appId);
        results.push({
          id: `steam-${appId}-${item.gid}`,
          title: decodeHTMLEntities(item.title),
          summary: stripBBCodeAndHTML(item.contents ?? '', 500),
          source: `Steam \u00B7 ${name}`,
          imageUrl,
          // Also store fallback for when hero image doesn't exist
          url: item.url,
          publishedAt: item.date,
        });
      }
    } catch {
      // Non-critical — skip this game
    }
  });

  await Promise.allSettled(promises);
  return results;
}

// ─── RSS Feed Fetcher ────────────────────────────────────────────────────────

/** Fetch news from RSS feeds via Electron IPC (PC Gamer, RPS, Eurogamer, etc). */
async function fetchRSSNews(): Promise<NewsItem[]> {
  if (typeof window === 'undefined' || !window.newsApi?.getRSSFeeds) {
    return [];
  }

  try {
    const items = await window.newsApi.getRSSFeeds();
    return items
      .filter((item) => isLikelyEnglish(item.title))
      .map((item) => ({
        id: item.id,
        title: decodeHTMLEntities(item.title),
        summary: decodeHTMLEntities(item.summary),
        source: item.source,
        imageUrl: item.imageUrl,
        url: item.url,
        publishedAt: item.publishedAt,
      }));
  } catch (err) {
    console.warn('[NewsService] RSS feed fetch failed:', err);
    return [];
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch all gaming news from all sources. Returns cached data if fresh enough.
 * @param force  If true, bypasses cache and fetches fresh data.
 */
export async function fetchAllNews(force = false): Promise<NewsItem[]> {
  // Return cache if still fresh
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.items;
  }

  // Fetch from all sources in parallel
  const [steamItems, rssItems] = await Promise.allSettled([
    fetchSteamNews(),
    fetchRSSNews(),
  ]);

  const allItems: NewsItem[] = [
    ...(steamItems.status === 'fulfilled' ? steamItems.value : []),
    ...(rssItems.status === 'fulfilled' ? rssItems.value : []),
  ];

  // Group by normalised title (multiple relays); pick canonical (newest), attach relaySources
  const normaliseTitle = (t: string) => t.toLowerCase().trim().replace(/\s+/g, ' ');
  const byKey = new Map<string, NewsItem[]>();
  for (const item of allItems) {
    const key = normaliseTitle(item.title);
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push(item);
    byKey.set(key, list);
  }

  const deduped: NewsItem[] = [];
  for (const [, group] of byKey) {
    group.sort((a, b) => b.publishedAt - a.publishedAt);
    const canonical = { ...group[0] };
    if (!canonical.imageUrl) {
      const withImage = group.find((g) => g.imageUrl);
      if (withImage) canonical.imageUrl = withImage.imageUrl;
    }
    if (group.length > 1) {
      canonical.relayCount = group.length;
      canonical.relaySources = group.map((g) => ({ source: g.source, url: g.url }));
    }
    deduped.push(canonical);
  }

  // Sort by date, newest first
  deduped.sort((a, b) => b.publishedAt - a.publishedAt);

  // Library relevance: match title/summary to library game titles
  let libraryTitles: string[] = [];
  try {
    const ids = libraryStore.getAllGameIds();
    const seen = new Set<string>();
    for (const id of ids) {
      const entry = journeyStore.getEntry(id);
      const title = entry?.title?.trim();
      if (title && !seen.has(title.toLowerCase())) {
        seen.add(title.toLowerCase());
        libraryTitles.push(title);
      }
    }
  } catch {
    // non-critical
  }

  for (const item of deduped) {
    const text = `${item.title} ${item.summary}`.toLowerCase();
    item.isFromYourFleet = libraryTitles.some(
      (t) => t.length > 2 && text.includes(t.toLowerCase()),
    );
  }

  // Cache
  cache = { items: deduped, fetchedAt: Date.now() };

  return deduped;
}

/** Clear the news cache (forces re-fetch on next call). */
export function clearNewsCache(): void {
  cache = null;
}

let _prewarming = false;

/**
 * Kick off a background fetch so the cache is hot when the user opens
 * Transmissions. Safe to call multiple times — only the first runs.
 */
export function prewarmNews(): void {
  if (_prewarming || cache) return;
  _prewarming = true;
  fetchAllNews().catch(() => {}).finally(() => { _prewarming = false; });
}
