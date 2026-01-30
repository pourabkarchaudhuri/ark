import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRoute, useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
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
  Play,
  Monitor,
  Cpu,
  Download,
} from 'lucide-react';
import { FaWindows, FaApple, FaLinux, FaSteam } from 'react-icons/fa';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { GameDialog } from '@/components/game-dialog';
import { cn } from '@/lib/utils';
import { SteamAppDetails, SteamReviewsResponse, GameRecommendation } from '@/types/steam';
import { MetacriticGameResponse } from '@/types/metacritic';
import { Game } from '@/types/game';
import { useLibrary } from '@/hooks/useGameStore';
import { getRepackLinkForGame } from '@/services/fitgirl-service';

// Check if running in Electron
function isElectron(): boolean {
  return typeof window !== 'undefined' && typeof window.steam !== 'undefined';
}

// Format minutes to hours and minutes
function formatPlaytime(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

// Format Unix timestamp to readable date
function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function GameDetailsPage() {
  const [, params] = useRoute('/game/:id');
  const [, navigate] = useLocation();
  const appId = params?.id ? parseInt(params.id, 10) : null;

  const [details, setDetails] = useState<SteamAppDetails | null>(null);
  const [reviews, setReviews] = useState<SteamReviewsResponse | null>(null);
  const [metacriticReviews, setMetacriticReviews] = useState<MetacriticGameResponse | null>(null);
  const [metacriticLoading, setMetacriticLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentMediaIndex, setCurrentMediaIndex] = useState(0);
  const [showFullDescription, setShowFullDescription] = useState(false);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [thumbnailsLoaded, setThumbnailsLoaded] = useState<Set<number>>(new Set());
  const [isAutoplayPaused, setIsAutoplayPaused] = useState(false);
  const [headerImageError, setHeaderImageError] = useState(false);
  const [headerImageLoaded, setHeaderImageLoaded] = useState(false);
  const [recommendations, setRecommendations] = useState<GameRecommendation[]>([]);
  const [recommendationsLoading, setRecommendationsLoading] = useState(false);
  const [fitgirlRepack, setFitgirlRepack] = useState<{ url: string; downloadLink: string | null } | null>(null);
  const [fitgirlLoading, setFitgirlLoading] = useState(false);
  const [isRecommendationsPaused, setIsRecommendationsPaused] = useState(false);
  const autoplayTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const resumeAutoplayTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const recommendationsScrollRef = useRef<HTMLDivElement>(null);
  const recommendationsAutoScrollRef = useRef<NodeJS.Timeout | null>(null);
  
  // Scroll to top when page loads or appId changes
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [appId]);
  
  // Library management
  const { addToLibrary, removeFromLibrary, isInLibrary, updateEntry, getAllGameIds } = useLibrary();
  const gameInLibrary = appId ? isInLibrary(appId) : false;
  
  // Dialog state for add to library
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [dialogGame, setDialogGame] = useState<Game | null>(null);
  
  // Convert Steam details to Game object for the dialog
  const createGameFromDetails = useCallback((): Game | null => {
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
  }, [details, appId, gameInLibrary]);
  
  // Handle opening the add to library dialog
  const handleOpenLibraryDialog = useCallback(() => {
    const game = createGameFromDetails();
    if (game) {
      setDialogGame(game);
      setIsDialogOpen(true);
    }
  }, [createGameFromDetails]);
  
  // Handle saving library entry from dialog
  const handleSaveLibraryEntry = useCallback((gameData: Partial<Game>) => {
    if (!appId) return;
    
    if (gameInLibrary) {
      // Update existing entry
      updateEntry(appId, {
        status: gameData.status,
        priority: gameData.priority,
        publicReviews: gameData.publicReviews,
        recommendationSource: gameData.recommendationSource,
      });
    } else {
      // Add to library
      addToLibrary(appId, gameData.status || 'Want to Play');
      // Then update with additional fields if provided
      if (gameData.priority || gameData.publicReviews || gameData.recommendationSource) {
        updateEntry(appId, {
          priority: gameData.priority,
          publicReviews: gameData.publicReviews,
          recommendationSource: gameData.recommendationSource,
        });
      }
    }
    
    setIsDialogOpen(false);
    setDialogGame(null);
  }, [appId, gameInLibrary, addToLibrary, updateEntry]);

  // Fetch game details and reviews - PARALLELIZED for faster loading
  useEffect(() => {
    if (!appId) return;

    let isMounted = true;

    const fetchData = async () => {
      setLoading(true);
      setError(null);

      try {
        if (isElectron()) {
          // OPTIMIZATION: Fetch game details and reviews in PARALLEL
          const detailsPromise = window.steam!.getAppDetails(appId);
          const reviewsPromise = typeof window.steam!.getGameReviews === 'function'
            ? window.steam!.getGameReviews(appId, 10).catch((err) => {
                console.warn('Failed to fetch Steam reviews:', err);
                return null;
              })
            : Promise.resolve(null);

          // Wait for both in parallel
          const [detailsData, reviewsData] = await Promise.all([detailsPromise, reviewsPromise]);
          
          if (!isMounted) return;
          
          if (detailsData) {
            setDetails(detailsData);
            if (reviewsData) {
              setReviews(reviewsData);
            }
          } else {
            setError('Game not found');
            setLoading(false);
            return;
          }

          // Fetch Metacritic reviews asynchronously (don't block page load)
          // This is intentionally NOT awaited - it loads after the main content
          if (detailsData?.name && typeof window.metacritic?.getGameReviews === 'function') {
            console.log(`[GameDetails] Fetching Metacritic reviews for: ${detailsData.name}`);
            if (isMounted) setMetacriticLoading(true);
            window.metacritic.getGameReviews(detailsData.name)
              .then((metacriticData) => {
                console.log(`[GameDetails] Metacritic response:`, metacriticData);
                if (isMounted && metacriticData) {
                  setMetacriticReviews(metacriticData);
                }
              })
              .catch((err) => {
                console.warn('[GameDetails] Failed to fetch Metacritic reviews:', err);
              })
              .finally(() => {
                if (isMounted) setMetacriticLoading(false);
              });
          } else {
            console.log('[GameDetails] Metacritic API not available or game name missing');
          }
        } else {
          // Mock data for browser development
          if (isMounted) setError('Steam API only available in Electron');
        }
      } catch (err) {
        console.error('Error fetching game details:', err);
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to load game details');
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchData();

    return () => {
      isMounted = false;
    };
  }, [appId]);

  // Fetch recommendations (asynchronously, after main content)
  useEffect(() => {
    // Only run when we have both appId and details loaded
    if (!appId || !details) {
      return;
    }
    
    console.log('[GameDetails] Recommendations useEffect - details loaded, checking API...');
    
    // Check if the API is available
    if (!isElectron()) {
      console.log('[GameDetails] Skipping recommendations: not in Electron');
      return;
    }
    
    if (!window.steam?.getRecommendations) {
      console.log('[GameDetails] Skipping recommendations: getRecommendations not available');
      console.log('[GameDetails] Available steam methods:', window.steam ? Object.keys(window.steam) : 'undefined');
      return;
    }

    let isMounted = true;
    console.log('[GameDetails] Starting recommendations fetch...');

    const fetchRecommendations = async () => {
      setRecommendationsLoading(true);
      try {
        const libraryIds = getAllGameIds();
        console.log(`[GameDetails] Fetching recommendations for ${appId} with ${libraryIds.length} library games`);
        const recs = await window.steam!.getRecommendations(appId, libraryIds, 8);
        if (isMounted) {
          setRecommendations(recs);
          console.log(`[GameDetails] Got ${recs.length} recommendations`);
        }
      } catch (err) {
        console.warn('[GameDetails] Failed to fetch recommendations:', err);
      } finally {
        if (isMounted) setRecommendationsLoading(false);
      }
    };

    fetchRecommendations();

    return () => {
      isMounted = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, details]);

  // Fetch FitGirl repack link (asynchronously, after main content)
  useEffect(() => {
    if (!details?.name) {
      return;
    }

    let isMounted = true;
    console.log('[GameDetails] Fetching FitGirl repack link for:', details.name);

    const fetchFitgirlRepack = async () => {
      setFitgirlLoading(true);
      try {
        const repackData = await getRepackLinkForGame(details.name);
        if (isMounted) {
          setFitgirlRepack(repackData);
          console.log('[GameDetails] FitGirl repack data:', repackData);
        }
      } catch (err) {
        console.warn('[GameDetails] Failed to fetch FitGirl repack:', err);
        if (isMounted) {
          setFitgirlRepack(null);
        }
      } finally {
        if (isMounted) setFitgirlLoading(false);
      }
    };

    fetchFitgirlRepack();

    return () => {
      isMounted = false;
    };
  }, [details?.name]);

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
    if (currentMediaIndex !== index) {
      pauseAutoplay();
      setMediaLoading(true);
      setCurrentMediaIndex(index);
    }
  }, [currentMediaIndex, pauseAutoplay]);

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

  // Review score color
  const getScoreColor = (score?: number) => {
    if (!score) return 'text-white/60';
    if (score >= 75) return 'text-green-400';
    if (score >= 50) return 'text-yellow-400';
    return 'text-red-400';
  };

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
        {/* Hero Section Skeleton */}
        <div className="relative h-[30vh] min-h-[240px] w-full bg-gradient-to-b from-white/5 to-black">
          {/* Gradient Overlay */}
          <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-transparent to-transparent" />

          {/* Back Button Skeleton */}
          <div className="absolute top-4 left-4 z-20">
            <div className="h-10 w-24 rounded-lg bg-white/10 animate-pulse" />
          </div>

          {/* Title and Info Skeleton */}
          <div className="absolute bottom-0 left-0 right-0 p-6 z-10">
            <div className="max-w-7xl mx-auto space-y-3">
              {/* Title */}
              <div className="h-10 w-2/3 max-w-md rounded-lg bg-white/10 animate-pulse" />
              
              {/* Meta info row */}
              <div className="flex flex-wrap items-center gap-4">
                <div className="h-6 w-32 rounded bg-white/10 animate-pulse" />
                <div className="h-6 w-28 rounded bg-white/10 animate-pulse" />
                <div className="h-6 w-16 rounded-full bg-white/10 animate-pulse" />
                <div className="h-6 w-24 rounded-full bg-white/10 animate-pulse" />
              </div>

              {/* Genre badges */}
              <div className="flex flex-wrap gap-2">
                <div className="h-6 w-20 rounded-full bg-white/10 animate-pulse" />
                <div className="h-6 w-24 rounded-full bg-white/10 animate-pulse" />
                <div className="h-6 w-16 rounded-full bg-white/10 animate-pulse" />
              </div>
            </div>
          </div>
        </div>

        {/* Main Content Skeleton */}
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
                  {/* Thumbnails skeleton */}
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
              {/* Quick Info Card Skeleton */}
              <div className="p-6 rounded-lg bg-white/5 border border-white/10 space-y-4">
                <div className="aspect-video rounded bg-white/10 animate-pulse" />
                <div className="h-10 w-full rounded bg-white/10 animate-pulse" />
                <div className="h-10 w-full rounded bg-white/10 animate-pulse" />
              </div>

              {/* Details Card Skeleton */}
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

              {/* Languages Skeleton */}
              <div className="p-6 rounded-lg bg-white/5 border border-white/10 space-y-3">
                <div className="h-5 w-24 rounded bg-white/10 animate-pulse" />
                <div className="h-4 w-full rounded bg-white/10 animate-pulse" />
                <div className="h-4 w-3/4 rounded bg-white/10 animate-pulse" />
              </div>

              {/* Reviews Skeleton */}
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
      </div>
    );
  }

  if (error || !details) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-red-400 text-xl">{error || 'Game not found'}</p>
          <Button onClick={() => navigate('/')} variant="outline">
            <ArrowLeft className="w-4 h-4 mr-2 pointer-events-none" />
            Back to Dashboard
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Hero Section with Background */}
      <div 
        className="relative h-[30vh] min-h-[240px] w-full"
        style={{
          backgroundImage: `url(${details.background || details.header_image})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center top',
        }}
      >
        {/* Gradient Overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-transparent to-transparent" />

        {/* Back Button */}
        <Button
          onClick={() => navigate('/')}
          variant="ghost"
          className="absolute top-4 left-4 z-20 bg-black/50 hover:bg-black/70 backdrop-blur-sm"
        >
          <ArrowLeft className="w-5 h-5 mr-2 pointer-events-none" />
          Back
        </Button>

        {/* Title and Basic Info */}
        <div className="absolute bottom-0 left-0 right-0 p-6 z-10">
          <div className="max-w-7xl mx-auto">
            <h1 className="text-3xl md:text-4xl font-bold mb-3 font-['Orbitron']">
              {details.name}
            </h1>
            
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
              
              {/* Metacritic Score */}
              {details.metacritic && (
                <Badge className={cn("font-bold", getScoreColor(details.metacritic.score))}>
                  <Star className="w-3 h-3 mr-1" />
                  {details.metacritic.score}
                </Badge>
              )}

              {/* Review Score */}
              {positivePercentage !== null && (
                <Badge variant="outline" className="border-white/20">
                  <ThumbsUp className="w-3 h-3 mr-1" />
                  {positivePercentage}% Positive
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
                          onLoad={() => setThumbnailsLoaded(prev => new Set(prev).add(index))}
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
            <section>
              <h2 className="text-xl font-semibold mb-4 font-['Orbitron']">About This Game</h2>
              <div 
                className={cn(
                  "prose prose-invert prose-sm max-w-none",
                  !showFullDescription && "line-clamp-6"
                )}
                dangerouslySetInnerHTML={{ __html: details.detailed_description || details.about_the_game }}
              />
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
                        dangerouslySetInnerHTML={{ __html: details.pc_requirements.minimum }}
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
                        dangerouslySetInnerHTML={{ __html: details.pc_requirements.recommended }}
                      />
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Reviews */}
            {reviews && reviews.reviews.length > 0 && (
              <section>
                <h2 className="text-xl font-semibold mb-4 font-['Orbitron']">Steam Reviews</h2>
                
                {/* Review Summary */}
                <div className="flex items-center gap-6 mb-6 p-4 rounded-lg bg-white/5 border border-white/10">
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
                </div>

                {/* Individual Reviews */}
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
                    className={cn(
                      "w-full h-full object-cover transition-opacity duration-300",
                      headerImageLoaded ? "opacity-100" : "opacity-0"
                    )}
                    onLoad={() => setHeaderImageLoaded(true)}
                    onError={() => setHeaderImageError(true)}
                  />
                )}
              </div>

              {/* Price / Free to Play */}
              {details.is_free ? (
                <Badge className="w-full justify-center py-2 bg-green-600 hover:bg-green-700">
                  Free to Play
                </Badge>
              ) : details.price_overview && (
                <div className="text-center">
                  {details.price_overview.discount_percent > 0 && (
                    <Badge className="mb-2 bg-green-600">
                      -{details.price_overview.discount_percent}%
                    </Badge>
                  )}
                  <div className="text-2xl font-bold">
                    {details.price_overview.final_formatted}
                  </div>
                </div>
              )}

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
                  onClick={() => appId && removeFromLibrary(appId)}
                  variant="outline"
                  className="w-full text-red-400 border-red-400/30 hover:bg-red-400/10"
                >
                  Remove from Library
                </Button>
              )}

              {/* Steam Link */}
              <Button
                variant="outline"
                className="w-full"
                onClick={() => window.open(`https://store.steampowered.com/app/${details.steam_appid}`, '_blank')}
              >
                <FaSteam className="w-4 h-4 mr-2" />
                View on Steam
                <ExternalLink className="w-3 h-3 ml-2" />
              </Button>

              {/* Website Link */}
              {details.website && (
                <Button
                  variant="ghost"
                  className="w-full text-sm"
                  onClick={() => window.open(details.website!, '_blank')}
                >
                  <ExternalLink className="w-3 h-3 mr-2" />
                  Official Website
                </Button>
              )}

              {/* FitGirl Repack Link */}
              {fitgirlLoading ? (
                <div className="flex items-center justify-center py-2">
                  <div className="w-4 h-4 border-2 border-white/20 border-t-fuchsia-500 rounded-full animate-spin" />
                  <span className="ml-2 text-sm text-white/60">Checking FitGirl...</span>
                </div>
              ) : fitgirlRepack && (fitgirlRepack.downloadLink || fitgirlRepack.url) ? (
                <div className="space-y-2">
                  {fitgirlRepack.downloadLink ? (
                    <Button
                      variant="outline"
                      className="w-full border-green-500/50 hover:bg-green-500/10 text-green-400"
                      onClick={() => {
                        if (fitgirlRepack.downloadLink) {
                          if (fitgirlRepack.downloadLink.startsWith('magnet:')) {
                            // For magnet links, try to open with default torrent client
                            window.open(fitgirlRepack.downloadLink, '_blank');
                          } else {
                            window.open(fitgirlRepack.downloadLink, '_blank');
                          }
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
                    onClick={() => window.open(fitgirlRepack.url, '_blank')}
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
                <div 
                  className="text-sm text-white/70 prose prose-invert prose-sm"
                  dangerouslySetInnerHTML={{ __html: details.supported_languages }}
                />
              </div>
            )}

            {/* Metacritic Critic Reviews */}
            <div className="p-6 rounded-lg bg-white/5 border border-white/10">
              <h3 className="font-semibold font-['Orbitron'] mb-3 flex items-center gap-2">
                <Star className="w-4 h-4 text-yellow-400" />
                Critic Reviews
              </h3>
              
              {metacriticLoading ? (
                <div className="flex items-center justify-center py-4">
                  <div className="w-6 h-6 border-2 border-white/20 border-t-fuchsia-500 rounded-full animate-spin" />
                </div>
              ) : metacriticReviews ? (
                <>
                  {/* Metacritic Score */}
                  {metacriticReviews.score > 0 && (
                    <div className="flex items-center gap-4 mb-4">
                      <div className={cn(
                        "w-12 h-12 rounded flex items-center justify-center font-bold text-lg",
                        metacriticReviews.score >= 75 ? "bg-green-600" :
                        metacriticReviews.score >= 50 ? "bg-yellow-600" : "bg-red-600"
                      )}>
                        {metacriticReviews.score}
                      </div>
                      <div>
                        <div className="text-sm font-medium">Metascore</div>
                        <div className="text-xs text-white/60">
                          {metacriticReviews.reviews.length} critic reviews
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Critic Reviews */}
                  <div className="space-y-3">
                    {metacriticReviews.reviews.slice(0, 3).map((review, index) => (
                      <div
                        key={index}
                        className="p-3 rounded bg-white/5"
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
                              "text-xs font-bold",
                              parseInt(review.review_grade) >= 75 ? "bg-green-600" :
                              parseInt(review.review_grade) >= 50 ? "bg-yellow-600" : "bg-red-600"
                            )}>
                              {review.review_grade}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-white/80 line-clamp-3">
                          {review.review}
                        </p>
                        {review.review_date && (
                          <div className="text-xs text-white/40 mt-1">
                            {review.review_date}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {metacriticReviews.reviews.length > 3 && (
                    <Button
                      variant="ghost"
                      className="w-full mt-3 text-xs"
                      onClick={() => window.open(`https://www.metacritic.com/search/${encodeURIComponent(details.name)}/`, '_blank')}
                    >
                      View all {metacriticReviews.reviews.length} reviews on Metacritic
                      <ExternalLink className="w-3 h-3 ml-1" />
                    </Button>
                  )}
                </>
              ) : (
                <div className="text-center py-4 text-white/40 text-sm">
                  No critic reviews available
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Similar Games / Recommendations Section */}
      {(recommendations.length > 0 || recommendationsLoading) && (
        <div className="bg-black/50 py-8 px-6">
          <div className="max-w-7xl mx-auto">
            <h2 className="text-xl font-bold mb-4 font-['Orbitron'] flex items-center gap-2">
              <Star className="w-5 h-5 text-fuchsia-400" />
              Similar Games You Might Like
            </h2>
            
            {recommendationsLoading ? (
              <div className="flex gap-4 overflow-x-auto pb-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex-shrink-0 w-64">
                    <div className="aspect-[460/215] bg-white/10 rounded-lg animate-pulse" />
                    <div className="mt-2 h-4 bg-white/10 rounded animate-pulse w-3/4" />
                    <div className="mt-1 h-3 bg-white/5 rounded animate-pulse w-1/2" />
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
                  {recommendations.map((rec) => {
                    // Score is already 0-1, multiply by 100 for percentage
                    const matchPercentage = Math.round(rec.score * 100);
                    return (
                      <motion.div
                        key={rec.appId}
                        className="flex-shrink-0 w-64 cursor-pointer group"
                        onClick={() => navigate(`/game/${rec.appId}`)}
                        whileHover={{ scale: 1.02 }}
                        transition={{ duration: 0.2 }}
                      >
                        <div className="relative aspect-[460/215] rounded-lg overflow-hidden bg-white/5">
                          <img
                            src={`https://cdn.akamai.steamstatic.com/steam/apps/${rec.appId}/header.jpg`}
                            alt={rec.name}
                            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                            onError={(e) => {
                              const img = e.target as HTMLImageElement;
                              img.src = `https://cdn.akamai.steamstatic.com/steam/apps/${rec.appId}/capsule_616x353.jpg`;
                            }}
                          />
                          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                        
                        {/* Title */}
                        <h3 className="mt-2 font-semibold text-sm truncate group-hover:text-fuchsia-400 transition-colors">
                          {rec.name}
                        </h3>
                        
                        {/* Badges below title */}
                        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                          {/* Match Score Badge */}
                          <Badge className={cn(
                            "text-[10px] px-1.5 py-0.5 font-semibold",
                            matchPercentage >= 80 ? "bg-fuchsia-600" :
                            matchPercentage >= 60 ? "bg-purple-600" : "bg-purple-800"
                          )}>
                            {matchPercentage}% Match
                          </Badge>
                          
                          {/* Reason Badges */}
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
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      
      {/* Library Dialog */}
      <GameDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        game={dialogGame}
        onSave={handleSaveLibraryEntry}
        genres={details?.genres?.map(g => g.description) || []}
        platforms={[
          ...(details?.platforms?.windows ? ['Windows'] : []),
          ...(details?.platforms?.mac ? ['Mac'] : []),
          ...(details?.platforms?.linux ? ['Linux'] : []),
        ]}
      />
    </div>
  );
}

