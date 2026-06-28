/**
 * Promise-based wrapper around the dedup-sort Web Worker.
 *
 * Maintains a SINGLETON persistent worker for the session — the previous
 * implementation spawned + terminated a fresh worker per call (~150-300ms
 * overhead each time for the spawn + structured-clone). Now the worker stays
 * alive and routes concurrent requests by requestId.
 *
 * Falls back to main-thread dedup if Worker is unavailable (SSR/tests) or if
 * the worker dies — next call lazily respawns.
 */

import type { Game } from '@/types/game';
import { dedupSortAndStamp } from '@/services/dedup';

interface PendingRequest {
  resolve: (games: Game[]) => void;
  rawGames: Game[];
}

let workerInstance: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function spawnWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    const w = new Worker(
      new URL('./dedup-sort.worker.ts', import.meta.url),
      { type: 'module', name: 'Ark DedupSort Worker' },
    );
    w.onmessage = (e: MessageEvent<{ requestId: number; games: Game[] }>) => {
      const req = pending.get(e.data.requestId);
      if (!req) return;
      pending.delete(e.data.requestId);
      req.resolve(e.data.games);
    };
    w.onerror = () => {
      // Worker died — drain all pending requests to the main-thread fallback,
      // and null the singleton so the next call lazily respawns.
      console.warn('[dedupSortInWorker] Worker died, falling back to main thread for pending requests');
      for (const [, req] of pending) {
        req.resolve(dedupSortAndStamp(req.rawGames));
      }
      pending.clear();
      try { w.terminate(); } catch { /* already dead */ }
      if (workerInstance === w) workerInstance = null;
    };
    return w;
  } catch {
    return null;
  }
}

function getWorker(): Worker | null {
  if (!workerInstance) workerInstance = spawnWorker();
  return workerInstance;
}

export function dedupSortInWorker(rawGames: Game[]): Promise<Game[]> {
  const w = getWorker();
  if (!w) {
    // Fallback when Worker unsupported or spawn failed.
    return Promise.resolve(dedupSortAndStamp(rawGames));
  }

  return new Promise<Game[]>((resolve) => {
    const requestId = nextRequestId++;
    pending.set(requestId, { resolve, rawGames });
    try {
      w.postMessage({ requestId, games: rawGames });
    } catch {
      pending.delete(requestId);
      resolve(dedupSortAndStamp(rawGames));
    }
  });
}

/**
 * Terminate the persistent worker (test cleanup / app teardown).
 * The next dedupSortInWorker call will lazily respawn.
 */
export function shutdownDedupWorker(): void {
  if (workerInstance) {
    try { workerInstance.terminate(); } catch { /* ignore */ }
    workerInstance = null;
  }
  pending.clear();
}
