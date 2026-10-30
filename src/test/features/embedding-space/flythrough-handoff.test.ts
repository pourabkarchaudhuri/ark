import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The controller pulls in the engine and every data store; none of that matters for the handoff.
vi.mock('html-to-image', () => ({ toPng: vi.fn() }));
vi.mock('@/features/embedding-space/engine/GalaxyEngine', () => ({ GalaxyEngine: class {} }));
vi.mock('@/services/galaxy-cache', () => ({
  GALAXY_STEP_LABELS: ['a'],
  GENRE_PALETTE: [],
  genreToColorIdx: () => 0,
  // Never resolves: the controller stays "loading" until the test says otherwise.
  loadCachedGalaxyIfFresh: () => new Promise(() => {}),
  buildAndCacheGalaxy: vi.fn(),
  getBackgroundBuildPromise: () => null,
  cancelActiveProjectionWorker: vi.fn(),
}));
vi.mock('@/services/embedding-service', () => ({ embeddingService: { isCatalogRunning: false, subscribe: () => () => {} }, getEmbeddingById: vi.fn() }));
vi.mock('@/services/library-store', () => ({ libraryStore: { subscribe: () => () => {} } }));
vi.mock('@/services/journey-store', () => ({ journeyStore: { getAllEntries: () => [] } }));
vi.mock('@/services/game-graph-store', () => ({ gameGraphStore: { subscribe: () => () => {}, state: { phase: 'idle' } } }));

import {
  FLYTHROUGH_PENDING_EVENT, FLYTHROUGH_PENDING_KEY, FLYTHROUGH_TTL_MS, consumePendingFlythrough,
} from '@/components/year-wrapped/flythrough';
import { EmbeddingSpaceController, type ControllerRefs } from '@/features/embedding-space/ui/controller';

const KF = [
  { gameId: 'a', title: 'A', subtitle: 'first' },
  { gameId: 'b', title: 'B', subtitle: 'second' },
];
const stash = (generatedAt?: number) =>
  localStorage.setItem(FLYTHROUGH_PENDING_KEY, JSON.stringify({ keyframes: KF, year: 2026, ...(generatedAt != null ? { generatedAt } : {}) }));

const refs = (): ControllerRefs => ({
  canvasHost: null, screenshotArea: null, root: null, neighborCardsHost: null, pathOverviewHost: null, tooltip: null,
  fps: null, approachWrap: null, approach: null, depth: null, railMarker: null, dockLine: null, dockBase: null,
});

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe('consumePendingFlythrough', () => {
  it('returns a fresh payload once, then nothing', () => {
    stash(Date.now());
    expect(consumePendingFlythrough()).toEqual(KF);
    expect(localStorage.getItem(FLYTHROUGH_PENDING_KEY)).toBeNull();
    expect(consumePendingFlythrough()).toBeNull();
  });

  it('drops and removes an expired payload', () => {
    stash(Date.now() - FLYTHROUGH_TTL_MS - 1);
    expect(consumePendingFlythrough()).toBeNull();
    expect(localStorage.getItem(FLYTHROUGH_PENDING_KEY)).toBeNull();
  });

  it('drops a payload without generatedAt, or a malformed one', () => {
    stash();
    expect(consumePendingFlythrough()).toBeNull();
    expect(localStorage.getItem(FLYTHROUGH_PENDING_KEY)).toBeNull();
    localStorage.setItem(FLYTHROUGH_PENDING_KEY, '{nope');
    expect(consumePendingFlythrough()).toBeNull();
    expect(localStorage.getItem(FLYTHROUGH_PENDING_KEY)).toBeNull();
  });
});

describe('EmbeddingSpaceController flythrough handoff', () => {
  it('launches a handoff that arrives while the Galaxy is already loaded', () => {
    vi.useFakeTimers();
    const ctl = new EmbeddingSpaceController(() => {}, () => {}, false);
    const launch = vi.spyOn(ctl, 'launchFlythroughKeyframes').mockImplementation(() => {});
    ctl.mount(refs());
    ctl.engine = {} as never;
    ctl.set({ loading: false });

    stash(Date.now());
    window.dispatchEvent(new CustomEvent(FLYTHROUGH_PENDING_EVENT));
    vi.advanceTimersByTime(700);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(KF);
    expect(localStorage.getItem(FLYTHROUGH_PENDING_KEY)).toBeNull();

    ctl.engine = null;
    ctl.unmount();
  });

  it('leaves the handoff for load() while still loading, and stops listening after unmount', () => {
    vi.useFakeTimers();
    const ctl = new EmbeddingSpaceController(() => {}, () => {}, false);
    const launch = vi.spyOn(ctl, 'launchFlythroughKeyframes').mockImplementation(() => {});
    ctl.mount(refs());

    stash(Date.now());
    window.dispatchEvent(new CustomEvent(FLYTHROUGH_PENDING_EVENT));
    vi.advanceTimersByTime(700);
    expect(launch).not.toHaveBeenCalled();
    expect(localStorage.getItem(FLYTHROUGH_PENDING_KEY)).not.toBeNull();

    ctl.unmount();
    ctl.engine = {} as never;
    ctl.set({ loading: false });
    window.dispatchEvent(new CustomEvent(FLYTHROUGH_PENDING_EVENT));
    vi.advanceTimersByTime(700);
    expect(launch).not.toHaveBeenCalled();
  });
});
