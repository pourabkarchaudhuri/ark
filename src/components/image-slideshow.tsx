import { useState, useEffect, useCallback, memo } from 'react';
import { ChevronLeft, ChevronRight, Play, Pause } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ImageSlideshowProps {
  images: string[];
  videos?: string[]; // YouTube video IDs
  autoPlayInterval?: number;
  className?: string;
  fallbackGradient?: string;
  fallbackContent?: React.ReactNode;
}

function ImageSlideshowComponent({
  images,
  videos = [],
  autoPlayInterval = 5000,
  className,
  fallbackGradient,
  fallbackContent,
}: ImageSlideshowProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [imageLoadError, setImageLoadError] = useState<Set<number>>(new Set());

  const allMedia = [...images];
  const hasMultiple = allMedia.length > 1;

  // Auto-advance slideshow
  useEffect(() => {
    if (!isPlaying || !hasMultiple) return;

    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % allMedia.length);
    }, autoPlayInterval);

    return () => clearInterval(interval);
  }, [isPlaying, allMedia.length, autoPlayInterval, hasMultiple]);

  const goToNext = useCallback(() => {
    setCurrentIndex((prev) => (prev + 1) % allMedia.length);
  }, [allMedia.length]);

  const goToPrev = useCallback(() => {
    setCurrentIndex((prev) => (prev - 1 + allMedia.length) % allMedia.length);
  }, [allMedia.length]);

  const handleImageError = useCallback((index: number) => {
    setImageLoadError((prev) => new Set(prev).add(index));
  }, []);

  // If no images, show fallback
  if (allMedia.length === 0) {
    return (
      <div 
        className={cn("relative overflow-hidden", className)}
        style={{ background: fallbackGradient }}
      >
        {fallbackContent}
      </div>
    );
  }

  const currentImage = allMedia[currentIndex];
  const hasError = imageLoadError.has(currentIndex);

  return (
    <div className={cn("relative overflow-hidden group", className)}>
      {/* Current Image */}
      <div className="absolute inset-0 transition-opacity duration-500">
        {!hasError ? (
          <img
            key={currentIndex}
            src={currentImage}
            alt={`Slide ${currentIndex + 1}`}
            className="w-full h-full object-cover animate-fade-in"
            onError={() => handleImageError(currentIndex)}
          />
        ) : (
          <div 
            className="w-full h-full" 
            style={{ background: fallbackGradient || 'linear-gradient(135deg, #1a1a2e 0%, #0f0f1a 100%)' }}
          >
            {fallbackContent}
          </div>
        )}
      </div>

      {/* Overlay gradient */}
      <div className="absolute inset-0 bg-gradient-to-t from-card via-card/60 to-transparent pointer-events-none" />

      {/* Navigation Controls (visible on hover) */}
      {hasMultiple && (
        <>
          {/* Previous Button */}
          <button
            onClick={goToPrev}
            className="absolute left-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/70 z-10"
            aria-label="Previous image"
          >
            <ChevronLeft className="h-5 w-5 text-white" />
          </button>

          {/* Next Button */}
          <button
            onClick={goToNext}
            className="absolute right-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/70 z-10"
            aria-label="Next image"
          >
            <ChevronRight className="h-5 w-5 text-white" />
          </button>

          {/* Play/Pause Button */}
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            className="absolute bottom-4 right-4 p-2 rounded-full bg-black/50 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/70 z-10"
            aria-label={isPlaying ? 'Pause slideshow' : 'Play slideshow'}
          >
            {isPlaying ? (
              <Pause className="h-4 w-4 text-white" />
            ) : (
              <Play className="h-4 w-4 text-white" />
            )}
          </button>

          {/* Dot Indicators */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 z-10">
            {allMedia.map((_, index) => (
              <button
                key={index}
                onClick={() => setCurrentIndex(index)}
                className={cn(
                  "w-2 h-2 rounded-full transition-all",
                  index === currentIndex
                    ? "bg-white w-4"
                    : "bg-white/40 hover:bg-white/60"
                )}
                aria-label={`Go to slide ${index + 1}`}
              />
            ))}
          </div>
        </>
      )}

      {/* Video Thumbnails Row (if videos available) */}
      {videos.length > 0 && (
        <div className="absolute bottom-16 left-4 right-4 flex items-center gap-2 overflow-x-auto pb-2 z-10">
          {videos.slice(0, 3).map((videoId, index) => (
            <a
              key={videoId}
              href={`https://www.youtube.com/watch?v=${videoId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="relative flex-shrink-0 w-20 h-12 rounded-lg overflow-hidden bg-black/50 hover:ring-2 ring-white/50 transition-all"
            >
              <img
                src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`}
                alt={`Video ${index + 1}`}
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                <Play className="h-4 w-4 text-white fill-white" />
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export const ImageSlideshow = memo(ImageSlideshowComponent);

