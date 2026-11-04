/**
 * Decorative infinite loops run on CSS keyframes, not framer-motion (v1.0.97, ui-voyage#24).
 *
 * framer v10 drives repeat: Infinity on its own JavaScript loop, so the
 * renderer never idled while Audit, Oracle or an empty state was open. The
 * loops now live in index.css with a prefers-reduced-motion fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'fs';
import path from 'path';
import type { JourneyEntry, LibraryGameEntry } from '@/types/game';

// Records every transition handed to a motion component.
const { transitions } = vi.hoisted(() => ({ transitions: [] as unknown[] }));

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
                transition,
                exit: _e,
                layout: _l,
                whileHover: _wh,
                whileTap: _wt,
                ...rest
              } = props;
              if (transition) transitions.push(transition);
              return React.createElement(tag, { ...rest, ref });
            }),
          );
        }
        return cache.get(tag);
      },
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children: unknown }) => children,
  };
});

vi.mock('@/services/bm25-index', () => ({
  bm25Index: { ensureReady: vi.fn().mockResolvedValue(false) },
}));
vi.mock('@/services/catalog-store', () => ({ catalogStore: {} }));
vi.mock('@/services/library-store', () => ({ libraryStore: { updateEntry: vi.fn() } }));

import { EmptyState } from '@/components/empty-state';
import { JourneyAuditView } from '@/components/journey-audit-view';

function infiniteTransitions(): unknown[] {
  return transitions.filter(
    (t) => typeof t === 'object' && t !== null && (t as { repeat?: number }).repeat === Infinity,
  );
}

const css = readFileSync(path.resolve(__dirname, '../../index.css'), 'utf8');

describe('decorative loops', () => {
  beforeEach(() => {
    transitions.length = 0;
  });

  it('empty-state rings use CSS keyframe classes, not framer repeat: Infinity', () => {
    const { container } = render(<EmptyState type="no-results" />);
    expect(container.querySelector('.empty-state-ring-a')).not.toBeNull();
    expect(container.querySelector('.empty-state-ring-b')).not.toBeNull();
    expect(infiniteTransitions()).toHaveLength(0);
  });

  it('empty-state decoration is finite: no infinite keyframes and no animate-pulse (they keep the window drawing at 60 fps)', () => {
    for (const cls of ['empty-state-ring-a', 'empty-state-ring-b', 'empty-state-twinkle', 'galaxy-building-pulse']) {
      const start = css.indexOf(`.${cls} {`);
      const rule = start < 0 ? '' : css.slice(start, css.indexOf('}', start));
      expect(rule, cls).toContain('animation:');
      expect(rule, cls).not.toContain('infinite');
    }
    const { container } = render(<EmptyState type="no-browse-results" />);
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(0);
    expect(container.querySelectorAll('.empty-state-twinkle')).toHaveLength(4);
  });

  it('a complete Audit ring glows through the CSS wrapper, not a framer loop', () => {
    const library: LibraryGameEntry[] = [
      {
        gameId: 'steam-1',
        status: 'Completed',
        priority: 'Medium',
        publicReviews: '',
        recommendationSource: '',
        hoursPlayed: 12,
        rating: 5,
        executablePath: 'C:\\Games\\hades.exe',
        addedAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
      },
    ];
    const journey: JourneyEntry[] = [
      {
        gameId: 'steam-1',
        title: 'Hades',
        genre: [],
        platform: [],
        status: 'Completed',
        hoursPlayed: 12,
        rating: 5,
        addedAt: '2024-01-01T00:00:00Z',
      },
    ];
    const { container } = render(
      <JourneyAuditView
        journeyEntries={journey}
        libraryEntries={library}
        statusHistory={[]}
        sessions={[]}
      />,
    );
    expect(container.querySelector('.audit-ring-glow circle')).not.toBeNull();
    expect(infiniteTransitions()).toHaveLength(0);
  });

  it('index.css defines the keyframes and a reduced-motion fallback for each loop', () => {
    for (const name of ['oracle-kenburns', 'audit-ring-glow', 'empty-state-ring-a', 'empty-state-ring-b', 'empty-state-twinkle']) {
      expect(css).toContain(`@keyframes ${name}`);
    }
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const cls of ['.oracle-kenburns', '.empty-state-ring-a', '.empty-state-ring-b', '.empty-state-twinkle', '.audit-ring-glow']) {
      expect(reduced).toContain(cls);
    }
    expect(reduced).toMatch(/\.audit-ring-glow\s*\{[^}]*animation:\s*none;[^}]*opacity:\s*0\.45/);
  });
});
