import { memo } from 'react';

/**
 * Skeleton loader component matching the GameCard design.
 * Shows a pulsing placeholder while game data is loading.
 */
function GameCardSkeletonComponent() {
  return (
    <div className="relative flex flex-col rounded-xl overflow-hidden bg-card/30 border border-transparent w-full">
      {/* Cover Image Container - 3:4 aspect ratio like game covers */}
      <div className="relative aspect-[3/4] overflow-hidden bg-white/5 animate-pulse">
        {/* Gradient overlay to match real cards */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent pointer-events-none" />
      </div>

      {/* Game Info Footer */}
      <div className="p-3 space-y-1.5">
        {/* Title Row with Actions */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0 min-h-[5.5rem] space-y-1.5">
            {/* Title skeleton - 2 lines */}
            <div className="h-4 bg-white/10 rounded animate-pulse w-[85%]" />
            <div className="h-4 bg-white/10 rounded animate-pulse w-[60%]" />
            {/* Developer skeleton */}
            <div className="h-3 bg-white/5 rounded animate-pulse w-[50%] mt-1" />
            {/* Release date skeleton */}
            <div className="h-3 bg-white/5 rounded animate-pulse w-[35%]" />
          </div>
          {/* Ellipsis menu skeleton */}
          <div className="h-8 w-8 bg-white/5 rounded animate-pulse flex-shrink-0" />
        </div>
        
        {/* Platform Icons and Status Badge Row */}
        <div className="flex items-center justify-between min-h-[1.5rem]">
          {/* Platform Icons skeleton */}
          <div className="flex items-center gap-1.5">
            <div className="w-6 h-6 rounded bg-white/10 animate-pulse" />
            <div className="w-6 h-6 rounded bg-white/10 animate-pulse" />
            <div className="w-6 h-6 rounded bg-white/10 animate-pulse" />
          </div>
        </div>
      </div>
    </div>
  );
}

export const GameCardSkeleton = memo(GameCardSkeletonComponent);

/**
 * Grid of skeleton cards for loading state.
 * @param count - Number of skeleton cards to show (default: 12)
 */
interface SkeletonGridProps {
  count?: number;
}

function SkeletonGridComponent({ count = 12 }: SkeletonGridProps) {
  return (
    <>
      {Array.from({ length: count }).map((_, index) => (
        <GameCardSkeleton key={`skeleton-${index}`} />
      ))}
    </>
  );
}

export const SkeletonGrid = memo(SkeletonGridComponent);

