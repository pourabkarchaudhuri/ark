/**
 * Metacritic API Client
 * Scrapes Metacritic game pages using cheerio for robust HTML parsing.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');

import * as cheerio from 'cheerio';
import { logger } from './safe-logger.js';

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
const reviewsCache = new Map<string, { data: MetacriticGameResponse | null; timestamp: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB

// ---------------------------------------------------------------------------
// Public types (unchanged — consumed by frontend)
// ---------------------------------------------------------------------------
export interface MetacriticReview {
  review: string;
  review_critic: string;
  author: string;
  review_date: string;
  review_grade: string;
}

export interface MetacriticGameResponse {
  title: string;
  poster: string;
  score: number;
  user_score: number;
  release_date: string;
  reviews: MetacriticReview[];
}

// ---------------------------------------------------------------------------
// HTTP helpers — uses Electron's net.fetch (Chromium network stack) so that
// corporate proxies / self-signed certificates are handled transparently.
// Falls back to global fetch when electron.net is unavailable (unit tests).
// ---------------------------------------------------------------------------
async function fetchUrl(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const fetchFn: typeof globalThis.fetch =
      electron?.net?.fetch ?? globalThis.fetch;

    const res = await fetchFn(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
      signal: controller.signal,
    } as any);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes limit`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Slug / URL helpers
// ---------------------------------------------------------------------------

/** Lowercased edition / remaster suffixes to strip from titles. */
const EDITION_SUFFIXES = [
  'game of the year edition', 'goty edition', 'goty',
  'ultimate edition', 'deluxe edition', 'gold edition',
  'complete edition', 'definitive edition', 'legendary edition',
  'premium edition', 'special edition', 'standard edition',
  'anniversary edition', 'enhanced edition', 'directors cut',
  "director's cut", 'remastered', 'remaster',
];

/** Arabic → Roman numeral map (covers the range seen in game titles). */
const ARABIC_TO_ROMAN: [RegExp, string][] = [
  [/\b2\b/g, 'ii'],
  [/\b3\b/g, 'iii'],
  [/\b4\b/g, 'iv'],
  [/\b5\b/g, 'v'],
  [/\b6\b/g, 'vi'],
  [/\b7\b/g, 'vii'],
  [/\b8\b/g, 'viii'],
  [/\b9\b/g, 'ix'],
  [/\b10\b/g, 'x'],
];

function createSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
}

/** Normalise a title before slugging — strip TM/R/C symbols, edition tags, etc. */
function normaliseTitle(raw: string): string {
  return raw
    .replace(/[™®©]/g, '')     // Trademark / registered / copyright symbols
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip known edition / remaster suffixes from a title. */
function stripEdition(title: string): string {
  let t = title.toLowerCase();
  for (const suffix of EDITION_SUFFIXES) {
    // Match suffix at end, optionally preceded by ` - `, `: `, or just ` `
    const re = new RegExp(`[:\\s-]*${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
    t = t.replace(re, '');
  }
  return t.trim();
}

/** Strip subtitle after ` - ` or after first `: ` (keeps base title). */
function stripSubtitle(title: string): string {
  // Prefer splitting on ` - ` first (more specific separator)
  const dashIdx = title.indexOf(' - ');
  if (dashIdx > 3) return title.slice(0, dashIdx).trim();
  const colonIdx = title.indexOf(': ');
  if (colonIdx > 3) return title.slice(0, colonIdx).trim();
  return title;
}

/**
 * Generate multiple slug candidates from a game title, ordered by likelihood.
 * Each slug is unique; duplicates are removed.
 */
function generateSlugCandidates(rawName: string): string[] {
  const normalised = normaliseTitle(rawName);
  const editionStripped = stripEdition(normalised);

  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => { if (s && !seen.has(s)) { seen.add(s); candidates.push(s); } };

  // 1. Direct slug from normalised title
  add(createSlug(normalised));

  // 2. Edition-stripped slug (e.g., "Witcher 3 Wild Hunt" from "… GOTY Edition")
  add(createSlug(editionStripped));

  // 3. Arabic → Roman numeral variants for both normalised and stripped titles
  for (const base of [normalised, editionStripped]) {
    const lower = base.toLowerCase();
    for (const [re, roman] of ARABIC_TO_ROMAN) {
      if (re.test(lower)) {
        add(createSlug(lower.replace(re, roman)));
      }
    }
  }

  // 4. Subtitle-stripped variant (e.g., "The Witcher 3" from "The Witcher 3: Wild Hunt")
  const subtitleStripped = stripSubtitle(editionStripped);
  if (subtitleStripped !== editionStripped) {
    add(createSlug(subtitleStripped));
  }

  return candidates;
}

/** Try fetching a game page directly by slug (multiple platform prefixes). */
async function trySlug(slug: string): Promise<string | null> {
  const prefixes = [
    'game',                   // New Metacritic URL scheme (no platform)
    'game/pc',
    'game/playstation-5',
    'game/playstation-4',
    'game/xbox-series-x',
  ];

  for (const prefix of prefixes) {
    const url = `https://www.metacritic.com/${prefix}/${slug}/`;
    try {
      logger.log(`[Metacritic] Trying: ${url}`);
      const html = await fetchUrl(url);
      if (html && html.length > 1000) return html;
    } catch {
      // Try next prefix
    }
  }
  return null;
}

/**
 * Search Metacritic as a last resort and fetch the top game result page.
 * Uses category=13 to restrict results to games.
 */
async function searchAndFetch(gameName: string): Promise<string | null> {
  const searchUrl = `https://www.metacritic.com/search/${encodeURIComponent(gameName)}/?page=1&category=13`;
  logger.log(`[Metacritic] Search fallback: ${searchUrl}`);

  try {
    const html = await fetchUrl(searchUrl);
    const $ = cheerio.load(html);

    // Search result links use data-testid="search-result-item" with href like /game/<slug>/
    const firstResult = $('a[data-testid="search-result-item"][href*="/game/"]').first();
    const href = firstResult.attr('href');
    if (!href || !href.match(/\/game\/[a-z0-9-]+/)) return null;

    const gameUrl = `https://www.metacritic.com${href.endsWith('/') ? href : href + '/'}`;
    logger.log(`[Metacritic] Search hit: ${gameUrl}`);

    const gameHtml = await fetchUrl(gameUrl);
    if (gameHtml && gameHtml.length > 1000) return gameHtml;
  } catch (err) {
    logger.warn(`[Metacritic] Search fallback failed:`, err);
  }
  return null;
}

/**
 * Try multiple strategies to find a game page on Metacritic:
 * 1. Direct slug variations (normalised, edition-stripped, numeral-converted)
 * 2. Metacritic search as last resort
 */
async function tryFetchWithPatterns(gameName: string): Promise<string | null> {
  const slugs = generateSlugCandidates(gameName);

  // Strategy 1: Direct slug lookups (fast — one HTTP per slug × platform prefix)
  for (const slug of slugs) {
    const html = await trySlug(slug);
    if (html) return html;
  }

  // Strategy 2: Search fallback (one search request + one game page request)
  return searchAndFetch(gameName);
}

// ---------------------------------------------------------------------------
// Parsing helpers (cheerio-based)
// ---------------------------------------------------------------------------

interface JsonLdData {
  score: number;
  userScore: number;
  poster: string;
  releaseDate: string;
  title: string;
}

/** Extract score, user score, poster, release date from JSON-LD + DOM. */
function parseJsonLd($: cheerio.CheerioAPI): JsonLdData {
  const result: JsonLdData = { score: 0, userScore: 0, poster: '', releaseDate: '', title: '' };

  // 1. Structured data (JSON-LD) — critic Metascore, poster, dates
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const raw = $(el).html();
      if (!raw) return;
      const data = JSON.parse(raw);

      if (data.aggregateRating?.ratingValue) {
        result.score = parseInt(data.aggregateRating.ratingValue, 10) || 0;
      }
      if (typeof data.image === 'string' && !result.poster) {
        result.poster = data.image;
      }
      if (data.datePublished && !result.releaseDate) {
        result.releaseDate = data.datePublished;
      }
      if (data.name && !result.title) {
        result.title = data.name;
      }
    } catch {
      // Skip malformed JSON-LD blocks
    }
  });

  // 2. User Score — scraped from the DOM (not in JSON-LD)
  //    The second .c-productScoreInfo block contains "User Score" and the value.
  $('.c-productScoreInfo').each((_i, el) => {
    const text = $(el).text();
    if (text.includes('User Score') || text.includes('User Ratings')) {
      const scoreEl = $(el).find('.c-siteReviewScore').first();
      const raw = scoreEl.text().trim();
      const parsed = parseFloat(raw);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 10) {
        result.userScore = parsed;
      }
    }
  });

  return result;
}

/** Extract individual critic reviews from `.c-siteReview` DOM cards. */
function parseCriticReviews($: cheerio.CheerioAPI): MetacriticReview[] {
  const reviews: MetacriticReview[] = [];

  $('.c-siteReview').each((_i, el) => {
    const $card = $(el);

    // Only critic reviews have a publication name; user reviews have a username
    const publicationName = $card.find('.c-siteReviewHeader_publicationName').first().text().trim();
    if (!publicationName) return; // Skip user reviews

    const grade = $card.find('.c-siteReviewScore').first().text().trim();
    const date = $card.find('.c-siteReview_reviewDate').first().text().trim();

    // Review body: try the dedicated quote element first, then fall back to
    // extracting text from the main body area minus the header/footer
    let body = $card.find('.c-siteReview_quote').first().text().trim();
    if (!body) {
      // Fall back: get the main section text, strip out known child texts
      const mainEl = $card.find('.c-siteReview_main').first();
      if (mainEl.length) {
        // Clone and remove header, footer, and button elements to isolate body text
        const clone = mainEl.clone();
        clone.find('.c-siteReviewHeader, .c-siteReview_extra, .c-siteReview_reviewDate, .c-globalButton').remove();
        body = clone.text().replace(/\s+/g, ' ').trim();
      }
    }

    if (grade || body) {
      reviews.push({
        review: body,
        review_critic: publicationName,
        author: publicationName,
        review_date: date,
        review_grade: grade,
      });
    }
  });

  return reviews;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Fetch game reviews from Metacritic.
 * @param gameName - The name of the game to search for
 * @returns Metacritic review data or null if not found
 */
export async function fetchMetacriticReviews(gameName: string): Promise<MetacriticGameResponse | null> {
  const cacheKey = gameName.toLowerCase().trim();

  // Check cache
  const cached = reviewsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    logger.log(`[Metacritic] Using cached reviews for: ${gameName}`);
    return cached.data;
  }

  try {
    logger.log(`[Metacritic] Fetching reviews for: ${gameName}`);

    const html = await tryFetchWithPatterns(gameName);
    if (!html) {
      logger.log(`[Metacritic] Could not find page for: ${gameName}`);
      reviewsCache.set(cacheKey, { data: null, timestamp: Date.now() });
      return null;
    }

    // Parse with cheerio
    const $ = cheerio.load(html);

    // 1. Structured data (JSON-LD)
    const ld = parseJsonLd($);

    // 2. Individual critic reviews from DOM
    const reviews = parseCriticReviews($);

    if (ld.score === 0 && reviews.length === 0) {
      logger.log(`[Metacritic] No data found for: ${gameName}`);
      reviewsCache.set(cacheKey, { data: null, timestamp: Date.now() });
      return null;
    }

    const response: MetacriticGameResponse = {
      title: ld.title || gameName,
      poster: ld.poster,
      score: ld.score,
      user_score: ld.userScore,
      release_date: ld.releaseDate,
      reviews,
    };

    logger.log(`[Metacritic] Found score ${ld.score} and ${reviews.length} critic reviews for: ${gameName}`);
    reviewsCache.set(cacheKey, { data: response, timestamp: Date.now() });
    return response;
  } catch (error) {
    logger.error(`[Metacritic] Error fetching reviews for ${gameName}:`, error);
    reviewsCache.set(cacheKey, { data: null, timestamp: Date.now() });
    return null;
  }
}

/**
 * Clear the Metacritic reviews cache
 */
export function clearMetacriticCache(): void {
  reviewsCache.clear();
  logger.log('[Metacritic] Cache cleared');
}

