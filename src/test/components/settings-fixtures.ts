/**
 * Fakes shared by the Settings page tests (1.0.97 B37): an AI router state, a `window.aiRouter`
 * and a `window.localAi` with the calls recorded, so each page is tested against the real IPC
 * shapes without Electron.
 */
import { vi } from 'vitest';
import type { AiConnector, AiRouterState, AiRole } from '@/services/ai-router-types';
import type { LocalAiStatus } from '@/services/local-ai-types';

export const pass = { ok: true, at: 1, latencyMs: 120, role: 'chat' as AiRole, model: 'm', message: 'ok' };
export const fail = { ok: false, at: 1, latencyMs: 20, role: 'chat' as AiRole, model: 'm', message: 'Request failed with status 401 Unauthorized' };

export function builtinConnector(over: Partial<AiConnector> = {}): AiConnector {
  return {
    id: 'builtin', kind: 'builtin', name: 'Built-in (llama.cpp)', hasKey: false, needsKey: false, state: 'live',
    routedFor: ['chat', 'embeddings', 'reranker'], serves: ['chat', 'embeddings', 'reranker'], ...over,
  };
}

export function connector(kind: AiConnector['kind'], over: Partial<AiConnector> = {}): AiConnector {
  const names: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google Gemini', 'azure-openai': 'Azure OpenAI', ollama: 'Ollama', 'openai-compatible': 'Home server' };
  const serves: Record<string, AiRole[]> = {
    anthropic: ['chat'], openai: ['chat', 'embeddings'], gemini: ['chat', 'embeddings'], 'azure-openai': ['chat', 'embeddings'], ollama: ['chat', 'embeddings'], 'openai-compatible': ['chat', 'embeddings', 'reranker'],
  };
  return {
    id: kind === 'openai-compatible' ? 'compat-1' : kind, kind, name: names[kind] ?? kind,
    hasKey: kind !== 'ollama', needsKey: kind !== 'ollama' && kind !== 'openai-compatible', state: 'armed',
    routedFor: [], serves: serves[kind] ?? ['chat'], test: pass, ...over,
  };
}

export function routerState(over: Partial<AiRouterState> & { connectors?: AiConnector[] } = {}): AiRouterState {
  const connectors = over.connectors ?? [builtinConnector()];
  return {
    connectors,
    routes: {
      chat: { connectorId: 'builtin', model: 'gemma3:12b' },
      embeddings: { connectorId: 'builtin', model: 'snowflake-arctic-embed2' },
      reranker: { connectorId: 'builtin', model: 'bge-reranker-v2-m3' },
    },
    policy: { onFail: 'show-error', timeoutSec: 30, retries: 1, recheckMin: 30, testOnKeySave: true },
    rebuild: null,
    status: { sidecar: { state: 'ready', lastError: null, restarts: 0 }, runtimeAvailable: true, routedRoles: [], fault: null },
    ...over,
  };
}

/** Routes chat to `c` in a state (and marks `c` routed for chat). */
export function withChatRoute(state: AiRouterState, id: string, model: string): AiRouterState {
  return {
    ...state,
    routes: { ...state.routes, chat: { connectorId: id, model } },
    connectors: state.connectors.map((c) => ({ ...c, routedFor: [...c.routedFor.filter((r) => r !== 'chat'), ...(c.id === id ? (['chat'] as AiRole[]) : [])] })),
  };
}

export function installRouter(initial: AiRouterState) {
  let state = initial;
  const listeners = new Set<(s: AiRouterState) => void>();
  const api = {
    getState: vi.fn(async () => state),
    fetchModels: vi.fn(async () => ({ success: true as const, models: ['served-a', 'served-b'] })),
    saveConnector: vi.fn(async () => ({ success: true as const })),
    removeConnector: vi.fn(async () => ({ success: true as const })),
    setKey: vi.fn(async () => ({ success: true as const, test: pass })),
    clearKey: vi.fn(async () => ({ success: true as const })),
    test: vi.fn(async () => ({ success: true as const, test: pass })),
    testAll: vi.fn(async () => ({ success: true as const, tests: {} })),
    setRoute: vi.fn(async () => ({ success: true as const, rebuild: null })),
    setPolicy: vi.fn(async () => ({ success: true as const })),
    acknowledgeEmbeddingRebuild: vi.fn(async () => ({ success: true as const })),
    recheckRuntime: vi.fn(async () => state),
    onStateChanged: vi.fn((cb: (s: AiRouterState) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; }),
  };
  (window as unknown as { aiRouter?: unknown }).aiRouter = api;
  return {
    api,
    set(next: AiRouterState) { state = next; },
    push(next: AiRouterState) { state = next; for (const l of [...listeners]) l(next); },
  };
}

export function removeRouter() {
  delete (window as unknown as { aiRouter?: unknown }).aiRouter;
}

export function localAiStatus(over: Partial<LocalAiStatus> = {}): LocalAiStatus {
  const model = (id: string, role: LocalAiStatus['models'][number]['role'], auto: boolean, state: LocalAiStatus['models'][number]['state'] = 'ready') => ({
    id, role, label: id, file: `${id}.gguf`, auto, sizeBytes: 1e9, state, transferred: 0, pct: state === 'ready' ? 100 : 0, source: null, error: null,
  });
  return {
    backend: 'builtin',
    runtime: { available: true, build: 'b11780', roles: [] },
    models: [model('arctic-embed2', 'embed', true), model('bge-reranker', 'rerank', true), model('gemma3-12b', 'chat', false, 'missing')],
    modelsDir: 'C:/models', diskUsedBytes: 0, diskFreeBytes: null, paused: false, declined: false, compute: 'gpu', computeDevice: 'NVIDIA GeForce RTX 3070 Ti Laptop GPU', computeVramBytes: 1e9,
    chatModel: { id: 'gemma3-12b', label: 'gemma3', sizeBytes: 7e9 },
    externalOllama: { enabled: false, url: 'http://localhost:11434' },
    ...over,
  };
}

export function installLocalAi(status: LocalAiStatus = localAiStatus()) {
  let current = status;
  const listeners = new Set<(s: LocalAiStatus) => void>();
  const api = {
    status: vi.fn(async () => current),
    recheck: vi.fn(async () => current),
    retry: vi.fn(async () => current),
    pause: vi.fn(async () => current),
    continueWithout: vi.fn(async () => current),
    removeModels: vi.fn(async () => current),
    changeFolder: vi.fn(async () => ({ cancelled: true, status: current })),
    resetFolder: vi.fn(async () => current),
    downloadChat: vi.fn(async () => current),
    setExternalOllama: vi.fn(async ({ enabled }: { enabled: boolean }) => { current = { ...current, externalOllama: { ...current.externalOllama, enabled } }; return current; }),
    onStatusChanged: vi.fn((cb: (s: LocalAiStatus) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; }),
    onModelsSettled: vi.fn(() => () => {}),
  };
  (window as unknown as { localAi?: unknown }).localAi = api;
  return { api, push(next: LocalAiStatus) { current = next; for (const l of [...listeners]) l(next); } };
}

export function removeLocalAi() {
  delete (window as unknown as { localAi?: unknown }).localAi;
}

/** Let pending promises (the pages load several things on mount) settle. */
export async function settle(act: (fn: () => Promise<void>) => Promise<void>, rounds = 12) {
  await act(async () => { for (let i = 0; i < rounds; i++) await Promise.resolve(); });
}
