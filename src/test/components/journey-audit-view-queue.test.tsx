/**
 * Audit queue paging and FindingCard memoisation (v1.0.97, ui-voyage#14).
 *
 * After a Steam import nearly every game lacks an executable path, so the queue
 * can hold thousands of findings. It mounts one page at a time, and a library
 * notification that changes nothing a card shows must not re-render the cards.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { JourneyEntry, LibraryGameEntry } from '@/types/game';

// Counts renders of each FindingCard's root (tagged with data-finding-key), so
// the test sees exactly which cards React re-rendered.
const { renderCounts } = vi.hoisted(() => ({ renderCounts: new Map<string, number>() }));

vi.mock('framer-motion', async () => {
  const React = await import('react');
  const cache = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!cache.has(tag)) {
          cache.set(
            tag,
            React.forwardRef<unknown, Record<string, unknown>>(function MotionStub(props, ref) {
              const {
                initial: _i,
                animate: _a,
                transition: _t,
                exit: _e,
                layout: _l,
                whileHover: _wh,
                whileTap: _wt,
                ...rest
              } = props;
              const key = rest['data-finding-key'];
              if (typeof key === 'string') renderCounts.set(key, (renderCounts.get(key) ?? 0) + 1);
              return React.createElement(tag, { ...rest, ref });
            }),
          );
        }
        return cache.get(tag);
      },
    },
  );
  return { motion, AnimatePresence: ({ children }: { children: unknown }) => children };
});

vi.mock('@/services/bm25-index', () => ({
  bm25Index: { ensureReady: vi.fn().mockResolvedValue(false) },
}));
vi.mock('@/services/catalog-store', () => ({ catalogStore: {} }));
vi.mock('@/services/library-store', () => ({
  libraryStore: { updateEntry: vi.fn() },
}));

import {
  JourneyAuditView,
  QUEUE_PAGE_SIZE,
  findingCardPropsEqual,
} from '@/components/journey-audit-view';

function libraryEntry(i: number, over: Partial<LibraryGameEntry> = {}): LibraryGameEntry {
  return {
    gameId: `steam-${1000 + i}`,
    status: 'Want to Play',
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
    hoursPlayed: 0,
    rating: 0,
    addedAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...over,
  };
}

function journeyEntry(i: number): JourneyEntry {
  return {
    gameId: `steam-${1000 + i}`,
    title: `Game ${String(i).padStart(3, '0')}`,
    genre: [],
    platform: [],
    status: 'Want to Play',
    hoursPlayed: 0,
    rating: 0,
    addedAt: '2024-01-01T00:00:00Z',
  };
}

const N = 200;

function fixture() {
  const libraryEntries = Array.from({ length: N }, (_, i) => libraryEntry(i));
  const journeyEntries = Array.from({ length: N }, (_, i) => journeyEntry(i));
  return { libraryEntries, journeyEntries };
}

function cardCount(container: HTMLElement): number {
  return container.querySelectorAll('[data-finding-key]').length;
}

describe('JourneyAuditView queue paging', () => {
  beforeEach(() => {
    renderCounts.clear();
    localStorage.clear();
  });

  it('mounts one page of findings plus a Show more control', () => {
    const { libraryEntries, journeyEntries } = fixture();
    const { container } = render(
      <JourneyAuditView
        journeyEntries={journeyEntries}
        libraryEntries={libraryEntries}
        statusHistory={[]}
        sessions={[]}
      />,
    );

    expect(QUEUE_PAGE_SIZE).toBe(50);
    expect(cardCount(container)).toBe(50);
    // Every record lacks an executable, so the full queue has at least N.
    // getByText, not getByRole: the role query walks the a11y tree of every card.
    const more = screen.getByText(/^Show 50 more of \d+$/).closest('button')!;
    const remaining = Number(/of (\d+)/.exec(more.textContent ?? '')![1]);
    expect(remaining + 50).toBeGreaterThanOrEqual(N);

    fireEvent.click(more);
    expect(cardCount(container)).toBe(100);
  });

  it('scores read the full open list, not the mounted page', () => {
    const { libraryEntries, journeyEntries } = fixture();
    render(
      <JourneyAuditView
        journeyEntries={journeyEntries}
        libraryEntries={libraryEntries}
        statusHistory={[]}
        sessions={[]}
      />,
    );
    // missing-exe lives in the completion area: all N records open of N checked.
    expect(screen.getByText(new RegExp(`· ${N} open of ${N} checked`))).toBeInTheDocument();
  });

  it('a library update that changes nothing a card shows re-renders no card', () => {
    const { libraryEntries, journeyEntries } = fixture();
    const { rerender, container } = render(
      <JourneyAuditView
        journeyEntries={journeyEntries}
        libraryEntries={libraryEntries}
        statusHistory={[]}
        sessions={[]}
      />,
    );
    const mounted = [...container.querySelectorAll('[data-finding-key]')].map(
      (el) => el.getAttribute('data-finding-key')!,
    );
    expect(mounted).toHaveLength(50);
    const before = new Map(mounted.map((k) => [k, renderCounts.get(k)]));

    // New array, new entry objects (as every libraryStore notify produces),
    // one unrelated field changed on one game.
    const next = libraryEntries.map((e) => ({ ...e }));
    next[N - 1] = { ...next[N - 1], publicReviews: 'Very Positive', updatedAt: new Date() };
    rerender(
      <JourneyAuditView
        journeyEntries={journeyEntries}
        libraryEntries={next}
        statusHistory={[]}
        sessions={[]}
      />,
    );

    for (const k of mounted) expect(renderCounts.get(k)).toBe(before.get(k));
    expect(cardCount(container)).toBe(50);
  });

  it('a card re-renders when its rollup status or rating changes', () => {
    const finding = {
      key: 'missing-exe:steam-1',
      ruleId: 'missing-exe' as const,
      area: 'completion' as const,
      subjectId: 'steam-1',
      title: 'Doom',
      question: 'q',
      detail: 'd',
      resolution: 'exe' as const,
    };
    const cb = vi.fn();
    const rollup = { status: 'Want to Play', rating: 0 } as never;
    const base = { finding, rollup, onResolve: cb, onSnooze: cb, onDismiss: cb };
    expect(findingCardPropsEqual(base, { ...base, finding: { ...finding } })).toBe(true);
    expect(
      findingCardPropsEqual(base, { ...base, rollup: { status: 'Completed', rating: 0 } as never }),
    ).toBe(false);
    expect(
      findingCardPropsEqual(base, { ...base, rollup: { status: 'Want to Play', rating: 4 } as never }),
    ).toBe(false);
    expect(findingCardPropsEqual(base, { ...base, finding: { ...finding, title: 'Doom II' } })).toBe(
      false,
    );
    expect(findingCardPropsEqual(base, { ...base, onResolve: vi.fn() })).toBe(false);
  });
});
