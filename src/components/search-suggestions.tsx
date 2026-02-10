import { memo, useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Game } from '@/types/game';
import { cn } from '@/lib/utils';
import { Search, Gamepad2 } from 'lucide-react';
import { FaSteam } from 'react-icons/fa';
import { SiEpicgames } from 'react-icons/si';

interface SearchSuggestionsProps {
  results: Game[];
  loading: boolean;
  visible: boolean;
  onSelect: (game: Game) => void;
  onClose: () => void;
  searchQuery: string;
}

// Image component with fallback handling
function SearchResultImage({ game }: { game: Game }) {
  const [imageError, setImageError] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [fallbackAttempt, setFallbackAttempt] = useState(0);
  
  // Reset state when game changes
  useEffect(() => {
    setImageError(false);
    setImageLoaded(false);
    setFallbackAttempt(0);
  }, [game.id]);

  // Deduplicated fallback URL list — prevents chain stalling on duplicate URLs.
  // Epic images use various CDN hosts; we collect every unique URL we can find
  // so the fallback chain has the best chance of finding a working one.
  const fallbackUrls = useMemo(() => {
    const candidates: string[] = [];

    if (game.store === 'epic' || game.id?.startsWith('epic-')) {
      // Epic-first candidates, then any Steam CDN URLs on deduped games
      if (game.coverUrl) candidates.push(game.coverUrl);
      if (game.headerImage) candidates.push(game.headerImage);
      if (game.screenshots) candidates.push(...game.screenshots.slice(0, 3));
      // For deduped games that also have a Steam app ID, add Steam CDN fallbacks
      if (game.steamAppId) {
        const cdnBase = 'https://cdn.akamai.steamstatic.com/steam/apps';
        candidates.push(`${cdnBase}/${game.steamAppId}/header.jpg`);
        candidates.push(`${cdnBase}/${game.steamAppId}/capsule_231x87.jpg`);
      }
    } else {
      const cdnBase = 'https://cdn.akamai.steamstatic.com/steam/apps';
      if (game.coverUrl) candidates.push(game.coverUrl);
      if (game.headerImage) candidates.push(game.headerImage);
      if (game.steamAppId) {
        candidates.push(
          `${cdnBase}/${game.steamAppId}/header.jpg`,
          `${cdnBase}/${game.steamAppId}/capsule_231x87.jpg`,
          `${cdnBase}/${game.steamAppId}/capsule_616x353.jpg`,
          `${cdnBase}/${game.steamAppId}/library_600x900.jpg`,
          `${cdnBase}/${game.steamAppId}/logo.png`,
        );
      }
      if (game.screenshots?.[0]) candidates.push(game.screenshots[0]);
    }

    // Deduplicate while preserving order
    const seen = new Set<string>();
    return candidates.filter(url => {
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
  }, [game.id, game.store, game.steamAppId, game.coverUrl, game.headerImage, game.screenshots]);

  const handleError = useCallback(() => {
    if (fallbackAttempt < fallbackUrls.length - 1) {
      setFallbackAttempt(prev => prev + 1);
      setImageLoaded(false);
    } else {
      setImageError(true);
    }
  }, [fallbackAttempt, fallbackUrls.length]);

  // Detect placeholder images (tiny dimensions) from old CDN
  const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth < 50 || img.naturalHeight < 50) {
      handleError();
      return;
    }
    setImageLoaded(true);
  }, [handleError]);

  // Per-URL timeout — if an image takes > 4s it's likely stuck; skip to next
  useEffect(() => {
    if (imageLoaded || imageError) return;
    const timer = setTimeout(() => {
      handleError();
    }, 4000);
    return () => clearTimeout(timer);
  }, [fallbackAttempt, imageLoaded, imageError, handleError]);

  const imageUrl = fallbackUrls[fallbackAttempt] || '';

  if (imageError || !imageUrl) {
    return (
      <div className="w-8 h-10 bg-white/10 rounded flex items-center justify-center flex-shrink-0">
        <Gamepad2 className="h-4 w-4 text-white/40" />
      </div>
    );
  }

  return (
    <div className="relative w-8 h-10 rounded overflow-hidden flex-shrink-0">
      {!imageLoaded && (
        <div className="absolute inset-0 bg-white/10 animate-pulse" />
      )}
      <img
        src={imageUrl}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className={cn(
          "w-full h-full object-cover transition-opacity duration-200",
          imageLoaded ? "opacity-100" : "opacity-0"
        )}
        onLoad={handleLoad}
        onError={handleError}
      />
    </div>
  );
}

/** Inline store indicator icons for a search result row. */
function StoreBadges({ game }: { game: Game }) {
  const stores = game.availableOn && game.availableOn.length > 0
    ? game.availableOn
    : game.store === 'epic' ? ['epic'] : game.isCustom ? [] : ['steam'];

  const onSteam = stores.includes('steam');
  const onEpic = stores.includes('epic');

  return (
    <div className="flex items-center gap-0.5 flex-shrink-0">
      {onSteam && (
        <div
          className="flex items-center justify-center w-5 h-5 rounded bg-white/5"
          title="Available on Steam"
        >
          <FaSteam className="h-3 w-3 text-white/60" />
        </div>
      )}
      {onEpic && (
        <div
          className="flex items-center justify-center w-5 h-5 rounded bg-white/5"
          title="Available on Epic Games"
        >
          <SiEpicgames className="h-3 w-3 text-white/60" />
        </div>
      )}
    </div>
  );
}

function SearchSuggestionsComponent({
  results,
  loading,
  visible,
  onSelect,
  onClose,
  searchQuery,
}: SearchSuggestionsProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    if (visible) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [visible, onClose]);

  // Close on escape
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    if (visible) {
      document.addEventListener('keydown', handleEscape);
    }
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [visible, onClose]);

  if (!visible || (!loading && results.length === 0 && !searchQuery.trim())) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="absolute top-full left-0 right-0 mt-1 bg-card/95 backdrop-blur-xl border border-white/10 rounded-lg shadow-xl z-50 max-h-80 overflow-y-auto"
    >
      {loading && (
        <div className="py-1">
          {/* Skeleton loaders for search results */}
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-2">
              <div className="w-8 h-10 bg-white/10 rounded animate-pulse flex-shrink-0" />
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="h-4 w-3/4 bg-white/10 rounded animate-pulse" />
                <div className="h-3 w-1/2 bg-white/10 rounded animate-pulse" />
              </div>
              <div className="w-8 h-5 bg-white/10 rounded animate-pulse" />
            </div>
          ))}
          <div className="flex items-center justify-center gap-2 px-4 py-2 text-white/40 text-xs">
            <div className="w-3 h-3 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
            Searching games...
          </div>
        </div>
      )}

      {!loading && results.length === 0 && searchQuery.trim() && (
        <div className="flex items-center gap-3 px-4 py-4 text-white/60">
          <Search className="h-4 w-4" />
          <span className="text-sm">No games found for "{searchQuery}"</span>
        </div>
      )}

      {!loading && results.length > 0 && (
        <ul className="py-1">
          {/* Sort by release date (newest first) */}
          {[...results]
            .sort((a, b) => {
              const dateA = a.releaseDate ? new Date(a.releaseDate).getTime() : 0;
              const dateB = b.releaseDate ? new Date(b.releaseDate).getTime() : 0;
              return dateB - dateA;
            })
            .slice(0, 8)
            .map((game) => (
            <li key={game.id}>
              <button
                onClick={() => onSelect(game)}
                className="w-full flex items-center gap-3 px-4 py-2 hover:bg-white/5 transition-colors text-left"
              >
                {/* Game Cover Thumbnail with fallback handling */}
                <SearchResultImage game={game} />
                
                {/* Game Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white font-medium truncate">{game.title}</p>
                  <p className="text-xs text-white/50 truncate">
                    {game.developer} • {game.releaseDate?.split('-')[0] || 'TBA'}
                  </p>
                </div>

                {/* Store badges */}
                <StoreBadges game={game} />

                {/* Rating */}
                {game.metacriticScore !== null && (
                  <div 
                    className={cn(
                      "px-2 py-0.5 rounded text-xs font-bold",
                      game.metacriticScore >= 75 ? "bg-green-500/20 text-green-400" :
                      game.metacriticScore >= 50 ? "bg-yellow-500/20 text-yellow-400" :
                      "bg-red-500/20 text-red-400"
                    )}
                  >
                    {game.metacriticScore}
                  </div>
                )}
              </button>
            </li>
          ))}
          
          {results.length > 8 && (
            <li className="px-4 py-2 text-xs text-white/40 text-center border-t border-white/10">
              {results.length - 8} more results...
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export const SearchSuggestions = memo(SearchSuggestionsComponent);

