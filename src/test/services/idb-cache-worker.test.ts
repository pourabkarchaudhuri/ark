/**
 * idb-cache worker (1.0.97 B19).
 *
 *  - renderer-stores#28: slimGames kept the full Steam `longDescription` HTML
 *    (a few MB across ~600 browse games on every save and boot) while
 *    stripping fields no game has. It now keeps a plain-text copy of the
 *    window the adult filter reads (first 1500 chars).
 *  - oracle#25: a failed IndexedDB open stayed cached as a rejected promise,
 *    so every later save/load failed for the rest of the session.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isAdultContentByDescription } from '@/services/adult-content-filter';

let worker: typeof import('@/workers/idb-cache.worker');
const posted: any[] = [];

beforeEach(async () => {
  posted.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(self, 'postMessage').mockImplementation(((msg: unknown) => { posted.push(msg); }) as any);
  vi.resetModules();
  worker = await import('@/workers/idb-cache.worker');
  worker.__resetIdbCacheWorkerForTests();
});

afterEach(() => {
  worker.__resetIdbCacheWorkerForTests();
  vi.restoreAllMocks();
});

async function send(data: unknown): Promise<any> {
  const before = posted.length;
  await (self.onmessage as (e: MessageEvent) => Promise<void>)({ data } as MessageEvent);
  return posted[before];
}

const bigHtml = (() => {
  const para = '<p>Explore a <strong>vast</strong> open world full of <em>secrets</em> and danger.</p>\n'
    + '<img src="https://cdn.example/x.jpg" alt="screenshot"><br>';
  let s = '';
  while (s.length < 20_000) s += para;
  return s;
})();

describe('slimGames — longDescription', () => {
  it('turns 20 KB of Steam HTML into at most 1500 plain chars', () => {
    const [slim] = worker.slimGames([{ id: 'steam-1', title: 'X', summary: 's', longDescription: bigHtml, screenshots: ['a'] }]);
    expect(slim.longDescription.length).toBeLessThanOrEqual(1500);
    expect(slim.longDescription).not.toMatch(/[<>]/);
    expect(slim.longDescription).toContain('Explore a vast open world');
    expect(slim.screenshots).toBeUndefined();
    expect(slim.summary).toBe('s');
  });

  it('leaves an empty or missing longDescription as is', () => {
    const [a, b] = worker.slimGames([{ id: 'epic-1', longDescription: '' }, { id: 'steam-2' }]);
    expect(a.longDescription).toBe('');
    expect('longDescription' in b).toBe(false);
  });

  it('keeps the adult-filter verdict on cached rows', () => {
    const fixtures = [
      { id: 'steam-901', title: 'Garden Sim', summary: 'Grow plants.', longDescription: bigHtml },
      {
        id: 'steam-902', title: 'Night Club', summary: 'A story.',
        longDescription: '<h2>About</h2><p>This game contains <b>explicit sexual content</b> and nudity.</p>' + bigHtml,
      },
    ];
    const verdicts: boolean[] = [];
    for (const g of fixtures) {
      // The filter caches verdicts by id: give the slim row its own id so it is really re-evaluated.
      const raw = isAdultContentByDescription({ ...g, id: `${g.id}-raw` });
      const [slim] = worker.slimGames([g]);
      expect(isAdultContentByDescription({ ...slim, id: `${g.id}-slim` })).toBe(raw);
      verdicts.push(raw);
    }
    expect(verdicts).toEqual([false, true]); // the fixture exercises both verdicts
  });
});

describe('IndexedDB open failure is not cached', () => {
  it('a save after a failed first open succeeds', async () => {
    const realOpen = indexedDB.open.bind(indexedDB);
    let calls = 0;
    const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation(((name: string, version?: number) => {
      calls++;
      if (calls === 1) {
        const req: any = { error: new DOMException('boom', 'UnknownError') };
        setTimeout(() => req.onerror?.(new Event('error')), 0);
        return req as IDBOpenDBRequest;
      }
      return realOpen(name, version);
    }) as typeof indexedDB.open);

    const first = await send({ type: 'save', games: [{ id: 'steam-1' }] });
    expect(first).toEqual({ type: 'save-done', error: true });

    const second = await send({ type: 'save', games: [{ id: 'steam-1', title: 'X' }] });
    expect(second).toEqual({ type: 'save-done' });
    openSpy.mockRestore();

    const loaded = await send({ type: 'load' });
    expect(loaded.type).toBe('load-result');
    expect(loaded.data.games).toEqual([{ id: 'steam-1', title: 'X' }]);
  });
});
