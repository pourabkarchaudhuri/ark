/**
 * VirtualGameGrid — renders a responsive grid of GameCards using windowed
 * virtualisation so only ~3 rows above/below the viewport are mounted.
 *
 * Uses `@tanstack/react-virtual` with window scrolling.
 * Responsive breakpoints mirror the original Tailwind grid:
 *   2 cols (< 640)  |  3 cols (sm)  |  4 cols (md)  |  5 cols (lg)  |  6 cols (xl)
 */

import { useRef, useMemo, useCallback, useState, useEffect, type ReactNode } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { Game } from '@/types/game';

// ---------------------------------------------------------------------------
// Responsive column hook
// ---------------------------------------------------------------------------

/** Tailwind breakpoints (px) → column count */
const BREAKPOINTS: [number, number][] = [
  [1280, 6], // xl
  [1024, 5], // lg
  [768, 4],  // md
  [640, 3],  // sm
  [0, 2],    // default
];

function getColumns(width: number): number {
  for (const [bp, cols] of BREAKPOINTS) {
    if (width >= bp) return cols;
  }
  return 2;
}

function useBreakpointColumns(): number {
  const [cols, setCols] = useState(() => getColumns(window.innerWidth));

  useEffect(() => {
    let rafId = 0;
    const onResize = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => setCols(getColumns(window.innerWidth)));
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(rafId);
    };
  }, []);

  return cols;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface VirtualGameGridProps {
  games: Game[];
  /** Render a single card. Must be stable (useCallback). */
  renderCard: (game: Game) => ReactNode;
  /** Gap between cards in px — should match the Tailwind gap-4 = 16px */
  gap?: number;
  /** Extra content rendered after the last virtual row (e.g. infinite-scroll sentinel) */
  footer?: ReactNode;
  /**
   * Approximate scroll margin (px) above the grid container so the
   * virtualizer correctly accounts for headers / padding.
   */
  scrollMargin?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VirtualGameGrid({
  games,
  renderCard,
  gap = 16,
  footer,
  scrollMargin = 0,
}: VirtualGameGridProps) {
  const columns = useBreakpointColumns();
  const containerRef = useRef<HTMLDivElement>(null);

  const rowCount = Math.ceil(games.length / columns);

  // Estimate row height: 3:4 cover aspect-ratio card.
  // At a typical 6-col layout the card is ~200px wide → 267px tall cover + ~80px info ≈ 350px.
  // We add gap to each row. The virtualizer will measure real sizes after first paint.
  const estimateSize = useCallback(() => 380 + gap, [gap]);

  const virtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize,
    overscan: 3, // rows above/below viewport to pre-render
    scrollMargin,
  });

  const virtualRows = virtualizer.getVirtualItems();

  // Memoize the grid-template-columns style string
  const gridTemplateCols = useMemo(
    () => `repeat(${columns}, minmax(0, 1fr))`,
    [columns],
  );

  return (
    <>
      <div
        ref={containerRef}
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualRows.map((virtualRow) => {
          const startIdx = virtualRow.index * columns;
          const rowGames = games.slice(startIdx, startIdx + columns);

          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: gridTemplateCols,
                  gap: `${gap}px`,
                  paddingBottom: `${gap}px`,
                }}
              >
                {rowGames.map((game) => (
                  <div key={game.id} className="min-w-0">
                    {renderCard(game)}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer (e.g. infinite-scroll sentinel) placed AFTER the virtual
          container so it flows naturally below the grid instead of sitting
          at y=0 behind the absolutely-positioned rows. */}
      {footer}
    </>
  );
}
