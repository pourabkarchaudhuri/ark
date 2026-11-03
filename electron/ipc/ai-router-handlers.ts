/**
 * IPC for the AI router (1.0.97 B35): connectors, routes, the failure policy, connection tests,
 * the router status and the embedding rebuild flag. The renderer sees connector settings and
 * whether a key exists; it can set or clear a key but never read one back.
 *
 * The controller is plain code over injected dependencies so its behaviour (validation, the test
 * gate, test-on-key-save) is unit-tested without Electron; `register` only wires it to ipcMain and
 * pushes `aiRouter:state-changed` to the window.
 */
import { createRequire } from 'node:module';
import { logger } from '../safe-logger.js';
import { getAiRouter } from '../ai-router/service.js';
import type { AiRouter } from '../ai-router/router.js';
import {
  failed, isAiRole, validateModelName, validateConnectorInput, validateKeyInput, validatePolicyInput, validateRouteInput, isConnectorId,
  BUILTIN_CONNECTOR_ID, type AiRole, type ConnectorTestResult,
} from '../ai-router/types.js';

const require = createRequire(import.meta.url);

type Result<T = object> = ({ success: true } & T) | { success: false; error: string };

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Models a server reports about itself. Anything that does not look like a model name is left out. */
export function parseServedModels(kind: 'ollama' | 'openai-compatible', body: unknown): string[] {
  const o = (body && typeof body === 'object' ? body : {}) as { models?: unknown; data?: unknown };
  const rows = kind === 'ollama' ? o.models : o.data;
  if (!Array.isArray(rows)) return [];
  const names = rows.map((r) => {
    const row = (r && typeof r === 'object' ? r : {}) as { name?: unknown; id?: unknown };
    return kind === 'ollama' ? row.name : row.id;
  });
  const out: string[] = [];
  for (const n of names) {
    const v = validateModelName(n);
    if (!failed(v) && !out.includes(v.value)) out.push(v.value);
    if (out.length >= 200) break;
  }
  return out;
}

export class AiRouterController {
  constructor(
    private readonly router: () => AiRouter,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init) as ReturnType<FetchLike>,
  ) {}

  /** "Fetch from server": ask an Ollama or OpenAI-compatible server which models it serves. */
  async fetchModels(id: unknown): Promise<Result<{ models: string[] }>> {
    if (!isConnectorId(id)) return { success: false, error: 'Unknown connector.' };
    const store = this.router().store;
    const c = store.connector(id);
    if (!c) return { success: false, error: 'Unknown connector.' };
    if ((c.kind !== 'ollama' && c.kind !== 'openai-compatible') || !c.baseUrl) return { success: false, error: 'This connector has no server to ask.' };
    const headers: Record<string, string> = { Accept: 'application/json' };
    const key = c.kind === 'openai-compatible' ? store.getKey(c.id) : null;
    if (key) headers.Authorization = `Bearer ${key}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await this.fetchImpl(c.kind === 'ollama' ? `${c.baseUrl}/api/tags` : `${c.baseUrl}/models`, { headers, signal: ctl.signal });
      if (!res.ok) return { success: false, error: `The server answered ${res.status}.` };
      const models = parseServedModels(c.kind, await res.json());
      return models.length > 0 ? { success: true, models } : { success: false, error: 'The server did not list any models.' };
    } catch {
      return { success: false, error: 'Could not reach the server.' };
    } finally {
      clearTimeout(timer);
    }
  }

  getState() {
    return this.router().state();
  }

  saveConnector(input: unknown): Result {
    const v = validateConnectorInput(input);
    if (failed(v)) return { success: false, error: v.error };
    try {
      this.router().store.upsertConnector(v.value);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Could not save the connector.' };
    }
  }

  removeConnector(id: unknown): Result {
    if (!isConnectorId(id) || id === BUILTIN_CONNECTOR_ID) return { success: false, error: 'That connector cannot be removed.' };
    return this.router().store.removeConnector(id) ? { success: true } : { success: false, error: 'Unknown connector.' };
  }

  /** Save a key. With "test when a key is saved" on, the connection is tested right away and the result returned. */
  async setKey(input: unknown): Promise<Result<{ test?: ConnectorTestResult }>> {
    const o = (input && typeof input === 'object' ? input : {}) as { connectorId?: unknown; key?: unknown };
    if (!isConnectorId(o.connectorId) || o.connectorId === BUILTIN_CONNECTOR_ID) return { success: false, error: 'Unknown connector.' };
    const key = validateKeyInput(o.key);
    if (failed(key)) return { success: false, error: key.error };
    const router = this.router();
    try {
      router.store.setKey(o.connectorId, key.value);
    } catch (err) {
      logger.error('[AI Router] saving a key failed:', err instanceof Error ? err.message : err);
      return { success: false, error: err instanceof Error ? err.message : 'Could not save the key.' };
    }
    if (!router.store.policy().testOnKeySave) return { success: true };
    return { success: true, test: await router.test(o.connectorId) };
  }

  clearKey(id: unknown): Result {
    if (!isConnectorId(id) || id === BUILTIN_CONNECTOR_ID) return { success: false, error: 'Unknown connector.' };
    try {
      this.router().store.clearKey(id);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Could not remove the key.' };
    }
  }

  /** `id`, or `{ connectorId, role, model }` to test with a model the connector has no default for. */
  async test(input: unknown): Promise<Result<{ test: ConnectorTestResult }>> {
    const o = (input && typeof input === 'object' ? input : { connectorId: input }) as { connectorId?: unknown; role?: unknown; model?: unknown };
    if (!isConnectorId(o.connectorId)) return { success: false, error: 'Unknown connector.' };
    if (!this.router().store.connector(o.connectorId)) return { success: false, error: 'Unknown connector.' };
    let opts: { role?: AiRole; model?: string } = {};
    if (o.role !== undefined || o.model !== undefined) {
      const model = validateModelName(o.model);
      if (!isAiRole(o.role) || failed(model)) return { success: false, error: 'Pick a role and a valid model to test with.' };
      opts = { role: o.role, model: model.value };
    }
    return { success: true, test: await this.router().test(o.connectorId, opts) };
  }

  async testAll(): Promise<Result<{ tests: Record<string, ConnectorTestResult> }>> {
    return { success: true, tests: await this.router().testAll() };
  }

  setRoute(input: unknown): Result<{ rebuild: { from: string; to: string } | null }> {
    const v = validateRouteInput(input);
    if (failed(v)) return { success: false, error: v.error };
    const res = this.router().store.setRoute(v.value.role, v.value.connectorId, v.value.model);
    return 'error' in res ? { success: false, error: res.error } : { success: true, rebuild: res.rebuild };
  }

  setPolicy(input: unknown): Result {
    const store = this.router().store;
    const v = validatePolicyInput(input, store.policy());
    if (failed(v)) return { success: false, error: v.error };
    store.setPolicy(v.value);
    return { success: true };
  }

  /** The cached vectors were rebuilt (or kept on purpose) for the new embeddings model. */
  acknowledgeEmbeddingRebuild(): Result {
    this.router().acknowledgeEmbeddingRebuild();
    return { success: true };
  }

  /** "Re-check": clear a failed sidecar and a remembered fault so the next request starts fresh. */
  recheckRuntime() {
    const router = this.router();
    router.sidecar.reset();
    router.clearFault();
    return router.state();
  }
}

export function register(
  getMainWindow: () => { webContents?: { send: (channel: string, ...args: unknown[]) => void } } | null,
  controller: AiRouterController = new AiRouterController(getAiRouter),
): void {
  const { ipcMain } = require('electron') as typeof import('electron');
  const wrap = <T>(name: string, fn: (...args: any[]) => Promise<T> | T) => async (_event: unknown, ...args: any[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      logger.warn(`[AI Router] ${name} failed:`, err instanceof Error ? err.message : err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  };
  ipcMain.handle('aiRouter:fetchModels', wrap('fetchModels', (id: unknown) => controller.fetchModels(id)));
  ipcMain.handle('aiRouter:getState', wrap('getState', () => controller.getState()));
  ipcMain.handle('aiRouter:saveConnector', wrap('saveConnector', (input: unknown) => controller.saveConnector(input)));
  ipcMain.handle('aiRouter:removeConnector', wrap('removeConnector', (id: unknown) => controller.removeConnector(id)));
  ipcMain.handle('aiRouter:setKey', wrap('setKey', (input: unknown) => controller.setKey(input)));
  ipcMain.handle('aiRouter:clearKey', wrap('clearKey', (id: unknown) => controller.clearKey(id)));
  ipcMain.handle('aiRouter:test', wrap('test', (id: unknown) => controller.test(id)));
  ipcMain.handle('aiRouter:testAll', wrap('testAll', () => controller.testAll()));
  ipcMain.handle('aiRouter:setRoute', wrap('setRoute', (input: unknown) => controller.setRoute(input)));
  ipcMain.handle('aiRouter:setPolicy', wrap('setPolicy', (input: unknown) => controller.setPolicy(input)));
  ipcMain.handle('aiRouter:acknowledgeEmbeddingRebuild', wrap('acknowledgeEmbeddingRebuild', () => controller.acknowledgeEmbeddingRebuild()));
  ipcMain.handle('aiRouter:recheckRuntime', wrap('recheckRuntime', () => controller.recheckRuntime()));

  // Push the state to the window whenever a connector, route, test or the sidecar changes.
  let pending: ReturnType<typeof setTimeout> | null = null;
  getAiRouter().onChange(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      try { getMainWindow()?.webContents?.send('aiRouter:state-changed', controller.getState()); } catch { /* window closed */ }
    }, 100);
  });
}
