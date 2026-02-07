import { memo, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'wouter';
import { Game, GameStatus } from '@/types/game';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { 
  Edit, 
  Trash2, 
  Heart,
  MoreVertical,
  Library,
  Plus,
} from 'lucide-react';
import { FaWindows, FaApple, FaLinux } from 'react-icons/fa';
import { cn } from '@/lib/utils';

interface GameCardProps {
  game: Game;
  onEdit: () => void;
  onDelete: () => void;
  onClick?: () => void;
  isInLibrary?: boolean;
  isPlayingNow?: boolean; // Live indicator: game's exe is currently running
  onAddToLibrary?: () => void;
  onRemoveFromLibrary?: () => void;
  onStatusChange?: (status: GameStatus) => void;
  hideLibraryBadge?: boolean; // Hide heart button and library badge (e.g., when already in library view)
}

// Steam platforms (Steam is primarily PC)
type PlatformType = 'windows' | 'mac' | 'linux';

function getPlatformType(platform: string): PlatformType | null {
  const lower = platform.toLowerCase();
  if (lower.includes('windows') || lower.includes('pc') || lower.includes('win')) {
    return 'windows';
  }
  if (lower.includes('mac') || lower.includes('macos') || lower.includes('osx')) {
    return 'mac';
  }
  if (lower.includes('linux') || lower.includes('ubuntu') || lower.includes('steamos')) {
    return 'linux';
  }
  return null;
}

function getPlatformIcon(type: PlatformType): React.ReactNode {
  switch (type) {
    case 'windows':
      return <FaWindows className="h-3.5 w-3.5" />;
    case 'mac':
      return <FaApple className="h-3.5 w-3.5" />;
    case 'linux':
      return <FaLinux className="h-3.5 w-3.5" />;
  }
}

function getUniquePlatformTypes(platforms: string[]): PlatformType[] {
  const types = new Set<PlatformType>();
  for (const platform of platforms) {
    const type = getPlatformType(platform);
    if (type) types.add(type);
  }
  return Array.from(types);
}

// Generate fallback gradient based on game title
function getGameFallbackGradient(title: string): string {
  const hash = title.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const hue = hash % 360;
  return `linear-gradient(135deg, hsl(${hue}, 50%, 20%) 0%, hsl(${(hue + 60) % 360}, 50%, 10%) 100%)`;
}

// Get initials for fallback
function getGameInitials(title: string): string {
  return title
    .split(' ')
    .slice(0, 2)
    .map(word => word[0])
    .join('')
    .toUpperCase();
}

// Format date as "Jan 18, 2025"
function formatDisplayDate(isoDate: string): string {
  if (!isoDate) return '';
  try {
    const date = new Date(isoDate);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

// Format player count with K/M suffixes for large numbers
function formatPlayerCount(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return millions >= 10 
      ? `${Math.round(millions)}M` 
      : `${millions.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (count >= 1_000) {
    const thousands = count / 1_000;
    return thousands >= 10 
      ? `${Math.round(thousands)}K` 
      : `${thousands.toFixed(1).replace(/\.0$/, '')}K`;
  }
  return count.toString();
}

// Manual statuses the user can pick (excludes 'Playing Now' which is system-managed)
const ALL_STATUSES: GameStatus[] = ['Want to Play', 'Playing', 'Completed', 'On Hold'];

const statusColors: Record<GameStatus, string> = {
  'Completed': 'bg-green-500/20 text-white',
  'Playing': 'bg-blue-500/20 text-blue-300',
  'Playing Now': 'bg-emerald-500/20 text-emerald-300',
  'On Hold': 'bg-yellow-500/20 text-yellow-300',
  'Want to Play': 'bg-white/10 text-white/80',
};

function GameCardComponent({ 
  game, 
  onEdit, 
  onDelete, 
  onClick, 
  isInLibrary,
  isPlayingNow,
  onAddToLibrary,
  onRemoveFromLibrary,
  onStatusChange,
  hideLibraryBadge,
}: GameCardProps) {
  const [, navigate] = useLocation();
  const [imageError, setImageError] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [fallbackAttempt, setFallbackAttempt] = useState(0); // 0 = cover, 1 = header, 2 = capsule
  const [menuOpen, setMenuOpen] = useState(false); // ellipsis button dropdown
  const [statusMenuOpen, setStatusMenuOpen] = useState(false); // status badge dropdown
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null); // right-click menu
  const cardRef = useRef<HTMLDivElement>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  // Check library status from game prop or explicit prop
  const inLibrary = isInLibrary !== undefined ? isInLibrary : game.isInLibrary;
  
  // Compute whether library badge should be shown (memoized for performance)
  const showLibraryBadge = useMemo(() => inLibrary && !hideLibraryBadge, [inLibrary, hideLibraryBadge]);
  
  // Compute rating badge position based on visible badges (memoized for performance)
  const ratingBadgePosition = useMemo(() => {
    if (showLibraryBadge) return "top-9";
    return "top-2";
  }, [showLibraryBadge]);

  // Notify other cards to close their context menus when this card opens one
  const CONTEXT_MENU_CLOSE_EVENT = 'gamecard:closeContextMenu';

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent(CONTEXT_MENU_CLOSE_EVENT, { detail: { gameId: game.id } }));
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, [game.id]);

  // Close this card's menu when another card opens its context menu
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ gameId: string }>;
      if (ev.detail?.gameId !== game.id) setCtxMenu(null);
    };
    window.addEventListener(CONTEXT_MENU_CLOSE_EVENT, handler);
    return () => window.removeEventListener(CONTEXT_MENU_CLOSE_EVENT, handler);
  }, [game.id]);

  // Close context menu on outside click or scroll
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('contextmenu', close);
    };
  }, [ctxMenu]);

  const handleCardClick = () => {
    // Navigate to game details page if we have a Steam App ID
    // Use steamAppId directly, or extract from id if available (e.g., "steam-12345")
    const gameId = game.steamAppId || (game.id?.startsWith('steam-') ? parseInt(game.id.split('-')[1]) : null);
    
    if (gameId) {
      navigate(`/game/${gameId}`);
    } else if (onClick) {
      // Fallback to onClick handler for custom games
      onClick();
    }
  };

  const handleHeartClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (inLibrary) {
      // Already in library - trigger remove
      if (onRemoveFromLibrary) {
        onRemoveFromLibrary();
      }
    } else {
      // Not in library - trigger add
      if (onAddToLibrary) {
        onAddToLibrary();
      }
    }
  };
  
  // Build a deduplicated list of fallback URLs.
  // Consecutive duplicates (e.g. headerImage == old CDN header.jpg) are removed
  // so the chain never stalls on an identical src that won't fire a new load event.
  const fallbackUrls = useMemo(() => {
    if (!game.steamAppId) return [game.coverUrl || ''];

    const cdnBase = 'https://cdn.akamai.steamstatic.com/steam/apps';
    const candidates = [
      game.coverUrl || `${cdnBase}/${game.steamAppId}/library_600x900.jpg`,
      game.headerImage || `${cdnBase}/${game.steamAppId}/header.jpg`,
      `${cdnBase}/${game.steamAppId}/header.jpg`,
      `${cdnBase}/${game.steamAppId}/capsule_616x353.jpg`,
      `${cdnBase}/${game.steamAppId}/capsule_231x87.jpg`,
      `${cdnBase}/${game.steamAppId}/logo.png`,
      game.screenshots?.[0] || '',
    ];

    // Deduplicate while preserving order
    const seen = new Set<string>();
    return candidates.filter(url => {
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
  }, [game.steamAppId, game.coverUrl, game.headerImage, game.screenshots]);

  // Handle image error - try next fallback URL
  const handleImageError = useCallback(() => {
    if (game.steamAppId && fallbackAttempt < fallbackUrls.length - 1) {
      console.log(`[GameCard] Image ${fallbackAttempt} failed for ${game.title}, trying next fallback`);
      setFallbackAttempt(prev => prev + 1);
      setImageLoaded(false);
    } else {
      // All fallbacks exhausted - show gradient with initials
      setImageError(true);
    }
  }, [fallbackAttempt, fallbackUrls.length, game.steamAppId, game.title]);

  // Detect placeholder images: newer Steam games return 200 from the old CDN
  // but with tiny (< 5KB) transparent placeholder images instead of real art.
  // If the loaded image has very small natural dimensions, advance the fallback.
  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth < 50 || img.naturalHeight < 50) {
      console.log(`[GameCard] Placeholder detected for ${game.title} (${img.naturalWidth}x${img.naturalHeight}), trying next fallback`);
      handleImageError();
      return;
    }
    setImageLoaded(true);
  }, [game.title, handleImageError]);
  
  // Current cover URL from the deduplicated fallback list
  const coverUrl = fallbackUrls[fallbackAttempt] || '';
  
  const fallbackGradient = getGameFallbackGradient(game.title);
  const initials = getGameInitials(game.title);

  return (
    <div 
      ref={cardRef}
      className="group relative flex flex-col rounded-xl overflow-hidden bg-card/30 hover:bg-card/50 border border-transparent hover:border-white/10 transition-all duration-300 w-full cursor-pointer"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleCardClick}
      onContextMenu={handleContextMenu}
    >
      {/* Cover Image Container - 3:4 aspect ratio like game covers */}
      <div 
        className="relative aspect-[3/4] overflow-hidden"
        style={{ background: imageError || !coverUrl ? fallbackGradient : '#0a0a0a' }}
      >
        {/* Cover Image */}
        {coverUrl && !imageError && (
          <img
            src={coverUrl}
            alt={game.title}
            className={cn(
              "w-full h-full object-cover transition-all duration-500",
              imageLoaded ? "opacity-100" : "opacity-0",
              isHovered ? "scale-105" : "scale-100"
            )}
            onLoad={handleImageLoad}
            onError={handleImageError}
          />
        )}
        
        {/* Fallback with initials */}
        {(imageError || !coverUrl) && (
          <div className="absolute inset-0 flex items-center justify-center text-white/60 font-bold text-4xl">
            {initials}
          </div>
        )}
        
        {/* Loading spinner */}
        {coverUrl && !imageLoaded && !imageError && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-8 border-3 border-white/20 border-t-white/60 rounded-full animate-spin" />
          </div>
        )}

        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent pointer-events-none" />
        
        {/* Rank Badge for Top 100 games */}
        {game.rank && (
          <div className="absolute top-2 left-2 flex items-center justify-center min-w-[28px] h-7 px-1.5 rounded-lg bg-gradient-to-br from-amber-500 to-amber-600 text-black font-bold text-sm shadow-lg z-10">
            #{game.rank}
          </div>
        )}
        
        {/* Library Heart Button - Top Left (visible on hover or if in library) - shifted right if rank badge is present */}
        {/* Hidden when hideLibraryBadge is true (e.g., in Library view where all games are already in library) */}
        {!hideLibraryBadge && (
          <button 
            onClick={handleHeartClick}
            className={cn(
              "absolute top-2 p-1.5 rounded-full bg-black/50 backdrop-blur-sm transition-all duration-200 hover:bg-black/70 z-10",
              game.rank ? "left-12" : "left-2",
              inLibrary ? "opacity-100" : isHovered ? "opacity-100" : "opacity-0"
            )}
            aria-label={inLibrary ? "Remove from library" : "Add to library"}
          >
            <Heart 
              className={cn(
                "h-4 w-4 transition-colors",
                inLibrary ? "fill-white text-white" : "text-white/70"
              )} 
            />
          </button>
        )}

        {/* Top Right Badges (Library, Installed) */}
        <div className="absolute top-2 right-2 z-10 flex flex-col gap-1 items-end">
          {/* In Library / Custom Badge - Hidden when hideLibraryBadge is true */}
          {showLibraryBadge && (
            <Badge className={cn(
              "text-white border-none text-[10px] gap-1",
              game.isCustom ? "bg-amber-500/80" : "bg-fuchsia-500/80"
            )}>
              <Library className="h-3 w-3" />
              {game.isCustom ? 'Custom' : 'Library'}
            </Badge>
          )}
          
        </div>
        
        {/* Rating Badge (visible on hover only, positioned below other badges) */}
        {game.metacriticScore !== null && game.metacriticScore !== undefined && game.metacriticScore > 0 && (
          <div 
            className={cn(
              "absolute px-2 py-1 rounded bg-black/70 backdrop-blur-sm text-xs font-bold shadow-lg transition-opacity duration-200 right-2",
              ratingBadgePosition,
              isHovered ? "opacity-100" : "opacity-0"
            )}
            aria-label={`Rating: ${game.metacriticScore}`}
          >
            <span className="text-white">
              Rating: {game.metacriticScore}
            </span>
          </div>
        )}

      </div>

      {/* Game Info Footer */}
      <div className="p-3 space-y-1.5">
        {/* Title Row with Actions */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h3 
              className="font-semibold text-sm text-white leading-tight line-clamp-2 h-[2.5rem]" 
              title={game.title}
            >
              {game.title}
            </h3>
            <p className="text-xs text-white/60 truncate mt-0.5">{game.developer}</p>
            {game.releaseDate && (
              <p className="text-xs text-white/40 mt-0.5">{formatDisplayDate(game.releaseDate)}</p>
            )}
            {game.playerCount !== undefined && game.playerCount > 0 && (
              <p className="text-xs text-cyan-400 mt-0.5">
                {formatPlayerCount(game.playerCount)} playing now
              </p>
            )}
          </div>
          {/* Ellipsis Menu - button only for library games (right-click uses custom context menu below) */}
          <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            {inLibrary && (
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 hover:bg-transparent"
                    aria-label={`More options for ${game.title}`}
                  >
                    <MoreVertical className="h-4 w-4 pointer-events-none" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="bg-card border-white/10 whitespace-nowrap">
                  <DropdownMenuItem onClick={onEdit} className="cursor-pointer">
                    <Edit className="h-4 w-4 mr-2" />
                    Edit Entry
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem 
                    onClick={onDelete} 
                    className="cursor-pointer text-red-400 focus:text-red-300 focus:bg-red-500/10"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Remove from Library
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        
        {/* Platform Icons and Status Badge Row */}
        <div className="flex items-center justify-between text-xs">
          {/* Platform Icons - Show only unique platform types */}
          <div className="flex items-center gap-1.5">
            {getUniquePlatformTypes(game.platform).map((type) => (
              <div
                key={type}
                className="flex items-center justify-center w-6 h-6 rounded bg-white/10 text-white/80"
                title={type.charAt(0).toUpperCase() + type.slice(1)}
              >
                {getPlatformIcon(type)}
              </div>
            ))}
          </div>
          
          {/* Status Badge - Clickable dropdown for library games */}
          {inLibrary && (() => {
            // Override displayed status when the game's exe is running
            const displayStatus: GameStatus = isPlayingNow ? 'Playing Now' : (game.status as GameStatus);
            return (
            <div onClick={(e) => e.stopPropagation()}>
              <DropdownMenu open={statusMenuOpen} onOpenChange={setStatusMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <button
                    className={cn(
                      "text-[10px] h-6 px-2 flex items-center justify-center rounded-md font-medium border-none cursor-pointer transition-colors",
                      statusColors[displayStatus] || 'bg-white/10 text-white/80',
                      "hover:ring-1 hover:ring-white/20",
                      isPlayingNow && "animate-pulse"
                    )}
                    aria-label={`Status: ${displayStatus}. Click to change.`}
                  >
                    {displayStatus}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="bg-card border-white/10 min-w-[140px]">
                  {ALL_STATUSES.map((status) => (
                    <DropdownMenuItem
                      key={status}
                      className={cn(
                        "cursor-pointer text-xs gap-2",
                        game.status === status && "bg-white/10"
                      )}
                      onClick={() => {
                        if (status !== game.status && onStatusChange) {
                          onStatusChange(status);
                        }
                      }}
                    >
                      <span className={cn(
                        "w-2 h-2 rounded-full flex-shrink-0",
                        status === 'Completed' ? 'bg-green-500' :
                        status === 'Playing' ? 'bg-blue-500' :
                        status === 'Playing Now' ? 'bg-emerald-500' :
                        status === 'On Hold' ? 'bg-yellow-500' :
                        'bg-white/40'
                      )} />
                      {status}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            );
          })()}
        </div>
      </div>

      {/* Right-click context menu — rendered via portal at exact cursor position */}
      {ctxMenu && createPortal(
        <div
          ref={ctxMenuRef}
          className="fixed z-[200] min-w-[10rem] rounded-md border border-white/10 bg-card p-1 shadow-xl animate-in fade-in-0 zoom-in-95 whitespace-nowrap"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {inLibrary ? (
            <>
              <button
                className="flex w-full items-center rounded-sm px-3 py-2 text-sm hover:bg-white/10 cursor-pointer"
                onClick={() => { setCtxMenu(null); onEdit(); }}
              >
                <Edit className="h-4 w-4 mr-2" />
                Edit Entry
              </button>
              <div className="my-1 h-px bg-white/10" />
              <button
                className="flex w-full items-center rounded-sm px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 cursor-pointer"
                onClick={() => { setCtxMenu(null); onDelete(); }}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Remove from Library
              </button>
            </>
          ) : (
            <button
              className="flex w-full items-center rounded-sm px-3 py-2 text-sm hover:bg-white/10 cursor-pointer"
              onClick={() => { setCtxMenu(null); if (onAddToLibrary) onAddToLibrary(); }}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add to Library
            </button>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

// Memoize to prevent re-renders when parent re-renders but props haven't changed
// Note: We don't compare callback functions (onEdit, onDelete, etc.) since they are
// inline arrow functions that capture the game object - comparing them would always fail.
// The game data and boolean props are sufficient for determining if re-render is needed.
export const GameCard = memo(GameCardComponent, (prevProps, nextProps) => {
  return (
    prevProps.game.id === nextProps.game.id &&
    prevProps.game.updatedAt === nextProps.game.updatedAt &&
    prevProps.game.releaseDate === nextProps.game.releaseDate &&
    prevProps.game.rank === nextProps.game.rank &&
    prevProps.game.playerCount === nextProps.game.playerCount &&
    prevProps.game.coverUrl === nextProps.game.coverUrl &&
    prevProps.game.headerImage === nextProps.game.headerImage &&
    prevProps.game.isInLibrary === nextProps.game.isInLibrary &&
    prevProps.game.status === nextProps.game.status &&
    prevProps.isInLibrary === nextProps.isInLibrary &&
    prevProps.isPlayingNow === nextProps.isPlayingNow &&
    prevProps.hideLibraryBadge === nextProps.hideLibraryBadge
  );
});
