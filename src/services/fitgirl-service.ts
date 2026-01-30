const BASE_URL = "https://fitgirl-repacks.site/";

// Utility function to try fetching without proxy first, and use proxy if it fails
async function fetchHTMLWithFallback(url: string, retries: number = 10): Promise<string> {
    try {
        console.log("Attempting to fetch without proxy...");
        const response = await fetch(url);

        if (response.ok) {
            return await response.text();
        } else {
            throw new Error(`Failed with status: ${response.status}`);
        }
    } catch (error) {
        console.warn(`Direct fetch failed: ${error instanceof Error ? error.message : 'Unknown error'}, switching to proxy.`);
        return await fetchViaProxy(url, retries);
    }
}

// Utility function to make a GET request through the proxy
async function fetchViaProxy(url: string, retries: number = 10): Promise<string> {
    const proxyUrl = `https://www.whateverorigin.org/get?url=${encodeURIComponent(url)}`;

    for (let i = 0; i < retries; i++) {
        try {
            const proxyResponse = await fetch(proxyUrl);
            const proxyData = await proxyResponse.json() as { contents: string };
            return proxyData.contents;
        } catch (error) {
            console.error(`Proxy fetch failed on attempt ${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    throw new Error(`Failed to fetch via proxy after ${retries} attempts`);
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
        
        // Common patterns for FitGirl download links
        // Pattern 1: Direct download links (magnet, torrent, or direct download)
        const patterns = [
            // Magnet link pattern
            /href="(magnet:\?xt=urn:btih:[^"]+)"/i,
            // Torrent file link pattern
            /href="([^"]*\.torrent)"/i,
            // Direct download link pattern (common FitGirl patterns)
            /href="(https?:\/\/[^"]*download[^"]*)"/i,
            // Alternative: Look for download buttons/links with specific classes
            /<a[^>]*class="[^"]*download[^"]*"[^>]*href="([^"]+)"/i,
            // Pattern for FitGirl's specific download section
            /<a[^>]*href="([^"]+)"[^>]*>.*?(?:Download|Magnet|Torrent).*?<\/a>/is,
        ];

        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
                const link = match[1];
                // Validate that it's a valid download link
                if (link.startsWith('magnet:') || 
                    link.endsWith('.torrent') || 
                    link.includes('download') ||
                    link.includes('torrent')) {
                    return link;
                }
            }
        }

        // Alternative: Look for download section in the post content
        const postContentMatch = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        if (postContentMatch) {
            const postContent = postContentMatch[1];
            // Look for links in the post content
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

// Function to search for repacks with a query and optional page number
export async function searchFitGirlRepacks(query: string, page: number = 1): Promise<{
    results: Array<{ url: string; title: string; imageurl: string }> | { message: string };
    currentPage: number;
    lastPage: number;
}> {
    const searchUrl = `${BASE_URL}page/${page}/?s=${encodeURIComponent(query)}`;
    console.log(`Fetching search results from: ${searchUrl}`);

    // Fetch the main search page HTML
    const html = await fetchHTMLWithFallback(searchUrl);

    // Extract titles and URLs using regex
    const regex = /<h1 class="entry-title"><a href="(.+?)" rel="bookmark">(.+?)<\/a><\/h1>/g;
    const matches = [...html.matchAll(regex)];

    // Build the search result list and fetch images
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

    // Extract the total number of pages by finding the pagination section
    const paginationRegex = /<a class="page-numbers" href="[^"]+\/page\/(\d+)\/\?s=[^"]+">(\d+)<\/a>/g;
    const paginationMatches = [...html.matchAll(paginationRegex)];
    const lastPage = paginationMatches.length > 0 ? Math.max(...paginationMatches.map(match => parseInt(match[1], 10))) : page;

    // Return the results along with pagination data
    return {
        results: results.length > 0 ? results : { message: "No results found" },
        currentPage: page,
        lastPage: lastPage
    };
}

// Function to get repack download link for a game by searching and extracting from the first result
export async function getRepackLinkForGame(gameName: string): Promise<{ url: string; downloadLink: string | null } | null> {
    try {
        // Search for the game
        const searchResults = await searchFitGirlRepacks(gameName, 1);
        
        if (!searchResults.results || Array.isArray(searchResults.results) === false || 
            (Array.isArray(searchResults.results) && searchResults.results.length === 0)) {
            return null;
        }

        const results = searchResults.results as Array<{ url: string; title: string; imageurl: string }>;
        
        // Get the first result's download link
        const firstResult = results[0];
        const downloadLink = await getRepackDownloadLink(firstResult.url);
        
        return {
            url: firstResult.url,
            downloadLink: downloadLink
        };
    } catch (error) {
        console.error(`Failed to get repack link for ${gameName}:`, error);
        return null;
    }
}
