/**
 * Web Search Module
 * Uses DuckDuckGo HTML Lite endpoint for grounding AI responses with current data.
 * No API keys required. Robust against rate limiting.
 */

import https from 'https';

export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
}

/**
 * Determine whether a user message would benefit from web search grounding.
 * Returns true for questions about current events, prices, reviews, news,
 * comparisons, release info, or anything the model likely needs fresh data for.
 */
export function needsWebSearch(message: string): boolean {
  const lower = message.toLowerCase();

  // Explicit web search intent
  if (/\b(search|google|look up|find out|what('s| is) new)\b/.test(lower)) return true;

  // Questions about current/recent things
  if (/\b(latest|recent|current|upcoming|new|today|this (week|month|year)|202[4-9]|203\d)\b/.test(lower)) return true;

  // Price / deal queries
  if (/\b(price|cost|deal|discount|sale|free|how much)\b/.test(lower)) return true;

  // Review / opinion aggregation
  if (/\b(review|rating|worth|should i (buy|play|get)|is .+ good|metacritic|opencritic)\b/.test(lower)) return true;

  // News / announcements
  if (/\b(news|update|patch|dlc|expansion|announced|release date|trailer|leak)\b/.test(lower)) return true;

  // Comparisons / recommendations that benefit from up-to-date info
  if (/\b(vs\.?|versus|compare|alternative|similar to|like .+ but|best .+ games?)\b/.test(lower)) return true;

  // Hardware / performance
  if (/\b(system requirements|can .+ run|fps|performance|steam deck)\b/.test(lower)) return true;

  // Mods / community
  if (/\b(mod|mods|modding|workshop|nexus)\b/.test(lower)) return true;

  // Awards / events / winners
  if (/\b(award|awards|won|winner|goty|game of the year|nominee|nominated|event|ceremony)\b/.test(lower)) return true;

  // General factual questions the model might not know
  if (/\b(how many|who (won|made|created|developed)|when (did|does|will|is)|where (can|do))\b/.test(lower)) return true;

  return false;
}

/**
 * Perform an HTTPS request to the given URL.
 * Handles redirects automatically.
 */
function fetchUrl(
  url: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const isPost = options.method === 'POST';
    const urlObj = new URL(url);

    const reqOpts: https.RequestOptions = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: isPost ? 'POST' : 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(isPost ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(options.headers || {}),
      },
    };

    const req = https.request(reqOpts, (res) => {
      // Follow redirects
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        fetchUrl(res.headers.location, options).then(resolve).catch(reject);
        return;
      }

      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data }));
    });

    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error('Request timed out'));
    });

    if (isPost && options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Parse DuckDuckGo HTML Lite response into structured search results.
 */
function parseDDGHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];

  // Extract result links and titles
  const linkRegex = /<a rel="nofollow" class="result__a" href="([^"]+)">(.*?)<\/a>/g;
  // Extract snippets
  const snippetRegex = /<a class="result__snippet"[^>]*>(.*?)<\/a>/gs;

  const links: Array<{ url: string; title: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const rawUrl = match[1];
    const title = match[2].replace(/<\/?b>/g, '').trim();

    // DDG Lite URLs are sometimes redirect URLs; decode them
    let url = rawUrl;
    const uddgMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      url = decodeURIComponent(uddgMatch[1]);
    }

    links.push({ url, title });
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(
      match[1]
        .replace(/<\/?b>/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    );
  }

  for (let i = 0; i < links.length; i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      description: snippets[i] || '',
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
  maxResults: number = 5
): Promise<WebSearchResult[]> {
  try {
    console.log(`[Web Search] Searching DuckDuckGo for: "${query}"`);

    const body = `q=${encodeURIComponent(query)}`;
    const response = await fetchUrl('https://html.duckduckgo.com/html/', {
      method: 'POST',
      body,
    });

    if (response.status !== 200) {
      console.error(`[Web Search] DuckDuckGo returned status ${response.status}`);
      return [];
    }

    const results = parseDDGHtml(response.data).slice(0, maxResults);

    console.log(`[Web Search] Found ${results.length} results`);
    return results;
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Web Search] Search failed: ${errMsg}`);
    return [];
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
