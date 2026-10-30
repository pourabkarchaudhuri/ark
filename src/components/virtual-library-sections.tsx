/**
 * VirtualLibrarySections — the grouped Library view ("All" status filter)
 * rendered as ONE window virtualizer over a flat row model, so a library of
 * thousands of games only mounts the cards near the viewport.
 *
 * Row model: one header row per non-empty status section, then
 * ceil(n / columns) card rows for each expanded section. Collapsing a section
 * simply drops its card rows (no height:auto animation — that cannot be
 * virtualized).
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Game } from '@/types/game';

export interface LibrarySection {
  key: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  color: string;
}

export type LibraryRow =
  | { kind: 'header'; key: string; section: LibrarySection; count: number; collapsed: boolean }
  | { kind: 'cards'; key: string; games: Game[] };

/** Flatten status groups into header + card rows (pure; exported for tests). */
export function buildLibraryRows(
  sections: readonly LibrarySection[],
  groups: Record<string, Game[]>,
  collapsed: ReadonlySet<string>,
  columns: number,
): LibraryRow[] {
  const cols = Math.max(1, columns);
  const rows: LibraryRow[] = [];
  for (const section of sections) {
    const games = groups[section.key];
    if (!games || games.length === 0) continue;
    const isCollapsed = collapsed.has(section.key);
    rows.push({ kind: 'header', key: `h:${section.key}`, section, count: games.length, collapsed: isCollapsed });
    if (isCollapsed) continue;
    for (let i = 0; i < games.length; i += cols) {
      rows.push({ kind: 'cards', key: `c:${section.key}:${i / cols}`, games: games.slice(i, i + cols) });
    }
  }
  return rows;
}

const HEADER_ROW_ESTIMATE = 52;
const CARD_ROW_ESTIMATE = 260;

export interface VirtualLibrarySectionsProps {
  sections: readonly LibrarySection[];
  groups: Record<string, Game[]>;
  collapsedSections: ReadonlySet<string>;
  onToggleSection: (key: string) => void;
  columns: number;
  /** Render a single card. Must be stable (useCallback). */
  renderCard: (game: Game) => ReactNode;
  gap?: number;
}

export function VirtualLibrarySections({
  sections,
  groups,
  collapsedSections,
  onToggleSection,
  columns,
  renderCard,
  gap = 16,
}: VirtualLibrarySectionsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const rows = useMemo(
    () => buildLibraryRows(sections, groups, collapsedSections, columns),
    [sections, groups, collapsedSections, columns],
  );

  // Distance from the document top to the list, so window scroll offsets map
  // onto row positions (the chips and toolbar sit above it).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const top = Math.round(el.getBoundingClientRect().top + window.scrollY);
    setScrollMargin((prev) => (prev === top ? prev : top));
  });

  const estimateSize = useCallback(
    (index: number) => (rows[index]?.kind === 'header' ? HEADER_ROW_ESTIMATE : CARD_ROW_ESTIMATE + gap),
    [rows, gap],
  );

  // Stable per row model: a fresh function each render would make the
  // virtualizer rebuild its measurements on every render.
  const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows]);

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize,
    overscan: 3,
    scrollMargin,
    getItemKey,
  });

  const gridTemplateCols = `repeat(${columns}, minmax(0, 1fr))`;

  return (
    <div
      ref={containerRef}
      data-testid="library-sections"
      style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index];
        if (!row) return null;
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
            {row.kind === 'header' ? (
              <div className="pb-2">
                <button
                  type="button"
                  onClick={() => onToggleSection(row.section.key)}
                  aria-expanded={!row.collapsed}
                  className="w-full flex items-center gap-2 py-2.5 px-3 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] transition-colors cursor-pointer group"
                >
                  <row.section.icon className={cn('w-3.5 h-3.5 flex-shrink-0', row.section.color)} />
                  <span className="text-sm font-semibold text-white/90 font-mono tracking-wide">// {row.section.label}</span>
                  <Badge variant="outline" className="text-[11px] px-2 py-0 h-5 border-white/20 text-white/50 font-mono tabular-nums">{row.count}</Badge>
                  <div className="flex-1" />
                  <ChevronDown className={cn(
                    'w-4 h-4 text-white/20 group-hover:text-white/40 transition-transform duration-200',
                    row.collapsed && '-rotate-90',
                  )} />
                </button>
              </div>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: gridTemplateCols,
                  gap: `${gap}px`,
                  paddingTop: 4,
                  paddingBottom: `${gap}px`,
                }}
              >
                {row.games.map((game) => (
                  <div key={game.id} className="min-w-0">
                    {renderCard(game)}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
