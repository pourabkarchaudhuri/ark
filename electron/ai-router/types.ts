/**
 * AI router data model (1.0.97 B35): connectors (where a model comes from), routes (which
 * connector and model serves each role) and the policy for when a route fails.
 *
 * Shared by the main-process router and its IPC; the renderer gets the same shapes (without any key
 * material) from `aiRouter:getState`. Pure types and validators, no Electron import.
 */

export type AiRole = 'chat' | 'embeddings' | 'reranker';
export const AI_ROLES: readonly AiRole[] = ['chat', 'embeddings', 'reranker'];

export type ConnectorKind = 'builtin' | 'ollama' | 'gemini' | 'azure-openai' | 'anthropic' | 'openai' | 'openai-compatible';
export const CONNECTOR_KINDS: readonly ConnectorKind[] = ['builtin', 'ollama', 'gemini', 'azure-openai', 'anthropic', 'openai', 'openai-compatible'];

/** The built-in llama.cpp connector: always present, default for all three roles. */
export const BUILTIN_CONNECTOR_ID = 'builtin';

/** Roles a kind can serve. "OpenAI-compatible server" serves the roles its connector lists. */
export const KIND_ROLES: Record<ConnectorKind, readonly AiRole[]> = {
  builtin: ['chat', 'embeddings', 'reranker'],
  ollama: ['chat', 'embeddings'],
  gemini: ['chat', 'embeddings'],
  'azure-openai': ['chat', 'embeddings'],
  anthropic: ['chat'],
  openai: ['chat', 'embeddings'],
  'openai-compatible': ['chat', 'embeddings', 'reranker'],
};

/** Kinds that cannot work without a saved key (an OpenAI-compatible server's key is optional). */
export const KIND_NEEDS_KEY: Record<ConnectorKind, boolean> = {
  builtin: false, ollama: false, gemini: true, 'azure-openai': true, anthropic: true, openai: true, 'openai-compatible': false,
};

/** Model each kind starts with for a role (editable on the route). Empty = the user must pick one. */
export const DEFAULT_MODELS: Record<ConnectorKind, Partial<Record<AiRole, string>>> = {
  builtin: {},
  ollama: { chat: 'gemma3:12b', embeddings: 'snowflake-arctic-embed2' },
  gemini: { chat: 'gemini-2.5-flash', embeddings: 'text-embedding-004' },
  'azure-openai': {},
  anthropic: { chat: 'claude-sonnet-5-5' },
  openai: { chat: 'gpt-5', embeddings: 'text-embedding-3-small' },
  'openai-compatible': {},
};

export interface ConnectorTestResult {
  ok: boolean;
  /** Epoch ms. */
  at: number;
  latencyMs: number;
  /** Role and model the test used. */
  role: AiRole;
  model: string;
  message: string;
}

/** Connector settings without any key. Keys live encrypted in main and are never part of this. */
export interface Connector {
  id: string;
  kind: ConnectorKind;
  name: string;
  /** Ollama / OpenAI-compatible server address; for Gemini, Anthropic and OpenAI an optional base URL override (proxy or gateway). */
  baseUrl?: string;
  /** Azure OpenAI resource endpoint, deployment and API version. */
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  /** OpenAI-compatible server: the roles it serves. */
  roles?: AiRole[];
  /** False = switched off in Settings: kept with its key, but on no route and never tested. Absent = on. */
  enabled?: boolean;
  /** Most recent connection test, if any. */
  test?: ConnectorTestResult;
  /** Role and model the user asked the connection test to use (servers with no default model need one). */
  testModel?: { role: AiRole; model: string };
}

export interface Route {
  connectorId: string;
  model: string;
}

export type FailPolicy = 'show-error' | 'retry-once' | 'use-fallback';

export interface RoutePolicy {
  onFail: FailPolicy;
  timeoutSec: 10 | 30 | 60;
  retries: 0 | 1 | 2;
  /** Minutes between re-checks of armed connectors; 0 = off. */
  recheckMin: 0 | 30 | 120;
  /** Run a connection test whenever a key is saved. */
  testOnKeySave: boolean;
}

export const DEFAULT_POLICY: RoutePolicy = { onFail: 'show-error', timeoutSec: 30, retries: 1, recheckMin: 30, testOnKeySave: true };

export type Routes = Record<AiRole, Route>;

/** What the renderer sees of a connector's state (design: Live, Armed, No key, Fault, Off). */
export type ConnectorState = 'live' | 'armed' | 'nokey' | 'fault' | 'off';

export function connectorServes(c: Pick<Connector, 'kind' | 'roles'>, role: AiRole): boolean {
  if (c.kind === 'openai-compatible') return (c.roles ?? []).includes(role);
  return KIND_ROLES[c.kind].includes(role);
}

/** Alias a role is served under inside LiteLLM; the model clients send is always one of these. */
export const ROLE_ALIAS: Record<AiRole, string> = { chat: 'ark-chat', embeddings: 'ark-embeddings', reranker: 'ark-reranker' };
export const testAlias = (connectorId: string): string => `ark-test-${connectorId}`;

// ── Validation ───────────────────────────────────────────────────────────────────────────────

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** Narrowing helper (boolean discriminants do not narrow without `strict`, which the main-process project does not set). */
export function failed<T>(v: Validated<T>): v is { ok: false; error: string } {
  return v.ok === false;
}

const MODEL_RE = /^[A-Za-z0-9][\w.:/@+-]{0,199}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const API_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.-]{0,39}$/;

export function isAiRole(v: unknown): v is AiRole {
  return typeof v === 'string' && (AI_ROLES as readonly string[]).includes(v);
}

export function isConnectorKind(v: unknown): v is ConnectorKind {
  return typeof v === 'string' && (CONNECTOR_KINDS as readonly string[]).includes(v);
}

export function isConnectorId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}

export function validateModelName(v: unknown): Validated<string> {
  if (typeof v !== 'string') return { ok: false, error: 'The model name must be text.' };
  const t = v.trim();
  if (!MODEL_RE.test(t)) return { ok: false, error: 'That does not look like a model name.' };
  return { ok: true, value: t };
}

/** An http(s) address without embedded credentials or a query, trailing slashes removed. */
export function validateHttpUrl(v: unknown, label: string): Validated<string> {
  if (typeof v !== 'string' || !v.trim() || v.length > 500) return { ok: false, error: `${label} is required.` };
  let u: URL;
  try { u = new URL(v.trim()); } catch { return { ok: false, error: `${label} is not a valid address.` }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: `${label} must start with http:// or https://.` };
  if (u.username || u.password) return { ok: false, error: `${label} must not contain a user name or password.` };
  if (u.search || u.hash) return { ok: false, error: `${label} must not have a query or fragment.` };
  return { ok: true, value: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}` };
}

/** The fixed id for every kind except OpenAI-compatible servers, which get one per entry. */
export function fixedConnectorId(kind: ConnectorKind): string | null {
  return kind === 'openai-compatible' ? null : kind;
}

/**
 * Connector fields from an IPC payload. Unknown fields are dropped; a key is never accepted here
 * (keys go through setKey), so a renderer cannot smuggle one into the stored settings.
 */
export function validateConnectorInput(input: unknown): Validated<Omit<Connector, 'test'>> {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid connector.' };
  const o = input as Record<string, unknown>;
  if (!isConnectorKind(o.kind)) return { ok: false, error: 'Unknown connector type.' };
  const kind = o.kind;
  if (kind === 'builtin') return { ok: false, error: 'The built-in connector cannot be changed.' };
  const fixed = fixedConnectorId(kind);
  const id = fixed ?? (typeof o.id === 'string' ? o.id : '');
  if (!fixed && id && !(isConnectorId(id) && id.startsWith('compat-'))) return { ok: false, error: 'Invalid connector id.' };
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 60) : '';
  const out: Omit<Connector, 'test'> = { id, kind, name: name || defaultConnectorName(kind) };
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled;
  if (kind === 'ollama' || kind === 'openai-compatible') {
    const url = validateHttpUrl(o.baseUrl, 'The server address');
    if (failed(url)) return url;
    out.baseUrl = url.value;
  }
  if ((kind === 'gemini' || kind === 'anthropic' || kind === 'openai') && typeof o.baseUrl === 'string' && o.baseUrl.trim()) {
    // Optional "Base URL override" (a proxy or self-hosted gateway for a hosted provider).
    const url = validateHttpUrl(o.baseUrl, 'The base URL');
    if (failed(url)) return url;
    out.baseUrl = url.value;
  }
  if (kind === 'azure-openai') {
    const ep = validateHttpUrl(o.endpoint, 'The endpoint');
    if (failed(ep)) return ep;
    out.endpoint = ep.value;
    const dep = typeof o.deployment === 'string' ? o.deployment.trim() : '';
    if (!dep || dep.length > 200 || !/^[\w.:-]+$/.test(dep)) return { ok: false, error: 'The deployment name is required.' };
    out.deployment = dep;
    const ver = typeof o.apiVersion === 'string' ? o.apiVersion.trim() : '';
    if (ver && !API_VERSION_RE.test(ver)) return { ok: false, error: 'That does not look like an API version.' };
    out.apiVersion = ver || '2024-12-01-preview';
  }
  if (kind === 'openai-compatible') {
    const roles = Array.isArray(o.roles) ? [...new Set(o.roles.filter(isAiRole))] : [];
    if (roles.length === 0) return { ok: false, error: 'Pick at least one role this server serves.' };
    out.roles = roles;
  }
  return { ok: true, value: out };
}

export function defaultConnectorName(kind: ConnectorKind): string {
  switch (kind) {
    case 'builtin': return 'Built-in (llama.cpp)';
    case 'ollama': return 'Ollama';
    case 'gemini': return 'Google Gemini';
    case 'azure-openai': return 'Azure OpenAI';
    case 'anthropic': return 'Anthropic';
    case 'openai': return 'OpenAI';
    default: return 'OpenAI-compatible server';
  }
}

export function validatePolicyInput(input: unknown, current: RoutePolicy): Validated<RoutePolicy> {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid policy.' };
  const o = input as Record<string, unknown>;
  const next: RoutePolicy = { ...current };
  if (o.onFail !== undefined) {
    if (o.onFail !== 'show-error' && o.onFail !== 'retry-once' && o.onFail !== 'use-fallback') return { ok: false, error: 'Invalid failure policy.' };
    next.onFail = o.onFail;
  }
  if (o.timeoutSec !== undefined) {
    if (o.timeoutSec !== 10 && o.timeoutSec !== 30 && o.timeoutSec !== 60) return { ok: false, error: 'Invalid timeout.' };
    next.timeoutSec = o.timeoutSec;
  }
  if (o.retries !== undefined) {
    if (o.retries !== 0 && o.retries !== 1 && o.retries !== 2) return { ok: false, error: 'Invalid retry count.' };
    next.retries = o.retries;
  }
  if (o.recheckMin !== undefined) {
    if (o.recheckMin !== 0 && o.recheckMin !== 30 && o.recheckMin !== 120) return { ok: false, error: 'Invalid re-check interval.' };
    next.recheckMin = o.recheckMin;
  }
  if (o.testOnKeySave !== undefined) {
    if (typeof o.testOnKeySave !== 'boolean') return { ok: false, error: 'Invalid setting.' };
    next.testOnKeySave = o.testOnKeySave;
  }
  return { ok: true, value: next };
}

/** `{ connectorId, model, role }` for setRoute. */
export function validateRouteInput(input: unknown): Validated<{ role: AiRole; connectorId: string; model: string }> {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid route.' };
  const o = input as Record<string, unknown>;
  if (!isAiRole(o.role)) return { ok: false, error: 'Unknown role.' };
  if (!isConnectorId(o.connectorId)) return { ok: false, error: 'Unknown connector.' };
  const model = o.model === '' || o.model === undefined ? { ok: true as const, value: '' } : validateModelName(o.model);
  if (failed(model)) return model;
  return { ok: true, value: { role: o.role, connectorId: o.connectorId, model: model.value } };
}

/** Key text from the renderer: printable, no whitespace, bounded. Shape rules are per provider's own check. */
export function validateKeyInput(v: unknown): Validated<string> {
  if (typeof v !== 'string') return { ok: false, error: 'That does not look like an API key.' };
  const t = v.trim();
  if (t.length < 8 || t.length > 500 || !/^[\x21-\x7e]+$/.test(t)) return { ok: false, error: 'That does not look like an API key.' };
  return { ok: true, value: t };
}
