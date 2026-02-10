/**
 * Web Worker: Deduplication + Sorting
 *
 * Receives raw Game[] arrays, deduplicates across stores, pre-computes
 * numeric release timestamps, and sorts by date descending.
 * Offloads the heaviest CPU work off the main/render thread.
 */

import { dedupSortAndStamp } from '@/services/dedup';

self.onmessage = (e: MessageEvent<{ games: unknown[] }>) => {
  const { games } = e.data;
  const result = dedupSortAndStamp(games as any[]);
  self.postMessage({ games: result });
};
