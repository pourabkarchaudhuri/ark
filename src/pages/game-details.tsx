import { useState, useEffect, useMemo, useRef, useCallback, memo, type MouseEvent } from 'react';
import { useRoute, useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import DOMPurify from 'dompurify';
import { 
  ArrowLeft, 
  Calendar, 
  Users, 
  Star, 
  ThumbsUp, 
  ThumbsDown, 
  Clock,
  ExternalLink,
  Heart,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Play,
  Monitor,
  Cpu,
  Download,
} from 'lucide-react';
import { FaWindows, FaApple, FaLinux, FaSteam } from 'react-icons/fa';
import { SiEpicgames, SiSteam } from 'react-icons/si';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { GameDialog } from '@/components/game-dialog';
import { cn } from '@/lib/utils';
import { SteamAppDetails, SteamReviewsResponse, GameRecommendation, SteamNewsItem } from '@/types/steam';
import { MetacriticGameResponse } from '@/types/metacritic';
import { Game } from '@/types/game';
import { useLibrary, extractCachedMeta } from '@/hooks/useGameStore';
import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';
import { GameDialogInitialEntry } from '@/components/game-dialog';
import { useToast } from '@/components/ui/toast';
import { getRepackLinkForGame } from '@/services/fitgirl-service';
import { steamService } from '@/services/steam-service';
import { epicService } from '@/services/epic-service';
import { findGameById, searchPrefetchedGames, getPrefetchedGames } from '@/services/prefetch-store';
import { WindowControls } from '@/components/window-controls';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { MyProgressTab, MyProgressSkeleton } from '@/components/my-progress-tab';
import { Gamepad2, BarChart3 } from 'lucide-react';
import { Carousel, BlurImage, type CardType } from '@/components/ui/apple-cards-carousel';

// ─── Epic → SteamAppDetails Normalizer ───────────────────────────────────────
// Converts an Epic `Game` object into a `SteamAppDetails`-compatible shape so
// the same unified layout renders for both stores.  Sections that have no data
// simply won't render (conditional checks throughout the UI handle this).
//
// `productContent` is optional rich data from the Epic CMS REST endpoint
// (store-content.ak.epicgames.com) — it provides the full HTML "About the
// Game" description and per-platform system requirements.
function epicToSteamDetails(
  game: Game,
  productContent?: {
    about?: string;
    requirements?: Array<{
      systemType: string;
      details: Array<{
        title: string;
        minimum: Record<string, string>;
        recommended: Record<string, string>;
      }>;
    }>;
    gallery?: Array<{ type: 'image' | 'video'; url: string; thumbnail?: string }>;
  } | null,
): SteamAppDetails {
  const hasWindows = game.platform?.some(p => /win|pc/i.test(p)) ?? true;
  const hasMac = game.platform?.some(p => /mac|osx/i.test(p)) ?? false;
  const hasLinux = game.platform?.some(p => /linux/i.test(p)) ?? false;

  // ── Description hierarchy ─────────────────────────────────────────────
  // 1. Product content "about" (full rich HTML from CMS)
  // 2. Game.longDescription (from GraphQL catalogOffer — often Markdown, convert it)
  // 3. Game.summary (short description fallback)
  const longDescHtml = game.longDescription ? markdownToHtml(game.longDescription) : '';
  const fullDescription = productContent?.about || longDescHtml || game.summary || '';
  const shortDescription = game.summary || '';

  // ── System requirements (from CMS product content) ────────────────────
  // Epic CMS stores requirements per-platform in varying shapes:
  //   • Object  { "GPU": "RTX 3070", "CPU": "i7-8700" }  → render as key-value list
  //   • String  "Intel HD 4000, ..."                       → render as plain text
  //   • Array   ["Intel HD 4000", ...]                     → join and render
  // Convert to HTML strings matching Steam's pc_requirements format.
  let pcRequirements: { minimum?: string; recommended?: string } = {};

  /** Convert a CMS spec value (object | string | array | unknown) to an HTML string */
  const specsToHtml = (specs: unknown): string | undefined => {
    if (!specs) return undefined;
    // Plain string — render as-is (wrapped in a paragraph)
    if (typeof specs === 'string') {
      const trimmed = specs.trim();
      return trimmed ? `<p>${trimmed}</p>` : undefined;
    }
    // Array of strings — join with line breaks
    if (Array.isArray(specs)) {
      const items = specs.filter(s => typeof s === 'string' && s.trim());
      return items.length > 0
        ? '<ul class="bb_ul">' + items.map(s => `<li>${s}</li>`).join('') + '</ul>'
        : undefined;
    }
    // Object with key-value pairs — render as definition list
    if (typeof specs === 'object') {
      const entries = Object.entries(specs as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '');
      return entries.length > 0
        ? '<ul class="bb_ul">' + entries.map(([k, v]) => `<li><strong>${k}:</strong> ${String(v)}</li>`).join('') + '</ul>'
        : undefined;
    }
    return undefined;
  };

  if (productContent?.requirements) {
    for (const system of productContent.requirements) {
      if (/windows|pc/i.test(system.systemType)) {
        for (const detail of system.details) {
          if (!pcRequirements.minimum) {
            pcRequirements.minimum = specsToHtml(detail.minimum);
          }
          if (!pcRequirements.recommended) {
            pcRequirements.recommended = specsToHtml(detail.recommended);
          }
        }
      }
    }
  }

  // ── Store URL ─────────────────────────────────────────────────────────
  const epicStoreUrl = game.epicSlug
    ? `https://store.epicgames.com/en-US/p/${game.epicSlug}`
    : null;

  return {
    type: 'game',
    name: game.title,
    steam_appid: game.steamAppId || 0,
    required_age: 0,
    is_free: game.price?.isFree ?? false,
    detailed_description: fullDescription,
    about_the_game: fullDescription,
    short_description: shortDescription,
    supported_languages: '',
    header_image: game.headerImage || game.coverUrl || '',
    capsule_image: game.coverUrl || game.headerImage || '',
    capsule_imagev5: game.coverUrl || game.headerImage || '',
    website: epicStoreUrl,
    pc_requirements: pcRequirements,
    developers: game.developer && game.developer !== 'Unknown Developer' ? [game.developer] : undefined,
    publishers: game.publisher && game.publisher !== 'Unknown Publisher' ? [game.publisher] : undefined,
    price_overview: game.price && !game.price.isFree && game.price.finalFormatted ? {
      currency: 'INR',
      initial: 0,
      final: 0,
      discount_percent: game.price.discountPercent || 0,
      final_formatted: game.price.finalFormatted,
    } : undefined,
    platforms: { windows: hasWindows, mac: hasMac, linux: hasLinux },
    metacritic: game.metacriticScore ? { score: game.metacriticScore, url: '' } : undefined,
    genres: game.genre?.map((g, i) => ({ id: String(i), description: g })),
    screenshots: (() => {
      // Prefer CMS gallery screenshots (real gameplay images) over keyImages (marketing covers)
      const galleryImages = productContent?.gallery
        ?.filter(g => g.type === 'image')
        .map((g, i) => ({ id: i, path_thumbnail: g.url, path_full: g.url }));

      if (galleryImages && galleryImages.length > 0) return galleryImages;

      // Fall back to keyImages-based screenshots from the Game object
      return game.screenshots?.map((url, i) => ({
        id: i,
        path_thumbnail: url,
        path_full: url,
      }));
    })(),
    // Map CMS gallery videos to the movies array
    movies: (() => {
      const galleryVideos = productContent?.gallery?.filter(g => g.type === 'video');
      if (!galleryVideos || galleryVideos.length === 0) return undefined;
      return galleryVideos.map((v, i) => ({
        id: i,
        name: `Video ${i + 1}`,
        thumbnail: v.thumbnail || game.headerImage || '',
        mp4: { '480': v.url, max: v.url },
      }));
    })(),
    release_date: game.releaseDate ? {
      coming_soon: game.comingSoon ?? false,
      date: (() => {
        // Format ISO dates to human-readable (e.g. "Mar 2, 2026") to match Steam
        try {
          const d = new Date(game.releaseDate);
          if (!isNaN(d.getTime()) && d.getFullYear() > 1970) {
            return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
          }
        } catch { /* fall through */ }
        return game.releaseDate;
      })(),
    } : undefined,
    background: game.headerImage || game.coverUrl || '',
  };
}

// Check if running in Electron
function isElectron(): boolean {
  return typeof window !== 'undefined' && typeof window.steam !== 'undefined';
}

// Open URL in default OS browser (uses Electron shell.openExternal)
function openExternalUrl(url: string): void {
  if (window.electron?.openExternal) {
    window.electron.openExternal(url);
  } else {
    // Fallback for browser development
    window.open(url, '_blank');
  }
}

// ---------------------------------------------------------------------------
// Lightweight Markdown → HTML converter for Epic's longDescription field.
// Epic's GraphQL catalogOffer returns longDescription as Markdown, not HTML.
// When the CMS "about" (rich HTML) is unavailable, we fall back to
// longDescription and need to render it properly instead of showing raw
// markdown symbols (#, **, *, -, etc.).
// ---------------------------------------------------------------------------
function markdownToHtml(md: string): string {
  if (!md) return md;

  // If it already looks like HTML (has tags), return as-is
  if (/<[a-z][\s\S]*>/i.test(md)) return md;

  let html = md;

  // Escape ampersands that aren't already entities
  html = html.replace(/&(?!#?\w+;)/g, '&amp;');

  // Images: ![alt](url)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,
    '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px;margin:12px 0;" loading="lazy" />');

  // Links: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Headings: ### → h3, ## → h2, # → h1 (must be at start of line)
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Horizontal rules
  html = html.replace(/^---+$/gm, '<hr/>');
  html = html.replace(/^\*\*\*+$/gm, '<hr/>');

  // Bold + Italic: ***text*** or ___text___
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');

  // Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic: *text* or _text_ (but not mid-word underscores like file_name)
  html = html.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<em>$1</em>');
  html = html.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<em>$1</em>');

  // Unordered lists: lines starting with - or * (not hr)
  // Collect consecutive list lines into <ul>
  html = html.replace(/((?:^[\t ]*[-*] .+\n?)+)/gm, (block) => {
    const items = block
      .split('\n')
      .filter(l => l.trim())
      .map(l => `<li>${l.replace(/^[\t ]*[-*] /, '')}</li>`)
      .join('');
    return `<ul>${items}</ul>`;
  });

  // Paragraphs: split on double newlines
  html = html
    .split(/\n{2,}/)
    .map(p => {
      const trimmed = p.trim();
      if (!trimmed) return '';
      // Don't wrap block-level elements in <p>
      if (/^<(?:h[1-6]|ul|ol|li|hr|img|div|blockquote|table|pre)/i.test(trimmed)) return trimmed;
      return `<p>${trimmed}</p>`;
    })
    .join('\n');

  // Single newlines within paragraphs → <br>
  html = html.replace(/<p>([\s\S]*?)<\/p>/g, (_, inner) => {
    return `<p>${inner.replace(/\n/g, '<br/>')}</p>`;
  });

  return html;
}

// ---------------------------------------------------------------------------
// Embed bare image URLs found in Epic game descriptions.
// Epic's longDescription (and sometimes CMS "about") contains raw URLs to
// images (e.g. https://cdn1.epicgames.com/…/Screenshot.png) that are not
// wrapped in <img> tags.  This function detects those URLs and converts them
// to inline <img> elements so they render like Steam's about-the-game section.
//
// It carefully avoids converting URLs that are already inside an HTML tag
// (src="…", href="…") or BBCode [img]…[/img] blocks.
// ---------------------------------------------------------------------------
const RE_BARE_IMAGE_URL = /(?<![="'\w/])(?<!\[img\])(https?:\/\/[^\s<>"']+\.(?:png|jpg|jpeg|gif|webp|bmp|svg)(?:\?[^\s<>"']*)?)(?!\[\/img\])/gi;

function embedDescriptionImages(html: string): string {
  if (!html) return html;

  // Quick bail — if there are no image-extension URLs at all, skip the regex work
  if (!/\.(?:png|jpg|jpeg|gif|webp|bmp|svg)/i.test(html)) return html;

  return html.replace(RE_BARE_IMAGE_URL, (url) => {
    return `<img src="${url}" alt="" style="max-width:100%;border-radius:8px;margin:12px 0;" loading="lazy" />`;
  });
}

// Intercept link clicks in HTML content (description, requirements, etc.) so they open in system browser
function handleContentLinkClick(e: MouseEvent<HTMLDivElement>): void {
  const target = e.target as HTMLElement;
  const anchor = target.closest('a');
  if (anchor?.href && (anchor.href.startsWith('http:') || anchor.href.startsWith('https:'))) {
    e.preventDefault();
    openExternalUrl(anchor.href);
  }
}

// Extract the first image URL from Steam news BBCode/HTML contents.
// Supports [img]url[/img], {STEAM_CLAN_IMAGE}/path, and <img src="url"> patterns.
//
// Regexes are pre-compiled at module level to avoid re-creation on every call
// (this function runs once per news item in a .map loop).
const STEAM_CLAN_IMAGE_BASE = 'https://clan.akamai.steamstatic.com/images/';
const RE_BBCODE_IMG = /\[img\](.*?)\[\/img\]/i;
const RE_CLAN_IMAGE = /\{STEAM_CLAN_IMAGE\}\/([\w/.-]+)/;
const RE_HTML_IMG = /<img[^>]+src=["']([^"']+)["']/i;

function extractNewsThumbnail(contents?: string): string | null {
  if (!contents) return null;

  // 1. BBCode [img] tags — may contain {STEAM_CLAN_IMAGE}
  const bbcodeMatch = contents.match(RE_BBCODE_IMG);
  if (bbcodeMatch) {
    let src = bbcodeMatch[1].trim();
    if (src.startsWith('{STEAM_CLAN_IMAGE}')) {
      src = src.replace('{STEAM_CLAN_IMAGE}', STEAM_CLAN_IMAGE_BASE);
    }
    if (src.startsWith('http')) return src;
  }

  // 2. Inline {STEAM_CLAN_IMAGE} references outside of [img] tags
  const clanMatch = contents.match(RE_CLAN_IMAGE);
  if (clanMatch) {
    return `${STEAM_CLAN_IMAGE_BASE}${clanMatch[1]}`;
  }

  // 3. HTML <img> tags
  const htmlImgMatch = contents.match(RE_HTML_IMG);
  if (htmlImgMatch) {
    const src = htmlImgMatch[1];
    if (src.startsWith('http')) return src;
  }

  return null;
}

// Format minutes to hours and minutes
function formatPlaytime(minutes: number): string {
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'Min' : 'Mins'}`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const hrLabel = hours === 1 ? 'Hr' : 'Hrs';
  if (mins === 0) return `${hours} ${hrLabel}`;
  const minLabel = mins === 1 ? 'Min' : 'Mins';
  return `${hours} ${hrLabel} ${mins} ${minLabel}`;
}

// Review score color — pure function, kept outside components to avoid re-creation
function getScoreColor(score?: number): string {
  if (!score) return 'text-white/60';
  if (score >= 75) return 'text-green-400';
  if (score >= 50) return 'text-yellow-400';
  return 'text-red-400';
}

// Format player count with K/M suffixes
function formatPlayerCount(count: number): string {
  if (count >= 1_000_000) {
    const m = count / 1_000_000;
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (count >= 1_000) {
    const k = count / 1_000;
    return k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, '')}K`;
  }
  return count.toLocaleString();
}

// Format Unix timestamp to readable date
function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Recommendation image with React-controlled fallback chain.
 * Uses state instead of direct DOM mutation so parent re-renders don't reset the chain.
 */
function RecommendationImage({ appId, name }: { appId: number; name: string }) {
  const cdnBase = 'https://cdn.akamai.steamstatic.com/steam/apps';
  const urls = useMemo(() => [
    `${cdnBase}/${appId}/header.jpg`,
    `${cdnBase}/${appId}/capsule_616x353.jpg`,
    `${cdnBase}/${appId}/library_hero.jpg`,
  ], [appId]);

  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);

  const advance = useCallback(() => {
    if (attempt < urls.length - 1) {
      setAttempt(prev => prev + 1);
    } else {
      setFailed(true);
    }
  }, [attempt, urls.length]);

  if (failed) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-white/5 text-white/30 text-xs">
        {name}
      </div>
    );
  }

  return (
    <img
      src={urls[attempt]}
      alt={name}
      className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
      onLoad={(e) => {
        const img = e.currentTarget;
        if (img.naturalWidth < 50 || img.naturalHeight < 50) advance();
      }}
      onError={advance}
    />
  );
}

/**
 * News Card — clean image card with a bottom gradient overlay.
 * Shows title, date published, and news source for readability.
 * Clicking opens the article URL externally.
 * Uses BlurImage for smooth lazy loading with a blur-up effect.
 */
function NewsCard({
  card,
  newsItem,
  fallbackImage,
}: {
  card: CardType;
  newsItem: SteamNewsItem;
  fallbackImage: string;
}) {
  const [imgSrc, setImgSrc] = useState(card.src);

  const handleClick = () => {
    const url = newsItem.url;
    if (!url || (!url.startsWith('http:') && !url.startsWith('https:'))) return;
    openExternalUrl(url);
  };

  return (
    <motion.button
      onClick={handleClick}
      className="relative z-10 flex h-52 w-40 flex-col items-start justify-end overflow-hidden rounded-2xl bg-neutral-900 md:h-72 md:w-52 group flex-shrink-0"
    >
      {/* Bottom gradient overlay — dark fade for text readability */}
      <div className="pointer-events-none absolute inset-0 z-20 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />

      {/* Title + date at the bottom */}
      <div className="relative z-30 p-3 md:p-4 w-full">
        <p className="text-left text-xs font-semibold leading-snug text-white line-clamp-2 md:text-sm">
          {card.title}
        </p>
        <p className="text-left text-[10px] text-white/50 mt-1 md:text-xs">
          {new Date(newsItem.date * 1000).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })}
        </p>
        {newsItem.feedlabel && (
          <p className="text-left text-[9px] text-white/30 mt-0.5 md:text-[10px] truncate">
            {newsItem.feedlabel}
          </p>
        )}
      </div>

      {/* Background image with blur-up lazy loading */}
      <BlurImage
        src={imgSrc}
        alt={card.title}
        className="absolute inset-0 z-10 object-cover group-hover:scale-105 transition-transform duration-500"
        onError={() => {
          if (imgSrc !== fallbackImage) {
            setImgSrc(fallbackImage);
          }
        }}
      />
    </motion.button>
  );
}

/** Return the dashboard URL. View is restored from sessionStorage on mount. */
function getBackToDashboardUrl(): string {
  return '/';
}

/**
 * Error / "game not found" fallback with auto-redirect to dashboard.
 * Prevents the app from getting stuck on a broken details page on cold-start.
 */
function ErrorFallback({ error, navigate }: { error: string | null; navigate: (to: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => navigate(getBackToDashboardUrl()), 5000);
    return () => clearTimeout(timer);
  }, [navigate]);

  return (
    <div className="min-h-screen bg-black flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 app-drag-region">
        <div />
        <WindowControls />
      </div>
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-red-400 text-xl">{error || 'Game not found'}</p>
          <p className="text-white/40 text-sm">Redirecting to dashboard in 5 seconds...</p>
          <Button onClick={() => navigate(getBackToDashboardUrl())} variant="outline">
            <ArrowLeft className="w-4 h-4 mr-2 pointer-events-none" />
            Back to Dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}

export function GameDetailsPage() {
  const [, params] = useRoute('/game/:id') as [boolean, Record<string, string> | null];
  const [, navigate] = useLocation();

  // Decode the URL param — supports "steam-730", "epic-namespace:offerId", or legacy numeric "730"
  const rawId = params?.id ? decodeURIComponent(params.id) : null;
  const gameId = rawId
    ? rawId.match(/^\d+$/) ? `steam-${rawId}` : rawId  // Legacy numeric → "steam-N"
    : null;
  const isSteamGame = gameId?.startsWith('steam-') ?? false;
  const isEpicGame = gameId?.startsWith('epic-') ?? false;
  const isCustomGame = gameId?.startsWith('custom-') ?? false;
  const appId = isSteamGame ? parseInt(gameId!.slice(6), 10) : null;

  const [details, setDetails] = useState<SteamAppDetails | null>(null);
  const [epicGame, setEpicGame] = useState<Game | null>(null);
  // Cross-store metadata from prefetch (e.g., price/link from the "other" store)
  const [crossStoreGame, setCrossStoreGame] = useState<Game | null>(null);
  const [reviews, setReviews] = useState<SteamReviewsResponse | null>(null);
  const [metacriticReviews, setMetacriticReviews] = useState<MetacriticGameResponse | null>(null);
  const [metacriticLoading, setMetacriticLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentMediaIndex, setCurrentMediaIndex] = useState(0);
  const [showFullDescription, setShowFullDescription] = useState(false);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [thumbnailsLoaded, setThumbnailsLoaded] = useState<Set<number>>(() => new Set());
  // Stable callback that batches thumbnail-loaded updates without creating a new
  // Set on every single onLoad.  The ref tracks pending indices and a microtask
  // flushes them into state in one batch.
  const pendingThumbsRef = useRef<number[]>([]);
  const thumbFlushScheduledRef = useRef(false);
  const markThumbnailLoaded = useCallback((index: number) => {
    pendingThumbsRef.current.push(index);
    if (!thumbFlushScheduledRef.current) {
      thumbFlushScheduledRef.current = true;
      queueMicrotask(() => {
        thumbFlushScheduledRef.current = false;
        const pending = pendingThumbsRef.current;
        pendingThumbsRef.current = [];
        if (pending.length === 0) return;
        setThumbnailsLoaded(prev => {
          const next = new Set(prev);
          for (const idx of pending) next.add(idx);
          return next;
        });
      });
    }
  }, []);
  const [isAutoplayPaused, setIsAutoplayPaused] = useState(false);
  const [headerImageError, setHeaderImageError] = useState(false);
  const [headerImageLoaded, setHeaderImageLoaded] = useState(false);
  const [heroBgLoaded, setHeroBgLoaded] = useState(false);
  const [recommendations, setRecommendations] = useState<GameRecommendation[]>([]);
  const [recommendationsLoading, setRecommendationsLoading] = useState(false);
  const [fitgirlRepack, setFitgirlRepack] = useState<{ url: string; downloadLink: string | null } | null>(null);
  const [fitgirlLoading, setFitgirlLoading] = useState(false);
  const [isRecommendationsPaused, setIsRecommendationsPaused] = useState(false);
  const [steamNews, setSteamNews] = useState<SteamNewsItem[]>([]);
  const [steamNewsLoading, setSteamNewsLoading] = useState(false);
  const [playerCount, setPlayerCount] = useState<number | null>(null);
  // Epic-specific enrichment
  const [epicNews, setEpicNews] = useState<import('@/types/epic').EpicNewsArticle[]>([]);
  const [epicNewsLoading, setEpicNewsLoading] = useState(false);
  const [epicReviews, setEpicReviews] = useState<import('@/types/epic').EpicProductReviews | null>(null);
  const [epicAddons, setEpicAddons] = useState<import('@/types/epic').EpicAddon[]>([]);
  
  const autoplayTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const resumeAutoplayTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const recommendationsScrollRef = useRef<HTMLDivElement>(null);
  const recommendationsAutoScrollRef = useRef<NodeJS.Timeout | null>(null);
  
  // Ref mirror of currentMediaIndex — lets callbacks read the latest value
  // without adding it as a dependency (prevents needless re-creation every 5s
  // autoplay tick, which would otherwise bust GameDetailsContent's memo).
  const currentMediaIndexRef = useRef(currentMediaIndex);
  currentMediaIndexRef.current = currentMediaIndex;
  
  
  // Scroll to top when page loads or gameId changes
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [gameId]);
  
  // Library management
  const { addToLibrary, removeFromLibrary, isInLibrary, updateEntry, getAllGameIds } = useLibrary();
  const gameInLibrary = gameId ? isInLibrary(gameId) : false;
  const { success: toastSuccess } = useToast();

  // Track whether the game was already in the library when this page loaded.
  // If the user adds it during this session, we keep showing the details view
  // instead of immediately switching to the My Progress tab.
  const wasInLibraryOnLoad = useRef<boolean | null>(null);
  if (wasInLibraryOnLoad.current === null && gameId) {
    wasInLibraryOnLoad.current = gameInLibrary;
  }
  // Reset when navigating to a different game
  useEffect(() => {
    wasInLibraryOnLoad.current = null;
  }, [gameId]);

  const showProgressTabs = isCustomGame || (gameInLibrary && wasInLibraryOnLoad.current === true);
  
  // Dialog state for add to library / edit library entry
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [dialogGame, setDialogGame] = useState<Game | null>(null);
  const [dialogInitialEntry, setDialogInitialEntry] = useState<GameDialogInitialEntry | null>(null);
  
  // Convert details to Game object for the dialog
  const createGameFromDetails = useCallback((): Game | null => {
    // Epic games: use epicGame directly
    if (epicGame) {
      return { ...epicGame, isInLibrary: gameInLibrary };
    }

    // Custom games: build from customGameStore + libraryStore
    if (isCustomGame && gameId) {
      const customEntry = customGameStore.getGame(gameId);
      const libEntry = libraryStore.getEntry(gameId);
      if (!customEntry && !libEntry) return null;
      return {
        id: gameId,
        title: customEntry?.title ?? libEntry?.cachedMeta?.title ?? 'Custom Game',
        developer: 'Custom Game',
        publisher: '',
        genre: libEntry?.cachedMeta?.genre ?? [],
        platform: customEntry?.platform ?? [],
        metacriticScore: null,
        releaseDate: '',
        summary: '',
        coverUrl: libEntry?.cachedMeta?.coverUrl ?? '',
        status: customEntry?.status ?? libEntry?.status ?? 'Want to Play',
        priority: customEntry?.priority ?? libEntry?.priority ?? 'Medium',
        publicReviews: customEntry?.publicReviews ?? libEntry?.publicReviews ?? '',
        recommendationSource: customEntry?.recommendationSource ?? libEntry?.recommendationSource ?? 'Personal Discovery',
        isCustom: true,
        createdAt: customEntry?.addedAt ?? new Date(),
        updatedAt: customEntry?.updatedAt ?? new Date(),
        isInLibrary: true,
      };
    }

    if (!details || !appId) return null;
    
    const platforms: string[] = [];
    if (details.platforms?.windows) platforms.push('Windows');
    if (details.platforms?.mac) platforms.push('Mac');
    if (details.platforms?.linux) platforms.push('Linux');
    
    return {
      id: `steam-${appId}`,
      steamAppId: appId,
      title: details.name,
      developer: details.developers?.join(', ') || 'Unknown',
      publisher: details.publishers?.join(', ') || 'Unknown',
      genre: details.genres?.map(g => g.description) || [],
      platform: platforms,
      metacriticScore: details.metacritic?.score || null,
      releaseDate: details.release_date?.date || '',
      summary: details.short_description,
      coverUrl: details.header_image,
      status: 'Want to Play',
      priority: 'Medium',
      publicReviews: '',
      recommendationSource: 'Personal Discovery',
      createdAt: new Date(),
      updatedAt: new Date(),
      isInLibrary: gameInLibrary,
    };
  }, [details, appId, epicGame, gameInLibrary, isCustomGame, gameId]);
  
  // Handle opening the add to library dialog
  const handleDialogOpenChange = useCallback((open: boolean) => {
    setIsDialogOpen(open);
    if (!open) {
      setDialogGame(null);
      setDialogInitialEntry(null);
    }
  }, []);

  const handleOpenLibraryDialog = useCallback(() => {
    const game = createGameFromDetails();
    if (game) {
      setDialogGame(game);

      // If already in library, open in edit mode with current values pre-filled
      if (gameId && (gameInLibrary || isCustomGame)) {
        const libEntry = libraryStore.getEntry(gameId);
        const customEntry = isCustomGame ? customGameStore.getGame(gameId) : null;
        setDialogInitialEntry({
          status: libEntry?.status ?? customEntry?.status ?? 'Want to Play',
          priority: libEntry?.priority ?? customEntry?.priority ?? 'Medium',
          publicReviews: libEntry?.publicReviews ?? customEntry?.publicReviews ?? '',
          recommendationSource: libEntry?.recommendationSource ?? customEntry?.recommendationSource ?? 'Personal Discovery',
          executablePath: libEntry?.executablePath ?? customEntry?.executablePath,
        });
      } else {
        setDialogInitialEntry(null);
      }

      setIsDialogOpen(true);
    }
  }, [createGameFromDetails, gameId, gameInLibrary, isCustomGame]);
  
  // Handle saving library entry from dialog
  const handleSaveLibraryEntry = useCallback((gameData: Partial<Game> & { executablePath?: string }) => {
    if (!gameId) return;
    
    const isNewAdd = !gameInLibrary && !isCustomGame;
    const gameName = details?.name || epicGame?.title || 'Game';
    
    if (isCustomGame) {
      // Custom games live in customGameStore, not libraryStore
      customGameStore.updateGame(gameId, {
        status: gameData.status,
        priority: gameData.priority,
        publicReviews: gameData.publicReviews,
        recommendationSource: gameData.recommendationSource,
        executablePath: gameData.executablePath,
      });
    } else if (gameInLibrary) {
      // Update existing entry
      updateEntry(gameId, {
        status: gameData.status,
        priority: gameData.priority,
        publicReviews: gameData.publicReviews,
        recommendationSource: gameData.recommendationSource,
        executablePath: gameData.executablePath,
      });
    } else {
      // Add to library — cache metadata for offline resilience
      const meta = dialogGame ? extractCachedMeta(dialogGame) : undefined;
      addToLibrary(gameId, gameData.status || 'Want to Play', meta);
      // Then update with additional fields if provided
      if (gameData.priority || gameData.publicReviews || gameData.recommendationSource || gameData.executablePath) {
        updateEntry(gameId, {
          priority: gameData.priority,
          publicReviews: gameData.publicReviews,
          recommendationSource: gameData.recommendationSource,
          executablePath: gameData.executablePath,
        });
      }
    }
    
    setIsDialogOpen(false);
    setDialogGame(null);
    setDialogInitialEntry(null);

    if (isNewAdd) {
      toastSuccess(`${gameName} added to your library!`);
    } else {
      toastSuccess(`${gameName} updated successfully`);
    }
  }, [gameId, gameInLibrary, isCustomGame, addToLibrary, updateEntry, details, epicGame, toastSuccess]);

  // Fetch game details and reviews - uses prefetch store first, then API
  useEffect(() => {
    if (!gameId) {
      // No valid game ID — redirect to dashboard to avoid stuck state
      navigate('/');
      return;
    }

    const controller = new AbortController();

    const fetchData = async () => {
      // Reset ALL state to avoid stale data from the previous game bleeding through
      setLoading(true);
      setError(null);
      setDetails(null);
      setEpicGame(null);
      setCrossStoreGame(null);
      setReviews(null);
      setMetacriticReviews(null);
      setMetacriticLoading(false);
      setCurrentMediaIndex(0);
      setShowFullDescription(false);
      setMediaLoading(true);
      setThumbnailsLoaded(new Set());
      setIsAutoplayPaused(false);
      setHeaderImageError(false);
      setHeaderImageLoaded(false);
      setHeroBgLoaded(false);
      setRecommendations([]);
      setRecommendationsLoading(false);
      setFitgirlRepack(null);
      setFitgirlLoading(false);
      setIsRecommendationsPaused(false);
      setEpicNews([]);
      setEpicNewsLoading(false);
      setEpicReviews(null);
      setEpicAddons([]);
      setSteamNews([]);
      setSteamNewsLoading(false);
      setPlayerCount(null);

      try {
        // --- Custom Games (no API calls needed) ---
        if (isCustomGame) {
          const customEntry = customGameStore.getGame(gameId);
          const libEntry = libraryStore.getEntry(gameId);

          if (!customEntry && !libEntry) {
            if (!controller.signal.aborted) setError('Custom game not found');
            return;
          }

          const title = customEntry?.title ?? libEntry?.cachedMeta?.title ?? 'Custom Game';
          const platforms = customEntry?.platform ?? [];

          // Build a minimal SteamAppDetails-compatible object
          const customDetails: SteamAppDetails = {
            type: 'game',
            name: title,
            steam_appid: 0,
            required_age: 0,
            is_free: false,
            detailed_description: '',
            about_the_game: '',
            short_description: '',
            supported_languages: '',
            header_image: libEntry?.cachedMeta?.coverUrl ?? '',
            capsule_image: '',
            capsule_imagev5: '',
            website: null,
            developers: ['Custom Game'],
            publishers: [],
            platforms: {
              windows: platforms.some(p => /win|pc/i.test(p)),
              mac: platforms.some(p => /mac|osx/i.test(p)),
              linux: platforms.some(p => /linux/i.test(p)),
            },
            categories: [],
            genres: (libEntry?.cachedMeta?.genre ?? []).map((g, i) => ({ id: String(i), description: g })),
            screenshots: [],
            movies: [],
            release_date: {
              coming_soon: false,
              date: customEntry?.addedAt
                ? new Date(customEntry.addedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                : 'Custom Game',
            },
            pc_requirements: {},
          };

          if (!controller.signal.aborted) {
            setDetails(customDetails);
            setLoading(false);
          }
          return;
        }

        // --- Step 0: Look up from prefetch store (instant, no API call) ---
        const prefetched = findGameById(gameId);

        // --- Epic Games ---
        if (isEpicGame) {
          // Try multiple lookup strategies in order of speed:
          // 1. Direct prefetch lookup by ID / secondaryId
          // 2. Title-based search in prefetch store (handles dedup ID changes)
          // 3. Live Epic API call (slowest, needs network)
          let epicData = prefetched;

          if (!epicData) {
            // Secondary lookup: try searching by offerId as title hint
            const rest = gameId.slice(5); // remove "epic-"
            const colonIdx = rest.indexOf(':');
            if (colonIdx !== -1) {
              const offerId = rest.slice(colonIdx + 1);
              // The offerId is often a slug of the game title
              const titleHint = offerId.replace(/[-_]/g, ' ');
              const searchHits = searchPrefetchedGames(titleHint, 3);
              if (searchHits && searchHits.length > 0) {
                // Pick the best match — prefer one with matching Epic metadata
                epicData = searchHits.find(g =>
                  g.epicOfferId === offerId || g.secondaryId === gameId
                ) || searchHits[0];
              }
            }
          }

          // Track the resolved title locally so the Metacritic fetch below
          // doesn't rely on stale React state (setState is async).
          let resolvedEpicTitle: string | undefined;

          if (epicData) {
            if (controller.signal.aborted) return;

            // ── Dual-store: prioritise Steam data when available ──────────
            // If this Epic game is also on Steam, load the rich Steam details
            // as primary and keep the Epic data for cross-store links / pricing.
            if (epicData.availableOn?.includes('steam') && epicData.steamAppId && isElectron()) {
              try {
                // Fetch Steam details + optionally live Epic price in parallel
                const needsEpicPrice = !epicData.price?.finalFormatted && !epicData.epicPrice?.finalFormatted;
                const epicPriceFetch = (needsEpicPrice && epicData.epicNamespace && epicData.epicOfferId && window.epic?.getGameDetails)
                  ? epicService.getGameDetails(epicData.epicNamespace, epicData.epicOfferId).catch((err) => { console.warn('[GameDetails] Epic details (dual-store):', err); return null; })
                  : Promise.resolve(null);

                const [steamDetails, steamReviews, liveEpic] = await Promise.all([
                  window.steam!.getAppDetails(epicData.steamAppId),
                  typeof window.steam!.getGameReviews === 'function'
                    ? window.steam!.getGameReviews(epicData.steamAppId, 10).catch((err) => { console.warn('[GameDetails] Steam reviews (dual-store):', err); return null; })
                    : Promise.resolve(null),
                  epicPriceFetch,
                ]);
                if (controller.signal.aborted) return;
                if (steamDetails) {
                  // Use Steam detail view — set `details` so the Steam render path is used
                  setDetails(steamDetails);
                  if (steamReviews) setReviews(steamReviews);
                  // Show Epic as the cross-store link with its pricing
                  // Prefer existing price with finalFormatted, then live-fetched, then epicPrice
                  const epicPrice = epicData.price?.finalFormatted
                    ? epicData.price
                    : liveEpic?.price?.finalFormatted
                      ? liveEpic.price
                      : epicData.epicPrice;
                  setCrossStoreGame({
                    ...epicData,
                    store: 'epic',
                    price: epicPrice,
                  } as Game);
                  // Fetch Metacritic using the Steam title
                  if (steamDetails.name && typeof window.metacritic?.getGameReviews === 'function') {
                    setMetacriticLoading(true);
                    window.metacritic.getGameReviews(steamDetails.name)
                      .then((data) => { if (!controller.signal.aborted && data) setMetacriticReviews(data); })
                      .catch((err) => { console.warn('[GameDetails] Metacritic fetch:', err); })
                      .finally(() => { if (!controller.signal.aborted) setMetacriticLoading(false); });
                  }
                  setLoading(false);
                  return;
                }
              } catch {
                // Steam fetch failed — fall through to Epic-only view
              }
            }

            // Epic-only view (not on Steam, or Steam fetch failed)
            setEpicGame(epicData);
            resolvedEpicTitle = epicData.title;

            // If this game is known to also be on Steam, set a cross-store ref
            // so the sidebar can show an "Also on Steam" link
            if (epicData.availableOn?.includes('steam') && epicData.steamAppId) {
              setCrossStoreGame({ ...epicData, store: 'steam' } as Game);
            }

            // The prefetched data came from SEARCH_STORE_QUERY which is missing
            // longDescription, full screenshots, etc.  Always enrich with the
            // full CATALOG_QUERY data + CMS product content in parallel.
            let enrichedGame = epicData;
            const enrichNs = epicData.epicNamespace;
            const enrichOid = epicData.epicOfferId;

            // Fire parallel requests: full details + CMS product content
            const [fullDetails, productContent] = await Promise.all([
              // Re-fetch full details from CATALOG_QUERY (has longDescription, customAttributes, etc.)
              (enrichNs && enrichOid && isElectron())
                ? epicService.getGameDetails(enrichNs, enrichOid).catch((err) => { console.warn('[GameDetails] Epic details (enrich):', err); return null; })
                : Promise.resolve(null),
              // CMS REST endpoint for full About HTML + system requirements
              (epicData.epicSlug && window.epic?.getProductContent)
                ? window.epic.getProductContent(epicData.epicSlug).catch((err) => { console.warn('[GameDetails] Epic product content:', err); return null; })
                : Promise.resolve(null),
            ]);
            if (controller.signal.aborted) return;

            // Merge full details into the prefetched game — keep prefetch
            // fields as fallbacks but prefer the richer CATALOG_QUERY data
            if (fullDetails) {
              // Use live price if the prefetched price is missing finalFormatted
              const bestPrice = (epicData.price?.finalFormatted ? epicData.price : fullDetails.price) || epicData.price;
              enrichedGame = {
                ...epicData,
                summary: fullDetails.summary || epicData.summary,
                longDescription: fullDetails.longDescription || epicData.longDescription,
                screenshots: (fullDetails.screenshots && fullDetails.screenshots.length > 0)
                  ? fullDetails.screenshots
                  : epicData.screenshots,
                epicSlug: fullDetails.epicSlug || epicData.epicSlug,
                platform: (fullDetails.platform && fullDetails.platform.length > 0)
                  ? fullDetails.platform
                  : epicData.platform,
                price: bestPrice,
              };
              setEpicGame(enrichedGame);
            }

            setDetails(epicToSteamDetails(enrichedGame, productContent));
          } else {
            // Final fallback: try the Epic API directly
            const rest = gameId.slice(5); // remove "epic-"
            const colonIdx = rest.indexOf(':');
            if (colonIdx === -1) {
              if (!controller.signal.aborted) setError('Invalid Epic game ID');
              return;
            }
            const namespace = rest.slice(0, colonIdx);
            const offerId = rest.slice(colonIdx + 1);

            const game = await epicService.getGameDetails(namespace, offerId);
            if (controller.signal.aborted) return;
            if (game) {
              setEpicGame(game);
              resolvedEpicTitle = game.title;

              // Fetch rich product content
              const slug = game.epicSlug;
              let productContent: Awaited<ReturnType<NonNullable<typeof window.epic>['getProductContent']>> = null;
              if (slug && window.epic?.getProductContent) {
                productContent = await window.epic.getProductContent(slug).catch((err) => { console.warn('[GameDetails] Epic product content (slug):', err); return null; });
              }
              if (controller.signal.aborted) return;
              setDetails(epicToSteamDetails(game, productContent));
            } else {
              setError('Game not found');
              return;
            }
          }

          // Fetch Metacritic for Epic games — use the local variable, NOT
          // React state which is still stale at this point.
          if (resolvedEpicTitle && typeof window.metacritic?.getGameReviews === 'function') {
            setMetacriticLoading(true);
            window.metacritic.getGameReviews(resolvedEpicTitle)
              .then((data) => { if (!controller.signal.aborted && data) setMetacriticReviews(data); })
              .catch((err) => { console.warn('[GameDetails] Metacritic fetch:', err); })
              .finally(() => { if (!controller.signal.aborted) setMetacriticLoading(false); });
          }
          return;
        }

        // --- Steam Games ---
        if (!appId) {
          if (!controller.signal.aborted) setError('Invalid game ID');
          return;
        }

        // Check if this Steam game is also on Epic (cross-store)
        const hasEpicAvailable = prefetched?.availableOn?.includes('epic');
        const hasEpicIds = prefetched && !!(prefetched.epicSlug || prefetched.epicNamespace);
        let isCrossStoreEpic = !!(prefetched && (hasEpicAvailable || hasEpicIds) && (prefetched.epicSlug || prefetched.epicNamespace));

        // Fallback: if the prefetched object is missing Epic metadata (stale
        // IDB cache from before dedup cross-store merge), search prefetchedGames
        // by title for an Epic match.
        let epicMeta: { epicSlug?: string; epicNamespace?: string; epicOfferId?: string; epicPrice?: Game['epicPrice'] } | null = null;
        if (!isCrossStoreEpic && prefetched?.title) {
          const allGames = getPrefetchedGames();
          if (allGames) {
            const titleLower = prefetched.title.toLowerCase();
            const epicMatch = allGames.find(
              g => g.store === 'epic' && g.title?.toLowerCase() === titleLower,
            );
            if (epicMatch) {
              epicMeta = {
                epicSlug: epicMatch.epicSlug,
                epicNamespace: epicMatch.epicNamespace,
                epicOfferId: epicMatch.epicOfferId,
                epicPrice: epicMatch.price as Game['epicPrice'],
              };
              isCrossStoreEpic = !!(epicMeta.epicSlug || epicMeta.epicNamespace);
            }
          }
        }

        if (isCrossStoreEpic) {
          setCrossStoreGame({
            ...prefetched,
            // Prefer merged metadata from dedup; fall back to live search match
            epicSlug: prefetched?.epicSlug || epicMeta?.epicSlug,
            epicNamespace: prefetched?.epicNamespace || epicMeta?.epicNamespace,
            epicOfferId: prefetched?.epicOfferId || epicMeta?.epicOfferId,
            store: 'epic',
            price: prefetched?.epicPrice ?? epicMeta?.epicPrice ?? undefined,
          } as Game);
        }

        if (isElectron()) {
          // Fetch Steam details + reviews in PARALLEL
          const detailsPromise = window.steam!.getAppDetails(appId);
          const reviewsPromise = typeof window.steam!.getGameReviews === 'function'
            ? window.steam!.getGameReviews(appId, 10).catch((err) => { console.warn('[GameDetails] Steam reviews:', err); return null; })
            : Promise.resolve(null);
          // If cross-store and we don't have a usable Epic price yet, fetch it live.
          const resolvedEpicNs = prefetched?.epicNamespace || epicMeta?.epicNamespace;
          const resolvedEpicOid = prefetched?.epicOfferId || epicMeta?.epicOfferId;
          const hasUsableEpicPrice = !!(
            prefetched?.epicPrice?.finalFormatted ||
            (epicMeta?.epicPrice as Game['epicPrice'])?.finalFormatted
          );
          const epicPricePromise = (isCrossStoreEpic && !hasUsableEpicPrice && resolvedEpicNs && resolvedEpicOid && window.epic?.getGameDetails)
            ? epicService.getGameDetails(resolvedEpicNs, resolvedEpicOid).catch((err) => { console.warn('[GameDetails] Epic details (cross-store):', err); return null; })
            : Promise.resolve(null);

          const [detailsData, reviewsData, liveEpicDetails] = await Promise.all([detailsPromise, reviewsPromise, epicPricePromise]);
          
          if (controller.signal.aborted) return;
          
          if (detailsData) {
            setDetails(detailsData);
            if (reviewsData) setReviews(reviewsData);
          } else {
            setError('Game not found');
            setLoading(false);
            return;
          }

          // Update cross-store Epic price from live fetch — overwrite if the
          // existing price is missing or has no finalFormatted string.
          if (liveEpicDetails?.price?.finalFormatted && isCrossStoreEpic) {
            setCrossStoreGame(prev => prev ? {
              ...prev,
              price: prev.price?.finalFormatted ? prev.price : liveEpicDetails.price,
            } as Game : prev);
          }

          // Fetch Metacritic reviews asynchronously (don't block page load)
          if (detailsData?.name && typeof window.metacritic?.getGameReviews === 'function') {
            setMetacriticLoading(true);
            window.metacritic.getGameReviews(detailsData.name)
              .then((data) => { if (!controller.signal.aborted && data) setMetacriticReviews(data); })
              .catch((err) => { console.warn('[GameDetails] Metacritic fetch:', err); })
              .finally(() => { if (!controller.signal.aborted) setMetacriticLoading(false); });
          }
          } else {
          if (!controller.signal.aborted) setError('Steam API only available in Electron');
        }
      } catch (err) {
        console.error('Error fetching game details:', err);
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Failed to load game details');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    fetchData();

    return () => {
      controller.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, isEpicGame, isCustomGame, appId]);

  // Resolved Steam App ID — works for Steam-primary (from URL) and dual-store
  // Epic-primary games (from details.steam_appid set during dual-store resolution)
  const resolvedSteamAppId = appId || details?.steam_appid || null;

  // Fetch recommendations (asynchronously, after main content)
  // Use a boolean gate (!!details) instead of the object reference so that
  // swapping from one details object to another doesn't trigger a refetch
  // when the appId hasn't changed.
  const hasDetails = !!details;
  useEffect(() => {
    // Use resolvedSteamAppId so dual-store Epic-primary games also get recommendations
    if (!resolvedSteamAppId || !hasDetails) {
      return;
    }
    
    // Check if the API is available
    if (!isElectron()) {
      return;
    }
    
    if (!window.steam?.getRecommendations) {
      return;
    }

    const controller = new AbortController();

    const fetchRecommendations = async () => {
      setRecommendationsLoading(true);
      try {
        const libraryIds = getAllGameIds();
        // Extract numeric Steam appIds from string gameIds for the recommendations API
        const numericLibIds = libraryIds
          .map(id => { const m = id.match(/^(?:steam-)?(\d+)$/); return m ? Number(m[1]) : null; })
          .filter((id): id is number => id !== null);
        const recs = await window.steam!.getRecommendations(resolvedSteamAppId, numericLibIds, 8);
        if (!controller.signal.aborted) {
          setRecommendations(recs);
        }
      } catch (err) {
        console.warn('[GameDetails] Failed to fetch recommendations:', err);
      } finally {
        if (!controller.signal.aborted) setRecommendationsLoading(false);
      }
    };

    fetchRecommendations();

    return () => {
      controller.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedSteamAppId, hasDetails]);

  // Fetch FitGirl repack link (asynchronously, after main content)
  useEffect(() => {
    const gameName = details?.name || epicGame?.title;
    if (!gameName) {
      return;
    }

    const controller = new AbortController();

    const fetchFitgirlRepack = async () => {
      setFitgirlLoading(true);
      try {
        const repackData = await getRepackLinkForGame(gameName);
        if (!controller.signal.aborted) {
          setFitgirlRepack(repackData);
        }
      } catch (err) {
        console.warn('[GameDetails] Failed to fetch FitGirl repack:', err);
        if (!controller.signal.aborted) {
          setFitgirlRepack(null);
        }
      } finally {
        if (!controller.signal.aborted) setFitgirlLoading(false);
      }
    };

    fetchFitgirlRepack();

    return () => {
      controller.abort();
    };
  }, [details?.name, epicGame?.title]);

  // Fetch Steam news for this game (IPC with fetch fallback)
  useEffect(() => {
    if (!resolvedSteamAppId) return;

    const controller = new AbortController();
    setSteamNewsLoading(true);

    steamService.getNewsForApp(resolvedSteamAppId, 15).then((news) => {
      if (!controller.signal.aborted) setSteamNews(news);
    }).catch((err) => {
      console.warn('[GameDetails] Failed to fetch Steam news:', err);
    }).finally(() => {
      if (!controller.signal.aborted) setSteamNewsLoading(false);
    });

    return () => { controller.abort(); };
  }, [resolvedSteamAppId]);

  // Fetch current player count (also works for dual-store Epic-primary games)
  useEffect(() => {
    if (!resolvedSteamAppId) return;
    const controller = new AbortController();

    steamService.getMultiplePlayerCounts([resolvedSteamAppId]).then((counts) => {
      if (!controller.signal.aborted && counts[resolvedSteamAppId]) {
        setPlayerCount(counts[resolvedSteamAppId]);
      }
    }).catch((err) => {
      console.warn('[GameDetails] Player count:', err);
    });

    return () => { controller.abort(); };
  }, [resolvedSteamAppId]);

  // ── Epic-specific enrichment: news, reviews, DLC ──────────────────────
  useEffect(() => {
    if (!isEpicGame || !epicGame) return;
    const controller = new AbortController();

    // News feed — search by game title
    const gameName = epicGame.title;
    if (gameName && window.epic?.getNewsFeed) {
      setEpicNewsLoading(true);
      window.epic.getNewsFeed(gameName, 15).then((articles) => {
        if (!controller.signal.aborted) setEpicNews(articles);
      }).catch((err) => { console.warn('[GameDetails] Epic news:', err); }).finally(() => {
        if (!controller.signal.aborted) setEpicNewsLoading(false);
      });
    }

    // Product reviews — use Epic slug
    const slug = epicGame.epicSlug;
    if (slug && window.epic?.getProductReviews) {
      window.epic.getProductReviews(slug).then((data) => {
        if (!controller.signal.aborted && data) setEpicReviews(data);
      }).catch((err) => { console.warn('[GameDetails] Epic reviews:', err); });
    }

    // DLC/Add-ons — use Epic namespace
    const ns = epicGame.epicNamespace;
    if (ns && window.epic?.getAddons) {
      window.epic.getAddons(ns, 50).then((addons) => {
        if (!controller.signal.aborted) setEpicAddons(addons);
      }).catch((err) => { console.warn('[GameDetails] Epic addons:', err); });
    }

    return () => { controller.abort(); };
  }, [isEpicGame, epicGame?.title, epicGame?.epicSlug, epicGame?.epicNamespace]);

  // ── Cross-store Epic DLC: fetch addons when a Steam-primary game also has Epic data
  useEffect(() => {
    if (isEpicGame) return; // Already handled above
    const ns = crossStoreGame?.store === 'epic' ? crossStoreGame.epicNamespace : null;
    if (!ns || !window.epic?.getAddons) return;

    const controller = new AbortController();
    window.epic.getAddons(ns, 50).then((addons) => {
      if (!controller.signal.aborted) setEpicAddons(addons);
    }).catch((err) => { console.warn('[GameDetails] Cross-store Epic addons:', err); });

    return () => { controller.abort(); };
  }, [isEpicGame, crossStoreGame?.epicNamespace, crossStoreGame?.store]);

  // Media items (screenshots + movies)
  const mediaItems = useMemo(() => {
    if (!details) return [];
    
    const items: Array<{ type: 'image' | 'video'; url: string; thumbnail: string; name?: string }> = [];
    
    // Add screenshots
    details.screenshots?.forEach((screenshot) => {
      items.push({
        type: 'image',
        url: screenshot.path_full,
        thumbnail: screenshot.path_thumbnail,
      });
    });
    
    // Add movies (prefer mp4 for better browser compatibility)
    details.movies?.forEach((movie) => {
      // Try different video quality options
      const videoUrl = movie.mp4?.max || movie.mp4?.['480'] || movie.webm?.max || movie.webm?.['480'] || '';
      if (videoUrl) {
        items.push({
          type: 'video',
          url: videoUrl,
          thumbnail: movie.thumbnail,
          name: movie.name,
        });
      }
    });
    
    return items;
  }, [details]);

  // Pause autoplay temporarily when user interacts
  const pauseAutoplay = useCallback(() => {
    setIsAutoplayPaused(true);
    
    // Clear any existing resume timeout
    if (resumeAutoplayTimeoutRef.current) {
      clearTimeout(resumeAutoplayTimeoutRef.current);
    }
    
    // Resume autoplay after 10 seconds of inactivity
    resumeAutoplayTimeoutRef.current = setTimeout(() => {
      setIsAutoplayPaused(false);
    }, 10000);
  }, []);

  // Navigate media with autoplay pause
  const nextMedia = useCallback(() => {
    setCurrentMediaIndex((prev) => (prev + 1) % mediaItems.length);
  }, [mediaItems.length]);

  const prevMedia = useCallback(() => {
    setCurrentMediaIndex((prev) => (prev - 1 + mediaItems.length) % mediaItems.length);
  }, [mediaItems.length]);

  // Manual navigation pauses autoplay
  const handleManualNav = useCallback((direction: 'next' | 'prev') => {
    pauseAutoplay();
    setMediaLoading(true);
    if (direction === 'next') {
      nextMedia();
    } else {
      prevMedia();
    }
  }, [pauseAutoplay, nextMedia, prevMedia]);

  const handleThumbnailClick = useCallback((index: number) => {
    if (currentMediaIndexRef.current !== index) {
      pauseAutoplay();
      setMediaLoading(true);
      setCurrentMediaIndex(index);
    }
  }, [pauseAutoplay]);

  // Autoplay media every 5 seconds
  useEffect(() => {
    // Don't autoplay if paused, loading, no media, or only 1 item
    if (isAutoplayPaused || loading || mediaItems.length <= 1) {
      return;
    }

    // Skip autoplay for videos (let them play through)
    const currentItem = mediaItems[currentMediaIndex];
    if (currentItem?.type === 'video') {
      return;
    }

    autoplayTimeoutRef.current = setTimeout(() => {
      setMediaLoading(true);
      nextMedia();
    }, 5000);

    return () => {
      if (autoplayTimeoutRef.current) {
        clearTimeout(autoplayTimeoutRef.current);
      }
    };
  }, [currentMediaIndex, isAutoplayPaused, loading, mediaItems, nextMedia]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (autoplayTimeoutRef.current) {
        clearTimeout(autoplayTimeoutRef.current);
      }
      if (resumeAutoplayTimeoutRef.current) {
        clearTimeout(resumeAutoplayTimeoutRef.current);
      }
      if (recommendationsAutoScrollRef.current) {
        clearTimeout(recommendationsAutoScrollRef.current);
      }
    };
  }, []);

  // Auto-scroll recommendations every 10 seconds
  useEffect(() => {
    if (!recommendationsScrollRef.current || recommendations.length === 0 || isRecommendationsPaused) {
      return;
    }

    const scrollContainer = recommendationsScrollRef.current;
    const cardWidth = 280; // w-64 (256px) + gap-4 (16px) = 272px, rounded to 280 for smooth scroll
    
    recommendationsAutoScrollRef.current = setInterval(() => {
      if (scrollContainer && !isRecommendationsPaused) {
        const maxScroll = scrollContainer.scrollWidth - scrollContainer.clientWidth;
        const currentScroll = scrollContainer.scrollLeft;
        
        // If we've reached the end, scroll back to the beginning
        if (currentScroll >= maxScroll - 10) {
          scrollContainer.scrollTo({ left: 0, behavior: 'smooth' });
        } else {
          scrollContainer.scrollBy({ left: cardWidth, behavior: 'smooth' });
        }
      }
    }, 10000); // 10 seconds

    return () => {
      if (recommendationsAutoScrollRef.current) {
        clearInterval(recommendationsAutoScrollRef.current);
      }
    };
  }, [recommendations, isRecommendationsPaused]);


  // Memoize derived arrays to avoid creating new references on every render
  const dialogGenres = useMemo(
    () => details?.genres?.map(g => g.description) || [],
    [details?.genres]
  );
  const dialogPlatforms = useMemo(() => {
    const p: string[] = [];
    if (details?.platforms?.windows) p.push('Windows');
    if (details?.platforms?.mac) p.push('Mac');
    if (details?.platforms?.linux) p.push('Linux');
    return p;
  }, [details?.platforms?.windows, details?.platforms?.mac, details?.platforms?.linux]);

  // Calculate positive percentage
  const positivePercentage = useMemo(() => {
    if (!reviews?.query_summary) return null;
    const { total_positive, total_reviews } = reviews.query_summary;
    if (total_reviews === 0) return null;
    return Math.round((total_positive / total_reviews) * 100);
  }, [reviews]);

  if (loading) {
    return (
      <div className="min-h-screen bg-black text-white">
        {/* Hero Section Skeleton — shared by both views */}
        <div className="relative h-[30vh] min-h-[240px] w-full bg-gradient-to-b from-white/5 to-black">
          <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-transparent to-transparent" />

          {/* Top Navigation Bar */}
          <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 py-3 app-drag-region">
            <div className="h-10 w-24 rounded-lg bg-white/10 animate-pulse no-drag" />
            <WindowControls />
          </div>

          {/* Title and Info Skeleton */}
          <div className="absolute bottom-0 left-0 right-0 p-6 z-10">
            <div className="max-w-7xl mx-auto space-y-3">
              <div className="h-10 w-2/3 max-w-md rounded-lg bg-white/10 animate-pulse" />
              <div className="flex flex-wrap items-center gap-4">
                <div className="h-6 w-32 rounded bg-white/10 animate-pulse" />
                <div className="h-6 w-28 rounded bg-white/10 animate-pulse" />
                <div className="h-6 w-16 rounded-full bg-white/10 animate-pulse" />
                <div className="h-6 w-24 rounded-full bg-white/10 animate-pulse" />
              </div>
              <div className="flex flex-wrap gap-2">
                <div className="h-6 w-20 rounded-full bg-white/10 animate-pulse" />
                <div className="h-6 w-24 rounded-full bg-white/10 animate-pulse" />
                <div className="h-6 w-16 rounded-full bg-white/10 animate-pulse" />
              </div>
            </div>
          </div>
        </div>

        {/* Content Skeleton — conditional based on whether user will see My Progress */}
        {showProgressTabs ? (
          <div className="max-w-7xl mx-auto px-4 py-6">
            {/* Tab bar skeleton */}
            <div className="mb-6 flex gap-1 p-1 rounded-lg bg-white/5 w-fit">
              <div className="h-9 w-36 rounded-md bg-white/10 animate-pulse" />
              <div className="h-9 w-36 rounded-md bg-white/5 animate-pulse" />
            </div>
            {/* My Progress skeleton content */}
            <div className="p-6 rounded-lg bg-white/5 border border-white/10">
              <MyProgressSkeleton />
            </div>
          </div>
        ) : (
          <div className="max-w-7xl mx-auto px-4 py-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Left Column */}
              <div className="lg:col-span-2 space-y-6">
                {/* Media Gallery Skeleton */}
                <section>
                  <div className="h-7 w-24 rounded bg-white/10 animate-pulse mb-4" />
                  <div className="rounded-lg overflow-hidden bg-white/5">
                    <div className="aspect-video bg-white/10 animate-pulse relative">
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="w-12 h-12 border-2 border-white/20 border-t-fuchsia-500 rounded-full animate-spin" />
                      </div>
                    </div>
                    <div className="flex gap-2 p-3">
                      {[...Array(6)].map((_, i) => (
                        <div key={i} className="flex-shrink-0 w-24 h-14 rounded-lg bg-white/10 animate-pulse" />
                      ))}
                    </div>
                  </div>
                </section>

                {/* Description Skeleton */}
                <section>
                  <div className="h-7 w-32 rounded bg-white/10 animate-pulse mb-4" />
                  <div className="p-6 rounded-lg bg-white/5 border border-white/10 space-y-3">
                    <div className="h-4 w-full rounded bg-white/10 animate-pulse" />
                    <div className="h-4 w-full rounded bg-white/10 animate-pulse" />
                    <div className="h-4 w-3/4 rounded bg-white/10 animate-pulse" />
                    <div className="h-4 w-full rounded bg-white/10 animate-pulse" />
                    <div className="h-4 w-5/6 rounded bg-white/10 animate-pulse" />
                  </div>
                </section>

                {/* System Requirements Skeleton */}
                <section>
                  <div className="h-7 w-48 rounded bg-white/10 animate-pulse mb-4" />
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="p-4 rounded-lg bg-white/5 border border-white/10 space-y-3">
                      <div className="h-5 w-24 rounded bg-white/10 animate-pulse" />
                      <div className="h-4 w-full rounded bg-white/10 animate-pulse" />
                      <div className="h-4 w-3/4 rounded bg-white/10 animate-pulse" />
                      <div className="h-4 w-5/6 rounded bg-white/10 animate-pulse" />
                    </div>
                    <div className="p-4 rounded-lg bg-white/5 border border-white/10 space-y-3">
                      <div className="h-5 w-32 rounded bg-white/10 animate-pulse" />
                      <div className="h-4 w-full rounded bg-white/10 animate-pulse" />
                      <div className="h-4 w-3/4 rounded bg-white/10 animate-pulse" />
                      <div className="h-4 w-5/6 rounded bg-white/10 animate-pulse" />
                    </div>
                  </div>
                </section>
              </div>

              {/* Right Column */}
              <div className="space-y-6">
                <div className="p-6 rounded-lg bg-white/5 border border-white/10 space-y-4">
                  <div className="aspect-video rounded bg-white/10 animate-pulse" />
                  <div className="h-10 w-full rounded bg-white/10 animate-pulse" />
                  <div className="h-10 w-full rounded bg-white/10 animate-pulse" />
                </div>
                <div className="p-6 rounded-lg bg-white/5 border border-white/10 space-y-4">
                  <div className="flex justify-between">
                    <div className="h-4 w-20 rounded bg-white/10 animate-pulse" />
                    <div className="h-4 w-28 rounded bg-white/10 animate-pulse" />
                  </div>
                  <div className="flex justify-between">
                    <div className="h-4 w-20 rounded bg-white/10 animate-pulse" />
                    <div className="h-4 w-24 rounded bg-white/10 animate-pulse" />
                  </div>
                  <div className="flex justify-between">
                    <div className="h-4 w-24 rounded bg-white/10 animate-pulse" />
                    <div className="h-4 w-28 rounded bg-white/10 animate-pulse" />
                  </div>
                  <div className="pt-4 border-t border-white/10">
                    <div className="h-4 w-20 rounded bg-white/10 animate-pulse mb-2" />
                    <div className="flex gap-2">
                      <div className="h-8 w-20 rounded bg-white/10 animate-pulse" />
                      <div className="h-8 w-16 rounded bg-white/10 animate-pulse" />
                    </div>
                  </div>
                </div>
                <div className="p-6 rounded-lg bg-white/5 border border-white/10 space-y-3">
                  <div className="h-5 w-24 rounded bg-white/10 animate-pulse" />
                  <div className="h-4 w-full rounded bg-white/10 animate-pulse" />
                  <div className="h-4 w-3/4 rounded bg-white/10 animate-pulse" />
                </div>
                <div className="p-6 rounded-lg bg-white/5 border border-white/10 space-y-4">
                  <div className="h-5 w-32 rounded bg-white/10 animate-pulse" />
                  <div className="flex items-center gap-4">
                    <div className="h-12 w-12 rounded bg-white/10 animate-pulse" />
                    <div className="space-y-2 flex-1">
                      <div className="h-4 w-24 rounded bg-white/10 animate-pulse" />
                      <div className="h-3 w-20 rounded bg-white/10 animate-pulse" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (error || (!loading && !details && !epicGame)) {
    return (
      <ErrorFallback error={error} navigate={navigate} />
    );
  }

  // --- Unified Game Rendering (Steam / Epic / Dual-store) ---
  if (!details) return null;

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Hero Section with Background */}
      <div className="relative h-[30vh] min-h-[240px] w-full overflow-hidden bg-black">
        {/* Lazy-loaded hero background with fade-in */}
        <img
          src={details.background || details.header_image}
          alt=""
          loading="lazy"
          onLoad={() => setHeroBgLoaded(true)}
          className={cn(
            "absolute inset-0 w-full h-full object-cover object-top transition-opacity duration-700 ease-out",
            heroBgLoaded ? "opacity-100" : "opacity-0"
          )}
        />
        {/* Skeleton shimmer while image loads */}
        {!heroBgLoaded && (
          <div className="absolute inset-0 bg-gradient-to-r from-white/5 via-white/10 to-white/5 animate-pulse" />
        )}
        {/* Gradient Overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-transparent to-transparent" />

        {/* Top Navigation Bar */}
        <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 py-3 app-drag-region">
          {/* Back Button — return to the view we came from (library, journey, browse, etc.) */}
          <Button
            onClick={() => navigate(getBackToDashboardUrl())}
            variant="ghost"
            className="bg-black/50 hover:bg-black/70 backdrop-blur-sm no-drag"
          >
            <ArrowLeft className="w-5 h-5 mr-2 pointer-events-none" />
            Back
          </Button>

          {/* Window Controls */}
          <WindowControls />
        </div>

        {/* Title and Basic Info */}
        <div className="absolute bottom-0 left-0 right-0 p-6 z-10">
          <div className="max-w-7xl mx-auto">
            <div className="flex items-center gap-3 mb-3">
              <h1 className="text-3xl md:text-4xl font-bold font-['Orbitron']">
              {details.name}
            </h1>
              {/* Primary store badge */}
              {epicGame && !crossStoreGame ? (
                <Badge variant="outline" className="border-white/30">
                  <SiEpicgames className="w-3 h-3 mr-1" />Epic
                </Badge>
              ) : !epicGame && !crossStoreGame ? (
                <Badge variant="outline" className="border-white/30">
                  <FaSteam className="w-3 h-3 mr-1" />Steam
                </Badge>
              ) : (
                <>
                <Badge variant="outline" className="border-white/30">
                  <FaSteam className="w-3 h-3 mr-1" />Steam
                </Badge>
                  <Badge variant="outline" className="border-white/30">
                    <SiEpicgames className="w-3 h-3 mr-1" />Epic
                  </Badge>
                </>
              )}
            </div>
            
            <div className="flex flex-wrap items-center gap-4 mb-4">
              {/* Developer */}
              {details.developers?.[0] && (
                <span className="text-white/70">
                  by <span className="text-white">{details.developers[0]}</span>
                </span>
              )}
              
              {/* Release Date */}
              {details.release_date && (
                <div className="flex items-center gap-1 text-white/70">
                  <Calendar className="w-4 h-4" />
                  <span>{details.release_date.date}</span>
                </div>
              )}
              
              {/* Metascore (from our Metacritic scraper — works for Steam, Epic, and dual-store) */}
              {metacriticReviews && metacriticReviews.score > 0 && (
                <Badge variant="outline" className={cn("font-bold", metacriticReviews.score >= 75 ? "border-green-500/40 text-green-400" : metacriticReviews.score >= 50 ? "border-yellow-500/40 text-yellow-400" : "border-red-500/40 text-red-400")} title="Metacritic Critic Score">
                  <Star className="w-3 h-3 mr-1" />
                  {metacriticReviews.score} Metascore
                </Badge>
              )}

              {/* Metacritic User Score */}
              {metacriticReviews && metacriticReviews.user_score > 0 && (
                <Badge variant="outline" className={cn("font-bold", metacriticReviews.user_score >= 7.5 ? "border-green-500/40 text-green-400" : metacriticReviews.user_score >= 5 ? "border-yellow-500/40 text-yellow-400" : "border-red-500/40 text-red-400")} title="Metacritic User Score">
                  <Users className="w-3 h-3 mr-1" />
                  {metacriticReviews.user_score} User Score
                </Badge>
              )}

              {/* Fallback: Metacritic from Steam API (in case scraper didn't run yet) */}
              {!metacriticReviews && details.metacritic && (
                <Badge className={cn("font-bold", getScoreColor(details.metacritic.score))} title="Metacritic Score (via Steam)">
                  <Star className="w-3 h-3 mr-1" />
                  {details.metacritic.score}
                </Badge>
              )}

              {/* Steam Review Score */}
              {positivePercentage !== null && (
                <Badge variant="outline" className="border-white/20" title="Steam User Reviews">
                  <ThumbsUp className="w-3 h-3 mr-1" />
                  {positivePercentage}% Positive
                </Badge>
              )}

              {/* Player Count (Steam API — Epic does not expose this data) */}
              {playerCount !== null && playerCount > 0 && (
                <Badge variant="outline" className="border-cyan-500/30 text-cyan-400 bg-cyan-500/10" title="Live concurrent players from Steam">
                  <Users className="w-3 h-3 mr-1" />
                  {formatPlayerCount(playerCount)} playing on Steam
                </Badge>
              )}
            </div>

            {/* Genres */}
            <div className="flex flex-wrap gap-2">
              {details.genres?.map((genre) => (
                <Badge key={genre.id} variant="outline" className="text-xs border-white/20 hover:bg-white/10">
                  {genre.description}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Tabbed view — only when game was already in library on page load */}
        {showProgressTabs && gameId ? (
          <Tabs defaultValue="progress" className="w-full">
            <TabsList className="mb-6 bg-white/5">
              <TabsTrigger value="progress" className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4" />
                My Progress
              </TabsTrigger>
              <TabsTrigger value="details" className="flex items-center gap-2">
                <Gamepad2 className="w-4 h-4" />
                Game Details
              </TabsTrigger>
            </TabsList>

            <TabsContent value="progress">
              <div className="p-6 rounded-lg bg-white/5 border border-white/10">
                <MyProgressTab gameId={gameId} gameName={details.name} />
              </div>
            </TabsContent>

            <TabsContent value="details">
              <GameDetailsContent
                details={details}
                epicGame={epicGame}
                reviews={reviews}
                metacriticReviews={metacriticReviews}
                metacriticLoading={metacriticLoading}
                mediaItems={mediaItems}
                currentMediaIndex={currentMediaIndex}
                mediaLoading={mediaLoading}
                thumbnailsLoaded={thumbnailsLoaded}
                handleManualNav={handleManualNav}
                handleThumbnailClick={handleThumbnailClick}
                setMediaLoading={setMediaLoading}
                markThumbnailLoaded={markThumbnailLoaded}
                positivePercentage={positivePercentage}
                showFullDescription={showFullDescription}
                setShowFullDescription={setShowFullDescription}
                headerImageError={headerImageError}
                setHeaderImageError={setHeaderImageError}
                headerImageLoaded={headerImageLoaded}
                setHeaderImageLoaded={setHeaderImageLoaded}
                recommendations={recommendations}
                recommendationsLoading={recommendationsLoading}
                fitgirlRepack={fitgirlRepack}
                fitgirlLoading={fitgirlLoading}
                isRecommendationsPaused={isRecommendationsPaused}
                setIsRecommendationsPaused={setIsRecommendationsPaused}
                recommendationsScrollRef={recommendationsScrollRef}
                steamNews={steamNews}
                steamNewsLoading={steamNewsLoading}
                epicNews={epicNews}
                epicNewsLoading={epicNewsLoading}
                epicReviews={epicReviews}
                epicAddons={epicAddons}
                gameInLibrary={gameInLibrary}
                handleOpenLibraryDialog={handleOpenLibraryDialog}
                removeFromLibrary={removeFromLibrary}
                crossStoreGame={crossStoreGame}
                gameId={gameId}
                appId={appId}
                navigate={navigate}
              />
            </TabsContent>
          </Tabs>
        ) : (
          <GameDetailsContent
            details={details}
            epicGame={epicGame}
            reviews={reviews}
            metacriticReviews={metacriticReviews}
            metacriticLoading={metacriticLoading}
            mediaItems={mediaItems}
            currentMediaIndex={currentMediaIndex}
            mediaLoading={mediaLoading}
            thumbnailsLoaded={thumbnailsLoaded}
            handleManualNav={handleManualNav}
            handleThumbnailClick={handleThumbnailClick}
            setMediaLoading={setMediaLoading}
            markThumbnailLoaded={markThumbnailLoaded}
            positivePercentage={positivePercentage}
            showFullDescription={showFullDescription}
            setShowFullDescription={setShowFullDescription}
            headerImageError={headerImageError}
            setHeaderImageError={setHeaderImageError}
            headerImageLoaded={headerImageLoaded}
            setHeaderImageLoaded={setHeaderImageLoaded}
            recommendations={recommendations}
            recommendationsLoading={recommendationsLoading}
            fitgirlRepack={fitgirlRepack}
            fitgirlLoading={fitgirlLoading}
            isRecommendationsPaused={isRecommendationsPaused}
            setIsRecommendationsPaused={setIsRecommendationsPaused}
            recommendationsScrollRef={recommendationsScrollRef}
            steamNews={steamNews}
            steamNewsLoading={steamNewsLoading}
            epicNews={epicNews}
            epicNewsLoading={epicNewsLoading}
            epicReviews={epicReviews}
            epicAddons={epicAddons}
            gameInLibrary={gameInLibrary}
            handleOpenLibraryDialog={handleOpenLibraryDialog}
            removeFromLibrary={removeFromLibrary}
            crossStoreGame={crossStoreGame}
            gameId={gameId}
            appId={appId}
            navigate={navigate}
          />
        )}
      </div>
      
      {/* Library Dialog — Add or Edit */}
      <GameDialog
        open={isDialogOpen}
        onOpenChange={handleDialogOpenChange}
        game={dialogGame}
        onSave={handleSaveLibraryEntry}
        genres={dialogGenres}
        platforms={dialogPlatforms}
        initialEntry={dialogInitialEntry}
      />
    </div>
  );
}

// Extracted Game Details Content Component
interface GameDetailsContentProps {
  details: SteamAppDetails;
  epicGame: Game | null; // Non-null when Epic is the primary store
  reviews: SteamReviewsResponse | null;
  metacriticReviews: MetacriticGameResponse | null;
  metacriticLoading: boolean;
  mediaItems: { type: 'image' | 'video'; url: string; thumbnail?: string; name?: string }[];
  currentMediaIndex: number;
  mediaLoading: boolean;
  thumbnailsLoaded: Set<number>;
  handleManualNav: (direction: 'next' | 'prev') => void;
  handleThumbnailClick: (index: number) => void;
  setMediaLoading: (loading: boolean) => void;
  markThumbnailLoaded: (index: number) => void;
  positivePercentage: number | null;
  showFullDescription: boolean;
  setShowFullDescription: (show: boolean) => void;
  headerImageError: boolean;
  setHeaderImageError: (error: boolean) => void;
  headerImageLoaded: boolean;
  setHeaderImageLoaded: (loaded: boolean) => void;
  recommendations: GameRecommendation[];
  recommendationsLoading: boolean;
  fitgirlRepack: { url: string; downloadLink: string | null } | null;
  fitgirlLoading: boolean;
  isRecommendationsPaused: boolean;
  setIsRecommendationsPaused: (paused: boolean) => void;
  recommendationsScrollRef: React.RefObject<HTMLDivElement>;
  steamNews: SteamNewsItem[];
  steamNewsLoading: boolean;
  epicNews: import('@/types/epic').EpicNewsArticle[];
  epicNewsLoading: boolean;
  epicReviews: import('@/types/epic').EpicProductReviews | null;
  epicAddons: import('@/types/epic').EpicAddon[];
  gameInLibrary: boolean;
  handleOpenLibraryDialog: () => void;
  removeFromLibrary: (gameId: string) => void;
  crossStoreGame: Game | null;
  gameId: string | null;
  appId: number | null;
  navigate: (path: string) => void;
}

const GameDetailsContent = memo(function GameDetailsContent({
  details,
  epicGame,
  reviews,
  metacriticReviews,
  metacriticLoading,
  mediaItems,
  currentMediaIndex,
  mediaLoading,
  thumbnailsLoaded,
  handleManualNav,
  handleThumbnailClick,
  setMediaLoading,
  markThumbnailLoaded,
  positivePercentage,
  showFullDescription,
  setShowFullDescription,
  headerImageError,
  setHeaderImageError,
  headerImageLoaded,
  setHeaderImageLoaded,
  recommendations,
  recommendationsLoading,
  fitgirlRepack,
  fitgirlLoading,
  isRecommendationsPaused: _isRecommendationsPaused, // Used for scrolling pause state
  setIsRecommendationsPaused,
  recommendationsScrollRef,
  steamNews,
  steamNewsLoading,
  epicNews,
  epicNewsLoading,
  epicReviews,
  epicAddons,
  gameInLibrary,
  handleOpenLibraryDialog,
  removeFromLibrary,
  crossStoreGame,
  gameId,
  appId: _appId,
  navigate,
}: GameDetailsContentProps) {
  const [reviewsExpanded, setReviewsExpanded] = useState(false);
  const [reviewTab, setReviewTab] = useState<'metacritic' | 'steam' | 'epic'>('metacritic');
  // Determine whether Epic is the primary store for this game
  const isEpicPrimary = !!epicGame;

  // ── Memoized derived JSX ─────────────────────────────────────────────────
  // These heavy .map() calls produce stable element arrays that survive the
  // 5-second autoplay re-renders (currentMediaIndex changes) without being
  // re-created.

  const newsCarouselItems = useMemo(() => {
    const fallback = details.header_image;

    // Steam news — from Steam GetNewsForApp API
    if (steamNews.length > 0) {
    return steamNews.map((item) => {
      const thumbnail = extractNewsThumbnail(item.contents);
      const cardData: CardType = {
        src: thumbnail || fallback,
        title: item.title,
        category: item.feedlabel || 'News',
        href: item.url,
      };
      return (
        <NewsCard
          key={item.gid}
          card={cardData}
          newsItem={item}
          fallbackImage={fallback}
        />
      );
    });
    }

    // Epic news — from Epic CMS blog feed (fallback when no Steam news)
    if (epicNews.length > 0) {
      return epicNews.map((article, i) => {
        const cardData: CardType = {
          src: article.image || fallback,
          title: article.title,
          category: article.source || 'Epic Games Store',
          href: article.url,
        };
        // Create a SteamNewsItem-compatible object for the NewsCard
        const fakeNewsItem: SteamNewsItem = {
          gid: `epic-news-${i}`,
          title: article.title,
          url: article.url,
          author: '',
          feedlabel: article.source || 'Epic Games Store',
          date: article.date ? Math.floor(new Date(article.date).getTime() / 1000) : 0,
        };
        return (
          <NewsCard
            key={`epic-news-${i}`}
            card={cardData}
            newsItem={fakeNewsItem}
            fallbackImage={fallback}
          />
        );
      });
    }

    return [];
  }, [steamNews, epicNews, details.header_image]);

  const recommendationsRendered = useMemo(() => {
    if (recommendations.length === 0) return [];
    const maxScore = Math.max(...recommendations.map(r => r.score), 1);
    return recommendations.map((rec) => {
      const matchPercentage = Math.min(Math.round((rec.score / maxScore) * 95), 99);
      return (
        <motion.div
          key={rec.appId}
          className="flex-shrink-0 w-64 cursor-pointer group"
          onClick={() => navigate(`/game/steam-${rec.appId}`)}
          whileHover={{ scale: 1.02 }}
          transition={{ duration: 0.2 }}
        >
          <div className="relative aspect-[460/215] rounded-lg overflow-hidden bg-white/5">
            <RecommendationImage appId={rec.appId} name={rec.name} />
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <h3 className="mt-2 font-semibold text-sm truncate group-hover:text-fuchsia-400 transition-colors">
            {rec.name}
          </h3>
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            <Badge className={cn(
              "text-[10px] px-1.5 py-0.5 font-semibold",
              matchPercentage >= 80 ? "bg-fuchsia-600" :
              matchPercentage >= 60 ? "bg-purple-600" : "bg-purple-800"
            )}>
              {matchPercentage}% Match
            </Badge>
            {rec.reasons.slice(0, 2).map((reason, i) => (
              <Badge
                key={i}
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 border-white/20 text-white/70"
              >
                {reason}
              </Badge>
            ))}
          </div>
        </motion.div>
      );
    });
  }, [recommendations, navigate]);

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Media & Description */}
          <div className="lg:col-span-2 space-y-6">
            {/* Media Gallery */}
            {mediaItems.length > 0 && (
              <section>
                <h2 className="text-xl font-semibold mb-4 font-['Orbitron']">Media</h2>
                <div className="relative rounded-lg overflow-hidden bg-black/50">
                  {/* Main Media Display */}
                  <div className="aspect-video relative">
                    {/* Skeleton loader */}
                    <AnimatePresence>
                      {mediaLoading && (
                        <motion.div
                          className="absolute inset-0 bg-gradient-to-r from-white/5 via-white/10 to-white/5 animate-pulse"
                          initial={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.3 }}
                        >
                          <div className="absolute inset-0 flex items-center justify-center">
                            <div className="w-12 h-12 border-2 border-white/20 border-t-fuchsia-500 rounded-full animate-spin" />
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <AnimatePresence mode="wait">
                      {mediaItems[currentMediaIndex]?.type === 'image' ? (
                        <motion.div
                          key={`img-${currentMediaIndex}`}
                          className="w-full h-full"
                          initial={{ opacity: 0, scale: 1.02 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.98 }}
                          transition={{ duration: 0.4, ease: 'easeOut' }}
                        >
                          <img
                            src={mediaItems[currentMediaIndex].url}
                            alt={`Screenshot ${currentMediaIndex + 1}`}
                            className={cn(
                              "w-full h-full object-cover transition-opacity duration-500",
                              mediaLoading ? "opacity-0" : "opacity-100"
                            )}
                            loading="lazy"
                            onLoad={() => setMediaLoading(false)}
                            onError={() => setMediaLoading(false)}
                          />
                        </motion.div>
                      ) : mediaItems[currentMediaIndex]?.url ? (
                        <motion.div
                          key={`video-${currentMediaIndex}`}
                          className="w-full h-full"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.4 }}
                        >
                          <video
                            key={`video-player-${currentMediaIndex}-${mediaItems[currentMediaIndex]?.url}`}
                            src={mediaItems[currentMediaIndex]?.url}
                            poster={mediaItems[currentMediaIndex]?.thumbnail}
                            controls
                            autoPlay
                            muted
                            playsInline
                            className={cn(
                              "w-full h-full object-contain bg-black transition-opacity duration-500",
                              mediaLoading ? "opacity-0" : "opacity-100"
                            )}
                            onLoadedData={() => setMediaLoading(false)}
                            onCanPlay={() => setMediaLoading(false)}
                            onError={(e) => {
                              console.error('Video failed to load:', mediaItems[currentMediaIndex]?.url);
                              setMediaLoading(false);
                              const video = e.currentTarget;
                              video.poster = mediaItems[currentMediaIndex]?.thumbnail || '';
                            }}
                          />
                        </motion.div>
                      ) : null}
                    </AnimatePresence>

                    {/* Navigation Arrows */}
                    {mediaItems.length > 1 && (
                      <>
                        <button
                          onClick={() => handleManualNav('prev')}
                          className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 hover:bg-black/80 transition-colors z-10"
                        >
                          <ChevronLeft className="w-6 h-6 pointer-events-none" />
                        </button>
                        <button
                          onClick={() => handleManualNav('next')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 hover:bg-black/80 transition-colors z-10"
                        >
                          <ChevronRight className="w-6 h-6 pointer-events-none" />
                        </button>
                      </>
                    )}

                    {/* Media Type Indicator */}
                    {mediaItems[currentMediaIndex]?.type === 'video' && (
                      <div className="absolute top-2 right-2 px-2 py-1 rounded bg-black/60 text-xs z-10">
                        <Play className="w-3 h-3 inline mr-1" />
                        Video
                      </div>
                    )}

                    {/* Media Counter */}
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-black/60 text-xs z-10">
                      {currentMediaIndex + 1} / {mediaItems.length}
                    </div>
                  </div>

                  {/* Thumbnails */}
                  <div className="flex gap-2 p-3 overflow-x-auto scrollbar-hide">
                    {mediaItems.slice(0, 10).map((item, index) => (
                      <button
                        key={index}
                        onClick={() => handleThumbnailClick(index)}
                        className={cn(
                          "relative flex-shrink-0 w-24 h-14 rounded-lg overflow-hidden border-2 transition-all duration-300",
                          currentMediaIndex === index
                            ? "border-fuchsia-500 scale-105"
                            : "border-transparent opacity-60 hover:opacity-100 hover:border-white/30"
                        )}
                      >
                        {/* Thumbnail skeleton */}
                        {!thumbnailsLoaded.has(index) && (
                          <div className="absolute inset-0 bg-white/10 animate-pulse" />
                        )}
                        <img
                          src={item.thumbnail}
                          alt={`Thumbnail ${index + 1}`}
                          className={cn(
                            "w-full h-full object-cover transition-opacity duration-300",
                            thumbnailsLoaded.has(index) ? "opacity-100" : "opacity-0"
                          )}
                          loading="lazy"
                          onLoad={() => markThumbnailLoaded(index)}
                        />
                        {item.type === 'video' && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                            <Play className="w-4 h-4" />
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            )}

            {/* Description */}
            {(details.detailed_description || details.about_the_game) && (
              <section>
                <h2 className="text-xl font-semibold mb-4 font-['Orbitron']">About This Game</h2>
                <div 
                  className={cn(
                    "prose prose-invert prose-sm max-w-none prose-img:rounded-lg prose-img:my-4 prose-img:max-w-full",
                    !showFullDescription && "max-h-[10rem] overflow-hidden"
                  )}
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(embedDescriptionImages(details.detailed_description || details.about_the_game)) }}
                  onClick={handleContentLinkClick}
                />
                {/* Gradient fade at bottom when collapsed */}
                {!showFullDescription && (details.detailed_description || details.about_the_game)?.length > 300 && (
                  <div className="h-12 -mt-12 relative bg-gradient-to-t from-[#0a0a0a] to-transparent pointer-events-none" />
                )}
                {(details.detailed_description || details.about_the_game)?.length > 500 && (
                  <Button
                    variant="link"
                    onClick={() => setShowFullDescription(!showFullDescription)}
                    className="mt-2 p-0 h-auto text-fuchsia-400 hover:text-fuchsia-300"
                  >
                    {showFullDescription ? 'Show Less' : 'Read More'}
                  </Button>
                )}
              </section>
            )}

            {/* System Requirements */}
            {details.pc_requirements && (details.pc_requirements.minimum || details.pc_requirements.recommended) && (
              <section>
                <h2 className="text-xl font-semibold mb-4 font-['Orbitron']">System Requirements</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {details.pc_requirements.minimum && (
                    <div className="p-4 rounded-lg bg-white/5 border border-white/10">
                      <h3 className="font-semibold mb-3 flex items-center gap-2">
                        <Monitor className="w-4 h-4" />
                        Minimum
                      </h3>
                      <div 
                        className="prose prose-invert prose-sm text-white/70"
                        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(details.pc_requirements.minimum) }}
                        onClick={handleContentLinkClick}
                      />
                    </div>
                  )}
                  {details.pc_requirements.recommended && (
                    <div className="p-4 rounded-lg bg-white/5 border border-white/10">
                      <h3 className="font-semibold mb-3 flex items-center gap-2">
                        <Cpu className="w-4 h-4" />
                        Recommended
                      </h3>
                      <div 
                        className="prose prose-invert prose-sm text-white/70"
                        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(details.pc_requirements.recommended) }}
                        onClick={handleContentLinkClick}
                      />
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* ── Unified Reviews (Tabbed) ─────────────────────────────── */}
            {(metacriticReviews || metacriticLoading || (reviews && reviews.reviews.length > 0) || (epicReviews && (epicReviews.totalReviews > 0 || epicReviews.averageRating > 0))) && (
              <section>
                <h2 className="text-xl font-semibold mb-4 font-['Orbitron']">Reviews</h2>

                {/* Tab Bar */}
                <div className="flex gap-1 mb-4 p-1 rounded-lg bg-white/5 border border-white/10">
                  {/* Metacritic tab — always visible */}
                  <button
                    type="button"
                    onClick={() => { setReviewTab('metacritic'); setReviewsExpanded(false); }}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                      reviewTab === 'metacritic'
                        ? "bg-fuchsia-600/30 text-fuchsia-300 border border-fuchsia-500/30"
                        : "text-white/50 hover:text-white/80 hover:bg-white/5"
                    )}
                  >
                    <Star className="w-3.5 h-3.5" />
                    Metacritic
                  </button>

                  {/* Steam tab — show when Steam reviews exist */}
                  {reviews && reviews.reviews.length > 0 && (
                    <button
                      type="button"
                      onClick={() => { setReviewTab('steam'); setReviewsExpanded(false); }}
                      className={cn(
                        "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                        reviewTab === 'steam'
                          ? "bg-blue-600/30 text-blue-300 border border-blue-500/30"
                          : "text-white/50 hover:text-white/80 hover:bg-white/5"
                      )}
                    >
                      <SiSteam className="w-3.5 h-3.5" />
                      Steam
                    </button>
                  )}

                  {/* Epic tab — show when Epic reviews exist and there are no Steam reviews */}
                  {epicReviews && (epicReviews.totalReviews > 0 || epicReviews.averageRating > 0) && (
                    <button
                      type="button"
                      onClick={() => { setReviewTab('epic'); setReviewsExpanded(false); }}
                      className={cn(
                        "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                        reviewTab === 'epic'
                          ? "bg-purple-600/30 text-purple-300 border border-purple-500/30"
                          : "text-white/50 hover:text-white/80 hover:bg-white/5"
                      )}
                    >
                      <SiEpicgames className="w-3.5 h-3.5" />
                      Epic
                    </button>
                  )}
                </div>

                {/* ── Metacritic Tab Content ── */}
                {reviewTab === 'metacritic' && (
                  <div className="space-y-4">
                    {metacriticLoading ? (
                      <div className="p-4 rounded-lg bg-white/5 border border-white/10 space-y-4">
                        {/* Score row skeleton */}
                        <div className="flex items-center gap-6">
                          <div className="w-10 h-10 rounded-lg bg-white/10 animate-pulse" />
                          <div className="space-y-2 flex-1">
                            <div className="h-4 w-28 rounded bg-white/10 animate-pulse" />
                            <div className="h-3 w-40 rounded bg-white/10 animate-pulse" />
                          </div>
                          <div className="w-10 h-10 rounded-lg bg-white/10 animate-pulse" />
                          <div className="space-y-2 flex-1">
                            <div className="h-4 w-24 rounded bg-white/10 animate-pulse" />
                            <div className="h-3 w-36 rounded bg-white/10 animate-pulse" />
                          </div>
                        </div>
                        {/* Review lines skeleton */}
                        <div className="space-y-3 pt-2 border-t border-white/5">
                          {Array.from({ length: 3 }).map((_, i) => (
                            <div key={i} className="flex gap-3">
                              <div className="w-8 h-8 rounded bg-white/10 animate-pulse flex-shrink-0" />
                              <div className="space-y-1.5 flex-1">
                                <div className="h-3 w-1/3 rounded bg-white/10 animate-pulse" />
                                <div className="h-3 w-full rounded bg-white/5 animate-pulse" />
                                <div className="h-3 w-4/5 rounded bg-white/5 animate-pulse" />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : metacriticReviews ? (
                      <>
                        {/* Metascore + User Score Summary — clickable to expand */}
                        <button
                          type="button"
                          onClick={() => setReviewsExpanded(prev => !prev)}
                          className="w-full flex items-center gap-6 p-4 rounded-lg bg-white/5 border border-white/10 hover:bg-white/[0.07] transition-colors cursor-pointer text-left"
                        >
                          {metacriticReviews.score > 0 && (
                            <div className="flex items-center gap-3">
                              <div className={cn(
                                "w-10 h-10 rounded flex items-center justify-center font-bold text-base flex-shrink-0",
                                metacriticReviews.score >= 75 ? "bg-green-600" :
                                metacriticReviews.score >= 50 ? "bg-yellow-600" : "bg-red-600"
                              )}>
                                {metacriticReviews.score}
                              </div>
                              <div className="text-sm text-white/60">Metascore</div>
                            </div>
                          )}
                          {metacriticReviews.user_score > 0 && (
                            <div className="flex items-center gap-3">
                              <div className={cn(
                                "w-10 h-10 rounded flex items-center justify-center font-bold text-base flex-shrink-0",
                                metacriticReviews.user_score >= 7.5 ? "bg-green-600" :
                                metacriticReviews.user_score >= 5 ? "bg-yellow-600" : "bg-red-600"
                              )}>
                                {metacriticReviews.user_score}
                              </div>
                              <div className="text-sm text-white/60">User Score</div>
                            </div>
                          )}
                          <div className="flex-1">
                            <div className="text-sm text-white/60">
                              {metacriticReviews.reviews.length} critic review{metacriticReviews.reviews.length !== 1 ? 's' : ''}
                            </div>
                          </div>
                          <ChevronDown className={cn(
                            "w-5 h-5 text-white/40 transition-transform duration-200 flex-shrink-0",
                            reviewsExpanded && "rotate-180"
                          )} />
                        </button>

                        {/* Individual Critic Reviews — collapsed by default */}
                        <AnimatePresence>
                          {reviewsExpanded && metacriticReviews.reviews.length > 0 && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.25, ease: 'easeInOut' }}
                              className="overflow-hidden"
                            >
                              <div className="space-y-3">
                                {metacriticReviews.reviews.slice(0, 10).map((review, index) => (
                                  <div
                                    key={index}
                                    className="p-4 rounded-lg bg-white/5 border border-white/10"
                                  >
                                    <div className="flex items-start justify-between mb-2">
                                      <div>
                                        <div className="text-sm font-medium text-white">
                                          {review.review_critic}
                                        </div>
                                        {review.author && (
                                          <div className="text-xs text-white/60">
                                            {review.author}
                                          </div>
                                        )}
                                      </div>
                                      {review.review_grade && (
                                        <Badge className={cn(
                                          "text-xs font-bold ml-3",
                                          parseInt(review.review_grade) >= 75 ? "bg-green-600" :
                                          parseInt(review.review_grade) >= 50 ? "bg-yellow-600" : "bg-red-600"
                                        )}>
                                          {review.review_grade}
                                        </Badge>
                                      )}
                                    </div>
                                    <p className="text-white/80 text-sm line-clamp-4">
                                      {review.review}
                                    </p>
                                    {review.review_date && (
                                      <div className="text-xs text-white/40 mt-2">
                                        {review.review_date}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>

                              {metacriticReviews.reviews.length > 0 && (
                                <Button
                                  variant="ghost"
                                  className="w-full mt-3 text-xs"
                                  onClick={() => openExternalUrl(`https://www.metacritic.com/search/${encodeURIComponent(details.name)}/`)}
                                >
                                  View all on Metacritic
                                  <ExternalLink className="w-3 h-3 ml-1" />
                                </Button>
                              )}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </>
                    ) : (
                      <div className="text-center py-8 text-white/40 text-sm">
                        No Metacritic reviews available
                      </div>
                    )}
                  </div>
                )}

                {/* ── Steam Tab Content ── */}
                {reviewTab === 'steam' && reviews && reviews.reviews.length > 0 && (
                  <div className="space-y-4">
                    {/* Review Summary — clickable to expand */}
                <button
                  type="button"
                  onClick={() => setReviewsExpanded(prev => !prev)}
                  className="w-full flex items-center gap-6 p-4 rounded-lg bg-white/5 border border-white/10 hover:bg-white/[0.07] transition-colors cursor-pointer text-left"
                >
                  <div className="text-center">
                    <div className="text-3xl font-bold text-green-400">
                      {positivePercentage}%
                    </div>
                    <div className="text-sm text-white/60">Positive</div>
                  </div>
                  <div className="flex-1">
                    <div className="text-lg font-medium">
                      {reviews.query_summary.review_score_desc || 'Mixed'}
                    </div>
                    <div className="text-sm text-white/60">
                      {reviews.query_summary.total_reviews.toLocaleString()} reviews
                    </div>
                  </div>
                  <div className="flex gap-4 text-sm">
                    <div className="flex items-center gap-1 text-green-400">
                      <ThumbsUp className="w-4 h-4" />
                      {reviews.query_summary.total_positive.toLocaleString()}
                    </div>
                    <div className="flex items-center gap-1 text-red-400">
                      <ThumbsDown className="w-4 h-4" />
                      {reviews.query_summary.total_negative.toLocaleString()}
                    </div>
                  </div>
                  <ChevronDown className={cn(
                    "w-5 h-5 text-white/40 transition-transform duration-200 flex-shrink-0",
                    reviewsExpanded && "rotate-180"
                  )} />
                </button>

                    {/* Individual Steam Reviews — collapsed by default */}
                <AnimatePresence>
                  {reviewsExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                          <div className="space-y-4">
                        {reviews.reviews.slice(0, 5).map((review) => (
                          <div
                            key={review.recommendationid}
                            className="p-4 rounded-lg bg-white/5 border border-white/10"
                          >
                            <div className="flex items-start gap-3 mb-3">
                              <div className={cn(
                                "p-2 rounded",
                                review.voted_up ? "bg-green-500/20" : "bg-red-500/20"
                              )}>
                                {review.voted_up ? (
                                  <ThumbsUp className="w-4 h-4 text-green-400" />
                                ) : (
                                  <ThumbsDown className="w-4 h-4 text-red-400" />
                                )}
                              </div>
                              <div className="flex-1">
                                <div className="flex items-center gap-2 text-sm text-white/60">
                                  <Clock className="w-3 h-3" />
                                  {formatPlaytime(review.author.playtime_forever)} on record
                                  <span className="text-white/40">•</span>
                                  {formatDate(review.timestamp_created)}
                                </div>
                              </div>
                            </div>
                            <p className="text-white/80 text-sm line-clamp-4">
                              {review.review}
                            </p>
                            <div className="flex items-center gap-4 mt-3 text-xs text-white/40">
                              <span>{review.votes_up} found helpful</span>
                              {review.votes_funny > 0 && (
                                <span>{review.votes_funny} found funny</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
                  </div>
                )}

                {/* ── Epic Tab Content ── */}
                {reviewTab === 'epic' && epicReviews && (
                  <div className="space-y-4">
                    {/* Epic score summary */}
                    <button
                      type="button"
                      onClick={() => epicReviews.recentReviews && epicReviews.recentReviews.length > 0 && setReviewsExpanded(prev => !prev)}
                      className={cn(
                        "w-full flex items-center gap-6 p-4 rounded-lg bg-white/5 border border-white/10 text-left",
                        epicReviews.recentReviews && epicReviews.recentReviews.length > 0 ? "hover:bg-white/[0.07] transition-colors cursor-pointer" : ""
                      )}
                    >
                      <div className="text-center">
                        <div className="text-3xl font-bold text-fuchsia-400">
                          {epicReviews.averageRating > 5 ? epicReviews.averageRating : `${epicReviews.averageRating}/5`}
                        </div>
                        <div className="text-sm text-white/60">
                          {epicReviews.averageRating > 5 ? 'OpenCritic' : 'Rating'}
                        </div>
                      </div>
                      <div className="flex-1">
                        <div className="text-lg font-medium">
                          {epicReviews.overallScore}
                        </div>
                        <div className="text-sm text-white/60">
                          {epicReviews.totalReviews > 0
                            ? `${epicReviews.totalReviews.toLocaleString()} reviews`
                            : 'Critic score'}
                        </div>
                      </div>
                      {epicReviews.recentReviews && epicReviews.recentReviews.length > 0 && (
                        <ChevronDown className={cn(
                          "w-5 h-5 text-white/40 transition-transform duration-200 flex-shrink-0",
                          reviewsExpanded && "rotate-180"
                        )} />
                      )}
                    </button>

                    {/* Individual Epic Reviews */}
                    {epicReviews.recentReviews && epicReviews.recentReviews.length > 0 && (
                      <AnimatePresence>
                        {reviewsExpanded && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.25, ease: 'easeInOut' }}
                            className="overflow-hidden"
                          >
                            <div className="space-y-4">
                              {epicReviews.recentReviews.slice(0, 5).map((review, idx) => (
                                <div
                                  key={`epic-review-${idx}`}
                                  className="p-4 rounded-lg bg-white/5 border border-white/10"
                                >
                                  <div className="flex items-start gap-3 mb-3">
                                    <div className={cn(
                                      "p-2 rounded",
                                      review.rating >= 3 ? "bg-green-500/20" : "bg-red-500/20"
                                    )}>
                                      {review.rating >= 3 ? (
                                        <ThumbsUp className="w-4 h-4 text-green-400" />
                                      ) : (
                                        <ThumbsDown className="w-4 h-4 text-red-400" />
                                      )}
                                    </div>
                                    <div className="flex-1">
                                      <div className="flex items-center gap-2 text-sm text-white/60">
                                        <Star className="w-3 h-3" />
                                        {review.rating}/5
                                        {review.userName && (
                                          <>
                                            <span className="text-white/40">•</span>
                                            {review.userName}
                                          </>
                                        )}
                                        {review.date && (
                                          <>
                                            <span className="text-white/40">•</span>
                                            {new Date(review.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                                          </>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                  {review.body && (
                                    <p className="text-white/80 text-sm line-clamp-4">
                                      {review.body}
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* Epic DLC / Add-ons */}
            {epicAddons.length > 0 && (
              <section>
                <h2 className="text-xl font-semibold mb-4 font-['Orbitron']">DLC & Add-ons</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {epicAddons.slice(0, 8).map((addon) => {
                    const fallbackSlug = epicGame?.epicSlug
                      || (crossStoreGame?.store === 'epic' ? (crossStoreGame.epicSlug || crossStoreGame.epicNamespace) : null);
                    const storeUrl = addon.slug
                      ? `https://store.epicgames.com/en-US/p/${addon.slug}`
                      : fallbackSlug
                        ? `https://store.epicgames.com/en-US/p/${fallbackSlug}`
                        : null;
                    return (
                      <button
                        key={addon.id}
                        type="button"
                        onClick={() => storeUrl && openExternalUrl(storeUrl)}
                        title={addon.title}
                        className="group flex flex-col rounded-lg bg-white/5 border border-white/10 hover:bg-white/[0.07] hover:border-white/20 transition-colors text-left cursor-pointer overflow-hidden"
                      >
                        <div className="aspect-square w-full bg-white/10 overflow-hidden">
                          {addon.image ? (
                            <img
                              src={addon.image}
                              alt={addon.title}
                              className="w-full h-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-white/20 text-2xl font-bold">
                              {addon.title.charAt(0)}
                            </div>
                          )}
                        </div>
                        <div className="p-2.5 w-full overflow-hidden flex flex-col justify-between flex-1">
                          <p className="text-xs font-medium text-white line-clamp-3 leading-4 min-h-[3rem]">{addon.title}</p>
                          <div className="flex items-center gap-1 mt-1.5">
                            <span className="text-[11px] text-fuchsia-400 truncate">
                              {addon.isFree ? 'Free' : addon.price || 'View on Store'}
                            </span>
                            <ExternalLink className="w-2.5 h-2.5 text-fuchsia-400/60 flex-shrink-0" />
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
                {epicAddons.length > 8 && (
                  <p className="text-xs text-white/40 mt-2 text-center">
                    +{epicAddons.length - 8} more add-ons available on the Epic Games Store
                  </p>
                )}
              </section>
            )}
          </div>

          {/* Right Column - Info Panel */}
          <div className="space-y-6">
            {/* Quick Info Card */}
            <div className="p-6 rounded-lg bg-white/5 border border-white/10 space-y-4">
              {/* Header Image with fallback */}
              <div className="relative aspect-video rounded-lg overflow-hidden bg-white/5">
                {!headerImageLoaded && !headerImageError && (
                  <div className="absolute inset-0 bg-white/10 animate-pulse" />
                )}
                {headerImageError ? (
                  <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-fuchsia-500/20 to-purple-600/20">
                    <span className="text-2xl font-bold text-white/40">{details.name.charAt(0)}</span>
                  </div>
                ) : (
                  <img
                    src={details.header_image}
                    alt={details.name}
                    loading="lazy"
                    className={cn(
                      "w-full h-full object-cover transition-opacity duration-500",
                      headerImageLoaded ? "opacity-100" : "opacity-0"
                    )}
                    onLoad={() => setHeaderImageLoaded(true)}
                    onError={() => setHeaderImageError(true)}
                  />
                )}
              </div>

              {/* ── Store Price Buttons ─────────────────────────────────── */}
              {(() => {
                // Resolve each store's price string and URL
                const steamUrl = details.steam_appid
                  ? `https://store.steampowered.com/app/${details.steam_appid}`
                  : null;
                const steamPrice = details.is_free
                  ? 'Free to Play'
                  : details.price_overview?.final_formatted || null;
                const steamDiscount = details.price_overview?.discount_percent || 0;

                const epicSlug = isEpicPrimary
                  ? epicGame.epicSlug
                  : crossStoreGame?.store === 'epic'
                    ? (crossStoreGame.epicSlug || crossStoreGame.epicNamespace)
                    : crossStoreGame?.store === 'steam'
                      ? null
                      : null;
                const epicUrl = epicSlug
                  ? `https://store.epicgames.com/en-US/p/${epicSlug}`
                  : null;

                // Resolve Epic price — try the direct price field first, then
                // fall back to the preserved epicPrice field from dedup.
                const epicPriceObj = (() => {
                  if (isEpicPrimary) return (epicGame as Game).price ?? null;
                  if (crossStoreGame?.store === 'epic') {
                    const direct = crossStoreGame.price;
                    if (direct?.finalFormatted) return direct;
                    // Fall back to the epicPrice field preserved during dedup
                    const fallback = (crossStoreGame as Game).epicPrice;
                    if (fallback?.finalFormatted) return fallback;
                    return direct ?? fallback ?? null;
                  }
                  return null;
                })();
                const epicIsFree = details.is_free || epicPriceObj?.isFree;
                const epicPrice = epicIsFree
                  ? 'Free to Play'
                  : epicPriceObj?.finalFormatted || null;
                const epicDiscount = epicPriceObj?.discountPercent || 0;

                // Cross-store: Steam on an Epic-primary game
                const crossSteamUrl = crossStoreGame?.store === 'steam' && crossStoreGame.steamAppId
                  ? `https://store.steampowered.com/app/${crossStoreGame.steamAppId}`
                  : null;

                // Parse raw price numbers for comparison
                const parsePrice = (s: string | null): number | null => {
                  if (!s || s === 'Free to Play') return 0;
                  const m = s.replace(/[^\d.,]/g, '').replace(',', '');
                  const n = parseFloat(m);
                  return isNaN(n) ? null : n;
                };
                const steamNum = parsePrice(steamPrice);
                const epicNum = parsePrice(epicPrice);

                const hasBoth = !!(steamUrl && epicUrl && steamPrice && epicPrice);
                let steamCheaperPct = 0;
                let epicCheaperPct = 0;
                if (hasBoth && steamNum !== null && epicNum !== null && steamNum !== epicNum) {
                  if (steamNum < epicNum && epicNum > 0) {
                    steamCheaperPct = Math.round(((epicNum - steamNum) / epicNum) * 100);
                  } else if (epicNum < steamNum && steamNum > 0) {
                    epicCheaperPct = Math.round(((steamNum - epicNum) / steamNum) * 100);
                  }
                }

                const priceBtn = (
                  label: string,
                  icon: React.ReactNode,
                  price: string | null,
                  storeDiscount: number,
                  cheaperPct: number,
                  url: string,
                  isFull: boolean,
                ) => (
                  <button
                    type="button"
                    onClick={() => openExternalUrl(url)}
                    className={cn(
                      "relative flex flex-col items-center gap-1 p-3 rounded-lg border transition-colors cursor-pointer text-center",
                      "bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20",
                      isFull ? "w-full" : "flex-1 min-w-0"
                    )}
                  >
                    {cheaperPct > 0 && (
                      <Badge className="absolute -top-2 -right-2 bg-green-600 text-[10px] px-1.5 py-0.5 shadow-lg">
                        {cheaperPct}% cheaper
                </Badge>
                    )}
                    {storeDiscount > 0 && (
                      <Badge className="bg-green-600 text-xs mb-0.5">
                        -{storeDiscount}%
                    </Badge>
                  )}
                    <div className="text-xl font-bold text-white">
                      {price || (details.release_date?.coming_soon ? 'Coming Soon' : 'View Store')}
                  </div>
                    <div className="flex items-center gap-1.5 text-xs text-white/50">
                      {icon}
                      {label}
                      <ExternalLink className="w-2.5 h-2.5" />
                </div>
                  </button>
                );

                  return (
                  <>
                    <div className={cn("flex gap-3", hasBoth ? "" : "flex-col")}>
                      {/* Steam price button */}
                      {steamUrl && steamPrice && priceBtn(
                        'Steam', <FaSteam className="w-3 h-3" />,
                        steamPrice, steamDiscount, steamCheaperPct,
                        steamUrl, !hasBoth
                      )}
                      {/* Epic price button */}
                      {epicUrl && epicPrice && priceBtn(
                        'Epic Games', <SiEpicgames className="w-3 h-3" />,
                        epicPrice, epicDiscount, epicCheaperPct,
                        epicUrl, !hasBoth
                      )}
                      {/* Steam URL only (no price data) */}
                      {steamUrl && !steamPrice && !epicUrl && priceBtn(
                        'Steam', <FaSteam className="w-3 h-3" />,
                        null, 0, 0, steamUrl, true
                      )}
                      {/* Epic URL only (no price data) */}
                      {epicUrl && !epicPrice && priceBtn(
                        'Epic Games', <SiEpicgames className="w-3 h-3" />,
                        null, 0, 0, epicUrl, !steamUrl
                      )}
                      {/* Cross-store Steam button (Epic-primary game also on Steam) */}
                      {crossSteamUrl && priceBtn(
                        'Steam', <FaSteam className="w-3 h-3" />,
                        null, 0, 0, crossSteamUrl, !epicUrl
                      )}
                    </div>
                  </>
                  );
              })()}

              {/* Add to Library / Edit Library Entry */}
              <Button
                onClick={handleOpenLibraryDialog}
                className={cn(
                  "w-full",
                  gameInLibrary 
                    ? "bg-fuchsia-600 hover:bg-fuchsia-700" 
                    : "bg-white/10 hover:bg-white/20"
                )}
              >
                <Heart className={cn("w-4 h-4 mr-2 pointer-events-none", gameInLibrary && "fill-current")} />
                {gameInLibrary ? 'Edit Library Entry' : 'Add to Library'}
              </Button>
              
              {/* Remove from Library - only show if in library */}
              {gameInLibrary && (
                <Button
                  onClick={() => gameId && removeFromLibrary(gameId)}
                  variant="outline"
                  className="w-full text-red-400 border-red-400/30 hover:bg-red-400/10"
                >
                  Remove from Library
                </Button>
              )}

              {/* Website Link */}
              {details.website && (
                <Button
                  variant="ghost"
                  className="w-full text-sm"
                  onClick={() => openExternalUrl(details.website!)}
                >
                  <ExternalLink className="w-3 h-3 mr-2" />
                  Official Website
                </Button>
              )}

              {/* FitGirl Repack Link */}
              {fitgirlLoading ? (
                <div className="h-10 w-full rounded-md bg-white/5 border border-white/10 animate-pulse" />
              ) : fitgirlRepack && (fitgirlRepack.downloadLink || fitgirlRepack.url) ? (
                <div className="space-y-2">
                  {fitgirlRepack.downloadLink ? (
                    <Button
                      variant="outline"
                      className="w-full border-green-500/50 hover:bg-green-500/10 text-green-400"
                      onClick={() => {
                        if (fitgirlRepack.downloadLink) {
                          openExternalUrl(fitgirlRepack.downloadLink);
                        }
                      }}
                    >
                      <Download className="w-3 h-3 mr-2" />
                      Download Repack
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    className="w-full text-sm text-white/70 hover:text-white"
                    onClick={() => openExternalUrl(fitgirlRepack.url)}
                  >
                    <ExternalLink className="w-3 h-3 mr-2" />
                    View on FitGirl
                  </Button>
                </div>
              ) : (
                <div className="text-center py-2 text-white/40 text-xs">
                  No FitGirl repack found
                </div>
              )}
            </div>

            {/* Details Card */}
            <div className="p-6 rounded-lg bg-white/5 border border-white/10 space-y-4">
              <h3 className="font-semibold font-['Orbitron']">Details</h3>
              
              <div className="space-y-3 text-sm">
                {/* Developer */}
                {details.developers && details.developers.length > 0 && (
                  <div>
                    <span className="text-white/60">Developer</span>
                    <div className="text-white">{details.developers.join(', ')}</div>
                  </div>
                )}

                {/* Publisher */}
                {details.publishers && details.publishers.length > 0 && (
                  <div>
                    <span className="text-white/60">Publisher</span>
                    <div className="text-white">{details.publishers.join(', ')}</div>
                  </div>
                )}

                {/* Release Date */}
                {details.release_date && (
                  <div>
                    <span className="text-white/60">Release Date</span>
                    <div className="text-white">{details.release_date.date}</div>
                  </div>
                )}

                {/* Platforms */}
                <div>
                  <span className="text-white/60">Platforms</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {details.platforms.windows && (
                      <Badge variant="outline" className="text-xs border-white/20">
                        <FaWindows className="w-3 h-3 mr-1" /> Windows
                      </Badge>
                    )}
                    {details.platforms.mac && (
                      <Badge variant="outline" className="text-xs border-white/20">
                        <FaApple className="w-3 h-3 mr-1" /> macOS
                      </Badge>
                    )}
                    {details.platforms.linux && (
                      <Badge variant="outline" className="text-xs border-white/20">
                        <FaLinux className="w-3 h-3 mr-1" /> Linux
                      </Badge>
                    )}
                  </div>
                </div>

                {/* Categories */}
                {details.categories && details.categories.length > 0 && (
                  <div>
                    <span className="text-white/60">Features</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {details.categories.slice(0, 6).map((cat) => (
                        <Badge key={cat.id} variant="outline" className="text-xs border-white/20">
                          {cat.description}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Achievements */}
                {details.achievements && details.achievements.total > 0 && (
                  <div>
                    <span className="text-white/60">Achievements</span>
                    <div className="text-white">{details.achievements.total}</div>
                  </div>
                )}

                {/* Epic DLC count */}
                {epicAddons.length > 0 && (
                  <div>
                    <span className="text-white/60">DLC & Add-ons</span>
                    <div className="text-white flex items-center gap-1">
                      <Download className="w-3 h-3" />
                      {epicAddons.length}
                    </div>
                  </div>
                )}

                {/* Recommendations */}
                {details.recommendations && (
                  <div>
                    <span className="text-white/60">Recommendations</span>
                    <div className="text-white flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      {details.recommendations.total.toLocaleString()}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Languages */}
            {details.supported_languages && (
              <div className="p-6 rounded-lg bg-white/5 border border-white/10">
                <h3 className="font-semibold font-['Orbitron'] mb-3">Languages</h3>
                <div className="flex flex-wrap gap-1">
                  {details.supported_languages
                    .replace(/<[^>]*>/g, '')
                    .split(',')
                    .map(l => l.trim())
                    .filter(Boolean)
                    .map((lang) => (
                      <Badge key={lang} variant="outline" className="text-xs border-white/20">
                        {lang}
                            </Badge>
                    ))
                  }
                        </div>
                          </div>
                        )}

          </div>
        </div>

      {/* News & Updates Section — Apple Cards Carousel */}
      <div className="bg-black/50 py-8">
        <div className="max-w-7xl mx-auto px-4">
          <h2 className="text-xl font-semibold mb-4 font-['Orbitron']">News & Updates</h2>

          {(steamNewsLoading || epicNewsLoading) ? (
            <div className="flex gap-4 overflow-x-auto py-6 pl-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex-shrink-0 w-40 md:w-52">
                  <div className="h-52 md:h-72 bg-white/5 rounded-2xl border border-white/10 overflow-hidden animate-pulse">
                    <div className="h-2/3 bg-white/10" />
                    <div className="p-3 space-y-2">
                      <div className="h-3 w-3/4 rounded bg-white/10" />
                      <div className="h-3 w-1/2 rounded bg-white/10" />
                      <div className="h-2 w-1/3 rounded bg-white/5" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : newsCarouselItems.length > 0 ? (
            <Carousel items={newsCarouselItems} />
          ) : (
            <div className="flex items-center justify-center min-h-[256px] md:min-h-[336px] text-white/40 text-sm">
              No news available for this game.
            </div>
          )}
        </div>
      </div>

      {/* Recommended by Steam Section */}
      {(recommendations.length > 0 || recommendationsLoading) && (
        <div className="bg-black/50 py-8">
          <div className="max-w-7xl mx-auto px-4">
            <h2 className="text-xl font-semibold mb-4 font-['Orbitron']">Recommended by Steam</h2>
            
            {recommendationsLoading ? (
              <div className="flex gap-4 overflow-x-auto pb-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex-shrink-0 w-64 animate-pulse">
                    <div className="aspect-[460/215] bg-white/10 rounded-lg border border-white/5" />
                    <div className="mt-2 h-4 bg-white/10 rounded w-3/4" />
                    <div className="mt-1 flex items-center gap-2">
                      <div className="h-3 bg-white/5 rounded w-12" />
                      <div className="h-2 bg-fuchsia-500/10 rounded-full w-16" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="relative group/recs">
                {/* Left Arrow */}
                <button
                  onClick={() => {
                    if (recommendationsScrollRef.current) {
                      recommendationsScrollRef.current.scrollBy({ left: -280, behavior: 'smooth' });
                    }
                  }}
                  className="absolute left-0 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/70 hover:bg-black/90 text-white opacity-0 group-hover/recs:opacity-100 transition-opacity -translate-x-4"
                  aria-label="Scroll left"
                >
                  <ChevronLeft className="w-5 h-5 pointer-events-none" />
                </button>

                {/* Right Arrow */}
                <button
                  onClick={() => {
                    if (recommendationsScrollRef.current) {
                      recommendationsScrollRef.current.scrollBy({ left: 280, behavior: 'smooth' });
                    }
                  }}
                  className="absolute right-0 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/70 hover:bg-black/90 text-white opacity-0 group-hover/recs:opacity-100 transition-opacity translate-x-4"
                  aria-label="Scroll right"
                >
                  <ChevronRight className="w-5 h-5 pointer-events-none" />
                </button>

                {/* Scrollable Container */}
                <div 
                  ref={recommendationsScrollRef}
                  onMouseEnter={() => setIsRecommendationsPaused(true)}
                  onMouseLeave={() => setIsRecommendationsPaused(false)}
                  className="flex gap-4 overflow-x-auto pb-4 scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent scroll-smooth"
                >
                  {recommendationsRendered}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
});
