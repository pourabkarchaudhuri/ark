import { describe, it, expect, vi } from 'vitest';

/**
 * Ollama chat context window setting (1.0.97 B12, main-apis#49): getOllamaSettings
 * always yields a usable chatNumCtx (default 8192, clamped 2048..131072 by
 * clampChatNumCtx, which setOllamaSettings also applies).
 *
 * settings-store.ts reads `fs` at import time, so it is mocked.
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/ark-test') },
}));

vi.mock('fs', () => {
  const api = {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
  return { ...api, default: api };
});

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { clampChatNumCtx, DEFAULT_CHAT_NUM_CTX, settingsStore } from '../../../electron/settings-store';

describe('chat num_ctx setting', () => {
  it('clamps values and falls back to the 8192 default', () => {
    expect(DEFAULT_CHAT_NUM_CTX).toBe(8192);
    expect(clampChatNumCtx(undefined)).toBe(8192);
    expect(clampChatNumCtx('abc')).toBe(8192);
    expect(clampChatNumCtx(0)).toBe(8192);
    expect(clampChatNumCtx(512)).toBe(2048);
    expect(clampChatNumCtx(16384.4)).toBe(16384);
    expect(clampChatNumCtx(10_000_000)).toBe(131072);
  });

  // Read-only: settings-store loads electron through createRequire, so saving is not exercised here.
  it('defaults in getOllamaSettings', () => {
    expect(settingsStore.getOllamaSettings().chatNumCtx).toBe(8192);
  });
});
