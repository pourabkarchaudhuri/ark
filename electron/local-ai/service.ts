/**
 * Wiring of the built-in local AI for the real app (1.0.97 B36): where the runtime and the models
 * live, one shared ModelStore + LlamaRuntime + BuiltinBackend per process, and shutdown.
 *
 * Paths:
 *  - runtime: `resources/llama-runtime` when packaged, `build/llama-runtime` in development
 *    (scripts/build-llama-runtime.mjs fills it).
 *  - models: `%LOCALAPPDATA%\Ark\models` (not roaming, so it survives updates and is never synced),
 *    or the folder chosen in Settings.
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { settingsStore } from '../settings-store.js';
import { logger } from '../safe-logger.js';
import { nativeJobAssignKillOnClose } from '../native-bridge.js';
import { BuiltinBackend } from './builtin-backend.js';
import { LlamaRuntime } from './llama-runtime.js';
import { getManifest } from './manifest.js';
import { ModelStore } from './model-store.js';

const require = createRequire(import.meta.url);

/** Default models folder: %LOCALAPPDATA%\Ark\models (a fallback under the home folder elsewhere). */
export function defaultModelsDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const base = env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local');
  return path.join(base, 'Ark', 'models');
}

export function resolveModelsDir(): string {
  const custom = settingsStore.getLocalAiSettings().modelsDir;
  return custom ? path.resolve(custom) : defaultModelsDir();
}

function resolveRuntimeDir(): string {
  const { app } = require('electron') as typeof import('electron');
  return app.isPackaged
    ? path.join(process.resourcesPath, 'llama-runtime')
    : path.join(app.getAppPath(), 'build', 'llama-runtime');
}

export interface LocalAiService {
  store: ModelStore;
  runtime: LlamaRuntime;
  backend: BuiltinBackend;
}

let _service: LocalAiService | null = null;

export function getLocalAiService(): LocalAiService {
  if (_service) return _service;
  const store = new ModelStore({
    models: () => getManifest().models,
    modelsDir: resolveModelsDir,
    log: (m) => logger.log(m),
  });
  const runtime = new LlamaRuntime({
    runtimeDir: resolveRuntimeDir,
    modelPath: (role) => {
      const m = getManifest().models.find((x) => x.role === role);
      return m ? store.modelPath(role) : null;
    },
    assignToJob: nativeJobAssignKillOnClose,
    log: (m) => logger.log(m),
  });
  const backend = new BuiltinBackend({ runtime, store, runtimeBuild: getManifest().runtime.build });
  _service = { store, runtime, backend };
  return _service;
}

/** Test seam. */
export function __setLocalAiServiceForTests(s: LocalAiService | null): void {
  _service = s;
}

/** Quit path: kill every llama-server now. Never throws. */
export function shutdownLocalAi(): void {
  try { _service?.runtime.stopAllSync(); } catch { /* quitting anyway */ }
}
