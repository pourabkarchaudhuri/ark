/**
 * Scenes spine → stream jumps (v1.0.97, ui-voyage#15).
 *
 * The spine lists episodes only, but the stream interleaves gap and milestone
 * rows, so the reveal window must be sized from the target's position in the
 * full stream. Rows mounted by a jump skip their entrance animation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { GameSession } from '@/types/game';

// Records the `initial` prop each scene row mounted with, keyed by scene id.
const { mountInitial } = vi.hoisted(() => ({ mountInitial: new Map<string, unknown>() }));

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
                initial,
                animate: _a,
                transition: _t,
                exit: _e,
                layout: _l,
                whileHover: _wh,
                whileTap: _wt,
                ...rest
              } = props;
              const id = rest['data-scene-id'];
              if (typeof id === 'string' && !mountInitial.has(id)) mountInitial.set(id, initial);
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

// jsdom has no layout, so the real virtualizer would render no spine rows.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({ index: i, start: i * 44, size: 44, key: i })),
    scrollToIndex: vi.fn(),
  }),
}));

import { JourneyScenesView } from '@/components/journey-scenes-view';

const DAY = 24 * 60 * 60 * 1000;
const scrollIntoView = vi.fn();

/**
 * 300 single-session episodes on distinct games, newest first. Every third
 * pair is separated by a 20-day silence, giving ~100 gap rows interleaved with
 * the scenes (plus a handful of session milestones).
 */
function sessions(): GameSession[] {
  const out: GameSession[] = [];
  let t = Date.UTC(2015, 0, 1, 18);
  for (let i = 0; i < 300; i++) {
    t += i % 3 === 0 ? 20 * DAY : DAY;
    const start = new Date(t);
    // Scene i = 0 is the oldest; ids are steam-<i>. Every tenth is a brief
    // launch, collapsed by the default curation (so 270 episodes show).
    const minutes = i % 10 === 5 ? 10 : 90;
    out.push({
      id: `s${i}`,
      gameId: `steam-${i}`,
      executablePath: 'game.exe',
      startTime: start.toISOString(),
      endTime: new Date(t + minutes * 60_000).toISOString(),
      durationMinutes: minutes,
      idleMinutes: 0,
    });
  }
  return out;
}

function renderView() {
  return render(<JourneyScenesView journeyEntries={[]} statusHistory={[]} sessions={sessions()} />);
}

function spineButtons(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('aside button')] as HTMLElement[];
}

/** The spine labels each episode with its title, which here is the game id. */
function gameOf(btn: HTMLElement): string {
  return /^(steam-\d+)/.exec(btn.textContent ?? '')![1];
}

function spineButton(container: HTMLElement, gameId: string): HTMLElement {
  const btn = spineButtons(container).find((b) => gameOf(b) === gameId);
  if (!btn) throw new Error(`no spine button for ${gameId}`);
  return btn;
}

function findButtonByText(container: HTMLElement, re: RegExp): HTMLElement | null {
  const all = [...container.querySelectorAll('button')] as HTMLElement[];
  return all.find((b) => re.test((b.textContent ?? '').trim())) ?? null;
}

function buttonByText(container: HTMLElement, re: RegExp): HTMLElement {
  const btn = findButtonByText(container, re);
  if (!btn) throw new Error(`no button matching ${re}`);
  return btn;
}

function sceneIdForGame(container: HTMLElement, gameId: string): string | null {
  const el = [...container.querySelectorAll('[data-scene-id]')].find((e) =>
    e.getAttribute('data-scene-id')!.startsWith(`${gameId}:`),
  );
  return el ? el.getAttribute('data-scene-id') : null;
}

describe('JourneyScenesView spine jumps', () => {
  beforeEach(() => {
    mountInitial.clear();
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  it('a click on a far episode mounts it and scrolls to it at once', () => {
    const { container } = renderView();
    const buttons = spineButtons(container);
    expect(buttons).toHaveLength(270);
    // Episode #250 in the spine. Its stream position is well past 250 + one
    // page, because ~80 gap rows sit above it.
    const target = gameOf(buttons[249]);
    expect(sceneIdForGame(container, target)).toBeNull();

    fireEvent.click(buttons[249]);

    const id = sceneIdForGame(container, target);
    expect(id).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const el = scrollIntoView.mock.instances[0] as unknown as HTMLElement;
    expect(el.getAttribute('data-scene-id')).toBe(id);
    expect(scrollIntoView.mock.calls[0][0]).toMatchObject({ behavior: 'auto' });
  });

  it('rows mounted by a jump render without their entrance animation', () => {
    const { container } = renderView();
    const first = container.querySelector('[data-scene-id]')!.getAttribute('data-scene-id')!;
    // Rows mounted on first paint animate in.
    expect(mountInitial.get(first)).not.toBe(false);

    const buttons = spineButtons(container);
    const target = gameOf(buttons[249]);
    // A row between the end of the first page and the target.
    const between = gameOf(buttons[150]);
    expect(sceneIdForGame(container, between)).toBeNull();

    fireEvent.click(buttons[249]);
    expect(mountInitial.get(sceneIdForGame(container, target)!)).toBe(false);
    expect(mountInitial.get(sceneIdForGame(container, between)!)).toBe(false);
  });

  it('a later Show more does not scroll back to a consumed or curated-away target', () => {
    const { container } = renderView();
    // Show brief launches, jump to one far down, then collapse them again so
    // the target leaves the stream. (Plain DOM queries: getByRole walks the
    // accessibility tree of hundreds of rows and takes seconds.)
    fireEvent.click(buttonByText(container, /^Curation/));
    const briefToggle = screen
      .getByText('Brief launches')
      .closest('label')!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(briefToggle);
    expect(spineButtons(container)).toHaveLength(300);

    fireEvent.click(spineButton(container, 'steam-215'));
    expect(sceneIdForGame(container, 'steam-215')).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    scrollIntoView.mockClear();

    fireEvent.click(briefToggle);
    expect(sceneIdForGame(container, 'steam-215')).toBeNull();

    const more = findButtonByText(container, /^Show \d+ more of \d+$/);
    expect(more).not.toBeNull();
    fireEvent.click(more!);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
