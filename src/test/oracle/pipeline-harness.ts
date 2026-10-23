/**
 * Drives the real reco worker pipeline inside vitest.
 *
 * The worker has no exports — its only entry is `self.onmessage`. In jsdom
 * `self` is the window, so importing the module registers the handler and we
 * can invoke it directly while capturing what it posts back. This lets tests
 * (and before/after comparisons between releases) run the full pipeline —
 * scoring, MMR, explanations, shelves, telemetry — on fixture libraries.
 */
import { vi } from 'vitest';
import type { RecoWorkerInput, RecoWorkerMessage, RecoWorkerResult } from '@/types/reco';

export async function runWorkerPipeline(input: RecoWorkerInput): Promise<RecoWorkerResult> {
  const messages: RecoWorkerMessage[] = [];
  const spy = vi.spyOn(self, 'postMessage').mockImplementation(((m: RecoWorkerMessage) => {
    messages.push(m);
  }) as unknown as typeof self.postMessage);
  try {
    await import('@/workers/reco.worker');
    const handler = (self as unknown as { onmessage: (e: { data: RecoWorkerInput }) => Promise<void> }).onmessage;
    if (typeof handler !== 'function') throw new Error('reco.worker did not register self.onmessage');
    // Deep-copy: the worker mutates its input (normalises arrays, sorts userGames, sets engagementPattern).
    await handler({ data: structuredClone(input) });
  } finally {
    spy.mockRestore();
  }
  const error = messages.find(m => m.type === 'error');
  if (error && error.type === 'error') throw new Error(`worker error: ${error.error}`);
  const result = messages.find((m): m is RecoWorkerResult => m.type === 'result');
  if (!result) throw new Error('worker posted no result');
  return result;
}

/** Minimal valid worker input for a library + candidate pool. */
export function baseWorkerInput(
  userGames: RecoWorkerInput['userGames'],
  candidates: RecoWorkerInput['candidates'],
  now: number,
  over: Partial<RecoWorkerInput> = {},
): RecoWorkerInput {
  return {
    userGames,
    candidates,
    now,
    currentHour: 20,
    embeddingCoverage: 0,
    dismissedGameIds: [],
    ...over,
  };
}
