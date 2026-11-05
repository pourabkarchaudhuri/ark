/**
 * Keeps the current Settings screen working against the connector/route store (1.0.97 B35).
 *
 * Until the Settings rewrite (B37) the user picks a chat provider (Ollama / Gemini / Azure OpenAI /
 * Anthropic) and types keys, endpoint and deployment there. These helpers translate that into the
 * router's model:
 *  - the provider selector sets the chat route (no test step in that UI, so the route is forced,
 *    but a key must exist);
 *  - the Azure endpoint/deployment/version the renderer sends with each chat message upsert the
 *    Azure connector;
 *  - "Ollama" means the built-in connector (which is the user's own Ollama when that switch is on).
 */
import { BUILTIN_CONNECTOR_ID, DEFAULT_MODELS, failed, validateConnectorInput, type ConnectorKind } from './types.js';
import type { RouterStore, SetRouteResult } from './connectors.js';

export type LegacyProvider = 'ollama' | 'gemini' | 'azure-openai' | 'anthropic';

const KIND_BY_PROVIDER: Record<Exclude<LegacyProvider, 'ollama'>, ConnectorKind> = {
  gemini: 'gemini', 'azure-openai': 'azure-openai', anthropic: 'anthropic',
};

/** The provider a chat route stands for (the inverse mapping, for `usedOllama`-style decisions). */
export function providerForKind(kind: ConnectorKind): LegacyProvider {
  switch (kind) {
    case 'builtin':
    case 'ollama': return 'ollama';
    case 'gemini': return 'gemini';
    case 'azure-openai': return 'azure-openai';
    default: return 'anthropic'; // OpenAI and OpenAI-compatible are cloud-style like the others
  }
}

/** Upsert the Azure connector from what the renderer sends with a chat message. True when it changed. */
export function syncAzureConnector(
  store: RouterStore,
  input: { endpoint?: string; deployment?: string; apiVersion?: string },
): boolean {
  const endpoint = input.endpoint?.trim().replace(/\/+$/, '');
  const deployment = input.deployment?.trim();
  if (!endpoint || !deployment) return false;
  const existing = store.connector('azure-openai');
  const apiVersion = input.apiVersion?.trim() || existing?.apiVersion || '2024-12-01-preview';
  // The renderer's Settings values get the same checks as the AI providers screen (address, deployment
  // name, API version), so nothing it sends can reach the generated config unchecked.
  const checked = validateConnectorInput({
    id: 'azure-openai', kind: 'azure-openai', name: existing?.name ?? 'Azure OpenAI', endpoint, deployment, apiVersion,
  });
  if (failed(checked)) return false;
  const v = checked.value;
  if (existing && existing.endpoint === v.endpoint && existing.deployment === v.deployment && existing.apiVersion === v.apiVersion) return false;
  store.upsertConnector(v, { keepExistingKey: !existing });
  return true;
}

/**
 * Route chat the way the legacy provider selector means it. Returns null when nothing had to change
 * (already routed that way) or the provider cannot be routed yet (no key, Azure not described).
 */
export function applyLegacyChatProvider(
  store: RouterStore,
  provider: LegacyProvider,
  opts: { anthropicModel?: string } = {},
): SetRouteResult | null {
  const current = store.route('chat');
  const currentKind = store.connector(current.connectorId)?.kind;
  if (provider === 'ollama') {
    if (current.connectorId === BUILTIN_CONNECTOR_ID) return null;
    // The AI providers screen (B37) can route chat to Ollama, OpenAI or an OpenAI-compatible server,
    // which the old selector cannot name: its default "ollama" must not undo that choice.
    if (currentKind === 'ollama' || currentKind === 'openai' || currentKind === 'openai-compatible') return null;
    return store.setRoute('chat', BUILTIN_CONNECTOR_ID, '');
  }
  const kind = KIND_BY_PROVIDER[provider];
  if (!store.connector(kind)) {
    if (kind === 'azure-openai') return null; // needs endpoint + deployment first (syncAzureConnector)
    store.upsertConnector({ id: kind, kind, name: kind === 'gemini' ? 'Google Gemini' : 'Anthropic' }, { keepExistingKey: true });
  }
  // A route already on this provider keeps the model chosen on the AI providers screen.
  if (current.connectorId === kind) return null;
  const model = kind === 'anthropic'
    ? (opts.anthropicModel?.trim() || (current.connectorId === 'anthropic' ? current.model : '') || DEFAULT_MODELS.anthropic.chat!)
    : kind === 'azure-openai'
      ? store.connector('azure-openai')?.deployment ?? ''
      : DEFAULT_MODELS.gemini.chat!;
  if (current.connectorId === kind && current.model === model) return null;
  return store.setRoute('chat', kind, model, { force: true });
}
