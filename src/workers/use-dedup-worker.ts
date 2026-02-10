/**
 * Promise-based wrapper around the dedup-sort Web Worker.
 * Spawns a one-shot worker, posts the data, and resolves with the result.
 *
 * Falls back to main-thread dedup if workers are unavailable.
 */

import type { Game } from '@/types/game';
import { dedupSortAndStamp } from '@/services/dedup';

export function dedupSortInWorker(rawGames: Game[]): Promise<Game[]> {
  // Fallback for environments without Worker support (SSR, tests)
  if (typeof Worker === 'undefined') {
    return Promise.resolve(dedupSortAndStamp(rawGames));
  }

  return new Promise<Game[]>((resolve) => {
    try {
      const w = new Worker(
        new URL('./dedup-sort.worker.ts', import.meta.url),
        { type: 'module', name: 'Ark DedupSort Worker' },
      );
      w.onmessage = (e: MessageEvent<{ games: Game[] }>) => {
        resolve(e.data.games);
        w.terminate();
      };
      w.onerror = () => {
        // If the worker fails to load, fall back to main thread
        console.warn('[dedupSortInWorker] Worker failed, falling back to main thread');
        resolve(dedupSortAndStamp(rawGames));
        w.terminate();
      };
      w.postMessage({ games: rawGames });
    } catch {
      // Worker construction failed
      resolve(dedupSortAndStamp(rawGames));
    }
  });
}
