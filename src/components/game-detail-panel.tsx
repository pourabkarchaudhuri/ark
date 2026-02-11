import { useEffect, useRef, useId, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Game } from '@/types/game';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ImageSlideshow } from '@/components/image-slideshow';
import { useOutsideClick } from '@/hooks/use-outside-click';
import { 
  X, 
  Edit, 
  Trash2, 
  Heart,
  Calendar,
  Building2,
  Star,
  MessageSquare,
  Lightbulb,
  Plus,
  Library,
  Gamepad2,
  ExternalLink,
  BookOpen,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { FaWindows, FaPlaystation, FaXbox, FaSteam, FaReddit, FaTwitter, FaTwitch, FaYoutube, FaFacebook, FaInstagram, FaGlobe, FaWikipediaW } from 'react-icons/fa';
import { SiNintendoswitch, SiEpicgames, SiGogdotcom } from 'react-icons/si';
import { cn, getHardcodedCover } from '@/lib/utils';

interface GameDetailPanelProps {
  game: Game | null;
  onClose: () => void;
  onEdit: (game: Game) => void;
  onDelete: (game: Game) => void;
  onAddToLibrary?: (game: Game) => void;
  onRemoveFromLibrary?: (game: Game) => void;
}

type PlatformType = 'windows' | 'playstation' | 'xbox' | 'nintendo';

function getPlatformType(platform: string): PlatformType | null {
  const lower = platform.toLowerCase();
  if (lower.includes('windows') || lower.includes('pc') || lower.includes('win')) {
    return 'windows';
  }
  if (lower.includes('playstation') || lower.includes('ps4') || lower.includes('ps5') || lower.includes('ps')) {
    return 'playstation';
  }
  if (lower.includes('xbox')) {
    return 'xbox';
  }
  if (lower.includes('nintendo') || lower.includes('switch')) {
    return 'nintendo';
  }
  return null;
}

function getPlatformIcon(type: PlatformType): React.ReactNode {
  switch (type) {
    case 'windows':
      return <FaWindows className="h-4 w-4" />;
    case 'playstation':
      return <FaPlaystation className="h-4 w-4" />;
    case 'xbox':
      return <FaXbox className="h-4 w-4" />;
    case 'nintendo':
      return <SiNintendoswitch className="h-4 w-4" />;
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

function getScoreColor(score: number): string {
  if (score >= 75) return 'bg-green-500';
  if (score >= 50) return 'bg-yellow-500';
  return 'bg-red-500';
}

function getPriorityColor(priority: string): string {
  switch (priority) {
    case 'High': return 'bg-red-500/20 text-red-400';
    case 'Medium': return 'bg-yellow-500/20 text-yellow-400';
    case 'Low': return 'bg-green-500/20 text-green-400';
    default: return 'bg-white/10 text-white/60';
  }
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

// Website category constants (compatible with Steam data)
const WEBSITE_CATEGORIES: Record<number, { name: string; icon: React.ReactNode; priority: number }> = {
  1: { name: 'Official', icon: <FaGlobe className="h-4 w-4" />, priority: 1 },
  2: { name: 'Wikia', icon: <FaWikipediaW className="h-4 w-4" />, priority: 10 },
  3: { name: 'Wikipedia', icon: <FaWikipediaW className="h-4 w-4" />, priority: 9 },
  4: { name: 'Facebook', icon: <FaFacebook className="h-4 w-4" />, priority: 8 },
  5: { name: 'Twitter', icon: <FaTwitter className="h-4 w-4" />, priority: 7 },
  6: { name: 'Twitch', icon: <FaTwitch className="h-4 w-4" />, priority: 6 },
  9: { name: 'YouTube', icon: <FaYoutube className="h-4 w-4" />, priority: 5 },
  13: { name: 'Steam', icon: <FaSteam className="h-4 w-4" />, priority: 2 },
  14: { name: 'Instagram', icon: <FaInstagram className="h-4 w-4" />, priority: 8 },
  15: { name: 'Reddit', icon: <FaReddit className="h-4 w-4" />, priority: 7 },
  16: { name: 'Epic Games', icon: <SiEpicgames className="h-4 w-4" />, priority: 3 },
  17: { name: 'GOG', icon: <SiGogdotcom className="h-4 w-4" />, priority: 4 },
};

// Get store-specific links (Steam, Epic, GOG)
function getStoreLinks(websites?: { url: string; category: number }[]) {
  if (!websites) return [];
  
  return websites
    .filter(w => [13, 16, 17].includes(w.category)) // Steam, Epic, GOG
    .map(w => ({
      ...w,
      ...WEBSITE_CATEGORIES[w.category],
    }))
    .sort((a, b) => a.priority - b.priority);
}

// Get other links (Official, Social, etc.)
function getOtherLinks(websites?: { url: string; category: number }[]) {
  if (!websites) return [];
  
  return websites
    .filter(w => [1, 4, 5, 6, 9, 14, 15].includes(w.category)) // Official, Social
    .map(w => ({
      ...w,
      ...WEBSITE_CATEGORIES[w.category],
    }))
    .sort((a, b) => a.priority - b.priority);
}

// Store Links Section Component
function StoreLinksSection({ 
  websites, 
  steamAppId,
  epicSlug,
  epicNamespace,
}: { 
  websites?: { url: string; category: number }[]; 
  steamAppId?: number;
  epicSlug?: string;
  epicNamespace?: string;
}) {
  const storeLinks = getStoreLinks(websites);
  const otherLinks = getOtherLinks(websites);
  const [showOther, setShowOther] = useState(false);
  
  // If we have a Steam app ID but no Steam link in websites, add one
  const hasSteamLink = storeLinks.some(l => l.category === 13);
  const steamLink = steamAppId && !hasSteamLink 
    ? { url: `https://store.steampowered.com/app/${steamAppId}`, category: 13, ...WEBSITE_CATEGORIES[13] }
    : null;

  // If we have an Epic slug/namespace but no Epic link in websites, add one
  const hasEpicLink = storeLinks.some(l => l.category === 16);
  const epicStoreSlug = epicSlug || epicNamespace;
  const epicLink = epicStoreSlug && !hasEpicLink
    ? { url: `https://store.epicgames.com/en-US/p/${epicStoreSlug}`, category: 16, ...WEBSITE_CATEGORIES[16] }
    : null;
  
  const allStoreLinks = [
    ...(steamLink ? [steamLink] : []),
    ...(epicLink ? [epicLink] : []),
    ...storeLinks,
  ];
  
  if (allStoreLinks.length === 0 && otherLinks.length === 0) return null;

  return (
    <div className="p-4 rounded-lg bg-white/5">
      <div className="flex items-center gap-2 mb-3">
        <ExternalLink className="h-5 w-5 text-fuchsia-400" />
        <p className="text-white/50 text-xs uppercase tracking-wide">Available On</p>
      </div>
      
      {/* Store Links (Steam, Epic, GOG) */}
      <div className="flex flex-wrap gap-2 mb-3">
        {allStoreLinks.map((link, idx) => (
          <a
            key={idx}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors text-white"
          >
            {link.icon}
            <span className="text-sm">{link.name}</span>
          </a>
        ))}
      </div>

      {/* Other Links Toggle */}
      {otherLinks.length > 0 && (
        <>
          <button
            onClick={() => setShowOther(!showOther)}
            className="flex items-center gap-1 text-xs text-white/50 hover:text-white/70 transition-colors"
          >
            {showOther ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {showOther ? 'Hide' : 'Show'} other links ({otherLinks.length})
          </button>
          
          {showOther && (
            <div className="flex flex-wrap gap-2 mt-2">
              {otherLinks.map((link, idx) => (
                <a
                  key={idx}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-white/70 hover:text-white text-sm"
                >
                  {link.icon}
                  <span>{link.name}</span>
                </a>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Storyline Section Component (expandable)
function StorylineSection({ storyline }: { storyline: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = storyline.length > 300;

  return (
    <div className="p-4 rounded-lg bg-white/5">
      <div className="flex items-center gap-2 mb-2">
        <BookOpen className="h-5 w-5 text-cyan-400" />
        <p className="text-white/50 text-xs uppercase tracking-wide">Storyline</p>
      </div>
      <p className={cn(
        "text-white/80 text-sm leading-relaxed",
        !expanded && isLong && "line-clamp-4"
      )}>
        {storyline}
      </p>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-2 flex items-center gap-1 text-xs text-fuchsia-400 hover:text-fuchsia-300 transition-colors"
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3 w-3" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
              Read more
            </>
          )}
        </button>
      )}
    </div>
  );
}

// Similar Games Section Component
function SimilarGamesSection({ similarGames }: { similarGames: { id: number; name: string; coverUrl?: string }[] }) {
  const displayedGames = similarGames.slice(0, 6);
  
  return (
    <div className="p-4 rounded-lg bg-white/5">
      <div className="flex items-center gap-2 mb-3">
        <Gamepad2 className="h-5 w-5 text-fuchsia-400" />
        <p className="text-white/50 text-xs uppercase tracking-wide">Similar Games</p>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {displayedGames.map((sg) => (
          <div key={sg.id} className="flex flex-col items-center gap-1">
            <div className="w-full aspect-[3/4] rounded-lg overflow-hidden bg-white/10">
              {sg.coverUrl ? (
                <img 
                  src={sg.coverUrl} 
                  alt={sg.name}
                  className="w-full h-full object-cover"
                  onLoad={(e) => {
                    // Detect tiny placeholder images from old CDN (newer games)
                    const img = e.currentTarget;
                    if (img.naturalWidth < 50 || img.naturalHeight < 50) {
                      img.dispatchEvent(new Event('error'));
                    }
                  }}
                  onError={(e) => {
                    const img = e.target as HTMLImageElement;
                    img.style.display = 'none';
                    // Show fallback initials
                    const parent = img.parentElement;
                    if (parent && !parent.querySelector('.fallback-initials')) {
                      const div = document.createElement('div');
                      div.className = 'fallback-initials w-full h-full flex items-center justify-center text-white/30 text-xs font-bold';
                      div.textContent = sg.name.substring(0, 2).toUpperCase();
                      parent.appendChild(div);
                    }
                  }}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-white/30 text-xs font-bold">
                  {sg.name.substring(0, 2).toUpperCase()}
                </div>
              )}
            </div>
            <p className="text-xs text-white/60 text-center line-clamp-2">{sg.name}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function GameDetailPanel({ 
  game, 
  onClose, 
  onEdit, 
  onDelete,
  onAddToLibrary,
  onRemoveFromLibrary,
}: GameDetailPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  
  const isInLibrary = game?.isInLibrary ?? false;

  // Prepare slideshow images: cover + screenshots
  const slideshowImages = useMemo(() => {
    if (!game) return [];
    const images: string[] = [];
    const hardcoded = getHardcodedCover(game.title);
    if (hardcoded) images.push(hardcoded);
    else if (game.coverUrl) images.push(game.coverUrl);
    if (game.screenshots) images.push(...game.screenshots);
    return images;
  }, [game?.id, game?.title, game?.coverUrl, game?.screenshots]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    if (game) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'auto';
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = 'auto';
    };
  }, [game, onClose]);

  useOutsideClick(ref, onClose);

  const handleLibraryToggle = () => {
    if (!game) return;
    if (isInLibrary) {
      onRemoveFromLibrary?.(game);
    } else {
      onAddToLibrary?.(game);
    }
  };

  if (!game) return null;

  const fallbackGradient = getGameFallbackGradient(game.title);
  const initials = getGameInitials(game.title);
  const platformTypes = getUniquePlatformTypes(game.platform);

  return (
    <AnimatePresence>
      {game && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50"
            onClick={onClose}
          />
          
          {/* Panel */}
          <div className="fixed inset-0 grid place-items-center z-50 p-4 overflow-y-auto">
            <motion.div
              ref={ref}
              layoutId={`game-card-${game.id}-${id}`}
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="w-full max-w-4xl bg-card/95 backdrop-blur-xl border border-white/10 rounded-2xl overflow-hidden shadow-2xl shadow-black/50"
            >
              {/* Hero Section with Image Slideshow */}
              <div className="relative h-64 sm:h-80">
                <ImageSlideshow
                  images={slideshowImages}
                  autoPlayInterval={5000}
                  className="absolute inset-0"
                  fallbackGradient={fallbackGradient}
                  fallbackContent={
                    <div className="absolute inset-0 flex items-center justify-center text-white/40 font-bold text-6xl">
                      {initials}
                    </div>
                  }
                />
                
                {/* Close button */}
                <button
                  onClick={onClose}
                  className="absolute top-4 right-4 p-2 rounded-full bg-black/50 backdrop-blur-sm hover:bg-black/70 transition-colors z-20"
                  aria-label="Close"
                >
                  <X className="h-5 w-5 text-white" />
                </button>
                
                {/* Library Heart Button */}
                <button
                  onClick={handleLibraryToggle}
                  className="absolute top-4 left-4 p-2 rounded-full bg-black/50 backdrop-blur-sm hover:bg-black/70 transition-colors z-20"
                  aria-label={isInLibrary ? "Remove from library" : "Add to library"}
                >
                  <Heart 
                    className={cn(
                      "h-5 w-5 transition-colors",
                      isInLibrary ? "fill-white text-white" : "text-white/70"
                    )} 
                  />
                </button>

                {/* Library Status Badge */}
                {isInLibrary && (
                  <div className="absolute top-4 left-16 z-20">
                    <Badge className="bg-fuchsia-500/80 text-white border-none gap-1">
                      <Library className="h-3 w-3" />
                      In Library
                    </Badge>
                  </div>
                )}
                
                {/* Rating Score */}
                {game.metacriticScore !== null && (
                  <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-sm z-20">
                    <div className={cn("w-2 h-2 rounded-full", getScoreColor(game.metacriticScore))} />
                    <span className="text-white font-bold text-sm">
                      Rating: {game.metacriticScore}
                    </span>
                  </div>
                )}
                
                {/* Title overlay at bottom */}
                <div className="absolute bottom-0 left-0 right-0 p-6 z-20">
                  <div className="flex items-end justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <h2 className="text-2xl sm:text-3xl font-bold text-white mb-1 line-clamp-2">
                        {game.title}
                      </h2>
                      <p className="text-white/70 text-sm sm:text-base">
                        {game.developer}
                      </p>
                    </div>
                    
                    {/* Platform Icons */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {platformTypes.map((type) => (
                        <div
                          key={type}
                          className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/10 backdrop-blur-sm text-white"
                          title={type.charAt(0).toUpperCase() + type.slice(1)}
                        >
                          {getPlatformIcon(type)}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              
              {/* Content Section */}
              <div className="p-6 space-y-6">
                {/* Game Summary */}
                {game.summary && (
                  <div className="p-4 rounded-lg bg-white/5">
                    <div className="flex items-center gap-2 mb-2">
                      <Gamepad2 className="h-5 w-5 text-fuchsia-400" />
                      <p className="text-white/50 text-xs uppercase tracking-wide">About</p>
                    </div>
                    <p className="text-white/80 text-sm leading-relaxed">
                      {game.summary}
                    </p>
                  </div>
                )}

                {/* Status and Priority Row (only for library games) */}
                <div className="flex flex-wrap items-center gap-3">
                  {isInLibrary && (
                    <>
                      <Badge 
                        className={cn(
                          "text-sm px-3 py-1 border-none",
                          game.status === 'Completed' || game.status === 'Playing'
                            ? 'bg-green-500/20 text-green-400'
                            : 'bg-blue-500/20 text-blue-400'
                        )}
                      >
                        {game.status}
                      </Badge>
                      
                      <Badge className={cn("text-sm px-3 py-1 border-none", getPriorityColor(game.priority))}>
                        {game.priority} Priority
                      </Badge>
                    </>
                  )}
                  
                  {/* Genres */}
                  {game.genre.map((g) => (
                    <Badge 
                      key={g} 
                      variant="outline" 
                      className="text-sm px-3 py-1 border-white/20 text-white/80"
                    >
                      {g}
                    </Badge>
                  ))}
                </div>
                
                {/* Details Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Publisher */}
                  <div className="flex items-start gap-3 p-3 rounded-lg bg-white/5">
                    <Building2 className="h-5 w-5 text-fuchsia-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-white/50 text-xs uppercase tracking-wide">Publisher</p>
                      <p className="text-white">{game.publisher || 'Unknown'}</p>
                    </div>
                  </div>
                  
                  {/* Release Date */}
                  <div className="flex items-start gap-3 p-3 rounded-lg bg-white/5">
                    <Calendar className="h-5 w-5 text-cyan-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-white/50 text-xs uppercase tracking-wide">Release Date</p>
                      <p className="text-white">{game.releaseDate || 'TBA'}</p>
                    </div>
                  </div>
                  
                  {/* Recommendation Source (only for library games) */}
                  {isInLibrary && game.recommendationSource && (
                    <div className="flex items-start gap-3 p-3 rounded-lg bg-white/5">
                      <Lightbulb className="h-5 w-5 text-yellow-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-white/50 text-xs uppercase tracking-wide">Discovered Via</p>
                        <p className="text-white">{game.recommendationSource}</p>
                      </div>
                    </div>
                  )}
                  
                  {/* Platforms Detail */}
                  <div className="flex items-start gap-3 p-3 rounded-lg bg-white/5">
                    <Star className="h-5 w-5 text-fuchsia-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-white/50 text-xs uppercase tracking-wide">Platforms</p>
                      <p className="text-white text-sm">{game.platform.join(', ') || 'Unknown'}</p>
                    </div>
                  </div>
                </div>
                
                {/* Store Links */}
                {game.websites && game.websites.length > 0 && (
                  <StoreLinksSection websites={game.websites} steamAppId={game.steamAppId} epicSlug={game.epicSlug} epicNamespace={game.epicNamespace} />
                )}

                {/* Storyline (expandable) */}
                {game.storyline && (
                  <StorylineSection storyline={game.storyline} />
                )}

                {/* User Notes (only for library games) */}
                {isInLibrary && game.publicReviews && (
                  <div className="p-4 rounded-lg bg-white/5">
                    <div className="flex items-center gap-2 mb-2">
                      <MessageSquare className="h-5 w-5 text-cyan-400" />
                      <p className="text-white/50 text-xs uppercase tracking-wide">Your Notes</p>
                    </div>
                    <p className="text-white/80 text-sm leading-relaxed whitespace-pre-wrap">
                      {game.publicReviews}
                    </p>
                  </div>
                )}

                {/* Similar Games */}
                {game.similarGames && game.similarGames.length > 0 && (
                  <SimilarGamesSection similarGames={game.similarGames} />
                )}
                
                {/* Action Buttons */}
                <div className="flex items-center justify-end gap-3 pt-4 border-t border-white/10">
                  {isInLibrary ? (
                    <>
                      <Button
                        variant="outline"
                        onClick={() => onDelete(game)}
                        className="gap-2 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                      >
                        <Trash2 className="h-4 w-4" />
                        Remove from Library
                      </Button>
                      <Button
                        onClick={() => onEdit(game)}
                        className="gap-2 bg-fuchsia-500 hover:bg-fuchsia-600 text-white"
                      >
                        <Edit className="h-4 w-4" />
                        Edit Entry
                      </Button>
                    </>
                  ) : (
                    <Button
                      onClick={() => onAddToLibrary?.(game)}
                      className="gap-2 bg-fuchsia-500 hover:bg-fuchsia-600 text-white"
                    >
                      <Plus className="h-4 w-4" />
                      Add to Library
                    </Button>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
