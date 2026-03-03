/**
 * Event Resolver — calls the Electron event scraper IPC, computes live
 * status (upcoming / live / past / unknown), and caches in memory.
 */
import { GAMING_EVENTS, type ResolvedEvent } from '@/data/gaming-events';

let resolved: ResolvedEvent[] | null = null;
let resolving = false;
const waiters: Array<(events: ResolvedEvent[]) => void> = [];

function computeStatus(start?: number, end?: number): ResolvedEvent['status'] {
  if (!start) return 'unknown';
  const now = Date.now() / 1000;
  const effectiveEnd = end ?? start + 86_400;
  if (now >= start && now <= effectiveEnd) return 'live';
  if (now < start) return 'upcoming';
  return 'past';
}

/**
 * Re-compute statuses for all events. Returns the SAME array reference
 * if nothing changed, so React can bail on re-render.
 */
export function refreshStatuses(events: ResolvedEvent[]): ResolvedEvent[] {
  let changed = false;
  const next = events.map((ev) => {
    const newStatus = computeStatus(ev.startDate, ev.endDate);
    if (newStatus !== ev.status) {
      changed = true;
      return { ...ev, status: newStatus };
    }
    return ev;
  });
  return changed ? next : events;
}

function fallbackEvents(): ResolvedEvent[] {
  return GAMING_EVENTS.map((ev) => ({
    ...ev,
    youtubeUrls: [],
    twitchUrls: [],
    status: 'unknown' as const,
  }));
}

export async function resolveEvents(): Promise<ResolvedEvent[]> {
  if (resolved) return refreshStatuses(resolved);

  if (resolving) {
    return new Promise<ResolvedEvent[]>((resolve) => {
      waiters.push(resolve);
    });
  }

  resolving = true;

  try {
    const api = window.eventScraper;
    if (!api) {
      resolved = fallbackEvents();
      return resolved;
    }

    const eventsWithUrl = GAMING_EVENTS.filter((ev) => ev.url).map((ev) => ({ id: ev.id, url: ev.url }));
    const scraped = await api.scrapeAll(eventsWithUrl);

    resolved = GAMING_EVENTS.map((ev) => {
      const data = scraped[ev.id];
      return {
        ...ev,
        startDate: data?.startDate,
        endDate: data?.endDate,
        youtubeUrls: data?.youtubeUrls ?? [],
        twitchUrls: data?.twitchUrls ?? [],
        status: computeStatus(data?.startDate, data?.endDate),
        scrapedAt: data?.scrapedAt,
      };
    });
  } catch (err) {
    console.error('[EventResolver] Scrape failed:', err);
    resolved = fallbackEvents();
  } finally {
    resolving = false;
    const result = resolved!;
    waiters.forEach((cb) => cb(result));
    waiters.length = 0;
  }

  return resolved!;
}

/** Clear the in-memory cache so the next resolveEvents() call re-scrapes. */
export function clearResolvedCache(): void {
  resolved = null;
}

/**
 * Kick off event resolution in the background so data is ready
 * when the user opens Transmissions. Safe to call multiple times.
 */
export function prewarmEvents(): void {
  if (resolved || resolving) return;
  resolveEvents().catch(() => {});
}
