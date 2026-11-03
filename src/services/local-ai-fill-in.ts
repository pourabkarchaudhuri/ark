/**
 * Fill-in after the built-in AI models finished downloading (1.0.97 B36).
 *
 * Ark starts without embeddings while the Oracle models download in the background. When main
 * says the queue drained, the splash's catalog pipeline is started (it was skipped at boot because
 * the embedder was not there yet) and the cached "unavailable" verdict is dropped so every other
 * caller probes again. Lives for the window's lifetime, so it still works after the splash is gone.
 */
import { embeddingService } from '@/services/embedding-service';
import './local-ai-types';

let starter: (() => void) | null = null;
let subscribed = false;

/** The splash registers its pipeline start here (idempotent on its side). */
export function registerCatalogPipelineStarter(fn: () => void): void {
  starter = fn;
}

export async function handleModelsSettled(data: { embeddingReady: boolean }): Promise<boolean> {
  if (!data?.embeddingReady) return false;
  embeddingService.clearUnavailableVerdict();
  const available = await embeddingService.isAvailable().catch(() => false);
  if (available) starter?.();
  return available;
}

/** Subscribe once per window. */
export function initLocalAiFillIn(): void {
  if (subscribed || typeof window === 'undefined' || !window.localAi?.onModelsSettled) return;
  subscribed = true;
  window.localAi.onModelsSettled((data) => { void handleModelsSettled(data); });
}

/** Test seam. */
export function __resetLocalAiFillInForTests(): void {
  starter = null;
  subscribed = false;
}
