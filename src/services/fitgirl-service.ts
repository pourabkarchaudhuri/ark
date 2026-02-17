const BASE_URL = "https://fitgirl-repacks.site/";

/**
 * Fetch HTML from a URL.
 *
 * In Electron, routes the request through the main process via IPC so it
 * bypasses CORS entirely (uses Chromium's network stack via electron.net.fetch).
 *
 * Falls back to a direct renderer `fetch()` (works in dev with proxy or
 * when CORS headers happen to be present).
 */
async function fetchHTMLWithFallback(url: string, _retries: number = 3): Promise<string> {
    // Strategy 1 (preferred): Electron main-process fetch — bypasses CORS entirely.
    if (typeof window !== 'undefined' && window.electron?.fetchHtml) {
        const html = await window.electron.fetchHtml(url);
        if (html) return html;
        // Main-process fetch returned null (network error).
        throw new Error(`Main-process fetch returned null for ${url}`);
    }

    // Outside Electron (e.g. plain browser dev): try direct fetch as a last resort.
    const response = await fetch(url);
    if (response.ok) return await response.text();

    throw new Error(`Fetch failed with status ${response.status} for ${url}`);
}

// Function to fetch an image from the repack page
async function fetchImageFromPage(url: string): Promise<string> {
    const html = await fetchHTMLWithFallback(url);
    const imageRegex = /<meta property="og:image" content="(.+?)" \/>/i;
    const imageMatch = html.match(imageRegex);
    
    return imageMatch ? imageMatch[1] : "../../store.akamai.steamstatic.com/public/images/mobile/steam_link_bg.png";
}

// Function to extract the repack download link from a details page
async function getRepackDownloadLink(pageUrl: string): Promise<string | null> {
    try {
        const html = await fetchHTMLWithFallback(pageUrl);
        
        const patterns = [
            /href="(magnet:\?xt=urn:btih:[^"]+)"/i,
            /href="([^"]*\.torrent)"/i,
            /href="(https?:\/\/[^"]*download[^"]*)"/i,
            /<a[^>]*class="[^"]*download[^"]*"[^>]*href="([^"]+)"/i,
            /<a[^>]*href="([^"]+)"[^>]*>.*?(?:Download|Magnet|Torrent).*?<\/a>/is,
        ];

        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
                const link = match[1];
                if (link.startsWith('magnet:') || 
                    link.endsWith('.torrent') || 
                    link.includes('download') ||
                    link.includes('torrent')) {
                    return link;
                }
            }
        }

        const postContentMatch = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        if (postContentMatch) {
            const postContent = postContentMatch[1];
            const linkPattern = /<a[^>]*href="([^"]+)"[^>]*>.*?(?:Download|Magnet|Torrent|Mirror).*?<\/a>/is;
            const linkMatch = postContent.match(linkPattern);
            if (linkMatch && linkMatch[1]) {
                return linkMatch[1];
            }
        }

        return null;
    } catch (error) {
        console.error(`Failed to extract repack link from ${pageUrl}:`, error);
        return null;
    }
}

// ── Title normalisation helpers ──────────────────────────────────────────────

/** Normalise a title for fuzzy comparison. */
function normalise(s: string): string {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&#8217;/g, "'")
        .replace(/&#8211;/g, '-')
        .replace(/&#8212;/g, '-')
        .replace(/&#?\w+;/g, '')        // strip remaining HTML entities
        .replace(/<[^>]*>/g, '')         // strip any HTML tags
        .replace(/['']/g, "'")
        .replace(/[""]/g, '"')
        .replace(/[\u2013\u2014]/g, '-')
        .replace(/[^\w\s'-]/g, '')       // keep letters, digits, spaces, hyphens, apostrophes
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/** Remove common repack suffixes FitGirl appends to titles. */
function stripRepackSuffix(s: string): string {
    return s
        .replace(/\s*[-–—]\s*v[\d.]+.*$/i, '')        // " – v1.2.3 + 4 DLCs"
        .replace(/\s*\+\s*\d+\s*DLC.*$/i, '')          // " + 3 DLCs"
        .replace(/\s*\(.*?\)\s*$/g, '')                 // trailing parenthesised text
        .replace(/\s*[-–—]\s*(?:repack|fitgirl).*$/i, '')
        .trim();
}

/** Strip common edition suffixes for looser matching. */
function stripEdition(s: string): string {
    return s
        .replace(/\s*[-:–]\s*(game of the year|goty|definitive|ultimate|complete|deluxe|gold|enhanced|legendary|special|premium|anniversary|remastered|remake)\s*(?:edition|version)?.*$/i, '')
        .replace(/\s*(game of the year|goty|definitive|ultimate|complete|deluxe|gold|enhanced|legendary|special|premium|anniversary|remastered|remake)\s*(?:edition|version)?.*$/i, '')
        .trim();
}

/**
 * Score how well a search result title matches the query.
 * Higher is better. Returns 0 for no match.
 */
function scoreMatch(query: string, resultTitle: string): number {
    const normQuery = normalise(query);
    const rawResult = stripRepackSuffix(resultTitle);
    const normResult = normalise(rawResult);

    // Exact match after normalisation
    if (normResult === normQuery) return 100;

    // Exact match after stripping edition suffixes
    const strippedQuery = normalise(stripEdition(query));
    const strippedResult = normalise(stripEdition(rawResult));
    if (strippedResult === strippedQuery) return 90;

    // One contains the other fully
    if (normResult.includes(normQuery)) return 80;
    if (normQuery.includes(normResult)) return 70;

    // Word-level overlap (Jaccard-ish)
    const qWords = new Set(normQuery.split(/\s+/).filter(w => w.length > 1));
    const rWords = new Set(normResult.split(/\s+/).filter(w => w.length > 1));
    if (qWords.size === 0 || rWords.size === 0) return 0;

    let overlap = 0;
    for (const w of qWords) {
        if (rWords.has(w)) overlap++;
    }

    const ratio = overlap / Math.max(qWords.size, rWords.size);
    // Require at least 60% word overlap to consider it a match
    if (ratio < 0.6) return 0;

    return Math.round(ratio * 60); // max 60 for partial matches
}

// Function to search for repacks with a query and optional page number
export async function searchFitGirlRepacks(query: string, page: number = 1): Promise<{
    results: Array<{ url: string; title: string; imageurl: string }> | { message: string };
    currentPage: number;
    lastPage: number;
}> {
    const searchUrl = `${BASE_URL}page/${page}/?s=${encodeURIComponent(query)}`;

    const html = await fetchHTMLWithFallback(searchUrl);

    const regex = /<h1 class="entry-title"><a href="(.+?)" rel="bookmark">(.+?)<\/a><\/h1>/g;
    const matches = [...html.matchAll(regex)];

    // Fetch images for display (only used when browsing search results, not for auto-match)
    const results = await Promise.all(
        matches.map(async (match) => {
            const imageUrl = await fetchImageFromPage(match[1]);
            return {
                url: match[1],
                title: match[2],
                imageurl: imageUrl
            };
        })
    );

    const paginationRegex = /<a class="page-numbers" href="[^"]+\/page\/(\d+)\/\?s=[^"]+">(\d+)<\/a>/g;
    const paginationMatches = [...html.matchAll(paginationRegex)];
    const lastPage = paginationMatches.length > 0 ? Math.max(...paginationMatches.map(match => parseInt(match[1], 10))) : page;

    return {
        results: results.length > 0 ? results : { message: "No results found" },
        currentPage: page,
        lastPage: lastPage
    };
}

/**
 * Search for a game and return the best-matching repack link.
 * Uses title scoring to avoid returning wrong results.
 */
export async function getRepackLinkForGame(gameName: string): Promise<{ url: string; downloadLink: string | null } | null> {
    try {
        const searchUrl = `${BASE_URL}?s=${encodeURIComponent(gameName)}`;
        const html = await fetchHTMLWithFallback(searchUrl);

        // Extract titles and URLs (lightweight — no image fetching)
        const regex = /<h1 class="entry-title"><a href="(.+?)" rel="bookmark">(.+?)<\/a><\/h1>/g;
        const matches = [...html.matchAll(regex)];

        if (matches.length === 0) return null;

        // Score each result against the game name
        let bestMatch: { url: string; title: string; score: number } | null = null;
        for (const m of matches) {
            const url = m[1];
            const title = m[2];
            const score = scoreMatch(gameName, title);
            if (score > 0 && (!bestMatch || score > bestMatch.score)) {
                bestMatch = { url, title, score };
            }
        }

        if (!bestMatch) {
            // No result scored above threshold
            return null;
        }

        const downloadLink = await getRepackDownloadLink(bestMatch.url);
        
        return {
            url: bestMatch.url,
            downloadLink: downloadLink
        };
    } catch (error) {
        console.error(`Failed to get repack link for ${gameName}:`, error);
        return null;
    }
}
