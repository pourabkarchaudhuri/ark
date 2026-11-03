/**
 * Renderer-side shape of `window.aiRouter` (the AI router, 1.0.97 B35). Mirrors the state the
 * main process returns from `aiRouter:getState` (electron/ai-router/). No key ever appears here:
 * a connector only says whether one is saved.
 */
export type AiRole = 'chat' | 'embeddings' | 'reranker';
export type ConnectorKind = 'builtin' | 'ollama' | 'gemini' | 'azure-openai' | 'anthropic' | 'openai' | 'openai-compatible';
export type ConnectorState = 'live' | 'armed' | 'nokey' | 'fault' | 'off';

export interface AiConnectorTest {
  ok: boolean;
  at: number;
  latencyMs: number;
  role: AiRole;
  model: string;
  message: string;
}

export interface AiConnector {
  id: string;
  kind: ConnectorKind;
  name: string;
  baseUrl?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  roles?: AiRole[];
  /** False = switched off (kept, but on no route). Absent = on. */
  enabled?: boolean;
  test?: AiConnectorTest;
  testModel?: { role: AiRole; model: string };
  hasKey: boolean;
  needsKey: boolean;
  state: ConnectorState;
  routedFor: AiRole[];
  serves: AiRole[];
}

export interface AiRoutePolicy {
  onFail: 'show-error' | 'retry-once' | 'use-fallback';
  timeoutSec: 10 | 30 | 60;
  retries: 0 | 1 | 2;
  recheckMin: 0 | 30 | 120;
  testOnKeySave: boolean;
}

export interface AiRouterState {
  connectors: AiConnector[];
  routes: Record<AiRole, { connectorId: string; model: string }>;
  policy: AiRoutePolicy;
  /** Set while the embeddings route points at a different model than the cached vectors. */
  rebuild: { from: string; to: string } | null;
  status: {
    sidecar: { state: 'stopped' | 'starting' | 'ready' | 'failed'; lastError: string | null; restarts: number };
    runtimeAvailable: boolean;
    routedRoles: AiRole[];
    fault: { role: AiRole; message: string; at: number } | null;
  };
}

type Ok<T = object> = ({ success: true } & T) | { success: false; error: string };

export interface AiRouterApi {
  getState: () => Promise<AiRouterState>;
  /** Ask an Ollama or OpenAI-compatible server which models it serves. */
  fetchModels: (id: string) => Promise<Ok<{ models: string[] }>>;
  saveConnector: (input: Partial<AiConnector> & { kind: ConnectorKind }) => Promise<Ok>;
  removeConnector: (id: string) => Promise<Ok>;
  setKey: (input: { connectorId: string; key: string }) => Promise<Ok<{ test?: AiConnectorTest }>>;
  clearKey: (id: string) => Promise<Ok>;
  /** Test one connector; pass role and model for a server that has no default model. */
  test: (input: string | { connectorId: string; role?: AiRole; model?: string }) => Promise<Ok<{ test: AiConnectorTest }>>;
  testAll: () => Promise<Ok<{ tests: Record<string, AiConnectorTest> }>>;
  setRoute: (input: { role: AiRole; connectorId: string; model: string }) => Promise<Ok<{ rebuild: { from: string; to: string } | null }>>;
  setPolicy: (input: Partial<AiRoutePolicy>) => Promise<Ok>;
  acknowledgeEmbeddingRebuild: () => Promise<Ok>;
  recheckRuntime: () => Promise<AiRouterState>;
  onStateChanged: (callback: (state: AiRouterState) => void) => () => void;
}

declare global {
  interface Window {
    aiRouter?: AiRouterApi;
  }
}
