/**
 * Wiring of the AI router for the real app (1.0.97 B35): where the connector store lives, which
 * folder holds the bundled LiteLLM runtime, one shared sidecar + router per process, startup
 * (adopt existing keys, route chat the way the Settings selector says) and shutdown.
 *
 * Paths:
 *  - store: `<userData>/ai-router.json` (keys encrypted with safeStorage inside it);
 *  - runtime: `resources/litellm-runtime` when packaged, `build/litellm-runtime` in development
 *    (scripts/build-litellm-runtime.mjs fills it);
 *  - per-launch config folders: `<userData>/ai-router-run/run-*`, removed on exit and swept at start.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { settingsStore } from '../settings-store.js';
import { logger } from '../safe-logger.js';
import { atomicWriteFileSync } from '../safe-write.js';
import { nativeJobAssignKillOnClose } from '../native-bridge.js';
import { LitellmSidecar } from '../litellm-sidecar.js';
import { getBuiltinBackend } from '../local-ai/backend.js';
import { getModelForRole } from '../local-ai/manifest.js';
import { RouterStore, type LegacyKeys, type LegacySlot, type RouterStoreIo } from './connectors.js';
import { AiRouter, type ResolvedRoute } from './router.js';
import { applyLegacyChatProvider, syncAzureConnector, type LegacyProvider } from './legacy-sync.js';
import type { AiRole } from './types.js';

const require = createRequire(import.meta.url);

/** The three pre-router keys stay in settings-store's encrypted slots; the router adopts them in place. */
export function settingsStoreLegacyKeys(): LegacyKeys {
  return {
    get(slot: LegacySlot) {
      switch (slot) {
        case 'googleAI': return settingsStore.getGoogleAIKey();
        case 'azureOpenAI': return settingsStore.getAzureOpenAIKey();
        default: return settingsStore.getAnthropicKey();
      }
    },
    set(slot: LegacySlot, key: string) {
      switch (slot) {
        case 'googleAI': settingsStore.setGoogleAIKey(key); break;
        case 'azureOpenAI': settingsStore.setAzureOpenAIKey(key); break;
        default: settingsStore.setAnthropicKey(key);
      }
    },
    clear(slot: LegacySlot) {
      switch (slot) {
        case 'googleAI': settingsStore.removeGoogleAIKey(); break;
        case 'azureOpenAI': settingsStore.clearAzureOpenAIKey(); break;
        default: settingsStore.clearAnthropicKey();
      }
    },
  };
}

function userDataDir(): string {
  const { app } = require('electron') as typeof import('electron');
  return app.getPath('userData');
}

function defaultIo(): RouterStoreIo {
  const { safeStorage } = require('electron') as typeof import('electron');
  const file = path.join(userDataDir(), 'ai-router.json');
  return {
    read: () => {
      try { return fs.readFileSync(file, 'utf8'); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    write: (data) => atomicWriteFileSync(file, data),
    now: () => Date.now(),
    safeStorage,
  };
}

export function resolveLitellmRuntimeDir(): string {
  const { app } = require('electron') as typeof import('electron');
  return app.isPackaged
    ? path.join(process.resourcesPath, 'litellm-runtime')
    : path.join(app.getAppPath(), 'build', 'litellm-runtime');
}

export interface AiRouterService {
  store: RouterStore;
  sidecar: LitellmSidecar;
  router: AiRouter;
}

let _service: AiRouterService | null = null;

/** What the built-in connector's "Test" checks for a role: runtime present and the model on disk. */
async function builtinProbe(role: AiRole): Promise<{ ok: boolean; message: string; model: string }> {
  const backend = getBuiltinBackend();
  const model = getModelForRole(role === 'chat' ? 'chat' : role === 'embeddings' ? 'embed' : 'rerank')?.id ?? '';
  if (!backend.health().running) return { ok: false, message: 'The built-in runtime is missing from this install.', model };
  const ready = backend.isModelReady('embed');
  return ready
    ? { ok: true, message: 'The built-in runtime and its models are ready.', model }
    : { ok: false, message: 'The built-in models are not downloaded yet.', model };
}

export function getAiRouterService(): AiRouterService {
  if (_service) return _service;
  const builtinModels = {
    chat: getModelForRole('chat')?.id ?? 'gemma3:12b',
    embeddings: getModelForRole('embed')?.id ?? 'snowflake-arctic-embed2',
    reranker: getModelForRole('rerank')?.id ?? 'bge-reranker-v2-m3',
  };
  const store = new RouterStore(defaultIo(), settingsStoreLegacyKeys(), builtinModels);
  const workDir = path.join(userDataDir(), 'ai-router-run');
  // A crashed run leaves its private config folder behind; nothing can be using one at startup.
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  const sidecar = new LitellmSidecar({
    runtimeDir: resolveLitellmRuntimeDir,
    workDir: () => workDir,
    assignToJob: nativeJobAssignKillOnClose,
    log: (m) => logger.log(m),
  });
  const router = new AiRouter({
    store,
    sidecar,
    log: (m) => logger.log(m),
    builtinProbe,
    onEmbeddingIdentity: (identity) => {
      void import('../ann-index.js').then((m) => m.setAnnModelTag(identity)).catch(() => undefined);
    },
  });
  _service = { store, sidecar, router };
  return _service;
}

export function getAiRouter(): AiRouter {
  return getAiRouterService().router;
}

let _warnedRouteFailure = false;

/**
 * Where a role goes right now. Callers on the Oracle's path (embeddings, reranking) use this so a
 * router that cannot even be built never breaks them: that case is the local backend, logged once.
 */
export function routeFor(role: AiRole): ResolvedRoute {
  try {
    return getAiRouterService().router.resolve(role);
  } catch (err) {
    if (!_warnedRouteFailure) {
      _warnedRouteFailure = true;
      logger.warn('[AI Router] could not resolve the route; using the local backend:', err instanceof Error ? err.message : err);
    }
    return { via: 'local' };
  }
}

/** Test seam. */
export function __setAiRouterServiceForTests(s: AiRouterService | null): void {
  _service = s;
}

/**
 * App start: show a connector row for each key already saved, make the chat route follow the
 * Settings provider selector, start the scheduled re-check. Never throws (the app starts without it).
 */
export function initAiRouter(): void {
  try {
    const { store, router } = getAiRouterService();
    store.adoptLegacyKeys();
    applyLegacyChatProvider(store, settingsStore.getPreferredChatProvider());
    router.startScheduler();
  } catch (err) {
    logger.error('[AI Router] init failed:', err);
  }
}

/**
 * A key was saved or removed through the current Settings key fields (settings-store holds the
 * three legacy keys): show its connector row, drop routes that lost their key. Never throws.
 */
export function onLegacyKeysChanged(): void {
  try {
    const { store } = getAiRouterService();
    store.adoptLegacyKeys();
    store.reconcile();
  } catch (err) {
    logger.warn('[AI Router] could not follow a key change:', err instanceof Error ? err.message : err);
  }
}

/** The Settings provider selector changed: route chat the same way. Never throws. */
export function followChatProvider(provider: LegacyProvider, opts: { anthropicModel?: string } = {}): void {
  try {
    const { store } = getAiRouterService();
    store.adoptLegacyKeys();
    applyLegacyChatProvider(store, provider, opts);
  } catch (err) {
    logger.warn('[AI Router] could not follow the chat provider:', err instanceof Error ? err.message : err);
  }
}

/**
 * Before a chat turn: the renderer still keeps the Azure endpoint/deployment/version and the
 * Anthropic model in its Settings; take them into the connectors and keep the chat route on the
 * provider the user selected. Never throws.
 */
export function syncChatConnectorsFromPayload(
  provider: LegacyProvider,
  payload: { azureEndpoint?: unknown; azureDeployment?: unknown; azureApiVersion?: unknown; anthropicModel?: unknown } | null | undefined,
): void {
  try {
    const { store } = getAiRouterService();
    const str = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 500) : '');
    if (provider === 'azure-openai') {
      syncAzureConnector(store, { endpoint: str(payload?.azureEndpoint), deployment: str(payload?.azureDeployment), apiVersion: str(payload?.azureApiVersion) });
    }
    const model = provider === 'anthropic' ? str(payload?.anthropicModel) : '';
    applyLegacyChatProvider(store, provider, model ? { anthropicModel: model } : {});
  } catch (err) {
    logger.warn('[AI Router] could not sync the chat connectors:', err instanceof Error ? err.message : err);
  }
}

/** Quit path: stop the scheduler and kill LiteLLM now. Never throws. */
export function shutdownAiRouter(): void {
  try {
    _service?.router.stopScheduler();
    _service?.sidecar.stopSync();
  } catch { /* quitting anyway */ }
}
