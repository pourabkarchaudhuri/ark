/**
 * The AI router state for the Settings pages (1.0.97 B37): loaded once, then kept current by the
 * `aiRouter:state-changed` push from main. Also the small naming helpers the pages share.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AiConnector, AiRole, AiRouterState, ConnectorKind } from '@/services/ai-router-types';

export const ROLE_LABEL: Record<AiRole, string> = { chat: 'Chat', embeddings: 'Embeddings', reranker: 'Reranker' };
/** What each role does, in the words the design uses ("Connectors that offer chat"). */
export const ROLE_NOUN: Record<AiRole, string> = { chat: 'chat', embeddings: 'embeddings', reranker: 'reranking' };
export const ROLES: readonly AiRole[] = ['chat', 'embeddings', 'reranker'];

/** LiteLLM provider prefix per connector kind (OpenAI-compatible servers speak the OpenAI API). */
export const LITELLM_PREFIX: Record<ConnectorKind, string> = {
  builtin: 'built-in/', ollama: 'ollama/', gemini: 'gemini/', 'azure-openai': 'azure/', anthropic: 'anthropic/', openai: 'openai/', 'openai-compatible': 'openai/',
};

export function litellmId(kind: ConnectorKind, model: string): string {
  return `${LITELLM_PREFIX[kind]}${model || '[model]'}`;
}

export function useAiRouter() {
  const [state, setState] = useState<AiRouterState | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    const api = window.aiRouter;
    if (!api) { setUnavailable(true); return null; }
    try {
      const s = await api.getState();
      setState(s);
      return s;
    } catch {
      setUnavailable(true);
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = window.aiRouter?.onStateChanged?.((s) => setState(s));
    return () => { off?.(); };
  }, [refresh]);

  return { state, refresh, unavailable };
}

/** The connector a role is routed to, when it is one and it still exists. */
export function routedConnector(state: AiRouterState | null, role: AiRole): AiConnector | null {
  const r = state?.routes[role];
  return state && r ? state.connectors.find((c) => c.id === r.connectorId) ?? null : null;
}

/** Short name for the sidebar and role tabs ("Anthropic", "Built-in (llama.cpp)"). */
export function routeName(state: AiRouterState | null, role: AiRole): string {
  return routedConnector(state, role)?.name ?? 'None';
}

/** Full route id for display, e.g. `anthropic/claude-sonnet-5-5`. */
export function routeId(state: AiRouterState | null, role: AiRole): string {
  const c = routedConnector(state, role);
  const r = state?.routes[role];
  return c && r ? litellmId(c.kind, r.model) : '';
}

/** Two-letter monogram on a connector node. */
export function monogram(c: Pick<AiConnector, 'kind' | 'name'>): string {
  switch (c.kind) {
    case 'builtin': return 'BI';
    case 'ollama': return 'OL';
    case 'gemini': return 'GE';
    case 'azure-openai': return 'AZ';
    case 'anthropic': return 'AN';
    case 'openai': return 'OA';
    default: return (c.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || 'OC').toUpperCase();
  }
}
