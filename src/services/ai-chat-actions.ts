/**
 * Library actions returned by an AI chat turn, shared by ai-chat-panel.tsx and useAIChat.ts.
 *
 * 'add' actions are applied immediately with the status normalized to a real GameStatus.
 * 'remove' actions are never applied here: they come back as pending removals that the UI shows
 * as a confirmation card, and only confirmAIChatRemovals (on the user's click) removes anything.
 * Third-party text the model reads (reviews, store pages, web search) must not be able to delete
 * library entries on its own.
 */

import type { LibraryAction, PendingRemoval } from '@/types/chat';
import type { CachedGameMeta, GameStatus } from '@/types/game';
import { normalizeGameStatus } from '@/lib/game-status-normalize';

export interface AIChatAddInput {
  gameId: string;
  steamAppId?: number;
  status: GameStatus;
  priority?: 'High' | 'Medium' | 'Low';
  cachedMeta?: CachedGameMeta;
}

export interface AIChatActionDeps {
  addToLibrary: (input: AIChatAddInput) => unknown;
  /** Resolve display metadata for a newly added game; falls back to { title: gameName, store }. */
  resolveCachedMeta?: (gameId: string) => Promise<CachedGameMeta | null | undefined>;
  /** Already-known title for a library game (used to label pending removals). */
  lookupName?: (gameId: string) => string | undefined;
  priority?: 'High' | 'Medium' | 'Low';
}

export interface AIChatActionResult {
  added: string[];
  pendingRemovals: PendingRemoval[];
}

/** Stable string id for an action: explicit gameId first, then steam-<appId>; '' when neither is valid. */
export function resolveActionGameId(action: LibraryAction): string {
  if (typeof action.gameId === 'string' && action.gameId.length > 0) return action.gameId;
  if (typeof action.appId === 'number' && Number.isFinite(action.appId) && action.appId > 0) return `steam-${action.appId}`;
  return '';
}

function fallbackMeta(gameId: string, gameName?: string): CachedGameMeta {
  const store = gameId.startsWith('epic-') ? 'epic' : 'steam';
  return { title: gameName || 'Unknown Game', store };
}

export async function applyAIChatActions(
  actions: readonly LibraryAction[] | undefined,
  deps: AIChatActionDeps,
): Promise<AIChatActionResult> {
  const added: string[] = [];
  const pendingRemovals: PendingRemoval[] = [];
  if (!actions || actions.length === 0) return { added, pendingRemovals };

  for (const action of actions) {
    const gameId = resolveActionGameId(action);
    if (!gameId) {
      console.warn('[AI Chat] Skipping action with invalid gameId/appId:', action);
      continue;
    }
    if (action.type === 'add') {
      try {
        let cachedMeta: CachedGameMeta;
        try {
          cachedMeta = (await deps.resolveCachedMeta?.(gameId)) ?? fallbackMeta(gameId, action.gameName);
        } catch {
          cachedMeta = fallbackMeta(gameId, action.gameName);
        }
        const steamAppId = gameId.startsWith('steam-') ? parseInt(gameId.slice(6), 10) : undefined;
        await deps.addToLibrary({
          gameId,
          steamAppId: typeof steamAppId === 'number' && !isNaN(steamAppId) ? steamAppId : undefined,
          status: normalizeGameStatus(action.status),
          ...(deps.priority ? { priority: deps.priority } : {}),
          cachedMeta,
        });
        added.push(gameId);
      } catch (e) {
        console.error('Failed to add game:', gameId, e);
      }
    } else if (action.type === 'remove') {
      if (pendingRemovals.some(r => r.gameId === gameId)) continue;
      pendingRemovals.push({
        gameId,
        gameName: action.gameName || deps.lookupName?.(gameId) || gameId,
      });
    }
  }
  return { added, pendingRemovals };
}

/** Apply removals the user confirmed. Returns the ids that were removed. */
export function confirmAIChatRemovals(
  removals: readonly PendingRemoval[] | undefined,
  removeFromLibrary: (gameId: string) => unknown,
): string[] {
  const removed: string[] = [];
  for (const r of removals ?? []) {
    try {
      removeFromLibrary(r.gameId);
      removed.push(r.gameId);
    } catch (e) {
      console.error('Failed to remove game:', r.gameId, e);
    }
  }
  return removed;
}
