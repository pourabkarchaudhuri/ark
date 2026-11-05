/**
 * Web Search Module
 * Uses DuckDuckGo HTML Lite endpoint for grounding AI responses with current data.
 * No API keys required. Robust against rate limiting.
 */

import { logger } from './safe-logger.js';
import { netFetch } from './net-fetch.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB — search results pages are small

export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
}

/**
 * Determine whether a user message would benefit from web search grounding.
 * Only explicit freshness intents count (search requests, latest/recent news,
 * prices, release dates, patch notes). Generic words such as "new", "free",
 * "review", "worth", "mod" or "update" used to trigger a blocking search before
 * nearly every Ollama message; the chat tools already cover reviews, HLTB and deals.
 */
export function needsWebSearch(message: string): boolean {
  const lower = message.toLowerCase();

  // Explicit web search intent
  if (/\b(search|google|look up|find out|what('s| is) new)\b/.test(lower)) return true;

  // Explicit freshness
  if (/\b(latest|recent|recently|upcoming|today|this (week|month|year)|202[4-9]|203\d)\b/.test(lower)) return true;

  // Price / deal queries (including Steam sale dates)
  if (/\b(price|prices|cost|deal|deals|discount|on sale|how much|steam sale|next sale)\b/.test(lower)) return true;

  // News / announcements / release info
  if (/\b(news|patch|patch notes|dlc|expansion|announced|announcement|release date|trailer|leak|leaks)\b/.test(lower)) return true;

  // Awards season
  if (/\b(goty|game of the year|nominee|nominees|nominated|game awards)\b/.test(lower)) return true;

  return false;
}

/** Overall budget for one web search, so a slow network never holds the chat for long. */
export const WEB_SEARCH_DEADLINE_MS = 2_500;
const SEARCH_CACHE_TTL_MS = 5 * 60_000;
const SEARCH_CACHE_MAX = 50;
const searchCache = new Map<string, { at: number; results: WebSearchResult[] }>();

type FetchOptions = { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal };
type FetchFn = (url: string, options: FetchOptions) => Promise<{ status: number; data: string }>;

let fetchImpl: FetchFn = (url, options) => fetchUrl(url, options);

/** Test seam: replace the HTTPS fetch (call with no argument to restore). */
export function __setWebSearchFetchForTests(fn?: FetchFn): void {
  fetchImpl = fn ?? ((url, options) => fetchUrl(url, options));
}

export function __clearWebSearchCacheForTests(): void {
  searchCache.clear();
}

/**
 * Collects a response body as raw bytes and decodes it once at the end, so a multi-byte UTF-8
 * character split across two socket chunks is not turned into replacement characters.
 * `push` returns false once the byte limit is exceeded (the caller aborts the request).
 */
export function createBodyCollector(maxBytes: number = MAX_RESPONSE_BYTES): {
  push(chunk: Buffer): boolean;
  text(): string;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    push(chunk) {
      bytes += chunk.length;
      if (bytes > maxBytes) return false;
      chunks.push(chunk);
      return true;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

/**
 * Perform an HTTPS request through the shared network helper (Chromium's stack inside Electron: system
 * certificates and proxy). Redirects are followed by the stack; the final URL must still be HTTPS, and the
 * body is read through a byte-capped collector so an oversized page is cut off.
 */
async function fetchUrl(url: string, options: FetchOptions = {}): Promise<{ status: number; data: string }> {
  if (options.signal?.aborted) throw new Error('Request aborted');
  const isPost = options.method === 'POST';
  const res = await netFetch(
    url,
    {
      method: isPost ? 'POST' : 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(isPost ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(options.headers || {}),
      },
      ...(isPost && options.body ? { body: options.body } : {}),
    },
    { timeoutMs: 10_000, signal: options.signal },
  );
  if (res.url && !/^https:/i.test(res.url)) {
    void res.body?.cancel().catch(() => {});
    throw new Error(`Redirect to non-HTTPS URL blocked: ${res.url}`);
  }
  const body = createBodyCollector(MAX_RESPONSE_BYTES);
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!body.push(Buffer.from(value))) {
        void reader.cancel().catch(() => {});
        throw new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes limit`);
      }
    }
  }
  return { status: res.status, data: body.text() };
}

const stripTags = (html: string): string =>
  html
    .replace(/<\/?b>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The real destination of a DDG link: the `uddg` target when present, else the raw href. */
function resultUrl(rawUrl: string): string {
  const uddgMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
  if (!uddgMatch) return rawUrl;
  try {
    return decodeURIComponent(uddgMatch[1]);
  } catch {
    return rawUrl; // malformed %-escape: keep this result rather than failing the whole search
  }
}

/**
 * Parse DuckDuckGo HTML Lite response into structured search results.
 * Each result block runs from its title link to the next one, and its snippet is read only inside
 * that block, so a result without a snippet never shifts descriptions onto the wrong URLs.
 */
export function parseDDGHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const linkRegex = /<a rel="nofollow" class="result__a" href="([^"]+)">(.*?)<\/a>/gs;
  const snippetRegex = /<a class="result__snippet"[^>]*>(.*?)<\/a>/s;

  const links: Array<{ rawUrl: string; title: string; start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    links.push({ rawUrl: match[1], title: match[2], start: match.index, end: linkRegex.lastIndex });
  }

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    // Sponsored results point at DDG's ad redirector, not a real page.
    if (/duckduckgo\.com\/y\.js/.test(link.rawUrl)) continue;
    const block = html.slice(link.end, i + 1 < links.length ? links[i + 1].start : html.length);
    const snippet = snippetRegex.exec(block);
    results.push({
      title: stripTags(link.title),
      url: resultUrl(link.rawUrl),
      description: snippet ? stripTags(snippet[1]) : '',
    });
  }

  return results;
}

/**
 * Search DuckDuckGo and return a concise list of results.
 * Uses the HTML Lite endpoint which is reliable and doesn't require API keys.
 *
 * @param query  The search query
 * @param maxResults  Maximum number of results to return (default 5)
 * @returns Array of simplified search results
 */
export async function webSearch(
  query: string,
  maxResults: number = 5,
  deadlineMs: number = WEB_SEARCH_DEADLINE_MS,
): Promise<WebSearchResult[]> {
  return (await webSearchOutcome(query, maxResults, deadlineMs)).results;
}

/** Like `webSearch`, but tells "the search could not run" (`error` set) apart from "nothing found". */
export async function webSearchOutcome(
  query: string,
  maxResults: number = 5,
  deadlineMs: number = WEB_SEARCH_DEADLINE_MS,
): Promise<{ results: WebSearchResult[]; error?: string }> {
  const cacheKey = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const hit = searchCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) return { results: hit.results.slice(0, maxResults) };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    logger.log(`[Web Search] Searching DuckDuckGo for: "${query}"`);

    const body = `q=${encodeURIComponent(query)}`;
    // One overall deadline covers redirects and slow bodies; on expiry the request is destroyed.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Search exceeded the ${deadlineMs} ms deadline`));
      }, deadlineMs);
    });
    const response = await Promise.race([
      fetchImpl('https://html.duckduckgo.com/html/', { method: 'POST', body, signal: controller.signal }),
      deadline,
    ]);

    if (response.status !== 200) {
      logger.error(`[Web Search] DuckDuckGo returned status ${response.status}`);
      return { results: [], error: `DuckDuckGo answered with status ${response.status}` };
    }

    const results = parseDDGHtml(response.data).slice(0, maxResults);
    if (searchCache.size >= SEARCH_CACHE_MAX) {
      const oldest = searchCache.keys().next().value;
      if (oldest !== undefined) searchCache.delete(oldest);
    }
    searchCache.set(cacheKey, { at: Date.now(), results });

    logger.log(`[Web Search] Found ${results.length} results`);
    return { results };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`[Web Search] Search failed: ${errMsg}`);
    return { results: [], error: errMsg };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Build a grounding context string from search results for injection
 * into an LLM system prompt.
 */
export function formatSearchContext(
  query: string,
  results: WebSearchResult[]
): string {
  if (results.length === 0) return '';

  const lines = results
    .map(
      (r, i) => `[${i + 1}] "${r.title}" (${r.url})\n    ${r.description}`
    )
    .join('\n');

  return (
    `\n\n--- Web Search Results (for grounding) ---\n` +
    `Query: "${query}"\n` +
    `${lines}\n` +
    `--- End of Search Results ---\n\n` +
    `Use the search results above to ground your answer with current, factual information. ` +
    `Cite sources where relevant. If the search results don't contain relevant information, ` +
    `say so and answer based on your own knowledge.`
  );
}
