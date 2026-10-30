import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * Ollama runtime fixes in ollama-setup.ts:
 *  - every embed request body sends the shared finite OLLAMA_KEEP_ALIVE,
 *  - unloadArkModels sends one keep_alive:0 per loaded Ark model and is bounded,
 *  - pullModel settles once and never reports a truncated stream as success,
 *  - overlapping rerank pulls for two tags keep separate in-flight slots.
 *
 * `http` is replaced by a scripted fake: each request's response is produced by
 * the next entry in `net.script` (keyed by path), so streams can end early,
 * error, or close without completing.
 */

type FakeRes = EventEmitter & { statusCode: number; complete: boolean; resume: () => void };
type FakeReq = EventEmitter & { write: (b: string) => void; end: () => void; destroy: () => void };
type Script = (res: FakeRes, req: FakeReq) => void;

const net = vi.hoisted(() => ({
  /** Per-path queue of response scripts, consumed in order. */
  script: {} as Record<string, Array<(res: any, req: any) => void>>,
  /** Bodies of every http.request, in order. */
  bodies: [] as Array<{ path: string; body: string }>,
  /** /api/tags model names served to listModels. */
  tags: [] as string[],
}));

vi.mock('http', () => {
  const makeRes = (): FakeRes => Object.assign(new EventEmitter(), {
    statusCode: 200,
    complete: false,
    resume: () => {},
  });
  const request = (opts: { path: string }, cb: (res: FakeRes) => void) => {
    let body = '';
    const req = Object.assign(new EventEmitter(), {
      write: (b: string) => { body += b; },
      destroy: () => {},
      end: () => {
        net.bodies.push({ path: opts.path, body });
        const next = net.script[opts.path]?.shift();
        setTimeout(() => {
          const res = makeRes();
          cb(res);
          next?.(res, req);
        }, 0);
      },
    }) as FakeReq;
    return req;
  };
  const get = (opts: { path: string }, cb: (res: FakeRes) => void) => {
    const req = Object.assign(new EventEmitter(), { destroy: () => {} });
    setTimeout(() => {
      const res = makeRes();
      cb(res);
      if (opts.path === '/api/tags') {
        res.emit('data', Buffer.from(JSON.stringify({ models: net.tags.map((name) => ({ name })) })));
      }
      res.complete = true;
      res.emit('end');
    }, 0);
    return req;
  };
  const api = { request, get };
  return { ...api, default: api };
});

vi.mock('../../../electron/settings-store.js', () => ({
  settingsStore: {
    getOllamaSettings: () => ({ url: 'http://127.0.0.1:11434', embeddingBatchSize: 0 }),
  },
  DEFAULT_OLLAMA_RERANK_MODEL: 'dengcao/bge-reranker-v2-m3',
  DEFAULT_OLLAMA_RERANK_QWEN_MODEL: 'dengcao/Qwen3-Reranker-0.6B:Q8_0',
}));

vi.mock('../../../electron/rerank-engine.js', () => ({ resetRerankTierCache: vi.fn() }));

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  OLLAMA_KEEP_ALIVE,
  ensureRerankModelPull,
  generateEmbeddingsBatchDetailed,
  isExactTagInstalled,
  pullModel,
  resetRerankPullAttempts,
  unloadArkModels,
} from '../../../electron/ollama-setup';

const line = (obj: unknown) => Buffer.from(`${JSON.stringify(obj)}\n`);
const queue = (path: string, ...scripts: Script[]) => {
  (net.script[path] ??= []).push(...scripts);
};
/** A pull stream that sends progress and then a final success line. */
const okPull: Script = (res) => {
  res.emit('data', line({ status: 'downloading', total: 100, completed: 50 }));
  res.emit('data', line({ status: 'success' }));
  res.complete = true;
  res.emit('end');
};
/** A pull stream that ends cleanly but never sends "success". */
const truncatedPull: Script = (res) => {
  res.emit('data', line({ status: 'downloading', total: 100, completed: 50 }));
  res.complete = true;
  res.emit('end');
};

const fetchMock = vi.fn();

beforeEach(() => {
  net.script = {};
  net.bodies = [];
  net.tags = [];
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  resetRerankPullAttempts();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('keep_alive', () => {
  it('is a finite window, never -1', () => {
    expect(OLLAMA_KEEP_ALIVE).not.toBe(-1);
    expect(typeof OLLAMA_KEEP_ALIVE).toBe('string');
  });

  it('every embed request body carries the shared constant', async () => {
    queue('/api/embed', (res) => {
      res.emit('data', Buffer.from(JSON.stringify({ embeddings: [[0.1], [0.2]] })));
      res.complete = true;
      res.emit('end');
    });
    await generateEmbeddingsBatchDetailed(['a', 'b'], {});
    const embed = net.bodies.filter((b) => b.path === '/api/embed');
    expect(embed).toHaveLength(1);
    expect(JSON.parse(embed[0].body).keep_alive).toBe(OLLAMA_KEEP_ALIVE);
  });
});

describe('unloadArkModels', () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it('sends one keep_alive:0 per loaded Ark model and leaves other models alone', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/ps')) {
        return json({
          models: [
            { name: 'snowflake-arctic-embed2:latest' },
            { name: 'dengcao/Qwen3-Reranker-0.6B:Q8_0' },
            { name: 'llama3.1:8b' },
          ],
        });
      }
      return json({});
    });

    const unloaded = await unloadArkModels();

    expect(unloaded.sort()).toEqual(['dengcao/Qwen3-Reranker-0.6B:Q8_0', 'snowflake-arctic-embed2:latest']);
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(2);
    const byPath = Object.fromEntries(posts.map(([url, init]) => [new URL(url).pathname, JSON.parse(init.body)]));
    expect(byPath['/api/embed']).toEqual({ model: 'snowflake-arctic-embed2:latest', input: [], keep_alive: 0 });
    expect(byPath['/api/generate']).toEqual({ model: 'dengcao/Qwen3-Reranker-0.6B:Q8_0', prompt: '', keep_alive: 0 });
  });

  it('never blocks beyond its timeout when Ollama hangs', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {})); // never settles
    const p = unloadArkModels({ timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toEqual([]);
  });

  it('never throws when Ollama is down', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(unloadArkModels()).resolves.toEqual([]);
  });
});

describe('pullModel', () => {
  it('a normal stream with the final success line resolves true', async () => {
    queue('/api/pull', okPull);
    await expect(pullModel('m:tag')).resolves.toBe(true);
  });

  it('a stream that ends without success resolves false when the tag is not installed', async () => {
    queue('/api/pull', truncatedPull);
    net.tags = ['other:latest'];
    await expect(pullModel('m:tag')).resolves.toBe(false);
  });

  it('a stream that ends without success resolves true when /api/tags confirms the tag', async () => {
    queue('/api/pull', truncatedPull);
    net.tags = ['m:tag'];
    await expect(pullModel('m:tag')).resolves.toBe(true);
  });

  it('a stream error resolves false without an uncaught exception', async () => {
    queue('/api/pull', (res) => {
      res.emit('data', line({ status: 'downloading', total: 100, completed: 10 }));
      res.emit('error', new Error('socket hang up'));
      res.emit('close');
    });
    await expect(pullModel('m:tag')).resolves.toBe(false);
  });

  it('a close before the response completes resolves false instead of hanging', async () => {
    queue('/api/pull', (res) => {
      res.emit('data', line({ status: 'downloading', total: 100, completed: 10 }));
      res.emit('close');
    });
    await expect(pullModel('m:tag')).resolves.toBe(false);
  });

  it('an error line in the stream resolves false', async () => {
    queue('/api/pull', (res) => {
      res.emit('data', line({ error: 'pull model manifest: file does not exist' }));
      res.complete = true;
      res.emit('end');
    });
    await expect(pullModel('m:tag')).resolves.toBe(false);
  });
});

describe('isExactTagInstalled', () => {
  it('treats a bare name as :latest and does not accept other quantizations', () => {
    expect(isExactTagInstalled(['m:latest'], 'm')).toBe(true);
    expect(isExactTagInstalled(['m:q4'], 'm:q8')).toBe(false);
    expect(isExactTagInstalled(['M:Q8'], 'm:q8')).toBe(true);
  });
});

describe('ensureRerankModelPull in-flight slots', () => {
  it('overlapping pulls for two tags: after A finishes, a new call for B reuses B', async () => {
    let finishB: (() => void) | null = null;
    queue('/api/pull', okPull, (res) => {
      // B stays open until the test finishes it.
      finishB = () => okPull(res, undefined as unknown as FakeReq);
    });

    const a = ensureRerankModelPull('tag-a');
    const b = ensureRerankModelPull('tag-b');
    await expect(a).resolves.toBe(true);

    const bAgain = ensureRerankModelPull('tag-b');
    expect(bAgain).toBe(b);
    expect(net.bodies.filter((x) => x.path === '/api/pull')).toHaveLength(2);

    await vi.waitFor(() => expect(finishB).not.toBeNull());
    finishB!();
    await expect(b).resolves.toBe(true);
  });

  it('a second call for the same tag shares the in-flight pull', async () => {
    queue('/api/pull', okPull);
    const first = ensureRerankModelPull('tag-a');
    expect(ensureRerankModelPull('tag-a')).toBe(first);
    await first;
    expect(net.bodies.filter((x) => x.path === '/api/pull')).toHaveLength(1);
  });
});
