/**
 * Buzz View Component — News Stories with Inline Webview
 *
 * Displays gaming news from Steam and RSS feeds as portrait story cards
 * left-aligned in the view. Clicking a card opens the source article in
 * an Electron webview panel on the right side.
 *
 * Features segmented progress bars, auto-advance, keyboard navigation,
 * always-visible nav arrows, and an inline webview reader.
 */
import { useEffect, useState, useCallback, useRef, useMemo, forwardRef, memo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Newspaper, RefreshCw, ExternalLink, Clock, ChevronLeft, ChevronRight, X, Loader2, Globe, ArrowLeft, ArrowRight, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchAllNews, clearNewsCache, NewsItem } from '@/services/news-service';
import { cn } from '@/lib/utils';

// ─── Config ─────────────────────────────────────────────────────────────────

const STORY_DURATION = 8000; // ms per story
const AUTO_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
const FALLBACK_IMAGE = 'https://cdn.akamai.steamstatic.com/steam/apps/730/header.jpg';

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatRelativeDate(unixSeconds: number): string {
  const now = Date.now() / 1000;
  const diff = now - unixSeconds;

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;

  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getSourceColor(source: string): string {
  if (source.startsWith('Steam')) return 'bg-blue-500/90 text-white';
  if (source.includes('r/gaming')) return 'bg-orange-500/90 text-white';
  if (source.includes('r/pcgaming')) return 'bg-red-500/90 text-white';
  return 'bg-fuchsia-500/90 text-white';
}

/** Build a Steam header fallback URL from a Steam source string. */
function getSteamFallbackFromSource(_source: string, imageUrl?: string): string | undefined {
  // If the original imageUrl is a library_hero, provide header.jpg as fallback
  if (imageUrl?.includes('/library_hero.')) {
    const match = imageUrl.match(/\/apps\/(\d+)\//);
    if (match) {
      return `https://cdn.akamai.steamstatic.com/steam/apps/${match[1]}/header.jpg`;
    }
  }
  return undefined;
}

// ─── Fade-in Image ──────────────────────────────────────────────────────────
// Combines native lazy loading, async decoding, and opacity fade-in.

function BuzzFadeImage({
  src,
  alt = '',
  className = '',
  onError,
}: {
  src: string;
  alt?: string;
  className?: string;
  onError?: () => void;
}) {
  // Check if the image is already in the browser cache (e.g. preloaded).
  // If so, skip the fade-in and show it immediately.
  const isCached = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const img = new Image();
    img.src = src;
    return img.complete && img.naturalWidth > 0;
  }, [src]);

  const [loaded, setLoaded] = useState(isCached);

  // Reset loaded state when src changes — but stay true if already cached
  useEffect(() => {
    if (isCached) {
      setLoaded(true);
    } else {
      setLoaded(false);
    }
  }, [src, isCached]);

  return (
    <img
      src={src}
      alt={alt}
      loading="eager"      // stories are preloaded, show immediately
      decoding="async"
      onLoad={() => setLoaded(true)}
      onError={onError}
      className={cn(
        className,
        'transition-opacity duration-300 ease-in',
        loaded ? 'opacity-100' : 'opacity-0',
      )}
    />
  );
}

// ─── Image Preloader Hook ───────────────────────────────────────────────────
// Preloads story images in the background the moment news data arrives.
// Prioritises the current image + nearby stories, then loads the rest.

function usePreloadStoryImages(stories: NewsItem[], currentIndex: number) {
  const preloadedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (stories.length === 0) return;

    // Build priority-ordered URL list: current → next 5 → prev 2 → rest
    const urls: string[] = [];
    const seen = new Set<string>();
    const addUrl = (idx: number) => {
      const url = stories[((idx % stories.length) + stories.length) % stories.length]?.imageUrl;
      if (url && !seen.has(url) && !preloadedRef.current.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    };

    // Current + next 5
    for (let i = 0; i <= 5; i++) addUrl(currentIndex + i);
    // Previous 2
    for (let i = 1; i <= 2; i++) addUrl(currentIndex - i);
    // Everything else
    for (let i = 0; i < stories.length; i++) addUrl(i);

    // Preload in micro-batches to avoid flooding the network
    let cancelled = false;
    const BATCH = 4;
    let offset = 0;

    const loadBatch = () => {
      if (cancelled || offset >= urls.length) return;
      const batch = urls.slice(offset, offset + BATCH);
      offset += BATCH;

      for (const url of batch) {
        const img = new Image();
        img.src = url;
        img.onload = () => { preloadedRef.current.add(url); };
        img.onerror = () => { preloadedRef.current.add(url); }; // mark done even on error
      }

      // Next batch after a short delay
      setTimeout(loadBatch, 200);
    };

    loadBatch();
    return () => { cancelled = true; };
  }, [stories, currentIndex]);
}

// ─── Progress Bar Segments ──────────────────────────────────────────────────

function StoryProgressBar({
  total,
  current,
  progress,
  onSegmentClick,
}: {
  total: number;
  current: number;
  progress: number;
  onSegmentClick: (index: number) => void;
}) {
  const maxVisible = 40;
  const startIdx = Math.max(0, Math.min(current - Math.floor(maxVisible / 2), total - maxVisible));
  const endIdx = Math.min(total, startIdx + maxVisible);

  return (
    <div className="flex gap-[3px] w-full px-3 pt-3 pb-1">
      {Array.from({ length: endIdx - startIdx }).map((_, offset) => {
        const i = startIdx + offset;
        return (
          <button
            key={i}
            onClick={(e) => {
              e.stopPropagation();
              onSegmentClick(i);
            }}
            className="flex-1 h-[2.5px] rounded-full overflow-hidden bg-white/25 cursor-pointer hover:bg-white/35 transition-colors"
          >
            <div
              className={cn(
                'h-full rounded-full',
                i < current
                  ? 'bg-white/80 w-full'
                  : i === current
                    ? 'bg-white/80'
                    : 'w-0',
              )}
              style={
                i === current
                  ? {
                      width: `${progress * 100}%`,
                      transition: 'width 100ms linear',
                    }
                  : undefined
              }
            />
          </button>
        );
      })}
    </div>
  );
}

// ─── Webview Panel ──────────────────────────────────────────────────────────

function WebviewPanel({
  url,
  onClose,
}: {
  url: string;
  onClose: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pageTitle, setPageTitle] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── Open / close BrowserView via IPC ──────────────────────────
  useEffect(() => {
    const api = window.webviewApi;
    const el = contentRef.current;
    if (!api || !el) return;

    // Compute the pixel bounds of the content area
    const getBounds = () => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    };

    // Open the BrowserView at the correct position
    api.open(url, getBounds());

    // Subscribe to events from the main process
    const unsubs = [
      api.onLoading((loading) => {
        setIsLoading(loading);
        if (loading) setLoadError(null);
      }),
      api.onTitle((title) => setPageTitle(title)),
      api.onError((error) => {
        setIsLoading(false);
        setLoadError(error);
      }),
      api.onNavState((state) => {
        setCanGoBack(state.canGoBack);
        setCanGoForward(state.canGoForward);
      }),
    ];

    // Keep BrowserView in sync when the container resizes / moves
    const updateBounds = () => api.resize(getBounds());
    const observer = new ResizeObserver(updateBounds);
    observer.observe(el);
    window.addEventListener('resize', updateBounds);

    // Safety timeout — hide loading spinner after 20s
    const safetyTimer = setTimeout(() => setIsLoading(false), 20000);

    return () => {
      clearTimeout(safetyTimer);
      observer.disconnect();
      window.removeEventListener('resize', updateBounds);
      unsubs.forEach((u) => u());
      api.close();
    };
  }, [url]);

  // ── Handlers ──────────────────────────────────────────────────
  const handleBack = useCallback(() => window.webviewApi?.goBack(), []);
  const handleForward = useCallback(() => window.webviewApi?.goForward(), []);

  const handleReload = useCallback(() => {
    setLoadError(null);
    setIsLoading(true);
    window.webviewApi?.reload();
  }, []);

  const handleOpenExternal = useCallback(() => {
    window.webviewApi?.openExternal(url);
  }, [url]);

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 rounded-2xl overflow-hidden border border-white/10 bg-black/60 backdrop-blur-sm shadow-2xl shadow-black/40">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-black/80 border-b border-white/[0.06] flex-shrink-0">
        {/* Navigation buttons */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={handleBack}
            disabled={!canGoBack}
            className={cn(
              'w-7 h-7 rounded-lg flex items-center justify-center transition-colors',
              canGoBack ? 'text-white/50 hover:text-white hover:bg-white/10' : 'text-white/15 cursor-not-allowed',
            )}
            title="Go back"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleForward}
            disabled={!canGoForward}
            className={cn(
              'w-7 h-7 rounded-lg flex items-center justify-center transition-colors',
              canGoForward ? 'text-white/50 hover:text-white hover:bg-white/10' : 'text-white/15 cursor-not-allowed',
            )}
            title="Go forward"
          >
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleReload}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors"
            title="Reload"
          >
            <RotateCw className={cn('w-3.5 h-3.5', isLoading && 'animate-spin')} />
          </button>
        </div>

        {/* URL / title bar */}
        <div className="flex-1 min-w-0 flex items-center gap-2 px-3 py-1 rounded-lg bg-white/5 border border-white/[0.06]">
          <Globe className="w-3 h-3 text-white/30 flex-shrink-0" />
          <span className="text-[11px] text-white/50 truncate">
            {pageTitle || url}
          </span>
          {isLoading && (
            <Loader2 className="w-3 h-3 text-fuchsia-400 animate-spin flex-shrink-0" />
          )}
        </div>

        {/* Open external */}
        <button
          onClick={handleOpenExternal}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors"
          title="Open in browser"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </button>

        {/* Close button */}
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-red-500/20 transition-colors"
          title="Close webview"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content area — BrowserView is positioned over this div by the main process */}
      <div ref={contentRef} className="flex-1 relative" style={{ minHeight: 0 }}>
        {isLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 pointer-events-none">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="w-8 h-8 text-fuchsia-500 animate-spin" />
              <span className="text-xs text-white/40">Loading article...</span>
            </div>
          </div>
        )}
        {loadError && !isLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60">
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="text-sm text-white/50">{loadError}</span>
              <button onClick={handleReload} className="text-xs text-fuchsia-400 hover:text-fuchsia-300">
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Story Card ─────────────────────────────────────────────────────────────

const StoryCard = forwardRef<HTMLDivElement, { item: NewsItem; direction: number }>(
  function StoryCard({ item, direction }, ref) {
  const [imgSrc, setImgSrc] = useState(item.imageUrl || FALLBACK_IMAGE);
  const steamFallback = getSteamFallbackFromSource(item.source, item.imageUrl);

  const handleOpenLink = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.electron?.openExternal) {
      window.electron.openExternal(item.url);
    } else {
      window.open(item.url, '_blank');
    }
  };

  const handleImgError = () => {
    if (steamFallback && imgSrc !== steamFallback && imgSrc !== FALLBACK_IMAGE) {
      setImgSrc(steamFallback);
    } else if (imgSrc !== FALLBACK_IMAGE) {
      setImgSrc(FALLBACK_IMAGE);
    }
  };

  const variants = {
    enter: (dir: number) => ({
      x: dir > 0 ? '100%' : '-100%',
      opacity: 0.5,
    }),
    center: {
      x: 0,
      opacity: 1,
    },
    exit: (dir: number) => ({
      x: dir > 0 ? '-100%' : '100%',
      opacity: 0.5,
    }),
  };

  return (
    <motion.div
      ref={ref}
      custom={direction}
      variants={variants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
      className="absolute inset-0 bg-black"
    >
      {/* Background image */}
      <BuzzFadeImage
        src={imgSrc}
        alt={item.title}
        className="absolute inset-0 w-full h-full z-0 object-cover"
        onError={handleImgError}
      />

      {/* Top gradient for progress bar */}
      <div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-b from-black/75 via-transparent to-transparent" />

      {/* Bottom gradient for text */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 h-[60%] bg-gradient-to-t from-black/95 via-black/70 to-transparent" />

      {/* Content — bottom */}
      <div className="absolute bottom-0 left-0 right-0 z-20 p-5 md:p-6 flex flex-col gap-2.5">
        {/* Source badge */}
        <div>
          <span
            className={cn(
              'px-2.5 py-0.5 rounded-full text-[10px] font-semibold backdrop-blur-sm',
              getSourceColor(item.source),
            )}
          >
            {item.source}
          </span>
        </div>

        {/* Title */}
        <h2 className="text-base md:text-xl font-bold text-white leading-snug line-clamp-3">
          {item.title}
        </h2>

        {/* Summary */}
        <p className="text-xs md:text-sm text-white/55 leading-relaxed line-clamp-6">
          {item.summary}
        </p>

        {/* Footer: date + Read more */}
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-1.5 text-[10px] text-white/35">
            <Clock className="w-3 h-3" />
            <span>{formatRelativeDate(item.publishedAt)}</span>
          </div>

          {/* Read more — opens in external browser */}
          <button
            onClick={handleOpenLink}
            className="flex items-center gap-1 text-[10px] text-white/40 hover:text-white transition-colors group"
          >
            <span>Read more</span>
            <ExternalLink className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
          </button>
        </div>
      </div>
    </motion.div>
  );
});

// ─── Main Component ─────────────────────────────────────────────────────────

export const BuzzView = memo(function BuzzView() {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [direction, setDirection] = useState(1);
  const [viewUrl, setViewUrl] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const progressInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  const stories = useMemo(() => news.slice(0, 30), [news]);
  const total = stories.length;

  // Preload story images in the background for instant navigation
  usePreloadStoryImages(stories, currentIndex);

  // ─── Data fetching ────────────────────────────────────────────

  const loadNews = useCallback(async (force = false) => {
    try {
      if (force) {
        clearNewsCache();
      } else {
        setLoading(true);
      }
      setError(null);
      const items = await fetchAllNews(force);
      setNews(items);
    } catch (err) {
      console.error('[BuzzView] Failed to fetch news:', err);
      setError('Failed to load gaming news. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNews();
  }, [loadNews]);

  useEffect(() => {
    const interval = setInterval(() => loadNews(true), AUTO_REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [loadNews]);

  // ─── Navigation ───────────────────────────────────────────────

  const goTo = useCallback(
    (index: number, dir?: number) => {
      if (total === 0) return;
      const next = ((index % total) + total) % total;
      setDirection(dir ?? (next > currentIndex ? 1 : -1));
      setCurrentIndex(next);
      setProgress(0);
    },
    [total, currentIndex],
  );

  const goNext = useCallback(() => {
    goTo(currentIndex + 1, 1);
  }, [goTo, currentIndex]);

  const goPrev = useCallback(() => {
    goTo(currentIndex - 1, -1);
  }, [goTo, currentIndex]);

  // ─── Auto-advance timer ───────────────────────────────────────

  useEffect(() => {
    if (total === 0 || isPaused) {
      if (progressInterval.current) {
        clearInterval(progressInterval.current);
        progressInterval.current = null;
      }
      return;
    }

    const tickMs = 50;
    const step = tickMs / STORY_DURATION;

    progressInterval.current = setInterval(() => {
      setProgress((prev) => {
        const next = prev + step;
        if (next >= 1) {
          setDirection(1);
          setCurrentIndex((ci) => (ci + 1) % total);
          return 0;
        }
        return next;
      });
    }, tickMs);

    return () => {
      if (progressInterval.current) clearInterval(progressInterval.current);
    };
  }, [total, isPaused, currentIndex]);

  // ─── Keyboard navigation ──────────────────────────────────────

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'Escape' && viewUrl) {
        e.preventDefault();
        setViewUrl(null);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goNext, goPrev, viewUrl]);

  // ─── Card click → open webview ────────────────────────────────

  const handleCardClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('button, a')) return;
      const story = stories[currentIndex];
      if (story) {
        setViewUrl(story.url);
        setIsPaused(true);
      }
    },
    [stories, currentIndex],
  );

  const handleCloseView = useCallback(() => {
    setViewUrl(null);
  }, []);

  // ─── Loading state ────────────────────────────────────────────

  if (loading && news.length === 0) {
    return (
      <div className="relative w-full overflow-hidden" style={{ height: 'calc(100vh - 180px)' }}>
        <div className="relative z-10 flex items-stretch w-full h-full px-6 py-2 gap-4 overflow-hidden">
          {/* Left: skeleton card */}
          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="w-9" /> {/* arrow placeholder */}
            <div className="relative h-full aspect-[9/16] rounded-2xl overflow-hidden bg-black/40 border border-white/10 backdrop-blur-sm">
              <div className="flex gap-[3px] w-full px-3 pt-3 pb-1">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="flex-1 h-[2.5px] rounded-full bg-white/10 animate-pulse" />
                ))}
              </div>
              <div className="absolute bottom-0 left-0 right-0 p-5 md:p-6">
                <div className="h-4 w-20 bg-white/10 rounded-full animate-pulse mb-4" />
                <div className="h-5 w-4/5 bg-white/10 rounded animate-pulse mb-2" />
                <div className="h-5 w-3/5 bg-white/10 rounded animate-pulse mb-4" />
                <div className="h-3.5 w-full bg-white/5 rounded animate-pulse mb-1.5" />
                <div className="h-3.5 w-4/5 bg-white/5 rounded animate-pulse mb-1.5" />
                <div className="h-3.5 w-3/5 bg-white/5 rounded animate-pulse mb-1.5" />
                <div className="h-3.5 w-2/3 bg-white/5 rounded animate-pulse" />
              </div>
            </div>
            <div className="w-9" /> {/* arrow placeholder */}
          </div>

          {/* Right: empty placeholder */}
          <div className="flex-1 h-full rounded-2xl border border-white/[0.06] bg-white/[0.02] flex items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-white/15">
              <Globe className="w-8 h-8" />
              <span className="text-xs">Webview</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Empty / error state ──────────────────────────────────────

  if (error || news.length === 0) {
    return (
      <div className="relative w-full" style={{ height: 'calc(100vh - 180px)' }}>
        <div className="relative z-10 flex flex-col items-center justify-center h-full text-center">
          <div className="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center mb-6 shadow-lg shadow-fuchsia-500/10 backdrop-blur-sm">
            <Newspaper className="w-10 h-10 text-fuchsia-500" />
          </div>
          <h2 className="text-2xl font-bold mb-2 font-['Orbitron']">
            {error ? 'Oops!' : 'No News Yet'}
          </h2>
          <p className="text-white/60 mb-6 max-w-md">
            {error || 'Gaming news will appear here once fetched from Steam and RSS feeds.'}
          </p>
          <Button
            onClick={() => loadNews(true)}
            className="bg-fuchsia-500 hover:bg-fuchsia-600 text-white gap-1.5"
          >
            <RefreshCw className="w-4 h-4" />
            Try Again
          </Button>
        </div>
      </div>
    );
  }

  const currentStory = stories[currentIndex];

  // ─── Stories view ─────────────────────────────────────────────

  return (
    <div
      className="relative w-full overflow-hidden"
      style={{ height: 'calc(100vh - 180px)' }}
    >
      <div className="relative z-10 flex items-stretch w-full h-full px-6 py-2 gap-4 overflow-hidden">
        {/* ── Left column: card + arrows ───────────────────────────── */}
        <div className="flex items-center gap-3 flex-shrink-0">
          {/* Left arrow */}
          <button
            onClick={goPrev}
            className={cn(
              'flex-shrink-0 w-9 h-9 rounded-full',
              'flex items-center justify-center',
              'bg-white/5 hover:bg-white/10 transition-colors',
              'border border-white/10 hover:border-white/20',
              'text-white/40 hover:text-white',
              'backdrop-blur-sm',
            )}
          >
            <ChevronLeft className="w-5 h-5" />
          </button>

          {/* The story card — height-driven, portrait 9:16 */}
          <div
            ref={containerRef}
            className={cn(
              'relative h-full aspect-[9/16] rounded-2xl overflow-hidden',
              'bg-black/80 border border-white/10',
              'cursor-pointer select-none',
              'shadow-2xl shadow-black/60',
            )}
            onClick={handleCardClick}
            onMouseEnter={() => setIsPaused(true)}
            onMouseLeave={() => { if (!viewUrl) setIsPaused(false); }}
          >
            {/* Progress segments */}
            <div className="absolute top-0 left-0 right-0 z-40">
              <StoryProgressBar
                total={total}
                current={currentIndex}
                progress={progress}
                onSegmentClick={(i) => goTo(i, i > currentIndex ? 1 : -1)}
              />
            </div>

            {/* Story counter */}
            <div className="absolute top-6 right-3 z-40">
              <span className="text-[10px] text-white/35 font-medium tabular-nums">
                {currentIndex + 1}/{total}
              </span>
            </div>

            {/* Story cards with animation */}
            <AnimatePresence initial={false} custom={direction} mode="popLayout">
              <StoryCard
                key={currentStory.id}
                item={currentStory}
                direction={direction}
              />
            </AnimatePresence>
          </div>

          {/* Right arrow */}
          <button
            onClick={goNext}
            className={cn(
              'flex-shrink-0 w-9 h-9 rounded-full',
              'flex items-center justify-center',
              'bg-white/5 hover:bg-white/10 transition-colors',
              'border border-white/10 hover:border-white/20',
              'text-white/40 hover:text-white',
              'backdrop-blur-sm',
            )}
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        {/* ── Right column: webview panel or placeholder ──────────── */}
        {viewUrl ? (
          <WebviewPanel url={viewUrl} onClose={handleCloseView} />
        ) : (
          <div className="flex-1 h-full rounded-2xl border border-white/[0.06] bg-white/[0.02] flex items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-white/15">
              <Globe className="w-10 h-10" />
              <span className="text-xs font-medium">Click on a story card to read it here, ad-free</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
