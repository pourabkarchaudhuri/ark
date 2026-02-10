/**
 * DetailEnricher — singleton service that lazy-loads full game metadata
 * for lightweight catalog cards as they scroll into the viewport.
 *
 * Architecture:
 *   • One shared IntersectionObserver watches card DOM elements
 *   • Visible cards' game IDs are collected in a LIFO priority queue
 *   • After a short debounce (150ms), a batch of up to 10 is sent
 *     through the existing getMultipleAppDetails IPC pipeline
 *   • Results are transformed and passed to the onEnriched callback,
 *     which patches the allGames state in the game store hook
 */

import { Game } from '@/types/game';
import { SteamAppDetails, getSteamCoverUrl } from '@/types/steam';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnricherConfig {
  /** Called with a map of gameId string → partial Game fields to merge */
  onEnriched: (results: Map<string, Partial<Game>>) => void;
  /** Predicate: should this gameId be enriched? (e.g. developer === '') */
  needsEnrichment: (gameId: string) => boolean;
}

// ---------------------------------------------------------------------------
// Transform helpers (mirrors transformSteamGame but returns Partial<Game>)
// ---------------------------------------------------------------------------

function detailsToPartialGame(details: SteamAppDetails): Partial<Game> {
  const platforms: string[] = [];
  if (details.platforms?.windows) platforms.push('Windows');
  if (details.platforms?.mac) platforms.push('Mac');
  if (details.platforms?.linux) platforms.push('Linux');

  const genres = details.genres?.map(g => g.description) || [];
  const screenshots = details.screenshots?.map(s => s.path_full) || [];
  const videos = details.movies?.map(m => m.mp4?.max || m.webm?.max || '').filter(Boolean) || [];

  let releaseDate = '';
  if (details.release_date?.date) {
    try {
      const parsed = new Date(details.release_date.date);
      releaseDate = !isNaN(parsed.getTime()) ? parsed.toISOString() : details.release_date.date;
    } catch {
      releaseDate = details.release_date.date;
    }
  }

  const coverUrl = getSteamCoverUrl(details.steam_appid);
  const allScreenshots = details.header_image
    ? [details.header_image, ...screenshots]
    : screenshots;

  return {
    developer: details.developers?.[0] || 'Unknown Developer',
    publisher: details.publishers?.[0] || 'Unknown Publisher',
    genre: genres,
    platform: platforms.length > 0 ? platforms : ['PC'],
    metacriticScore: details.metacritic?.score || null,
    releaseDate,
    summary: details.short_description || details.about_the_game || '',
    coverUrl,
    headerImage: details.header_image || undefined,
    screenshots: allScreenshots,
    videos,
    price: {
      isFree: details.is_free || false,
      finalFormatted: details.price_overview?.final_formatted,
      discountPercent: details.price_overview?.discount_percent,
    },
    achievements: details.achievements?.total,
    recommendations: details.recommendations?.total,
    comingSoon: details.release_date?.coming_soon,
    // Bump updatedAt so the GameCard memo detects the change
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// DetailEnricher singleton
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 300;
const MAX_BATCH_SIZE = 6; // One grid row — keeps API load low
const BATCH_COOLDOWN_MS = 3000; // Wait between batches to avoid 429s

// Memory caps — prevent unbounded growth during long browsing sessions
const MAX_ENRICHED_IDS = 5_000;
const MAX_ELEMENT_MAP_SIZE = 500;

class DetailEnricher {
  // --- config (set via configure()) ---
  private config: EnricherConfig | null = null;

  // --- tracking sets ---
  /** Game IDs that have been enriched or returned null (never retry) */
  private enrichedIds = new Set<string>();
  /** Game IDs currently in-flight (IPC call running) */
  private inFlightIds = new Set<string>();

  // --- priority queue (LIFO — most recently visible first) ---
  private pendingQueue: string[] = [];

  // --- observer ---
  private observer: IntersectionObserver | null = null;

  // --- debounce timer ---
  private timer: ReturnType<typeof setTimeout> | null = null;

  // --- batch-in-progress flag ---
  private processing = false;

  // --- element ↔ gameId mapping ---
  private elementToGameId = new Map<HTMLElement, string>();

  // -----------------------------------------------------------------------
  // Memory management — evict oldest entries when caps are reached
  // -----------------------------------------------------------------------

  private pruneEnrichedIds(): void {
    if (this.enrichedIds.size <= MAX_ENRICHED_IDS) return;
    // Set iteration is insertion-order; delete from the front (oldest)
    const excess = this.enrichedIds.size - MAX_ENRICHED_IDS;
    let removed = 0;
    for (const id of this.enrichedIds) {
      if (removed >= excess) break;
      this.enrichedIds.delete(id);
      removed++;
    }
  }

  private pruneElementMap(): void {
    if (this.elementToGameId.size <= MAX_ELEMENT_MAP_SIZE) return;
    // Evict entries whose elements are no longer connected to the DOM
    for (const [el, _id] of this.elementToGameId) {
      if (!el.isConnected) {
        this.observer?.unobserve(el);
        this.elementToGameId.delete(el);
      }
    }
    // If still over limit after GC, drop oldest entries
    if (this.elementToGameId.size > MAX_ELEMENT_MAP_SIZE) {
      const excess = this.elementToGameId.size - MAX_ELEMENT_MAP_SIZE;
      let removed = 0;
      for (const [el] of this.elementToGameId) {
        if (removed >= excess) break;
        this.observer?.unobserve(el);
        this.elementToGameId.delete(el);
        removed++;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Wire up the enricher to the game store. Called once (or on re-mount).
   */
  configure(config: EnricherConfig): void {
    // Clear any pending timer from a previous configure() call
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.config = config;
    this.ensureObserver();
  }

  /**
   * Observe a card element. Supports both string gameId and legacy numeric appId.
   */
  observe(element: HTMLElement, gameIdOrAppId: string | number): void {
    const gameId = typeof gameIdOrAppId === 'number' ? `steam-${gameIdOrAppId}` : gameIdOrAppId;
    if (this.enrichedIds.has(gameId) || this.inFlightIds.has(gameId)) return;
    this.elementToGameId.set(element, gameId);
    this.pruneElementMap(); // Evict detached DOM elements before growing further
    this.ensureObserver();
    this.observer!.observe(element);
  }

  /**
   * Stop observing (called on unmount or after enrichment).
   */
  unobserve(element: HTMLElement): void {
    this.observer?.unobserve(element);
    this.elementToGameId.delete(element);
  }

  /**
   * Full reset — call on category change or refresh.
   */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.processing = false;
    this.pendingQueue = [];
    this.enrichedIds.clear();
    this.inFlightIds.clear();
    // Disconnect & recreate observer so stale entries don't fire
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.elementToGameId.clear();
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private ensureObserver(): void {
    if (this.observer) return;
    this.observer = new IntersectionObserver(
      (entries) => this.handleIntersection(entries),
      { rootMargin: '200px 0px', threshold: 0 },
    );
  }

  private handleIntersection(entries: IntersectionObserverEntry[]): void {
    if (!this.config) return;

    let added = false;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target as HTMLElement;
      const gameId = this.elementToGameId.get(el);
      if (!gameId) continue;
      if (this.enrichedIds.has(gameId) || this.inFlightIds.has(gameId)) continue;
      if (!this.config.needsEnrichment(gameId)) {
        // Already has details — mark and unobserve
        this.enrichedIds.add(gameId);
        this.observer?.unobserve(el);
        continue;
      }
      // LIFO: push to end (popped from end in processBatch)
      if (!this.pendingQueue.includes(gameId)) {
        this.pendingQueue.push(gameId);
        added = true;
      }
    }

    if (added) this.scheduleBatch();
  }

  private scheduleBatch(): void {
    // Don't schedule if a batch is already in-flight; processBatch will
    // schedule the next one after the cooldown completes.
    if (this.processing) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.processBatch(), DEBOUNCE_MS);
  }

  private async processBatch(): Promise<void> {
    if (!this.config || !window.steam || this.processing) return;

    // Take up to MAX_BATCH_SIZE from the END (LIFO — most recently visible)
    const batch: string[] = [];
    while (batch.length < MAX_BATCH_SIZE && this.pendingQueue.length > 0) {
      const gameId = this.pendingQueue.pop()!;
      if (this.enrichedIds.has(gameId) || this.inFlightIds.has(gameId)) continue;
      batch.push(gameId);
    }

    if (batch.length === 0) {
      // If there are still items in the queue, schedule another batch
      if (this.pendingQueue.length > 0) this.scheduleBatch();
      return;
    }

    this.processing = true;

    // Mark in-flight
    for (const id of batch) this.inFlightIds.add(id);

    try {
      // Extract numeric Steam appIds for the IPC call
      const numericBatch = batch
        .filter(id => id.startsWith('steam-'))
        .map(id => parseInt(id.replace('steam-', ''), 10))
        .filter(id => !isNaN(id));

      if (numericBatch.length === 0) {
        // No Steam games in this batch — mark all as enriched
        for (const id of batch) {
          this.inFlightIds.delete(id);
          this.enrichedIds.add(id);
        }
        this.processing = false;
        if (this.pendingQueue.length > 0) this.scheduleBatch();
        return;
      }

      console.log(`[DetailEnricher] Fetching details for ${numericBatch.length} games: [${numericBatch.slice(0, 5).join(', ')}${numericBatch.length > 5 ? '...' : ''}]`);
      const results = await window.steam.getMultipleAppDetails(numericBatch);

      const enrichments = new Map<string, Partial<Game>>();
      for (const { appId, details } of results) {
        if (details) {
          enrichments.set(`steam-${appId}`, detailsToPartialGame(details as unknown as SteamAppDetails));
        }
      }

      // Mark all as enriched (even those that returned null — don't retry)
      for (const id of batch) {
        this.inFlightIds.delete(id);
        this.enrichedIds.add(id);
      }

      if (enrichments.size > 0 && this.config) {
        this.config.onEnriched(enrichments);
      }

      // Prevent enrichedIds from growing without bound
      this.pruneEnrichedIds();
    } catch (err) {
      console.error('[DetailEnricher] Batch fetch failed:', err);
      // Move failed IDs out of in-flight but mark as enriched to avoid retry storm
      for (const id of batch) {
        this.inFlightIds.delete(id);
        this.enrichedIds.add(id);
      }
    }

    // Cooldown before the next batch to stay under Steam's rate limit
    if (this.pendingQueue.length > 0) {
      this.timer = setTimeout(() => {
        this.processing = false;
        this.processBatch();
      }, BATCH_COOLDOWN_MS);
    } else {
      this.processing = false;
    }
  }
}

// Export singleton
export const detailEnricher = new DetailEnricher();
