/**
 * Metacritic API Client
 * Custom implementation for scraping Metacritic reviews
 */

import https from 'https';

// Cache for Metacritic reviews to reduce scraping
const reviewsCache = new Map<string, { data: MetacriticGameResponse | null; timestamp: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour cache

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
  release_date: string;
  reviews: MetacriticReview[];
}

/**
 * Make an HTTPS request with proper headers
 */
function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    };

    https.get(url, options, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = res.headers.location;
        if (redirectUrl) {
          fetchUrl(redirectUrl).then(resolve).catch(reject);
          return;
        }
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Extract text between two strings
 */
function extractBetween(html: string, start: string, end: string): string {
  const startIdx = html.indexOf(start);
  if (startIdx === -1) return '';
  const endIdx = html.indexOf(end, startIdx + start.length);
  if (endIdx === -1) return '';
  return html.substring(startIdx + start.length, endIdx).trim();
}

/**
 * Create URL-friendly slug from game name
 */
function createSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
}

/**
 * Try multiple URL patterns to find the game on Metacritic
 */
async function tryFetchWithPatterns(gameName: string): Promise<string | null> {
  const slug = createSlug(gameName);
  
  // Try different URL patterns that Metacritic uses
  const urlPatterns = [
    `https://www.metacritic.com/game/${slug}/`,
    `https://www.metacritic.com/game/${slug}/critic-reviews/`,
    `https://www.metacritic.com/game/pc/${slug}/`,
    `https://www.metacritic.com/game/pc/${slug}/critic-reviews/`,
    `https://www.metacritic.com/game/playstation-5/${slug}/`,
    `https://www.metacritic.com/game/playstation-4/${slug}/`,
    `https://www.metacritic.com/game/xbox-series-x/${slug}/`,
  ];
  
  for (const url of urlPatterns) {
    try {
      console.log(`[Metacritic] Trying: ${url}`);
      const html = await fetchUrl(url);
      if (html && html.length > 1000) {
        return html;
      }
    } catch {
      // Try next pattern
    }
  }
  
  return null;
}

/**
 * Fetch game reviews from Metacritic
 * @param gameName - The name of the game to search for
 * @returns Metacritic review data or null if not found
 */
export async function fetchMetacriticReviews(gameName: string): Promise<MetacriticGameResponse | null> {
  // Normalize game name for cache key
  const cacheKey = gameName.toLowerCase().trim();
  
  // Check cache
  const cached = reviewsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`[Metacritic] Using cached reviews for: ${gameName}`);
    return cached.data;
  }

  try {
    console.log(`[Metacritic] Fetching reviews for: ${gameName}`);
    
    // Try multiple URL patterns
    const html = await tryFetchWithPatterns(gameName);
    
    if (!html) {
      console.log(`[Metacritic] Could not find page for: ${gameName}`);
      reviewsCache.set(cacheKey, { data: null, timestamp: Date.now() });
      return null;
    }
    
    // Try to extract Metascore from the page
    let score = 0;
    const scoreMatch = html.match(/metascore[^>]*>(\d+)</i) || 
                       html.match(/"score":(\d+)/);
    if (scoreMatch) {
      score = parseInt(scoreMatch[1], 10);
    }

    // Try to extract reviews from structured data or page content
    const reviews: MetacriticReview[] = [];
    
    // Look for JSON-LD structured data
    const jsonLdMatch = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
    if (jsonLdMatch) {
      for (const match of jsonLdMatch) {
        try {
          const jsonContent = match.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
          const data = JSON.parse(jsonContent);
          
          if (data.aggregateRating?.ratingValue) {
            score = parseInt(data.aggregateRating.ratingValue, 10);
          }
          
          if (data.review && Array.isArray(data.review)) {
            for (const r of data.review.slice(0, 5)) {
              reviews.push({
                review: r.reviewBody || r.description || '',
                review_critic: r.author?.name || r.publisher?.name || '',
                author: r.author?.name || '',
                review_date: r.datePublished || '',
                review_grade: r.reviewRating?.ratingValue?.toString() || '',
              });
            }
          }
        } catch {
          // Continue if JSON parsing fails
        }
      }
    }

    if (score === 0 && reviews.length === 0) {
      console.log(`[Metacritic] No data found for: ${gameName}`);
      reviewsCache.set(cacheKey, { data: null, timestamp: Date.now() });
      return null;
    }

    const response: MetacriticGameResponse = {
      title: gameName,
      poster: '',
      score,
      release_date: '',
      reviews,
    };

    console.log(`[Metacritic] Found score ${score} and ${reviews.length} reviews for: ${gameName}`);
    
    // Cache the result
    reviewsCache.set(cacheKey, { data: response, timestamp: Date.now() });
    
    return response;
  } catch (error) {
    console.error(`[Metacritic] Error fetching reviews for ${gameName}:`, error);
    // Cache the failure to avoid repeated failed requests
    reviewsCache.set(cacheKey, { data: null, timestamp: Date.now() });
    return null;
  }
}

/**
 * Clear the Metacritic reviews cache
 */
export function clearMetacriticCache(): void {
  reviewsCache.clear();
  console.log('[Metacritic] Cache cleared');
}

