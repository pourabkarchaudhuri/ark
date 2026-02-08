/**
 * News Service
 *
 * Aggregates gaming news from multiple free, keyless sources:
 *   1. Steam News API — news from the user's library games + trending Steam games
 *   2. Reddit JSON API — hot posts from r/gaming, r/pcgaming, r/Games, r/gamernews
 *   3. RSS feeds — PC Gamer, Rock Paper Shotgun, Eurogamer, IGN, Ars Technica
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
  source: string;       // e.g. "Steam · Elden Ring", "Reddit r/gaming"
  imageUrl?: string;
  url: string;
  publishedAt: number;  // Unix timestamp in seconds
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

/** Strip BBCode tags, HTML entities, and trim to maxLen characters. */
function stripBBCodeAndHTML(raw: string, maxLen: number = 150): string {
  let text = raw;
  // Remove [img]...[/img], [url]...[/url], and other BBCode tags
  text = text.replace(/\[img\].*?\[\/img\]/gi, '');
  text = text.replace(/\[url=.*?\](.*?)\[\/url\]/gi, '$1');
  text = text.replace(/\[\/?\w+.*?\]/g, '');
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > maxLen) {
    return text.slice(0, maxLen).replace(/\s+\S*$/, '') + '...';
  }
  return text;
}

/** Extract the first image URL from BBCode/HTML content. */
function extractImageFromContent(contents: string): string | undefined {
  // Try [img] BBCode
  const bbMatch = /\[img\](https?:\/\/[^\[]+)\[\/img\]/i.exec(contents);
  if (bbMatch) return bbMatch[1];
  // Try <img src="...">
  const htmlMatch = /<img\b[^>]*src=["']([^"']+)["']/i.exec(contents);
  if (htmlMatch) return htmlMatch[1];
  // Try bare image URL
  const urlMatch = /(https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp))/i.exec(contents);
  if (urlMatch) return urlMatch[1];
  return undefined;
}

/** Get a high-res Steam image URL for an appId. Prefers library_hero (1920x620) > capsule_616x353. */
function getSteamHighResUrl(appId: number): string {
  return `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/library_hero.jpg`;
}

/** Get fallback Steam header image URL for an appId (460x215). */
export function getSteamHeaderUrl(appId: number): string {
  return `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`;
}

/**
 * Simple heuristic to check if a string is likely English.
 * Checks for high ratio of ASCII-latin characters vs non-latin scripts.
 */
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
      const journeyEntry = journeyStore.getEntry(id);
      const name = journeyEntry?.title ?? `Game ${id}`;
      addGame(id, name);
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
        // Filter out non-English articles
        if (!isLikelyEnglish(item.title)) continue;

        // Prefer extracted image from content, then high-res hero, then header
        const contentImage = extractImageFromContent(item.contents ?? '');
        const imageUrl = contentImage || getSteamHighResUrl(appId);
        results.push({
          id: `steam-${item.gid}`,
          title: item.title,
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

/** Fetch hot posts from Reddit gaming subreddits. */
async function fetchRedditNews(): Promise<NewsItem[]> {
  const results: NewsItem[] = [];

  // Try Electron IPC first (avoids CORS)
  if (typeof window !== 'undefined' && window.newsApi?.getRedditNews) {
    try {
      const posts = await window.newsApi.getRedditNews(['gaming', 'pcgaming', 'Games', 'gamernews'], 15);
      for (const post of posts) {
        if (!isLikelyEnglish(post.title)) continue;
        const imageUrl = getRedditImageUrl(post);
        results.push({
          id: `reddit-${post.id}`,
          title: post.title,
          summary: stripBBCodeAndHTML(post.selftext || post.title, 500),
          source: `Reddit r/${post.subreddit}`,
          imageUrl,
          url: `https://www.reddit.com${post.permalink}`,
          publishedAt: post.created_utc,
        });
      }
      return results;
    } catch (err) {
      console.warn('[NewsService] Electron Reddit IPC failed, falling back to proxy:', err);
    }
  }

  // Fallback: Vite dev proxy
  for (const sub of ['gaming', 'pcgaming', 'Games', 'gamernews']) {
    try {
      const response = await fetch(`/api/reddit/r/${sub}/hot.json?limit=15`);
      if (!response.ok) continue;
      const data = await response.json();
      const posts = data?.data?.children ?? [];
      for (const post of posts) {
        const d = post.data;
        if (!d || d.stickied) continue;
        const title = d.title ?? '';
        if (!isLikelyEnglish(String(title))) continue;
        const imageUrl = getRedditImageUrlFromData(d);
        results.push({
          id: `reddit-${d.id}`,
          title: String(title),
          summary: stripBBCodeAndHTML(d.selftext || d.title || '', 500),
          source: `Reddit r/${d.subreddit ?? sub}`,
          imageUrl,
          url: `https://www.reddit.com${d.permalink ?? ''}`,
          publishedAt: d.created_utc ?? 0,
        });
      }
    } catch {
      // Try next subreddit
    }
  }

  return results;
}

/** Extract the best (highest resolution) image URL from a Reddit post (Electron IPC shape). */
function getRedditImageUrl(post: {
  thumbnail: string;
  url: string;
  preview?: {
    images?: Array<{
      source?: { url: string; width?: number };
      resolutions?: Array<{ url: string; width?: number }>;
    }>;
  };
}): string | undefined {
  // Prefer the source image from preview (original resolution, usually 1080p+)
  const previewSource = post.preview?.images?.[0]?.source?.url;
  if (previewSource) return previewSource.replace(/&amp;/g, '&');
  // Try the highest resolution available
  const resolutions = post.preview?.images?.[0]?.resolutions;
  if (resolutions && resolutions.length > 0) {
    const best = resolutions[resolutions.length - 1]; // Last = highest res
    if (best?.url) return best.url.replace(/&amp;/g, '&');
  }
  // Fallback: if URL itself is an image
  if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(post.url)) return post.url;
  // Fallback: thumbnail (may be "self", "default", "nsfw", or a URL)
  if (post.thumbnail && post.thumbnail.startsWith('http')) return post.thumbnail;
  return undefined;
}

/** Same as above but from raw Reddit JSON data shape. */
function getRedditImageUrlFromData(d: Record<string, unknown>): string | undefined {
  const preview = d.preview as {
    images?: Array<{
      source?: { url: string; width?: number };
      resolutions?: Array<{ url: string; width?: number }>;
    }>;
  } | undefined;
  // Prefer source image (original resolution)
  const previewSource = preview?.images?.[0]?.source?.url;
  if (previewSource) return previewSource.replace(/&amp;/g, '&');
  // Highest resolution fallback
  const resolutions = preview?.images?.[0]?.resolutions;
  if (resolutions && resolutions.length > 0) {
    const best = resolutions[resolutions.length - 1];
    if (best?.url) return best.url.replace(/&amp;/g, '&');
  }
  const url = String(d.url ?? '');
  if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url)) return url;
  const thumbnail = String(d.thumbnail ?? '');
  if (thumbnail.startsWith('http')) return thumbnail;
  return undefined;
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
        title: item.title,
        summary: item.summary,
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
  const [steamItems, redditItems, rssItems] = await Promise.allSettled([
    fetchSteamNews(),
    fetchRedditNews(),
    fetchRSSNews(),
  ]);

  const allItems: NewsItem[] = [
    ...(steamItems.status === 'fulfilled' ? steamItems.value : []),
    ...(redditItems.status === 'fulfilled' ? redditItems.value : []),
    ...(rssItems.status === 'fulfilled' ? rssItems.value : []),
  ];

  // Deduplicate by normalised title (exact match after lowercasing)
  const seen = new Set<string>();
  const deduped = allItems.filter((item) => {
    const key = item.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by date, newest first
  deduped.sort((a, b) => b.publishedAt - a.publishedAt);

  // Cache
  cache = { items: deduped, fetchedAt: Date.now() };

  return deduped;
}

/** Clear the news cache (forces re-fetch on next call). */
export function clearNewsCache(): void {
  cache = null;
}
