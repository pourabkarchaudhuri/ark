/**
 * Web Worker: Deduplication + Sorting
 *
 * Receives raw Game[] arrays, deduplicates across stores, pre-computes
 * numeric release timestamps, and sorts by date descending.
 * Offloads the heaviest CPU work off the main/render thread.
 *
 * Persistent worker: handles many requests across the session, routed by
 * `requestId` so concurrent calls don't collide. Caller is `use-dedup-worker.ts`.
 */

import { dedupSortAndStamp } from '@/services/dedup';

interface DedupRequest {
  requestId: number;
  games: unknown[];
}

interface DedupResponse {
  requestId: number;
  games: unknown[];
}

self.onmessage = (e: MessageEvent<DedupRequest>) => {
  const { requestId, games } = e.data;
  const result = dedupSortAndStamp(games as any[]);
  const response: DedupResponse = { requestId, games: result };
  self.postMessage(response);
};
