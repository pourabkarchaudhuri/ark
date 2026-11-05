/**
 * Pure logic of the AI providers page (1.0.97 B37): the connector catalog, how a connector's state
 * is shown, the per-connector model lists, and the router graph layout. No React, no IPC, so every
 * rule is unit-tested.
 */
import type { AiConnector, AiConnectorTest, AiRole, AiRouterState, ConnectorKind } from '@/services/ai-router-types';
import type { LocalAiRoleName, LocalAiStatus } from '@/services/local-ai-types';

// ── Catalog ("Add a connector") ─────────────────────────────────────────────────────────────────

export interface CatalogItem {
  id: string;
  mono: string;
  name: string;
  /** Short note on the right of the picker row. */
  kind: string;
  connectorKind: ConnectorKind;
  /** Presets for an OpenAI-compatible server. */
  baseUrl?: string;
  roles?: AiRole[];
}

/**
 * Providers Ark can talk to. Besides the four hosted ones and a local Ollama, any server that
 * speaks the OpenAI API works as an "OpenAI-compatible server"; the presets only fill in its address.
 */
export const CONNECTOR_CATALOG: readonly CatalogItem[] = [
  { id: 'compat', mono: 'OC', name: 'OpenAI-compatible endpoint', kind: 'Custom', connectorKind: 'openai-compatible', baseUrl: 'http://localhost:8000/v1', roles: ['chat'] },
  { id: 'anthropic', mono: 'AN', name: 'Anthropic', kind: 'Chat', connectorKind: 'anthropic' },
  { id: 'openai', mono: 'OA', name: 'OpenAI', kind: 'Chat, embed', connectorKind: 'openai' },
  { id: 'gemini', mono: 'GE', name: 'Google Gemini', kind: 'Chat, embed', connectorKind: 'gemini' },
  { id: 'azure-openai', mono: 'AZ', name: 'Azure OpenAI', kind: 'Chat, embed', connectorKind: 'azure-openai' },
  { id: 'ollama', mono: 'OL', name: 'Ollama', kind: 'Local', connectorKind: 'ollama', baseUrl: 'http://localhost:11434' },
  { id: 'lmstudio', mono: 'LM', name: 'LM Studio', kind: 'Local', connectorKind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', roles: ['chat', 'embeddings'] },
  { id: 'openrouter', mono: 'OR', name: 'OpenRouter', kind: 'Chat', connectorKind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', roles: ['chat'] },
  { id: 'groq', mono: 'GQ', name: 'Groq', kind: 'Chat', connectorKind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', roles: ['chat'] },
  { id: 'deepseek', mono: 'DS', name: 'DeepSeek', kind: 'Chat', connectorKind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', roles: ['chat'] },
  { id: 'mistral', mono: 'MI', name: 'Mistral', kind: 'Chat, embed', connectorKind: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1', roles: ['chat', 'embeddings'] },
];

/** Catalog entries still worth offering: one of each fixed kind, any number of compatible servers. */
export function availableCatalog(connectors: readonly Pick<AiConnector, 'kind'>[]): CatalogItem[] {
  const taken = new Set(connectors.map((c) => c.kind));
  return CONNECTOR_CATALOG.filter((i) => i.connectorKind === 'openai-compatible' || !taken.has(i.connectorKind));
}

export const KEY_SITES: Partial<Record<ConnectorKind, { hint: string; site: string; url: string }>> = {
  anthropic: { hint: 'sk-ant-…', site: 'console.anthropic.com', url: 'https://console.anthropic.com/' },
  openai: { hint: 'sk-…', site: 'platform.openai.com', url: 'https://platform.openai.com/api-keys' },
  gemini: { hint: 'AIza…', site: 'aistudio.google.com', url: 'https://aistudio.google.com/apikey' },
  'azure-openai': { hint: 'Azure API key', site: 'portal.azure.com', url: 'https://portal.azure.com/' },
};

export const KIND_LORE: Record<ConnectorKind, string> = {
  builtin: 'On this PC',
  ollama: 'Local server',
  gemini: 'Google AI',
  'azure-openai': 'Azure resource',
  anthropic: 'Anthropic API',
  openai: 'OpenAI API',
  'openai-compatible': 'OpenAI-compatible server',
};

// ── Display state ───────────────────────────────────────────────────────────────────────────────

export type NodeTone = 'live' | 'armed' | 'nokey' | 'fault' | 'off';
export const TONE_LABEL: Record<NodeTone, string> = { live: 'Live', armed: 'Armed', nokey: 'No key', fault: 'Fault', off: 'Off' };

export interface NodeDisplay {
  tone: NodeTone;
  chip: string;
  routed: boolean;
  /** Text of the route button. */
  routeLabel: string;
  /** The route button does something (route, or open the drawer to fix the key). */
  canAct: boolean;
  /** Pressing it opens the drawer instead of routing. */
  opensDrawer: boolean;
}

/** A failed test whose message says the key itself was refused: that holds for every role. */
const KEY_REJECTED_RE = /\b401\b|unauthori[sz]ed|invalid.*key|key rejected|incorrect api key/i;

/**
 * The connector's last test as it counts for one role. A test is stored once per connector, so a
 * pass for chat says nothing about embeddings, and a missing embeddings model must not mark the
 * chat model faulty. Only a refused key (401) is a fault for every role.
 */
export function testFor(c: AiConnector, role: AiRole): AiConnectorTest | undefined {
  const t = c.test;
  if (!t) return undefined;
  if (t.role === role) return t;
  return !t.ok && KEY_REJECTED_RE.test(t.message || '') ? t : undefined;
}

/**
 * Mark connectors as testing (or done) without touching the others: a test already running keeps
 * its spinner when "Test all" starts or ends.
 */
export function markTesting(map: Record<string, boolean>, ids: readonly string[], on: boolean): Record<string, boolean> {
  const next = { ...map };
  for (const id of ids) { if (on) next[id] = true; else delete next[id]; }
  return next;
}

/**
 * Whether the built-in connector can answer one role: `ready`, `needs-model` (the role's model is
 * not on disk), `downloading`, `checking` (local AI status not loaded yet) or `down` (the runtime
 * is missing or the role's server failed).
 */
export type BuiltinReadiness = 'ready' | 'needs-model' | 'downloading' | 'checking' | 'down';

const LOCAL_MODEL_ROLES: Record<AiRole, LocalAiRoleName[]> = { chat: ['chat'], embeddings: ['embed'], reranker: ['rerank', 'rerank-qwen'] };

/**
 * Per-role readiness of the built-in connector from the local AI status. `null` means the status
 * has not arrived; pass `unavailable` when there is no local AI API at all (nothing to wait for).
 */
export function builtinReadiness(localAi: LocalAiStatus | null | undefined, role: AiRole, unavailable = false): BuiltinReadiness {
  if (!localAi) return unavailable ? 'ready' : 'checking';
  if (localAi.backend !== 'builtin') return 'ready';
  if (!localAi.runtime.available) return 'down';
  const names = LOCAL_MODEL_ROLES[role];
  if (localAi.runtime.roles?.some((r) => names.includes(r.role) && r.state === 'failed')) return 'down';
  const models = localAi.models.filter((m) => names.includes(m.role));
  if (models.length === 0 || models.some((m) => m.state === 'ready')) return 'ready';
  if (models.some((m) => m.state === 'downloading' || m.state === 'queued' || m.state === 'verifying')) return 'downloading';
  return 'needs-model';
}

/**
 * How one connector shows for the role being viewed. `testing` is a test in flight; `builtinState`
 * is the built-in connector's readiness for this role (`builtinDown` is the older flag for `down`).
 */
export function describeNode(c: AiConnector, role: AiRole, opts: { testing?: boolean; builtinDown?: boolean; builtinState?: BuiltinReadiness } = {}): NodeDisplay {
  const enabled = c.enabled !== false;
  const serves = c.serves.includes(role);
  const routed = c.routedFor.includes(role) && enabled && serves;
  const test = testFor(c, role);
  const idle: Omit<NodeDisplay, 'tone' | 'chip'> = { routed, routeLabel: 'Route here', canAct: true, opensDrawer: false };

  if (opts.testing) return { ...idle, tone: 'armed', chip: 'Testing', routeLabel: routed ? 'Routed' : 'Route here', canAct: false };
  if (!enabled) return { ...idle, tone: 'off', chip: 'Off', routed: false, canAct: false };
  if (c.kind === 'builtin') {
    const state = opts.builtinDown ? 'down' : opts.builtinState ?? 'ready';
    if (state === 'down') return { ...idle, tone: 'fault', chip: 'Not running', routeLabel: routed ? 'Routed' : 'Route here', canAct: !routed };
    if (state === 'checking') return { ...idle, tone: 'armed', chip: 'Checking', routeLabel: routed ? 'Routed' : 'Route here', canAct: !routed };
    if (state === 'downloading') return { ...idle, tone: 'armed', chip: 'Downloading', routeLabel: routed ? 'Routed' : 'Route here', canAct: !routed };
    if (state === 'needs-model') {
      // Routed, but nothing to answer with: the button opens the drawer, where the download lives.
      return routed
        ? { ...idle, tone: 'nokey', chip: 'Needs model', routeLabel: 'Download model', canAct: true, opensDrawer: true }
        : { ...idle, tone: 'nokey', chip: 'Needs model' };
    }
    return routed ? { ...idle, tone: 'live', chip: 'Live', routeLabel: 'Routed', canAct: false } : { ...idle, tone: 'armed', chip: 'Ready' };
  }
  if (test && !test.ok) return { ...idle, routed: false, tone: 'fault', chip: 'Fault', routeLabel: 'Fix key', opensDrawer: true };
  if (c.needsKey && !c.hasKey) return { ...idle, routed: false, tone: 'nokey', chip: 'No key', routeLabel: 'Add key', opensDrawer: true };
  if (!serves) return { ...idle, routed: false, tone: 'off', chip: 'Not offered', canAct: false };
  if (routed) return { ...idle, tone: 'live', chip: 'Live', routeLabel: 'Routed', canAct: false };
  // Configured; routing waits for a passed test, which pressing the button runs first.
  if (!test) return { ...idle, tone: 'armed', chip: 'Untested', routeLabel: 'Test and route' };
  return { ...idle, tone: 'armed', chip: 'Armed' };
}

/** What the "Route here" call-to-action at the bottom of the drawer says. */
export function routeCta(c: AiConnector, role: AiRole, noun: string, d: NodeDisplay): { label: string; disabled: boolean } {
  if (d.routed) return { label: `Routed for ${noun}`, disabled: true };
  if (!c.serves.includes(role)) return { label: `Doesn’t offer ${noun}`, disabled: true };
  if (c.enabled === false) return { label: 'Enable to route', disabled: true };
  const test = testFor(c, role);
  if (test && !test.ok) return { label: 'Fix the key to route', disabled: true };
  if (c.needsKey && !c.hasKey) return { label: 'Save a key to route', disabled: true };
  return { label: d.chip === 'Untested' ? `Test and route ${noun} here` : `Route ${noun} here`, disabled: false };
}

/** Counts shown in the router node: armed, fault and off connectors among those offering the role. */
export function countStates(items: Array<{ display: NodeDisplay }>) {
  return {
    armed: items.filter((i) => i.display.tone === 'armed').length,
    fault: items.filter((i) => i.display.tone === 'fault').length,
    off: items.filter((i) => i.display.tone === 'off').length,
  };
}

/** Message under a finished connection test (design: 401, 429, timeout and missing-model states). */
export function describeTest(t: { ok: boolean; message: string; latencyMs: number }): { tone: 'live' | 'fault' | 'nokey'; text: string; advice: string | null } {
  if (t.ok) return { tone: 'live', text: `Connected · ${t.latencyMs} ms`, advice: null };
  const m = t.message || 'The test failed.';
  if (/\b401\b|unauthori[sz]ed|invalid.*key|key rejected|incorrect api key/i.test(m)) {
    return { tone: 'fault', text: 'Key rejected (401)', advice: 'Paste a new key. The old one stays saved until you replace or remove it.' };
  }
  if (/\b429\b|rate.?limit/i.test(m)) {
    return { tone: 'nokey', text: 'Rate limited (429)', advice: 'The key works but the provider is throttling. Try again in a moment.' };
  }
  if (/time.?out|timed out|no reply/i.test(m)) {
    return { tone: 'fault', text: 'No reply in time', advice: 'Raise the timeout in Connection test, or check the provider’s status.' };
  }
  if (/not.?found|\b404\b|does not exist|unknown model|no such model/i.test(m)) {
    return { tone: 'nokey', text: 'Model not found', advice: 'That model isn’t on this account. Uncheck it or pick another default.' };
  }
  return { tone: 'fault', text: m.length > 90 ? `${m.slice(0, 87)}…` : m, advice: null };
}

// ── Model lists ─────────────────────────────────────────────────────────────────────────────────

/** Mirror of DEFAULT_MODELS in electron/ai-router/types.ts (a test keeps the two equal). */
export const DEFAULT_MODELS_UI: Record<ConnectorKind, Partial<Record<AiRole, string>>> = {
  builtin: {},
  ollama: { chat: 'gemma3:12b', embeddings: 'snowflake-arctic-embed2' },
  gemini: { chat: 'gemini-2.5-flash', embeddings: 'text-embedding-004' },
  'azure-openai': {},
  anthropic: { chat: 'claude-sonnet-5-5' },
  openai: { chat: 'gpt-5', embeddings: 'text-embedding-3-small' },
  'openai-compatible': {},
};

/** Per connector and role: model ids the user added or fetched, ones switched off, and the default. */
export interface ModelPrefs {
  added: string[];
  off: string[];
  def?: string;
}
export type ModelPrefsStore = Record<string, Partial<Record<AiRole, ModelPrefs>>>;

export const MODEL_PREFS_KEY = 'ark-router-model-prefs';

export function loadModelPrefs(): ModelPrefsStore {
  try {
    const raw = localStorage.getItem(MODEL_PREFS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed as ModelPrefsStore : {};
  } catch {
    return {};
  }
}

export function saveModelPrefs(store: ModelPrefsStore): void {
  try { localStorage.setItem(MODEL_PREFS_KEY, JSON.stringify(store)); } catch { /* storage unavailable: choices last for this visit */ }
}

const MODEL_ID_RE = /^[A-Za-z0-9][\w.:/@+-]{0,199}$/;
export function isModelId(v: string): boolean {
  return MODEL_ID_RE.test(v.trim());
}

export interface ModelRow { id: string; active: boolean }
export interface ModelList { rows: ModelRow[]; def: string | null }

/**
 * The models shown for a connector and role: the kind's default, the routed model, the test model
 * and whatever was added or fetched. The default is the saved one if still checked, else the routed
 * model (when this connector is routed for the role), else the first checked.
 */
export function modelList(c: AiConnector, role: AiRole, routed: { connectorId: string; model: string } | undefined, prefs: ModelPrefs | undefined): ModelList {
  if (c.kind === 'azure-openai') {
    const dep = c.deployment ?? '';
    return { rows: dep ? [{ id: dep, active: true }] : [], def: dep || null };
  }
  const ids: string[] = [];
  const add = (id: string | undefined) => { if (id && !ids.includes(id)) ids.push(id); };
  add(DEFAULT_MODELS_UI[c.kind][role]);
  if (routed?.connectorId === c.id) add(routed.model);
  if (c.testModel?.role === role) add(c.testModel.model);
  for (const id of prefs?.added ?? []) add(id);
  const off = new Set(prefs?.off ?? []);
  const rows = ids.map((id) => ({ id, active: !off.has(id) }));
  const active = rows.filter((r) => r.active).map((r) => r.id);
  const routedModel = routed?.connectorId === c.id ? routed.model : undefined;
  const def = prefs?.def && active.includes(prefs.def) ? prefs.def
    : routedModel && active.includes(routedModel) ? routedModel
      : active[0] ?? null;
  return { rows, def };
}

/** Heuristic for "Test with: Smallest": the id that looks like the cheapest model, else the first. */
export function smallestModel(ids: readonly string[]): string | null {
  if (ids.length === 0) return null;
  const small = /(nano|mini|haiku|flash|lite|small|tiny|0\.\d+b|\b[1-8]b\b|-[1-8]b\b|:[1-8]b\b)/i;
  return ids.find((id) => small.test(id)) ?? ids[0]!;
}

// ── Graph layout ────────────────────────────────────────────────────────────────────────────────

export interface GraphLayout {
  stageH: number;
  routerTop: number;
  routerLabelY: number;
  deck1Y: number;
  deck2Y: number;
  deckLabelY: number;
  hiddenY: number;
  /** Top of node i. */
  nodeY: (i: number) => number;
  /** Bezier from node i to the router. */
  wire: (i: number) => string;
  deckWires: [string, string];
}

/** Positions of the stage (720 wide): connector nodes at the left, the router in the middle, uses at the right. */
export function graphLayout(n: number, hidden: number): GraphLayout {
  const stageH = Math.max(560, 32 + n * 118 + (hidden ? 56 : 24));
  const routerTop = Math.round(stageH / 2 - 105);
  const cy = routerTop + 105;
  return {
    stageH, routerTop, routerLabelY: routerTop - 22, deck1Y: cy - 88, deck2Y: cy + 32, deckLabelY: cy - 112,
    hiddenY: 32 + n * 118 + 4,
    nodeY: (i) => 32 + i * 118,
    wire: (i) => {
      const y1 = 32 + i * 118 + 52;
      const y2 = cy - (n - 1) * 12 + i * 24;
      return `M252 ${y1} C292 ${y1} 288 ${y2} 320 ${y2}`;
    },
    deckWires: [
      `M540 ${cy - 30} C560 ${cy - 30} 560 ${cy - 60} 580 ${cy - 60}`,
      `M540 ${cy + 30} C560 ${cy + 30} 560 ${cy + 60} 580 ${cy + 60}`,
    ],
  };
}

/** What each role is used for, shown on the right of the graph. */
export const ROLE_DECKS: Record<AiRole, [string, string]> = {
  chat: ['AI Chat', 'Oracle reasons'],
  embeddings: ['Similar games', 'Galaxy map'],
  reranker: ['Similar ordering', 'Oracle shelves'],
};

export const TEST_INPUT: Record<AiRole, { text: string; hint: string }> = {
  chat: { text: 'Reply with the single word OK.', hint: 'Kept tiny so a test costs almost nothing.' },
  embeddings: { text: 'A short co-op roguelike about a lighthouse.', hint: 'Ark checks that a vector comes back and notes its size.' },
  reranker: { text: 'Query: co-op roguelike · 3 sample games', hint: 'Ark checks that the three sample games come back scored.' },
};

/** The route a `setRoute` should ask for, from the connector and its model list. */
export function routeRequest(c: AiConnector, role: AiRole, list: ModelList): { connectorId: string; model: string; role: AiRole } {
  // Built-in and Azure pick their own model in main (the built-in role model, the deployment).
  const model = c.kind === 'builtin' || c.kind === 'azure-openai' ? '' : list.def ?? '';
  return { role, connectorId: c.id, model };
}

export function hasRoutes(state: AiRouterState | null): boolean {
  return !!state && (['chat', 'embeddings', 'reranker'] as const).some((r) => state.routes[r].connectorId !== 'builtin');
}
