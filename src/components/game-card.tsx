import { memo, useState, useCallback, useMemo } from 'react';
import { useLocation } from 'wouter';
import { Game } from '@/types/game';
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
} from 'lucide-react';
import { FaWindows, FaApple, FaLinux } from 'react-icons/fa';
import { cn } from '@/lib/utils';

interface GameCardProps {
  game: Game;
  onEdit: () => void;
  onDelete: () => void;
  onClick?: () => void;
  isInLibrary?: boolean;
  onAddToLibrary?: () => void;
  onRemoveFromLibrary?: () => void;
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

function GameCardComponent({ 
  game, 
  onEdit, 
  onDelete, 
  onClick, 
  isInLibrary,
  onAddToLibrary,
  onRemoveFromLibrary,
}: GameCardProps) {
  const [, navigate] = useLocation();
  const [imageError, setImageError] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [fallbackAttempt, setFallbackAttempt] = useState(0); // 0 = cover, 1 = header, 2 = capsule

  // Check library status from game prop or explicit prop
  const inLibrary = isInLibrary !== undefined ? isInLibrary : game.isInLibrary;

  const handleCardClick = () => {
    // Navigate to game details page if we have a Steam App ID
    if (game.steamAppId) {
      navigate(`/game/${game.steamAppId}`);
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
  
  // Handle image error - try multiple fallback URLs
  const handleImageError = useCallback(() => {
    if (game.steamAppId) {
      // Fallback order: library_600x900 -> header -> capsule_616x353 -> capsule_231x87 -> logo
      if (fallbackAttempt < 4) {
        console.log(`[GameCard] Image ${fallbackAttempt} failed for ${game.title}, trying next fallback`);
        setFallbackAttempt(prev => prev + 1);
        setImageLoaded(false);
      } else {
        // All fallbacks exhausted - show gradient with initials
        setImageError(true);
      }
    } else {
      setImageError(true);
    }
  }, [fallbackAttempt, game.steamAppId, game.title]);
  
  // Build cover URL based on fallback attempt
  const coverUrl = useMemo(() => {
    if (!game.steamAppId) return game.coverUrl || '';
    
    const cdnBase = 'https://cdn.akamai.steamstatic.com/steam/apps';
    switch (fallbackAttempt) {
      case 0:
        return game.coverUrl || `${cdnBase}/${game.steamAppId}/library_600x900.jpg`;
      case 1:
        return `${cdnBase}/${game.steamAppId}/header.jpg`;
      case 2:
        return `${cdnBase}/${game.steamAppId}/capsule_616x353.jpg`;
      case 3:
        return `${cdnBase}/${game.steamAppId}/capsule_231x87.jpg`;
      case 4:
        return `${cdnBase}/${game.steamAppId}/logo.png`;
      default:
        return '';
    }
  }, [game.steamAppId, game.coverUrl, fallbackAttempt]);
  
  const fallbackGradient = getGameFallbackGradient(game.title);
  const initials = getGameInitials(game.title);

  return (
    <div 
      className="group relative flex flex-col rounded-xl overflow-hidden bg-card/30 hover:bg-card/50 border border-transparent hover:border-white/10 transition-all duration-300 w-full cursor-pointer"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleCardClick}
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
            onLoad={() => setImageLoaded(true)}
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

        {/* In Library / Custom Badge */}
        {inLibrary && (
          <div className="absolute top-2 right-2 z-10">
            <Badge className={cn(
              "text-white border-none text-[10px] gap-1",
              game.isCustom ? "bg-amber-500/80" : "bg-fuchsia-500/80"
            )}>
              <Library className="h-3 w-3" />
              {game.isCustom ? 'Custom' : 'Library'}
            </Badge>
          </div>
        )}
        
        {/* Rating Badge (visible on hover only, positioned below library badge) */}
        {game.metacriticScore !== null && game.metacriticScore !== undefined && game.metacriticScore > 0 && (
          <div 
            className={cn(
              "absolute px-2 py-1 rounded bg-black/70 backdrop-blur-sm text-xs font-bold shadow-lg transition-opacity duration-200",
              inLibrary ? "top-9 right-2" : "top-2 right-2",
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
          {/* Ellipsis Menu - Only show for library games */}
          {inLibrary && (
            <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
              <DropdownMenu>
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
                <DropdownMenuContent align="end" className="bg-card border-white/10">
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
            </div>
          )}
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
          
          {/* Status Badge - Only show for library games */}
          {inLibrary && (
            <Badge 
              className={cn(
                "text-[10px] h-6 px-2 flex items-center justify-center border-none hover:bg-white/10",
                game.status === 'Completed' || game.status === 'Playing'
                  ? 'bg-green-500/20 text-white hover:bg-green-500/20'
                  : 'bg-white/10 text-white/80'
              )}
            >
              {game.status === 'Completed' ? 'Completed' : 
               game.status === 'Playing' ? 'Playing' : 
               game.status === 'Dropped' ? 'Dropped' :
               game.status === 'On Hold' ? 'On Hold' : 'Backlog'}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

// Memoize to prevent re-renders when parent re-renders but props haven't changed
export const GameCard = memo(GameCardComponent, (prevProps, nextProps) => {
  return (
    prevProps.game.id === nextProps.game.id &&
    prevProps.game.updatedAt === nextProps.game.updatedAt &&
    prevProps.game.releaseDate === nextProps.game.releaseDate &&
    prevProps.game.rank === nextProps.game.rank &&
    prevProps.game.isInLibrary === nextProps.game.isInLibrary &&
    prevProps.onEdit === nextProps.onEdit &&
    prevProps.onDelete === nextProps.onDelete &&
    prevProps.onClick === nextProps.onClick &&
    prevProps.isInLibrary === nextProps.isInLibrary &&
    prevProps.onAddToLibrary === nextProps.onAddToLibrary &&
    prevProps.onRemoveFromLibrary === nextProps.onRemoveFromLibrary
  );
});
