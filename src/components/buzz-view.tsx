/**
 * Buzz View Component
 *
 * Displays aggregated gaming news from Steam and Reddit in an auto-scrolling
 * carousel. Cards show source, title, summary, date, and a background image
 * with a gradient overlay styled to match the app's dark theme.
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Newspaper, RefreshCw, ExternalLink, Clock, MessageSquare, Gamepad2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Carousel } from '@/components/ui/apple-cards-carousel';
import { BlurImage } from '@/components/ui/apple-cards-carousel';
import { fetchAllNews, clearNewsCache, NewsItem } from '@/services/news-service';
import { cn } from '@/lib/utils';

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
  if (source.startsWith('Steam')) return 'bg-blue-500/80 text-white';
  if (source.includes('r/gaming')) return 'bg-orange-500/80 text-white';
  if (source.includes('r/pcgaming')) return 'bg-red-500/80 text-white';
  return 'bg-fuchsia-500/80 text-white';
}

// ─── Fallback placeholder image ─────────────────────────────────────────────

const FALLBACK_IMAGE = 'https://cdn.akamai.steamstatic.com/steam/apps/730/header.jpg';

// ─── News Card ──────────────────────────────────────────────────────────────

function BuzzNewsCard({ item }: { item: NewsItem }) {
  const [imgSrc, setImgSrc] = useState(item.imageUrl || FALLBACK_IMAGE);

  const handleClick = () => {
    if (window.electron?.openExternal) {
      window.electron.openExternal(item.url);
    } else {
      window.open(item.url, '_blank');
    }
  };

  return (
    <motion.button
      onClick={handleClick}
      className={cn(
        'relative z-10 flex flex-col items-start justify-end overflow-hidden rounded-2xl',
        'w-[280px] h-[340px] md:w-[320px] md:h-[400px]',
        'bg-black/40 border border-white/10 group flex-shrink-0',
        'hover:border-fuchsia-500/40 transition-all duration-300',
      )}
      whileHover={{ scale: 1.02 }}
      transition={{ duration: 0.2 }}
    >
      {/* Background image */}
      <BlurImage
        src={imgSrc}
        alt={item.title}
        className="absolute inset-0 z-10 object-cover group-hover:scale-105 transition-transform duration-500"
        onError={() => {
          if (imgSrc !== FALLBACK_IMAGE) setImgSrc(FALLBACK_IMAGE);
        }}
      />

      {/* Top gradient — dark fade for source badge */}
      <div className="pointer-events-none absolute inset-0 z-20 bg-gradient-to-b from-black/70 via-transparent to-transparent" />

      {/* Bottom gradient — dark fade for text readability */}
      <div className="pointer-events-none absolute inset-0 z-20 bg-gradient-to-t from-black/95 via-black/50 to-transparent" />

      {/* Source badge — top left */}
      <div className="absolute top-3 left-3 z-30">
        <span className={cn(
          'px-2 py-0.5 rounded-full text-[10px] font-semibold backdrop-blur-sm',
          getSourceColor(item.source),
        )}>
          {item.source}
        </span>
      </div>

      {/* External link icon — top right */}
      <div className="absolute top-3 right-3 z-30 opacity-0 group-hover:opacity-100 transition-opacity">
        <ExternalLink className="w-4 h-4 text-white/60" />
      </div>

      {/* Content — bottom */}
      <div className="relative z-30 p-4 w-full text-left">
        <h3 className="text-sm md:text-base font-bold text-white leading-snug line-clamp-2 mb-1.5">
          {item.title}
        </h3>
        <p className="text-[11px] md:text-xs text-white/50 line-clamp-2 mb-2 leading-relaxed">
          {item.summary}
        </p>
        <div className="flex items-center gap-2 text-[10px] text-white/40">
          <Clock className="w-3 h-3" />
          <span>{formatRelativeDate(item.publishedAt)}</span>
        </div>
      </div>
    </motion.button>
  );
}

// ─── Skeleton Card ──────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="w-[280px] h-[340px] md:w-[320px] md:h-[400px] rounded-2xl bg-white/5 border border-white/10 animate-pulse flex-shrink-0">
      <div className="w-full h-full flex flex-col justify-end p-4">
        <div className="h-3 w-16 bg-white/10 rounded-full mb-3" />
        <div className="h-4 w-3/4 bg-white/10 rounded mb-2" />
        <div className="h-4 w-1/2 bg-white/10 rounded mb-3" />
        <div className="h-3 w-full bg-white/5 rounded mb-1" />
        <div className="h-3 w-2/3 bg-white/5 rounded mb-3" />
        <div className="h-2 w-20 bg-white/5 rounded" />
      </div>
    </div>
  );
}

// ─── Section Header ─────────────────────────────────────────────────────────

function SectionHeader({
  title,
  icon: Icon,
  count,
}: {
  title: string;
  icon: React.ElementType;
  count?: number;
}) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <Icon className="w-4 h-4 text-fuchsia-400" />
      <h3 className="text-sm font-semibold text-white/80">{title}</h3>
      {count !== undefined && count > 0 && (
        <span className="text-xs text-white/30">({count})</span>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function BuzzView() {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadNews = useCallback(async (force = false) => {
    try {
      if (force) {
        setRefreshing(true);
        clearNewsCache();
      } else {
        setLoading(true);
      }
      setError(null);

      const items = await fetchAllNews(force);
      setNews(items);
      setLastFetched(new Date());
    } catch (err) {
      console.error('[BuzzView] Failed to fetch news:', err);
      setError('Failed to load gaming news. Check your connection and try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadNews();
  }, [loadNews]);

  // Split news by source for sectioned display
  const { steamNews, redditNews } = useMemo(() => {
    const steam: NewsItem[] = [];
    const reddit: NewsItem[] = [];
    for (const item of news) {
      if (item.source.startsWith('Steam')) {
        steam.push(item);
      } else {
        reddit.push(item);
      }
    }
    return { steamNews: steam, redditNews: reddit };
  }, [news]);

  // Build carousel card elements for each section
  const steamCards = useMemo(
    () => steamNews.map((item) => <BuzzNewsCard key={item.id} item={item} />),
    [steamNews],
  );

  const redditCards = useMemo(
    () => redditNews.map((item) => <BuzzNewsCard key={item.id} item={item} />),
    [redditNews],
  );

  // All combined for the hero carousel
  const allCards = useMemo(
    () => news.slice(0, 30).map((item) => <BuzzNewsCard key={item.id} item={item} />),
    [news],
  );

  // ─── Loading state ──────────────────────────────────────────────
  if (loading && news.length === 0) {
    return (
      <div className="max-w-7xl mx-auto py-10 px-4 md:px-8 lg:px-10">
        {/* Header skeleton */}
        <div className="mb-8">
          <div className="h-8 w-48 bg-white/10 rounded animate-pulse mb-2" />
          <div className="h-4 w-72 bg-white/5 rounded animate-pulse" />
        </div>

        {/* Skeleton cards */}
        <div className="flex gap-4 overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </div>
    );
  }

  // ─── Empty / error state ────────────────────────────────────────
  if (error || news.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-center">
        <div className="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center mb-6 shadow-lg shadow-fuchsia-500/10">
          <Newspaper className="w-10 h-10 text-fuchsia-500" />
        </div>
        <h2 className="text-2xl font-bold mb-2 font-['Orbitron']">
          {error ? 'Oops!' : 'No News Yet'}
        </h2>
        <p className="text-white/60 mb-6 max-w-md">
          {error || 'Gaming news will appear here once fetched from Steam and Reddit.'}
        </p>
        <Button
          onClick={() => loadNews(true)}
          className="bg-fuchsia-500 hover:bg-fuchsia-600 text-white gap-1.5"
        >
          <RefreshCw className="w-4 h-4" />
          Try Again
        </Button>
      </div>
    );
  }

  // ─── Main view ──────────────────────────────────────────────────
  return (
    <div className="relative w-full overflow-clip">
      {/* Header */}
      <div className="max-w-7xl mx-auto py-10 px-4 md:px-8 lg:px-10">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-lg md:text-3xl mb-2 text-white font-bold font-['Orbitron']">
              Gaming Buzz
            </h2>
            <p className="text-white/60 text-sm md:text-base max-w-lg">
              {news.length} article{news.length !== 1 ? 's' : ''} from Steam and Reddit
              {lastFetched && (
                <span className="text-white/30 ml-2">
                  · updated {formatRelativeDate(Math.floor(lastFetched.getTime() / 1000))}
                </span>
              )}
            </p>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => loadNews(true)}
            disabled={refreshing}
            className="border-white/10 hover:bg-white/10 text-white/60 hover:text-white gap-1.5"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* ── Trending (all sources mixed) ─────────────────────────── */}
      <div className="px-4 md:px-8 lg:px-10 mb-6">
        <SectionHeader title="Trending" icon={Newspaper} count={allCards.length} />
      </div>
      <Carousel items={allCards} autoScrollInterval={5000} />

      {/* ── Steam News section ───────────────────────────────────── */}
      {steamCards.length > 0 && (
        <div className="mt-8">
          <div className="px-4 md:px-8 lg:px-10 mb-2">
            <SectionHeader title="Steam Updates" icon={Gamepad2} count={steamCards.length} />
          </div>
          <Carousel items={steamCards} autoScrollInterval={6000} />
        </div>
      )}

      {/* ── Reddit News section ──────────────────────────────────── */}
      {redditCards.length > 0 && (
        <div className="mt-8">
          <div className="px-4 md:px-8 lg:px-10 mb-2">
            <SectionHeader title="Reddit Gaming" icon={MessageSquare} count={redditCards.length} />
          </div>
          <Carousel items={redditCards} autoScrollInterval={7000} />
        </div>
      )}

      {/* Bottom padding */}
      <div className="h-10" />
    </div>
  );
}
