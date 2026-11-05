/**
 * LiteLLM config generated from the user's connectors and routes (1.0.97 B35).
 *
 * Pure: connectors + routes + a key reader in, `{ config, env }` out.
 *  - `config` is what gets written to the temp file (JSON is valid YAML). It never contains a key:
 *    every credential is the reference `os.environ/ARK_KEY_<n>`.
 *  - `env` maps those variable names to the real values and is handed to the child process
 *    environment only (never argv, never the file, never logs).
 *
 * Model aliases: the app talks to `ark-chat`, `ark-embeddings` and `ark-reranker` (one per routed
 * role) and `ark-test-<connector>` (connection tests, so a connector can be tested before it is
 * routed). Roles routed to the built-in connector are not in the config at all: they go straight to
 * the built-in llama.cpp servers.
 */
import { createHash } from 'node:crypto';
import {
  AI_ROLES, BUILTIN_CONNECTOR_ID, DEFAULT_MODELS, KIND_NEEDS_KEY, ROLE_ALIAS, connectorServes, testAlias,
  type AiRole, type Connector, type RoutePolicy, type Routes,
} from './types.js';

export interface LitellmModelEntry {
  model_name: string;
  litellm_params: Record<string, string | number | boolean>;
}

export interface LitellmConfig {
  model_list: LitellmModelEntry[];
  general_settings: { master_key: string };
  litellm_settings: Record<string, string | number | boolean>;
}

export interface BuiltConfig {
  config: LitellmConfig;
  /** ARK_KEY_<n> -> secret. Child environment only. */
  env: Record<string, string>;
  /** Roles that go through LiteLLM (the others are served by the built-in runtime directly). */
  routedRoles: AiRole[];
  /** Changes whenever the config or any key changes (test aliases included). Tests need a sidecar with exactly this. */
  hash: string;
  /**
   * Changes only when something a routed role depends on changes: the routed entries and their keys.
   * Edits to a connector that is not routed (its key, address, test model) leave it alone, so they
   * never restart LiteLLM under a running request.
   */
  routedHash: string;
}

export interface BuildInput {
  connectors: Connector[];
  routes: Routes;
  policy: RoutePolicy;
  getKey: (connectorId: string) => string | null;
}

/** The model a connection test uses: the one the user chose, else the routed model, else the kind's default, else the deployment. */
export function testTarget(c: Connector, routes: Routes): { role: AiRole; model: string } | null {
  if (c.testModel && connectorServes(c, c.testModel.role)) return { ...c.testModel };
  for (const role of AI_ROLES) {
    if (routes[role].connectorId === c.id && connectorServes(c, role)) return { role, model: routes[role].model };
  }
  for (const role of AI_ROLES) {
    if (!connectorServes(c, role)) continue;
    const model = c.kind === 'azure-openai' ? c.deployment : DEFAULT_MODELS[c.kind][role];
    if (model) return { role, model };
  }
  return null;
}

/** Longest request timeout the policy offers (60 s); LiteLLM never cuts a request short before the client does. */
export const LITELLM_TIMEOUT_CEILING_SEC = 60;

/** LiteLLM resolves any param that starts with this to an environment variable; only generated key references may. */
const ENV_REF = /^\s*os\.environ\//i;

function litellmParams(c: Connector, role: AiRole, model: string, keyRef: string | null): Record<string, string | number | boolean> | null {
  // One layer retries: the router's client loop. LiteLLM's own retries would multiply with it, and
  // its timeout is the ceiling the client's (shorter, policy-driven) timeout always aborts before, so
  // changing the policy never needs a LiteLLM restart.
  const base: Record<string, string | number | boolean> = { timeout: LITELLM_TIMEOUT_CEILING_SEC, num_retries: 0 };
  const withKey = (extra: Record<string, string | number | boolean>) => ({ ...base, ...extra, ...(keyRef ? { api_key: keyRef } : {}) });
  switch (c.kind) {
    case 'ollama':
      if (!c.baseUrl) return null;
      return withKey({ model: `${role === 'chat' ? 'ollama_chat' : 'ollama'}/${model}`, api_base: c.baseUrl });
    case 'gemini':
      return withKey({ model: `gemini/${model}`, ...(c.baseUrl ? { api_base: c.baseUrl } : {}) });
    case 'azure-openai':
      if (!c.endpoint) return null;
      return withKey({ model: `azure/${model || c.deployment || ''}`, api_base: c.endpoint, api_version: c.apiVersion || '2024-12-01-preview' });
    case 'anthropic':
      return withKey({ model: `anthropic/${model}`, ...(c.baseUrl ? { api_base: c.baseUrl } : {}) });
    case 'openai':
      return withKey({ model: `openai/${model}`, ...(c.baseUrl ? { api_base: c.baseUrl } : {}) });
    case 'openai-compatible':
      if (!c.baseUrl) return null;
      // An OpenAI-compatible server may need no key; LiteLLM's OpenAI client wants some value.
      return role === 'reranker'
        ? { ...base, model: `infinity/${model}`, api_base: c.baseUrl, ...(keyRef ? { api_key: keyRef } : {}) }
        : { ...base, model: `openai/${model}`, api_base: c.baseUrl, api_key: keyRef ?? 'ark-no-key' };
    default:
      return null;
  }
}

/** True when a user-influenced value would be read by LiteLLM as an environment reference (the generated key reference is the only legitimate one). */
function carriesEnvReference(params: Record<string, string | number | boolean>): boolean {
  return Object.entries(params).some(([k, v]) => k !== 'api_key' && typeof v === 'string' && ENV_REF.test(v))
    || (typeof params.api_key === 'string' && ENV_REF.test(params.api_key) && !/^os\.environ\/ARK_KEY_\d+$/.test(params.api_key));
}

export function buildLitellmConfig(input: BuildInput): BuiltConfig {
  const env: Record<string, string> = {};
  const refs = new Map<string, string>();
  const refFor = (connectorId: string): string | null => {
    const existing = refs.get(connectorId);
    if (existing) return existing;
    const key = input.getKey(connectorId);
    if (!key) return null;
    const name = `ARK_KEY_${refs.size}`;
    env[name] = key;
    const ref = `os.environ/${name}`;
    refs.set(connectorId, ref);
    return ref;
  };

  const model_list: LitellmModelEntry[] = [];
  const routedRoles: AiRole[] = [];
  const byId = new Map(input.connectors.map((c) => [c.id, c]));

  for (const role of AI_ROLES) {
    const route = input.routes[role];
    const c = byId.get(route.connectorId);
    if (!c || c.kind === 'builtin' || c.id === BUILTIN_CONNECTOR_ID || !connectorServes(c, role)) continue;
    const keyRef = refFor(c.id);
    if (KIND_NEEDS_KEY[c.kind] && !keyRef) continue;
    const params = litellmParams(c, role, route.model, keyRef);
    if (!params || carriesEnvReference(params)) continue;
    model_list.push({ model_name: ROLE_ALIAS[role], litellm_params: params });
    routedRoles.push(role);
  }

  for (const c of input.connectors) {
    if (c.kind === 'builtin') continue;
    const target = testTarget(c, input.routes);
    if (!target) continue;
    const keyRef = refFor(c.id);
    if (KIND_NEEDS_KEY[c.kind] && !keyRef) continue;
    const params = litellmParams(c, target.role, target.model, keyRef);
    if (params && !carriesEnvReference(params)) model_list.push({ model_name: testAlias(c.id), litellm_params: params });
  }
  const routedCount = routedRoles.length;

  const config: LitellmConfig = {
    model_list,
    general_settings: { master_key: 'os.environ/LITELLM_MASTER_KEY' },
    litellm_settings: { drop_params: true, telemetry: false, set_verbose: false },
  };
  const digest = (entries: LitellmModelEntry[], onlyReferenced: boolean): string => {
    const h = createHash('sha256');
    h.update(JSON.stringify({ ...config, model_list: entries }));
    const used = new Set<string>();
    for (const e of entries) {
      const ref = e.litellm_params.api_key;
      if (typeof ref === 'string' && ref.startsWith('os.environ/')) used.add(ref.slice('os.environ/'.length));
    }
    for (const name of Object.keys(env).sort()) {
      if (!onlyReferenced || used.has(name)) h.update(`\n${name}=${createHash('sha256').update(env[name]!).digest('hex')}`);
    }
    return h.digest('hex');
  };
  return {
    config, env, routedRoles,
    hash: digest(model_list, false),
    routedHash: digest(model_list.slice(0, routedCount), true),
  };
}
