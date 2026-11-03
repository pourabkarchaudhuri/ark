/**
 * Connector and route store of the AI router (1.0.97 B35), kept in main.
 *
 * Holds the connectors (Built-in llama.cpp, Ollama, Gemini, Azure OpenAI, Anthropic, OpenAI and
 * OpenAI-compatible servers), one route per role (chat, embeddings, reranker), the failure policy
 * and the last connection test per connector, in `ai-router.json` under userData.
 *
 * Keys:
 *  - encrypted with Electron safeStorage ("ss:" + base64), never in clear text on disk;
 *  - the store has has/set/clear and one main-only reader used to build the sidecar's environment;
 *    there is deliberately no getter that the renderer's IPC can reach;
 *  - the Gemini, Azure OpenAI and Anthropic keys already live in main-side safeStorage slots since
 *    B13 (settings-store.ts). They are adopted in place through `LegacyKeys` instead of being copied,
 *    so a key exists in exactly one place and the existing Settings key fields keep working.
 *
 * Everything that touches the disk or the OS is injected (`RouterStoreIo`), so the store is
 * unit-tested without Electron.
 */
import {
  AI_ROLES, BUILTIN_CONNECTOR_ID, DEFAULT_MODELS, DEFAULT_POLICY, KIND_NEEDS_KEY, connectorServes, defaultConnectorName,
  type AiRole, type Connector, type ConnectorKind, type ConnectorState, type ConnectorTestResult, type Route, type RoutePolicy, type Routes,
} from './types.js';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface RouterStoreIo {
  /** Persisted JSON text, or null when there is no file yet. */
  read(): string | null;
  write(data: string): void;
  now(): number;
  safeStorage: SafeStorageLike | null | undefined;
}

/** The three keys that predate the router and live in settings-store's encrypted slots. */
export type LegacySlot = 'googleAI' | 'azureOpenAI' | 'anthropic';

export interface LegacyKeys {
  get(slot: LegacySlot): string | null;
  set(slot: LegacySlot, key: string): void;
  clear(slot: LegacySlot): void;
}

export const LEGACY_SLOT_BY_CONNECTOR: Record<string, LegacySlot> = {
  gemini: 'googleAI',
  'azure-openai': 'azureOpenAI',
  anthropic: 'anthropic',
};

interface Persisted {
  version: 1;
  connectors: Connector[];
  routes: Partial<Routes>;
  policy: RoutePolicy;
  /** Encrypted keys of connectors that do not use a legacy slot, by connector id. */
  secrets: Record<string, string>;
  /** Identity of the embedding model the cached vectors were made with. */
  vectorsModel: string | null;
  /** Set while the embeddings route points at a different model than the cached vectors. */
  rebuild: { from: string; to: string } | null;
}

export interface BuiltinModels {
  chat: string;
  embeddings: string;
  reranker: string;
}

export interface ConnectorView extends Connector {
  hasKey: boolean;
  needsKey: boolean;
  state: ConnectorState;
  /** Roles this connector is routed for right now. */
  routedFor: AiRole[];
  /** Roles it could serve. */
  serves: AiRole[];
}

export interface RouterStateView {
  connectors: ConnectorView[];
  routes: Routes;
  policy: RoutePolicy;
  rebuild: { from: string; to: string } | null;
}

export type SetRouteResult = { ok: true; rebuild: { from: string; to: string } | null } | { ok: false; error: string };

export class RouterStore {
  private data: Persisted;
  private readonly listeners = new Set<() => void>();
  /** Decrypted keys, so OS decryption runs once per key. */
  private readonly memo = new Map<string, string>();

  constructor(
    private readonly io: RouterStoreIo,
    private readonly legacy: LegacyKeys,
    private readonly builtinModels: BuiltinModels,
  ) {
    this.data = this.load();
  }

  // ── Persistence ───────────────────────────────────────────────────────────────────────────

  private defaults(): Persisted {
    return {
      version: 1,
      connectors: [{ id: BUILTIN_CONNECTOR_ID, kind: 'builtin', name: defaultConnectorName('builtin') }],
      routes: {},
      policy: { ...DEFAULT_POLICY },
      secrets: {},
      vectorsModel: this.builtinModels.embeddings,
      rebuild: null,
    };
  }

  private load(): Persisted {
    const d = this.defaults();
    let raw: string | null = null;
    try { raw = this.io.read(); } catch { raw = null; }
    if (!raw) return d;
    try {
      const p = JSON.parse(raw) as Partial<Persisted>;
      if (!p || typeof p !== 'object' || p.version !== 1) return d;
      const connectors = Array.isArray(p.connectors) ? p.connectors.filter((c) => c && typeof c.id === 'string' && typeof c.kind === 'string') : [];
      if (!connectors.some((c) => c.id === BUILTIN_CONNECTOR_ID)) connectors.unshift(d.connectors[0]!);
      return {
        version: 1,
        connectors,
        routes: p.routes && typeof p.routes === 'object' ? p.routes : {},
        policy: { ...DEFAULT_POLICY, ...(p.policy ?? {}) },
        secrets: p.secrets && typeof p.secrets === 'object' ? p.secrets : {},
        vectorsModel: typeof p.vectorsModel === 'string' ? p.vectorsModel : d.vectorsModel,
        rebuild: p.rebuild && typeof p.rebuild.from === 'string' && typeof p.rebuild.to === 'string' ? p.rebuild : null,
      };
    } catch {
      return d;
    }
  }

  private save(): void {
    this.io.write(JSON.stringify(this.data, null, 2));
    for (const fn of this.listeners) {
      try { fn(); } catch { /* a listener must not break the store */ }
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── Reading ───────────────────────────────────────────────────────────────────────────────

  connectors(): Connector[] {
    return this.data.connectors.map((c) => ({ ...c }));
  }

  connector(id: string): Connector | undefined {
    const c = this.data.connectors.find((x) => x.id === id);
    return c ? { ...c } : undefined;
  }

  policy(): RoutePolicy {
    return { ...this.data.policy };
  }

  private defaultRoute(role: AiRole): Route {
    return { connectorId: BUILTIN_CONNECTOR_ID, model: this.builtinModels[role === 'chat' ? 'chat' : role === 'embeddings' ? 'embeddings' : 'reranker'] };
  }

  /** The effective route for a role; falls back to the built-in connector when the stored one is gone or cannot serve it. */
  route(role: AiRole): Route {
    const r = this.data.routes[role];
    const c = r ? this.data.connectors.find((x) => x.id === r.connectorId) : undefined;
    if (!r || !c || !connectorServes(c, role)) return this.defaultRoute(role);
    return { ...r };
  }

  routes(): Routes {
    return { chat: this.route('chat'), embeddings: this.route('embeddings'), reranker: this.route('reranker') };
  }

  /** Identity of the embedding model behind the current embeddings route (builtin: the plain model name). */
  embeddingIdentity(): string {
    const r = this.route('embeddings');
    const c = this.data.connectors.find((x) => x.id === r.connectorId);
    return !c || c.kind === 'builtin' ? this.builtinModels.embeddings : `${c.kind}:${r.model}`;
  }

  /** Identity of the built-in embedding model (what a built-in fallback would produce). */
  builtinEmbeddingIdentity(): string {
    return this.builtinModels.embeddings;
  }

  vectorsModel(): string | null {
    return this.data.vectorsModel;
  }

  rebuild(): { from: string; to: string } | null {
    return this.data.rebuild ? { ...this.data.rebuild } : null;
  }

  // ── Keys ──────────────────────────────────────────────────────────────────────────────────

  hasKey(connectorId: string): boolean {
    return this.getKey(connectorId) !== null;
  }

  /** Main process only (the sidecar environment, connection tests). Never reachable from IPC. */
  getKey(connectorId: string): string | null {
    const slot = LEGACY_SLOT_BY_CONNECTOR[connectorId];
    if (slot) return this.legacy.get(slot);
    const stored = this.data.secrets[connectorId];
    if (!stored) return null;
    const memo = this.memo.get(stored);
    if (memo !== undefined) return memo;
    try {
      const ss = this.io.safeStorage;
      if (!stored.startsWith('ss:') || !ss) return null;
      const plain = ss.decryptString(Buffer.from(stored.slice(3), 'base64'));
      this.memo.set(stored, plain);
      return plain;
    } catch {
      return null; // e.g. settings copied from another PC: the key has to be entered again
    }
  }

  setKey(connectorId: string, key: string): void {
    if (!this.data.connectors.some((c) => c.id === connectorId)) throw new Error('Unknown connector');
    if (connectorId === BUILTIN_CONNECTOR_ID) throw new Error('The built-in connector has no key');
    const slot = LEGACY_SLOT_BY_CONNECTOR[connectorId];
    if (slot) {
      this.legacy.set(slot, key);
    } else {
      const ss = this.io.safeStorage;
      if (!ss?.isEncryptionAvailable()) throw new Error('Secure key storage is not available on this PC');
      this.data.secrets[connectorId] = `ss:${ss.encryptString(key).toString('base64')}`;
    }
    // A new key invalidates the earlier test: the connector must prove itself again before it is routed.
    const c = this.data.connectors.find((x) => x.id === connectorId);
    if (c) delete c.test;
    this.save();
  }

  clearKey(connectorId: string): void {
    const slot = LEGACY_SLOT_BY_CONNECTOR[connectorId];
    if (slot) this.legacy.clear(slot);
    else delete this.data.secrets[connectorId];
    const c = this.data.connectors.find((x) => x.id === connectorId);
    if (c) delete c.test;
    this.unrouteConnector(connectorId, true);
    this.save();
  }

  // ── State for the UI ──────────────────────────────────────────────────────────────────────

  private stateOf(c: Connector, routedFor: AiRole[], hasKey: boolean): ConnectorState {
    if (c.kind === 'builtin') return 'live';
    const needsKey = KIND_NEEDS_KEY[c.kind];
    if (c.test && !c.test.ok) return 'fault';
    if (needsKey && !hasKey) return 'nokey';
    if (!c.test) return 'off';
    return routedFor.length > 0 ? 'live' : 'armed';
  }

  view(): RouterStateView {
    const routes = this.routes();
    const connectors = this.data.connectors.map((c): ConnectorView => {
      const routedFor = AI_ROLES.filter((r) => routes[r].connectorId === c.id);
      const hasKey = c.kind === 'builtin' ? false : this.hasKey(c.id);
      return {
        ...c,
        hasKey,
        needsKey: KIND_NEEDS_KEY[c.kind],
        routedFor,
        serves: AI_ROLES.filter((r) => connectorServes(c, r)),
        state: this.stateOf(c, routedFor, hasKey),
      };
    });
    return { connectors, routes, policy: this.policy(), rebuild: this.rebuild() };
  }

  /** "Armed": configured, key present when needed, and its last test passed. Re-checked on a schedule. */
  isArmed(c: Connector): boolean {
    if (c.kind === 'builtin' || c.enabled === false) return false;
    return c.test?.ok === true && (!KIND_NEEDS_KEY[c.kind] || this.hasKey(c.id));
  }

  // ── Changing ──────────────────────────────────────────────────────────────────────────────

  /** Add or update a connector. Its earlier test no longer applies when anything but the name changed. */
  upsertConnector(input: Omit<Connector, 'test'>): Connector {
    if (input.kind === 'builtin') throw new Error('The built-in connector cannot be changed');
    let id = input.id;
    if (!id) {
      if (input.kind !== 'openai-compatible') id = input.kind;
      else {
        let n = 1;
        while (this.data.connectors.some((c) => c.id === `compat-${n}`)) n++;
        id = `compat-${n}`;
      }
    }
    const existing = this.data.connectors.find((c) => c.id === id);
    if (existing && existing.kind !== input.kind) throw new Error('A connector cannot change its type');
    const next: Connector = { ...input, id };
    // Callers that do not mention the switch (the legacy chat bridge) leave a switched-off connector off.
    if (next.enabled === undefined && existing?.enabled === false) next.enabled = false;
    if (next.enabled !== false) delete next.enabled;
    if (existing) {
      const same = (['baseUrl', 'endpoint', 'deployment', 'apiVersion'] as const).every((k) => existing[k] === next[k])
        && JSON.stringify(existing.roles ?? []) === JSON.stringify(next.roles ?? []);
      if (same && existing.test) next.test = existing.test;
      if (same && existing.name === next.name && existing.enabled === next.enabled) return { ...existing }; // nothing changed: no write, no restart
      this.data.connectors[this.data.connectors.indexOf(existing)] = next;
      // A kept route must still be servable.
      for (const role of AI_ROLES) {
        const r = this.data.routes[role];
        if (r?.connectorId === id && !connectorServes(next, role)) this.unroute(role);
      }
      if (!same) this.unrouteConnector(id, false);
      // Switching a connector off takes it off every route at once; its settings, key and last test stay.
      else if (next.enabled === false && existing.enabled !== false) this.unrouteConnector(id, true);
    } else {
      this.data.connectors.push(next);
    }
    this.save();
    return { ...next };
  }

  removeConnector(id: string): boolean {
    if (id === BUILTIN_CONNECTOR_ID) return false;
    const idx = this.data.connectors.findIndex((c) => c.id === id);
    if (idx < 0) return false;
    this.clearKeyQuiet(id);
    this.data.connectors.splice(idx, 1);
    this.unrouteConnector(id, true);
    this.save();
    return true;
  }

  private clearKeyQuiet(id: string): void {
    const slot = LEGACY_SLOT_BY_CONNECTOR[id];
    if (slot) this.legacy.clear(slot);
    else delete this.data.secrets[id];
  }

  private unroute(role: AiRole): void {
    delete this.data.routes[role];
    if (role === 'embeddings') this.noteEmbeddingChange();
  }

  /** Put every role served by `id` back on the built-in connector. `all` also drops a half-done test result. */
  private unrouteConnector(id: string, all: boolean): void {
    for (const role of AI_ROLES) {
      if (this.data.routes[role]?.connectorId === id) this.unroute(role);
    }
    if (!all) {
      const c = this.data.connectors.find((x) => x.id === id);
      if (c) delete c.test;
    }
  }

  /** Raise or clear the "embedding model changed" flag after the embeddings route moved. */
  private noteEmbeddingChange(): void {
    const now = this.embeddingIdentity();
    const vectors = this.data.vectorsModel;
    if (vectors && now !== vectors) this.data.rebuild = { from: vectors, to: now };
    else this.data.rebuild = null;
  }

  /**
   * Point a role at a connector and model. A connector other than the built-in one must be able to
   * serve the role, be configured (key saved when it needs one) and have passed a connection test,
   * unless `force` (the legacy Settings chat-provider selector, which has no test step).
   */
  setRoute(role: AiRole, connectorId: string, model: string, opts: { force?: boolean } = {}): SetRouteResult {
    const c = this.data.connectors.find((x) => x.id === connectorId);
    if (!c) return { ok: false, error: 'Unknown connector.' };
    if (!connectorServes(c, role)) return { ok: false, error: `${c.name} cannot serve ${role}.` };
    if (c.enabled === false) return { ok: false, error: `${c.name} is switched off.` };
    let chosen = model.trim();
    if (c.kind !== 'builtin') {
      if (KIND_NEEDS_KEY[c.kind] && !this.hasKey(c.id)) return { ok: false, error: `Save a key for ${c.name} first.` };
      if (!opts.force && !c.test?.ok) return { ok: false, error: `Test ${c.name} first: a connector is only routed after a test passes.` };
      if (!chosen) chosen = (c.kind === 'azure-openai' ? c.deployment : DEFAULT_MODELS[c.kind][role]) ?? '';
      if (!chosen) return { ok: false, error: 'Pick a model for this route.' };
    } else {
      chosen = this.builtinModels[role];
    }
    this.data.routes[role] = { connectorId, model: chosen };
    if (role === 'embeddings') this.noteEmbeddingChange();
    this.save();
    return { ok: true, rebuild: this.rebuild() };
  }

  /** The user rebuilt the vectors (or kept the new model): the cached vectors now match the route. */
  acknowledgeRebuild(): void {
    this.data.vectorsModel = this.embeddingIdentity();
    this.data.rebuild = null;
    this.save();
  }

  setPolicy(policy: RoutePolicy): void {
    this.data.policy = { ...policy };
    this.save();
  }

  /** The role and model the next connection tests use (changes the generated config, so LiteLLM restarts once). */
  setTestModel(id: string, role: AiRole, model: string): boolean {
    const c = this.data.connectors.find((x) => x.id === id);
    if (!c || c.kind === 'builtin' || !connectorServes(c, role)) return false;
    if (c.testModel?.role === role && c.testModel.model === model) return true;
    c.testModel = { role, model };
    this.save();
    return true;
  }

  recordTest(id: string, result: ConnectorTestResult): void {
    const c = this.data.connectors.find((x) => x.id === id);
    if (!c) return;
    c.test = { ...result };
    this.save();
  }

  /**
   * A key changed outside the store (the Settings key fields write settings-store directly): drop
   * routes whose connector needs a key it no longer has, and forget tests that no longer apply.
   */
  reconcile(): boolean {
    let changed = false;
    for (const c of this.data.connectors) {
      if (c.kind === 'builtin' || !KIND_NEEDS_KEY[c.kind] || this.hasKey(c.id)) continue;
      const routed = AI_ROLES.some((r) => this.data.routes[r]?.connectorId === c.id);
      if (routed || c.test) {
        this.unrouteConnector(c.id, true);
        delete c.test;
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  /**
   * Adopt the keys that already exist in settings-store (B13): a connector row appears for each
   * key the user had saved, untested, so nothing is routed until it passes a test.
   */
  adoptLegacyKeys(): boolean {
    let changed = false;
    const adopt = (kind: ConnectorKind, slot: LegacySlot) => {
      if (this.data.connectors.some((c) => c.id === kind)) return;
      if (this.legacy.get(slot) === null) return;
      this.data.connectors.push({ id: kind, kind, name: defaultConnectorName(kind) });
      changed = true;
    };
    adopt('gemini', 'googleAI');
    adopt('anthropic', 'anthropic');
    // Azure also needs endpoint and deployment, which Settings sends with the first chat message.
    if (changed) this.save();
    return changed;
  }
}
