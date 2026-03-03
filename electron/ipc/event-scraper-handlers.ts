/**
 * Event Scraper IPC Handlers
 *
 * Fetches gaming-event websites via net.fetch (no CORS issues), extracts
 * dates and YouTube/Twitch links from the HTML, and caches results for 24h.
 * Runs sequentially to avoid hammering sites.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain, net, app } = electron;
import { logger } from '../safe-logger.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CACHE_TTL = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT = 15_000;
const MAX_HTML_BYTES = 512 * 1024;

interface ScrapedEvent {
  id: string;
  startDate?: number;
  endDate?: number;
  youtubeUrls: string[];
  twitchUrls: string[];
  scrapedAt: number;
}

interface EventCache {
  events: Record<string, ScrapedEvent>;
  updatedAt: number;
}

// ─── Month lookup ───────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7,
  sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
  // With trailing period (CES uses "Jan.", "Feb.", etc.)
  'jan.': 0, 'feb.': 1, 'mar.': 2, 'apr.': 3, 'may.': 4, 'jun.': 5,
  'jul.': 6, 'aug.': 7, 'sep.': 8, 'sept.': 8, 'oct.': 9, 'nov.': 10, 'dec.': 11,
};

// ─── Cache I/O ──────────────────────────────────────────────────────────────

function getCachePath(): string {
  return path.join(app.getPath('userData'), 'event-cache.json');
}

function readCache(): EventCache | null {
  try {
    return JSON.parse(fs.readFileSync(getCachePath(), 'utf-8'));
  } catch {
    return null;
  }
}

function writeCache(cache: EventCache): void {
  try {
    fs.writeFileSync(getCachePath(), JSON.stringify(cache, null, 2));
  } catch (err) {
    logger.warn('[EventScraper] Cache write failed:', err);
  }
}

// ─── URL validation ─────────────────────────────────────────────────────────

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ─── Date extraction ────────────────────────────────────────────────────────

interface DateCandidate { start: number; end?: number; specificity: number }

function extractDatesFromText(text: string): DateCandidate[] {
  const currentYear = new Date().getFullYear();
  const validYears = new Set([currentYear, currentYear + 1]);

  function tryMonth(name: string): number | undefined {
    return MONTHS[name.toLowerCase().replace(/\.$/, '')];
  }

  function validDay(d: number): boolean { return d >= 1 && d <= 31; }
  function validYear(y: number): boolean { return validYears.has(y); }

  const candidates: DateCandidate[] = [];
  let m: RegExpExecArray | null;

  // Cross-month US: "August 30 – September 2, 2026"
  const crossMonthUS = /\b([A-Za-z]+)\.?\s+(\d{1,2})\s*[-–—]\s*([A-Za-z]+)\.?\s+(\d{1,2}),?\s*(\d{4})\b/g;
  while ((m = crossMonthUS.exec(text)) !== null) {
    const mi1 = tryMonth(m[1]); const d1 = +m[2];
    const mi2 = tryMonth(m[3]); const d2 = +m[4]; const y = +m[5];
    if (mi1 === undefined || mi2 === undefined || !validDay(d1) || !validDay(d2) || !validYear(y)) continue;
    candidates.push({
      start: new Date(y, mi1, d1).getTime() / 1000,
      end:   new Date(y, mi2, d2, 23, 59, 59).getTime() / 1000,
      specificity: 3,
    });
  }

  // Cross-month EU: "06 July - 23 August 2026"
  const crossMonthEU = /\b(\d{1,2})\s+([A-Za-z]+)\.?\s*[-–—]\s*(\d{1,2})\s+([A-Za-z]+)\.?,?\s*(\d{4})\b/g;
  while ((m = crossMonthEU.exec(text)) !== null) {
    const d1 = +m[1]; const mi1 = tryMonth(m[2]);
    const d2 = +m[3]; const mi2 = tryMonth(m[4]); const y = +m[5];
    if (mi1 === undefined || mi2 === undefined || !validDay(d1) || !validDay(d2) || !validYear(y)) continue;
    candidates.push({
      start: new Date(y, mi1, d1).getTime() / 1000,
      end:   new Date(y, mi2, d2, 23, 59, 59).getTime() / 1000,
      specificity: 3,
    });
  }

  // Same-month US range: "June 8-10, 2026" or "March 9-13, 2026"
  const rangeUS = /\b([A-Za-z]+)\.?\s+(\d{1,2})\s*[-–—]\s*(\d{1,2}),?\s*(\d{4})\b/g;
  while ((m = rangeUS.exec(text)) !== null) {
    const mi = tryMonth(m[1]); const d1 = +m[2]; const d2 = +m[3]; const y = +m[4];
    if (mi === undefined || !validDay(d1) || !validDay(d2) || !validYear(y)) continue;
    candidates.push({
      start: new Date(y, mi, d1).getTime() / 1000,
      end:   new Date(y, mi, d2, 23, 59, 59).getTime() / 1000,
      specificity: 3,
    });
  }

  // Same-month EU range: "8-10 June 2026" or "26-30 August 2026"
  const rangeEU = /\b(\d{1,2})\s*[-–—]\s*(\d{1,2})\s+([A-Za-z]+)\.?,?\s*(\d{4})\b/g;
  while ((m = rangeEU.exec(text)) !== null) {
    const d1 = +m[1]; const d2 = +m[2]; const mi = tryMonth(m[3]); const y = +m[4];
    if (mi === undefined || !validDay(d1) || !validDay(d2) || !validYear(y)) continue;
    candidates.push({
      start: new Date(y, mi, d1).getTime() / 1000,
      end:   new Date(y, mi, d2, 23, 59, 59).getTime() / 1000,
      specificity: 3,
    });
  }

  // ISO date range: "2026-06-15 to 2026-06-22" or "2026-06-15 – 2026-06-22"
  const isoRange = /\b(\d{4})[-/](\d{2})[-/](\d{2})\s*(?:[-–—]|to)\s*(\d{4})[-/](\d{2})[-/](\d{2})\b/g;
  while ((m = isoRange.exec(text)) !== null) {
    const y1 = +m[1]; const mo1 = +m[2] - 1; const d1 = +m[3];
    const y2 = +m[4]; const mo2 = +m[5] - 1; const d2 = +m[6];
    if (!validYear(y1) || !validDay(d1) || !validDay(d2)) continue;
    candidates.push({
      start: new Date(y1, mo1, d1).getTime() / 1000,
      end:   new Date(y2, mo2, d2, 23, 59, 59).getTime() / 1000,
      specificity: 3,
    });
  }

  // Single US: "June 8, 2026" or "Jun. 8, 2026"
  const singleUS = /\b([A-Za-z]+)\.?\s+(\d{1,2}),?\s*(\d{4})\b/g;
  while ((m = singleUS.exec(text)) !== null) {
    const mi = tryMonth(m[1]); const d = +m[2]; const y = +m[3];
    if (mi === undefined || !validDay(d) || !validYear(y)) continue;
    candidates.push({ start: new Date(y, mi, d).getTime() / 1000, specificity: 2 });
  }

  // Single EU: "8 June 2026" or "7 June 2026"
  const singleEU = /\b(\d{1,2})\s+([A-Za-z]+)\.?,?\s*(\d{4})\b/g;
  while ((m = singleEU.exec(text)) !== null) {
    const d = +m[1]; const mi = tryMonth(m[2]); const y = +m[3];
    if (mi === undefined || !validDay(d) || !validYear(y)) continue;
    candidates.push({ start: new Date(y, mi, d).getTime() / 1000, specificity: 2 });
  }

  // Single ISO: "2026-06-05" or "2026/06/05" or "2026-02-20T16:33:09"
  const isoSingle = /\b(\d{4})[-/](\d{2})[-/](\d{2})(?:\b|T)/g;
  while ((m = isoSingle.exec(text)) !== null) {
    const y = +m[1]; const mo = +m[2] - 1; const d = +m[3];
    if (!validYear(y) || !validDay(d) || mo < 0 || mo > 11) continue;
    candidates.push({ start: new Date(y, mo, d).getTime() / 1000, specificity: 2 });
  }

  // Month + year only (lowest priority): "February 2026", "September 2026"
  const monthYear = /\b([A-Za-z]+)\.?\s+(\d{4})\b/g;
  while ((m = monthYear.exec(text)) !== null) {
    const mi = tryMonth(m[1]); const y = +m[2];
    if (mi === undefined || !validYear(y)) continue;
    candidates.push({ start: new Date(y, mi, 1).getTime() / 1000, specificity: 1 });
  }

  return candidates;
}

/**
 * Extract dates from multiple text sources (cleaned text, raw HTML, meta tags,
 * script contents) and pick the best candidate. Searches broadly so we catch
 * dates hidden in Next.js data, JSON-LD, meta tags, etc.
 */
function extractDates(html: string, cleanedText: string): { start?: number; end?: number } {
  // Build a combined text from meta-tag content attributes + cleaned text + script contents
  const metaContents: string[] = [];
  const metaRe = /<meta[^>]*content=["']([^"']{10,300})["'][^>]*>/gi;
  let mm: RegExpExecArray | null;
  while ((mm = metaRe.exec(html)) !== null) metaContents.push(mm[1]);

  // Extract text from inside <script> tags (catches Next.js, JSON-LD, inline data)
  const scriptContents: string[] = [];
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let sc: RegExpExecArray | null;
  while ((sc = scriptRe.exec(html)) !== null) {
    const content = sc[1];
    if (content.length > 10 && content.length < 200_000) scriptContents.push(content);
  }

  // Title tag
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleText = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

  // Unescape common HTML/JSON escapes so regex can match through them
  const unescape = (s: string) => s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—').replace(/&#8211;/g, '–').replace(/&#8212;/g, '—')
    .replace(/\\u002F/g, '/').replace(/\\u0026/g, '&')
    .replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\s+/g, ' ');

  const allText = [
    cleanedText,
    titleText,
    ...metaContents,
    ...scriptContents.map(unescape),
  ].join(' \n ');

  const candidates = extractDatesFromText(allText);

  if (candidates.length === 0) return {};

  const now = Date.now() / 1000;
  const future = candidates.filter((c) => c.start >= now || (c.end && c.end >= now));

  if (future.length > 0) {
    // Sort by specificity (ranges > singles > month-only), then by soonest start
    future.sort((a, b) => b.specificity - a.specificity || a.start - b.start);
    const best = future[0];
    return { start: best.start, end: best.end };
  }

  // All in past — return most recent
  candidates.sort((a, b) => b.start - a.start);
  return { start: candidates[0].start, end: candidates[0].end };
}

// ─── Link extraction ────────────────────────────────────────────────────────

function extractLinks(html: string): { youtubeUrls: string[]; twitchUrls: string[] } {
  const ytSet = new Set<string>();
  const twitchSet = new Set<string>();

  const ytRe = /(?:href|src)=["'](https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|live\/|channel\/|@)|youtu\.be\/)[^"'\s]+)["']/gi;
  const twRe = /(?:href|src)=["'](https?:\/\/(?:www\.)?twitch\.tv\/[^"'\s]+)["']/gi;

  let m: RegExpExecArray | null;
  while ((m = ytRe.exec(html)) !== null) ytSet.add(m[1].replace(/&amp;/g, '&'));
  while ((m = twRe.exec(html)) !== null) twitchSet.add(m[1].replace(/&amp;/g, '&'));

  return { youtubeUrls: [...ytSet], twitchUrls: [...twitchSet] };
}

// ─── Fetch a single URL ─────────────────────────────────────────────────────

async function fetchPage(url: string): Promise<{ html: string; text: string } | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    const res = await net.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    let html = await res.text();
    if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES);

    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
    return { html, text };
  } catch (err) {
    logger.warn(`[EventScraper] Fetch failed for ${url}:`, err);
    return null;
  }
}

// ─── Scrape logic (extracted so it can run in background) ───────────────────

async function scrapeAll(events: Array<{ id: string; url?: string }>): Promise<Record<string, ScrapedEvent>> {
  logger.log(`[EventScraper] Scraping ${events.length} event sites…`);
  const results: Record<string, ScrapedEvent> = {};
  const now = Date.now();

  for (const ev of events) {
    if (!ev.url || !isAllowedUrl(ev.url)) {
      results[ev.id] = { id: ev.id, youtubeUrls: [], twitchUrls: [], scrapedAt: now };
      continue;
    }

    const page = await fetchPage(ev.url);
    if (!page) {
      results[ev.id] = { id: ev.id, youtubeUrls: [], twitchUrls: [], scrapedAt: now };
      continue;
    }

    const dates = extractDates(page.html, page.text);
    const links = extractLinks(page.html);

    results[ev.id] = {
      id: ev.id,
      startDate: dates.start,
      endDate: dates.end,
      youtubeUrls: links.youtubeUrls,
      twitchUrls: links.twitchUrls,
      scrapedAt: now,
    };

    logger.log(
      `[EventScraper] ${ev.id}: date=${dates.start ? 'yes' : 'no'}, yt=${links.youtubeUrls.length}, tw=${links.twitchUrls.length}`,
    );
  }

  writeCache({ events: results, updatedAt: now });
  return results;
}

let backgroundScrapeRunning = false;

function scrapeInBackground(events: Array<{ id: string; url?: string }>): void {
  if (backgroundScrapeRunning) return;
  backgroundScrapeRunning = true;
  logger.log('[EventScraper] Stale cache — refreshing in background');
  scrapeAll(events).catch((err) => {
    logger.warn('[EventScraper] Background refresh failed:', err);
  }).finally(() => { backgroundScrapeRunning = false; });
}

// ─── IPC Registration ───────────────────────────────────────────────────────

export function register(): void {
  // Stale-while-revalidate: always return cached data instantly if available.
  // If stale (>TTL), trigger a background refresh so the next call gets fresh data.
  ipcMain.handle(
    'events:scrapeAll',
    async (_event: any, events: Array<{ id: string; url?: string }>) => {
      if (!Array.isArray(events)) return {};

      const cache = readCache();

      if (cache) {
        const isStale = Date.now() - cache.updatedAt >= CACHE_TTL;
        if (isStale) {
          scrapeInBackground(events);
        } else {
          logger.log('[EventScraper] Serving from cache (fresh)');
        }
        return cache.events;
      }

      return await scrapeAll(events);
    },
  );

  ipcMain.handle('events:clearCache', async () => {
    try { fs.unlinkSync(getCachePath()); return { success: true }; } catch { return { success: false }; }
  });
}
