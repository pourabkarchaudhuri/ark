/**
 * The AI router (1.0.97 B35): decides, per role, whether a request goes to the built-in llama.cpp
 * runtime or through the bundled LiteLLM sidecar to the user's connector, and applies the
 * "when a route fails" policy.
 *
 *  - A role routed to the Built-in connector never touches Python: callers get `via: 'local'` and
 *    use the local backend (the built-in servers, or the user's own Ollama when that switch is on).
 *  - Any other connector goes through the sidecar: chat as an OpenAI-compatible endpoint for
 *    `ChatOpenAI`, embeddings via /v1/embeddings, reranking via /v1/rerank.
 *  - The Oracle never depends on Python being healthy: when the sidecar is down, embeddings and
 *    reranking fall back directly to the local backend (embeddings only when the cached vectors are
 *    from that same model, so two vector spaces are never mixed). Chat shows the router error.
 *  - Every failure is remembered as a router fault (design "StatesCore") for the Settings screen.
 *
 * All I/O is injected: the store, the sidecar, `fetch`, timers and the built-in probe.
 */
import {
  AI_ROLES, BUILTIN_CONNECTOR_ID, ROLE_ALIAS, connectorServes, testAlias,
  type AiRole, type Connector, type ConnectorTestResult, type Routes,
} from './types.js';
import { scrubSecrets } from '../secret-scrub.js';
import { buildLitellmConfig, testTarget, LITELLM_TIMEOUT_CEILING_SEC, LITELLM_TIMEOUT_MARGIN_SEC, type BuiltConfig } from './litellm-config.js';
import type { RouterStore, RouterStateView } from './connectors.js';
import type { LitellmSidecar, SidecarInfo, SidecarSpec, SidecarStatus } from '../litellm-sidecar.js';

export type RouterErrorCode = 'router_down' | 'not_configured' | 'http' | 'timeout' | 'network' | 'parse';

export class RouterError extends Error {
  constructor(message: string, readonly code: RouterErrorCode, readonly status?: number) {
    super(message);
    this.name = 'RouterError';
  }
}

export type ResolvedRoute =
  | { via: 'local' }
  | { via: 'router'; connector: Connector; model: string; alias: string };

export interface RouterFault {
  role: AiRole;
  message: string;
  at: number;
}

export interface EmbedOutcome {
  embeddings: (number[] | null)[];
  error: { kind: 'timeout' | 'network' | 'http' | 'parse' | 'empty'; status?: number; message: string } | null;
}

export interface RerankOutcome {
  rows: Array<{ index?: number; relevance_score?: number; score?: number }> | null;
  /** 'ok' | 'http_error' | 'network_error' | 'timeout' | 'cancelled' | 'router_down' */
  code: string;
  message: string;
  httpStatus?: number;
}

export interface ChatTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerName: string;
  connector: Connector;
  /** The failure policy for the chat client: its request timeout and its own retry count (the only retry layer). */
  timeoutMs: number;
  maxRetries: number;
}

export interface RouterStatus {
  sidecar: SidecarStatus;
  runtimeAvailable: boolean;
  routedRoles: AiRole[];
  fault: RouterFault | null;
}

export interface AiRouterDeps {
  store: RouterStore;
  sidecar: LitellmSidecar;
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  log?: (msg: string) => void;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (h: unknown) => void;
  /** Quick check of the built-in connector for "Test": starts the role's server and reports. */
  builtinProbe?: (role: AiRole) => Promise<{ ok: boolean; message: string; model: string }>;
  /** Called when the identity of the embedding model changes (the ANN index tag follows it). */
  onEmbeddingIdentity?: (identity: string) => void;
  /** True while Ark is in the tray, minimised, unfocused or a game runs: the scheduled re-check then waits. */
  isBackground?: () => boolean;
}

const EMBED_PER_TEXT_MS = 100;
/** No client deadline may reach LiteLLM's own timeout, or LiteLLM answers 408/5xx first and the loop retries a call that already ran. */
export const MAX_CLIENT_TIMEOUT_MS = (LITELLM_TIMEOUT_CEILING_SEC - LITELLM_TIMEOUT_MARGIN_SEC) * 1000;

function messageOf(text: string, status: number): string {
  try {
    const p = JSON.parse(text) as { error?: { message?: string } | string; detail?: string };
    const e = p.error;
    const msg = typeof e === 'string' ? e : e?.message ?? p.detail;
    if (msg) return String(msg).slice(0, 300);
  } catch { /* not JSON */ }
  return text.slice(0, 300) || `HTTP ${status}`;
}

/** Keep a provider's error text short and free of anything key-shaped before it reaches the UI or a log. */
export function scrubMessage(msg: string): string {
  return scrubSecrets(msg)
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

export class AiRouter {
  private readonly fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private fault: RouterFault | null = null;
  private timer: unknown = null;
  private timerMs = 0;
  private lastIdentity: string;
  private readonly listeners = new Set<() => void>();
  private testing = new Map<string, { sig: string; promise: Promise<ConnectorTestResult> }>();

  constructor(private readonly deps: AiRouterDeps) {
    this.fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? (() => undefined);
    this.lastIdentity = deps.store.embeddingIdentity();
    deps.store.onChange(() => this.onStoreChange());
    deps.sidecar.onChange(() => this.emit());
    // A restart after a crash rebuilds the config from the store as it is now (never from an old request).
    deps.sidecar.setSpecProvider?.(() => {
      const built = this.build();
      return built.config.model_list.length === 0 ? null : this.specOf(built);
    });
  }

  get store(): RouterStore { return this.deps.store; }
  get sidecar(): LitellmSidecar { return this.deps.sidecar; }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch { /* listeners must not break the router */ }
    }
  }

  // ── Resolution ────────────────────────────────────────────────────────────────────────────

  resolve(role: AiRole): ResolvedRoute {
    const route = this.deps.store.route(role);
    const c = this.deps.store.connector(route.connectorId);
    if (!c || c.kind === 'builtin' || !connectorServes(c, role)) return { via: 'local' };
    return { via: 'router', connector: c, model: route.model, alias: ROLE_ALIAS[role] };
  }

  chatUsesRouter(): boolean {
    return this.resolve('chat').via === 'router';
  }

  status(): RouterStatus {
    const routes = this.deps.store.routes();
    const built = this.build();
    return {
      sidecar: this.deps.sidecar.status(),
      runtimeAvailable: this.deps.sidecar.isRuntimeAvailable(),
      routedRoles: AI_ROLES.filter((r) => routes[r].connectorId !== BUILTIN_CONNECTOR_ID && built.routedRoles.includes(r)),
      fault: this.fault ? { ...this.fault } : null,
    };
  }

  state(): RouterStateView & { status: RouterStatus } {
    return { ...this.deps.store.view(), status: this.status() };
  }

  clearFault(): void {
    if (this.fault) { this.fault = null; this.emit(); }
  }

  private noteFault(role: AiRole, message: string): void {
    this.fault = { role, message: scrubMessage(message), at: this.now() };
    this.log(`[AI Router] fault (${role}): ${this.fault.message}`);
    this.emit();
  }

  // ── Sidecar access ────────────────────────────────────────────────────────────────────────

  private build(): BuiltConfig {
    return buildLitellmConfig({
      connectors: this.deps.store.connectors(),
      routes: this.deps.store.routes(),
      policy: this.deps.store.policy(),
      getKey: (id) => this.deps.store.getKey(id),
    });
  }

  private specOf(built: BuiltConfig, exact = false): SidecarSpec {
    return { config: built.config, env: built.env, hash: built.hash, routedHash: built.routedHash, exact };
  }

  /**
   * The sidecar serving the routed roles; errors become a RouterError with a message fit for the UI.
   * `exact` (connection tests) additionally needs the test alias of every connector in the running config.
   */
  async endpoint(opts: { exact?: boolean } = {}): Promise<SidecarInfo> {
    const built = this.build();
    try {
      return await this.deps.sidecar.ensure(this.specOf(built, opts.exact === true));
    } catch (err) {
      const msg = scrubMessage(err instanceof Error ? err.message : String(err));
      throw new RouterError(`The AI router is not running: ${msg}`, 'router_down');
    }
  }

  private onStoreChange(): void {
    const identity = this.deps.store.embeddingIdentity();
    if (identity !== this.lastIdentity) {
      this.lastIdentity = identity;
      try { this.deps.onEmbeddingIdentity?.(identity); } catch { /* informational */ }
    }
    this.syncTimer();
    // Routes, connectors or keys changed: a running sidecar gets the regenerated config now (or is
    // stopped when nothing needs it any more); a stopped one picks it up on the next request.
    const st = this.deps.sidecar.status().state;
    if (st === 'ready') {
      const built = this.build();
      if (built.config.model_list.length === 0) void this.deps.sidecar.stop();
      else if (built.routedHash !== this.deps.sidecar.status().routedHash) {
        // Only a change that a routed role depends on restarts LiteLLM. Saving a key, an address or a
        // test model of a connector nobody is routed to leaves the running process (and its requests) alone.
        void this.deps.sidecar.ensure(this.specOf(built)).catch((e) => {
          this.noteFault('chat', `Restart after a settings change failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    }
    this.emit();
  }

  // ── Chat ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Endpoint for `ChatOpenAI` when the chat route is not the built-in connector. Chat has no
   * fallback: a router that is down is reported to the user as it is.
   */
  async chatTarget(): Promise<ChatTarget | null> {
    const r = this.resolve('chat');
    if (r.via !== 'router') return null;
    const built = this.build();
    if (!built.routedRoles.includes('chat')) {
      throw new RouterError(`${r.connector.name} is not ready for chat: save its key and run Test in Settings.`, 'not_configured');
    }
    try {
      const info = await this.endpoint();
      const policy = this.deps.store.policy();
      return {
        baseUrl: `${info.baseUrl}/v1`, apiKey: info.masterKey, model: ROLE_ALIAS.chat,
        providerName: `${r.connector.name} (${r.model})`, connector: r.connector,
        timeoutMs: policy.timeoutSec * 1000, maxRetries: policy.retries + (policy.onFail === 'retry-once' ? 1 : 0),
      };
    } catch (err) {
      this.noteFault('chat', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // ── Embeddings and reranking ──────────────────────────────────────────────────────────────

  /**
   * Attempts per request. This loop is the only retry layer (LiteLLM's own `num_retries` is 0), so a
   * failing request costs `attempts` upstream calls, not `attempts x LiteLLM's retries`.
   */
  private attempts(): number {
    const p = this.deps.store.policy();
    return 1 + p.retries + (p.onFail === 'retry-once' ? 1 : 0);
  }

  /** The whole request, retries included, never waits longer than two timeouts. */
  private static readonly DEADLINE_TIMEOUTS = 2;

  /** One POST to the sidecar with the policy's timeout. Never throws: returns the failure. */
  private async post(
    path: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
    info?: SidecarInfo,
  ): Promise<{ kind: 'ok'; status: number; text: string } | { kind: 'timeout' | 'network' | 'cancelled' | 'router_down'; message: string }> {
    let sc = info;
    if (!sc) {
      try { sc = await this.endpoint(); } catch (err) { return { kind: 'router_down', message: err instanceof Error ? err.message : String(err) }; }
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs);
    const onCancel = () => ac.abort();
    if (signal?.aborted) ac.abort();
    else signal?.addEventListener('abort', onCancel, { once: true });
    try {
      const res = await this.fetchFn(`${sc.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sc.masterKey}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      return { kind: 'ok', status: res.status, text: await res.text() };
    } catch (err) {
      if (signal?.aborted) return { kind: 'cancelled', message: 'Cancelled' };
      const name = (err as { name?: string } | null)?.name;
      const reason = (ac.signal.reason as { name?: string } | undefined)?.name;
      if (reason === 'TimeoutError' || name === 'TimeoutError' || name === 'AbortError') {
        return { kind: 'timeout', message: `No response within ${Math.round(timeoutMs / 1000)}s` };
      }
      return { kind: 'network', message: scrubMessage(err instanceof Error ? err.message : String(err)) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCancel);
    }
  }

  private static retryable(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
  }

  /**
   * Embeddings. `local` embeds with the local backend; it is used when the route is the built-in
   * connector, and as the fallback when the route fails under the "use fallback" policy and the
   * cached vectors come from that same local model.
   */
  async embed(texts: string[], local: () => Promise<EmbedOutcome>, opts: { queryOnly?: boolean } = {}): Promise<EmbedOutcome> {
    const r = this.resolve('embeddings');
    if (r.via === 'local') return local();
    if (texts.length === 0) return { embeddings: [], error: null };
    const policy = this.deps.store.policy();
    const timeoutMs = Math.min(policy.timeoutSec * 1000 + texts.length * EMBED_PER_TEXT_MS, MAX_CLIENT_TIMEOUT_MS);
    const nulls = () => texts.map(() => null);
    let failure: NonNullable<EmbedOutcome['error']> = { kind: 'network', message: 'No attempt was made' };
    const deadline = this.now() + timeoutMs * AiRouter.DEADLINE_TIMEOUTS;
    for (let i = 0; i < this.attempts(); i++) {
      const left = deadline - this.now();
      if (i > 0 && left <= 0) break;
      const res = await this.post('/v1/embeddings', { model: r.alias, input: texts, encoding_format: 'float' }, i === 0 ? timeoutMs : Math.min(timeoutMs, left));
      if (res.kind !== 'ok') {
        failure = { kind: res.kind === 'timeout' ? 'timeout' : 'network', message: res.message };
        if (res.kind === 'router_down') break; // no point retrying a sidecar that did not start
        continue;
      }
      if (res.status >= 400) {
        failure = { kind: 'http', status: res.status, message: scrubMessage(messageOf(res.text, res.status)) };
        if (!AiRouter.retryable(res.status)) break;
        continue;
      }
      try {
        const parsed = JSON.parse(res.text) as { data?: Array<{ index?: number; embedding?: number[] }> };
        const data = parsed.data ?? [];
        if (data.length === 0) { failure = { kind: 'empty', status: res.status, message: 'No embeddings in the response' }; continue; }
        const out: (number[] | null)[] = nulls();
        data.forEach((row, k) => {
          const at = typeof row.index === 'number' ? row.index : k;
          if (at >= 0 && at < out.length && Array.isArray(row.embedding)) out[at] = row.embedding;
        });
        return { embeddings: out, error: null };
      } catch {
        failure = { kind: 'parse', status: res.status, message: 'Unparseable /v1/embeddings response' };
      }
    }
    this.noteFault('embeddings', failure.message);
    if (policy.onFail === 'use-fallback') {
      const store = this.deps.store;
      // While a rebuild for the new model is pending, the cache is being rewritten with the routed model's
      // vectors: a built-in vector written now would sit beside them in a different space (and dimension).
      // A query-only embed (nothing is written to the cache) may still use the built-in model against the old, still-current vectors.
      const sameSpace = (opts.queryOnly === true || store.rebuild() === null) && store.vectorsModel() === store.builtinEmbeddingIdentity();
      if (sameSpace) {
        this.log('[AI Router] embeddings route failed; using the built-in runtime (same vector space)');
        return local();
      }
      failure = { ...failure, message: `${failure.message} (the built-in fallback was skipped: it would mix two embedding models)` };
    }
    return { embeddings: nulls(), error: failure };
  }

  /** Reranking; same shape as the built-in backend's outcome so callers need no new parsing. */
  async rerank(
    query: string,
    documents: string[],
    opts: { timeoutMs?: number; signal?: AbortSignal } | undefined,
    local: () => Promise<RerankOutcome>,
  ): Promise<RerankOutcome> {
    const r = this.resolve('reranker');
    if (r.via === 'local') return local();
    if (opts?.signal?.aborted) return { rows: null, code: 'cancelled', message: 'Cancelled by the renderer' };
    const policy = this.deps.store.policy();
    const timeoutMs = Math.min(opts?.timeoutMs ?? policy.timeoutSec * 1000, policy.timeoutSec * 1000 * 3, MAX_CLIENT_TIMEOUT_MS);
    let failure: RerankOutcome = { rows: null, code: 'network_error', message: 'No attempt was made' };
    const deadline = this.now() + timeoutMs * AiRouter.DEADLINE_TIMEOUTS;
    for (let i = 0; i < this.attempts(); i++) {
      const left = deadline - this.now();
      if (i > 0 && left <= 0) break;
      const res = await this.post('/v1/rerank', { model: r.alias, query, documents, top_n: documents.length }, i === 0 ? timeoutMs : Math.min(timeoutMs, left), opts?.signal);
      if (res.kind !== 'ok') {
        if (res.kind === 'cancelled') return { rows: null, code: 'cancelled', message: 'Cancelled by the renderer' };
        failure = { rows: null, code: res.kind === 'timeout' ? 'timeout' : res.kind === 'router_down' ? 'router_down' : 'network_error', message: res.message };
        if (res.kind === 'router_down') break;
        continue;
      }
      if (res.status >= 400) {
        failure = { rows: null, code: 'http_error', message: `Rerank HTTP ${res.status}: ${scrubMessage(messageOf(res.text, res.status))}`, httpStatus: res.status };
        if (!AiRouter.retryable(res.status)) break;
        continue;
      }
      try {
        const parsed = JSON.parse(res.text) as { results?: RerankOutcome['rows'] };
        return { rows: parsed.results ?? [], code: 'ok', message: 'ok', httpStatus: res.status };
      } catch {
        failure = { rows: null, code: 'http_error', message: 'Unparseable /v1/rerank response', httpStatus: res.status };
      }
    }
    this.noteFault('reranker', failure.message);
    // Reranking is per query, so the local reranker is always a safe fallback.
    if (policy.onFail === 'use-fallback') {
      this.log('[AI Router] rerank route failed; using the built-in reranker');
      return local();
    }
    return failure;
  }

  // ── Connection tests ──────────────────────────────────────────────────────────────────────

  /**
   * Test one connector: a real request through the same path the route would use, with the model
   * the route (or the connector's default) names. Result, latency and model are stored with the
   * connector. Concurrent tests of one connector share a run.
   */
  test(connectorId: string, opts: { role?: AiRole; model?: string } = {}): Promise<ConnectorTestResult> {
    const running = this.testing.get(connectorId);
    // A run started for another address / key / model is not the answer for the connector as it is now.
    if (running && running.sig === this.configSignature(connectorId)) return running.promise;
    if (opts.role && opts.model) this.deps.store.setTestModel(connectorId, opts.role, opts.model);
    const entry: { sig: string; promise: Promise<ConnectorTestResult> } = { sig: this.configSignature(connectorId), promise: null as never };
    entry.promise = this.runTest(connectorId).finally(() => {
      if (this.testing.get(connectorId) === entry) this.testing.delete(connectorId);
    });
    this.testing.set(connectorId, entry);
    return entry.promise;
  }

  /**
   * Everything a connection test depends on (the connector without its stored result, and its key), so a
   * test that finishes after an edit or a re-key is recognised as being about a configuration that is gone.
   * Held in memory only, never logged.
   */
  private configSignature(connectorId: string): string {
    const c = this.deps.store.connector(connectorId);
    if (!c) return 'missing';
    const { test: _test, ...rest } = c as Connector & { test?: unknown };
    void _test;
    return JSON.stringify([rest, this.deps.store.getKey(connectorId)]);
  }

  private async runTest(connectorId: string, opts: { routedRole?: AiRole } = {}): Promise<ConnectorTestResult> {
    const store = this.deps.store;
    const c = store.connector(connectorId);
    const sigAtStart = this.configSignature(connectorId);
    const t0 = this.now();
    const done = (partial: Pick<ConnectorTestResult, 'ok' | 'message'> & Partial<ConnectorTestResult>): ConnectorTestResult => {
      const result: ConnectorTestResult = {
        role: 'chat', model: '', latencyMs: this.now() - t0, ...partial, at: this.now(),
      };
      result.message = scrubMessage(result.message);
      // A result for an address / key that was edited meanwhile would arm (and unlock routing for) the new one.
      if (c && c.kind !== 'builtin' && this.configSignature(connectorId) === sigAtStart) store.recordTest(connectorId, result);
      return result;
    };
    if (!c) return done({ ok: false, message: 'Unknown connector.' });
    if (c.kind === 'builtin') {
      const probe = this.deps.builtinProbe;
      if (!probe) return done({ ok: true, message: 'The built-in runtime starts on demand.' });
      // Every role is checked, so a missing embedding or reranker model is not hidden behind a ready chat one (or the reverse).
      const outs: Array<{ role: AiRole; ok: boolean; message: string; model: string }> = [];
      for (const role of AI_ROLES) {
        const out = await probe(role).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e), model: '' }));
        outs.push({ role, ...out });
      }
      const bad = outs.filter((o) => !o.ok);
      if (bad.length === 0) return done({ ok: true, message: outs[0]!.message, role: outs[0]!.role, model: outs[0]!.model });
      const message = [...new Set(bad.map((o) => o.message))].join(' ');
      return done({ ok: false, message, role: bad[0]!.role, model: bad[0]!.model });
    }
    const routes: Routes = store.routes();
    // A scheduled re-check goes through the route itself (already in the running config), so it needs no restart.
    const target = opts.routedRole ? { role: opts.routedRole, model: routes[opts.routedRole].model } : testTarget(c, routes);
    if (!target) return done({ ok: false, message: 'Pick a model first: this connector has no default.' });
    const built = this.build();
    const alias = opts.routedRole ? ROLE_ALIAS[opts.routedRole] : testAlias(c.id);
    if (!built.config.model_list.some((m) => m.model_name === alias)) {
      return done({ ok: false, ...target, message: c.test || store.hasKey(c.id) ? 'The connector is not fully configured.' : 'No key saved.' });
    }
    const timeoutMs = store.policy().timeoutSec * 1000;
    let info: SidecarInfo;
    try {
      if (opts.routedRole) {
        const running = this.deps.sidecar.peek();
        if (!running) return done({ ok: false, ...target, message: 'The AI router is not running.' });
        info = running;
      } else {
        info = await this.endpoint({ exact: true });
      }
    } catch (err) {
      return done({ ok: false, ...target, message: err instanceof Error ? err.message : String(err) });
    }
    const { path, body } = target.role === 'chat'
      ? { path: '/v1/chat/completions', body: { model: alias, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_tokens: 16 } }
      : target.role === 'embeddings'
        ? { path: '/v1/embeddings', body: { model: alias, input: ['ping'] } }
        : { path: '/v1/rerank', body: { model: alias, query: 'ping', documents: ['pong', 'ping'] } };
    const res = await this.post(path, body, timeoutMs, undefined, info);
    if (res.kind !== 'ok') return done({ ok: false, ...target, message: res.message });
    if (res.status === 401 || res.status === 403) return done({ ok: false, ...target, message: `Key rejected (${res.status})` });
    if (res.status >= 400) return done({ ok: false, ...target, message: messageOf(res.text, res.status) });
    return done({ ok: true, ...target, message: `Connected: ${target.model}` });
  }

  /** Test every connector that is configured (keys saved) plus the built-in one. */
  async testAll(): Promise<Record<string, ConnectorTestResult>> {
    const out: Record<string, ConnectorTestResult> = {};
    for (const c of this.deps.store.connectors()) {
      const needsKey = this.deps.store.view().connectors.find((v) => v.id === c.id)?.needsKey;
      if (c.kind !== 'builtin' && needsKey && !this.deps.store.hasKey(c.id)) continue;
      out[c.id] = await this.test(c.id);
    }
    return out;
  }

  // ── Scheduled re-check (armed connectors only) ────────────────────────────────────────────

  startScheduler(): void {
    this.syncTimer();
  }

  stopScheduler(): void {
    if (this.timer !== null) (this.deps.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>)))(this.timer);
    this.timer = null;
    this.timerMs = 0;
  }

  private syncTimer(): void {
    const minutes = this.deps.store.policy().recheckMin;
    const ms = minutes * 60_000;
    if (ms === this.timerMs && (this.timer !== null || ms === 0)) return;
    this.stopScheduler();
    if (ms === 0) return;
    const set = this.deps.setIntervalFn ?? ((fn, t) => {
      const h = setInterval(fn, t);
      (h as { unref?: () => void }).unref?.();
      return h;
    });
    this.timerMs = ms;
    this.timer = set(() => { void this.recheckArmed(); }, ms);
  }

  /**
   * One scheduled pass: re-test the connectors that are armed AND routed, through the route's own alias
   * on the sidecar that is already running. It never starts LiteLLM, never touches a connector nobody is
   * routed to (no paid request for it), and waits while Ark is in the tray, unfocused or a game runs.
   */
  async recheckArmed(): Promise<string[]> {
    const tested: string[] = [];
    if (this.deps.isBackground?.()) return tested;
    if (!this.deps.sidecar.peek()) return tested;
    const routes = this.deps.store.routes();
    for (const c of this.deps.store.connectors()) {
      if (!this.deps.store.isArmed(c)) continue;
      const role = AI_ROLES.find((r) => routes[r].connectorId === c.id && connectorServes(c, r));
      if (!role) continue;
      if (this.deps.isBackground?.() || !this.deps.sidecar.peek()) break;
      const res = await this.runTest(c.id, { routedRole: role });
      tested.push(c.id);
      if (!res.ok) this.noteFault(res.role, `${c.name}: ${res.message}`);
    }
    return tested;
  }

  // ── Embedding model change ────────────────────────────────────────────────────────────────

  /** Identity of the embedding model behind the route (also the ANN index's model tag). */
  embeddingIdentity(): string {
    return this.deps.store.embeddingIdentity();
  }

  /** The cached vectors were rebuilt (or deliberately kept) for the current embeddings route. */
  acknowledgeEmbeddingRebuild(): void {
    this.deps.store.acknowledgeRebuild();
  }
}
