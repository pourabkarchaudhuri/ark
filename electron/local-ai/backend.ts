/**
 * Which local AI backend is active (1.0.97 B36).
 *
 *  - built-in (default): Ark's own llama.cpp servers, see builtin-backend.ts. Every install
 *    starts here, including installs that used Ollama before.
 *  - external Ollama (Settings > Advanced, "Use my own Ollama at URL", off by default): the
 *    original Ollama-protocol implementation in ollama-setup.ts / rerank-engine.ts /
 *    ollama-handlers.ts, pointed at the user's URL. Ark never reads or changes the user's Ollama
 *    models folder in either mode.
 *
 * Entry points that used to talk to `http://localhost:11434` call `useBuiltinBackend()` and, when
 * it is true, `getBuiltinBackend()`. The built-in servers never use port 11434, so both can run
 * at the same time.
 */
import { settingsStore } from '../settings-store.js';
import type { BuiltinBackend } from './builtin-backend.js';
import { getLocalAiService } from './service.js';

export type BackendKind = 'builtin' | 'ollama';

export function getBackendKind(): BackendKind {
  // A store without the local-AI settings (old test doubles) is the legacy Ollama setup.
  const read = (settingsStore as { getLocalAiSettings?: () => { useExternalOllama: boolean } }).getLocalAiSettings;
  if (typeof read !== 'function') return 'ollama';
  return read.call(settingsStore).useExternalOllama ? 'ollama' : 'builtin';
}

export function useBuiltinBackend(): boolean {
  return getBackendKind() === 'builtin';
}

let _override: BuiltinBackend | null = null;

export function getBuiltinBackend(): BuiltinBackend {
  return _override ?? getLocalAiService().backend;
}

/** Test seam: use a fake built-in backend. */
export function __setBuiltinBackendForTests(b: BuiltinBackend | null): void {
  _override = b;
}
