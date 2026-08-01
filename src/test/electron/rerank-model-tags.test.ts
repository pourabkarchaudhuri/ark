import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Covers Workstream 1 (reranker pull fix):
 *  - the new namespaced+quantized Qwen3 default tag resolves through
 *    getRerankQwenModelTag(),
 *  - loadSettings() migrates ONLY the legacy `qwen3-reranker:0.6b` tag and
 *    leaves custom user tags alone,
 *  - isRerankModelInstalled() matches the new tag against a /api/tags list,
 *  - a failed background pull surfaces the real error text.
 *
 * settings-store.ts pulls `electron`, `fs` and a persisted settings.json at
 * import time, so those are mocked and the module graph is rebuilt per scenario
 * with vi.resetModules().
 */

const mockState = vi.hoisted(() => ({
  fileExists: false,
  fileContent: '{}',
  writes: [] as Array<{ path: string; data: string }>,
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'userData' ? '/tmp/ark-test' : '/tmp/ark-cache')),
  },
}));

vi.mock('fs', () => {
  const api = {
    existsSync: vi.fn(() => mockState.fileExists),
    readFileSync: vi.fn(() => mockState.fileContent),
    writeFileSync: vi.fn((p: string, data: string) => {
      mockState.writes.push({ path: String(p), data: String(data) });
    }),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
  return { ...api, default: api };
});

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const NEW_TAG = 'dengcao/Qwen3-Reranker-0.6B:Q8_0';
const LEGACY_TAG = 'qwen3-reranker:0.6b';

async function loadFresh() {
  vi.resetModules();
  const store = await import('../../../electron/settings-store');
  const setup = await import('../../../electron/ollama-setup');
  return { store, setup };
}

beforeEach(() => {
  mockState.fileExists = false;
  mockState.fileContent = '{}';
  mockState.writes = [];
});

describe('DEFAULT_OLLAMA_RERANK_QWEN_MODEL', () => {
  it('is the real namespaced+quantized registry tag', async () => {
    const { store } = await loadFresh();
    expect(store.DEFAULT_OLLAMA_RERANK_QWEN_MODEL).toBe(NEW_TAG);
  });

  it('resolves through getRerankQwenModelTag() when no user override exists', async () => {
    const { setup } = await loadFresh();
    expect(setup.getRerankQwenModelTag()).toBe(NEW_TAG);
  });
});

describe('migrateOllamaRerankQwenModel (pure decision)', () => {
  it('rewrites exactly qwen3-reranker:0.6b to the new default and reports the change', async () => {
    const { store } = await loadFresh();
    const ollama = { rerankQwenModel: LEGACY_TAG };
    const changed = store.migrateOllamaRerankQwenModel(ollama);
    expect(changed).toBe(true);
    expect(ollama.rerankQwenModel).toBe(NEW_TAG);
  });

  it('leaves a custom user tag untouched', async () => {
    const { store } = await loadFresh();
    const ollama = { rerankQwenModel: 'my/custom-reranker:latest' };
    const changed = store.migrateOllamaRerankQwenModel(ollama);
    expect(changed).toBe(false);
    expect(ollama.rerankQwenModel).toBe('my/custom-reranker:latest');
  });

  it('leaves the already-migrated new default untouched', async () => {
    const { store } = await loadFresh();
    const ollama = { rerankQwenModel: NEW_TAG };
    expect(store.migrateOllamaRerankQwenModel(ollama)).toBe(false);
    expect(ollama.rerankQwenModel).toBe(NEW_TAG);
  });
});

describe('isRerankModelInstalled', () => {
  it('matches the new tag against a /api/tags-style installed list', async () => {
    const { setup } = await loadFresh();
    const fullTags = ['snowflake-arctic-embed2:latest', NEW_TAG];
    const baseNames = fullTags.map((t) => t.split(':')[0]);
    expect(setup.isRerankModelInstalled(baseNames, fullTags, NEW_TAG)).toBe(true);
  });

  it('matches case-insensitively and across quantization variants of the same base', async () => {
    const { setup } = await loadFresh();
    expect(
      setup.isRerankModelInstalled([], ['dengcao/qwen3-reranker-0.6b:f16'], NEW_TAG),
    ).toBe(true);
  });

  it('returns false when the reranker is not installed', async () => {
    const { setup } = await loadFresh();
    expect(
      setup.isRerankModelInstalled(
        ['snowflake-arctic-embed2'],
        ['snowflake-arctic-embed2:latest'],
        NEW_TAG,
      ),
    ).toBe(false);
  });
});

describe('buildRerankPullFailureEvent', () => {
  it('carries the real pull error text in both status and error, staying on cosine', async () => {
    const { setup } = await loadFresh();
    const realErr = 'Error: pull model manifest: file does not exist';
    const ev = setup.buildRerankPullFailureEvent(NEW_TAG, realErr, 'Cosine fallback');

    expect(ev.tier).toBe('embed_fallback');
    expect(ev.done).toBe(true);
    expect(ev.status).toContain(realErr);
    expect(ev.error).toContain(realErr);
    expect(ev.error).toContain(NEW_TAG);
  });

  it('falls back to a generic message when no status was captured', async () => {
    const { setup } = await loadFresh();
    const ev = setup.buildRerankPullFailureEvent(NEW_TAG, null, 'Cosine fallback');

    expect(ev.status).toBe(`Cosine fallback — could not download ${NEW_TAG}`);
    expect(ev.error).toBe(`Failed to pull ${NEW_TAG}`);
  });
});
