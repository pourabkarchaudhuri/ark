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
  /** Changes whenever the config or any key changes; the sidecar restarts when it does. */
  hash: string;
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

function litellmParams(c: Connector, role: AiRole, model: string, keyRef: string | null, policy: RoutePolicy): Record<string, string | number | boolean> | null {
  const base: Record<string, string | number | boolean> = { timeout: policy.timeoutSec, num_retries: policy.retries };
  const withKey = (extra: Record<string, string | number | boolean>) => ({ ...base, ...extra, ...(keyRef ? { api_key: keyRef } : {}) });
  switch (c.kind) {
    case 'ollama':
      if (!c.baseUrl) return null;
      return withKey({ model: `${role === 'chat' ? 'ollama_chat' : 'ollama'}/${model}`, api_base: c.baseUrl });
    case 'gemini':
      return withKey({ model: `gemini/${model}` });
    case 'azure-openai':
      if (!c.endpoint) return null;
      return withKey({ model: `azure/${model || c.deployment || ''}`, api_base: c.endpoint, api_version: c.apiVersion || '2024-12-01-preview' });
    case 'anthropic':
      return withKey({ model: `anthropic/${model}` });
    case 'openai':
      return withKey({ model: `openai/${model}` });
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
    const params = litellmParams(c, role, route.model, keyRef, input.policy);
    if (!params) continue;
    model_list.push({ model_name: ROLE_ALIAS[role], litellm_params: params });
    routedRoles.push(role);
  }

  for (const c of input.connectors) {
    if (c.kind === 'builtin') continue;
    const target = testTarget(c, input.routes);
    if (!target) continue;
    const keyRef = refFor(c.id);
    if (KIND_NEEDS_KEY[c.kind] && !keyRef) continue;
    const params = litellmParams(c, target.role, target.model, keyRef, { ...input.policy, retries: 0 });
    if (params) model_list.push({ model_name: testAlias(c.id), litellm_params: params });
  }

  const config: LitellmConfig = {
    model_list,
    general_settings: { master_key: 'os.environ/LITELLM_MASTER_KEY' },
    litellm_settings: { drop_params: true, telemetry: false, set_verbose: false },
  };
  const h = createHash('sha256');
  h.update(JSON.stringify(config));
  for (const name of Object.keys(env).sort()) h.update(`\n${name}=${createHash('sha256').update(env[name]!).digest('hex')}`);
  return { config, env, routedRoles, hash: h.digest('hex') };
}
