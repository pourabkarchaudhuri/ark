import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';

// Mock fs before any imports that use it
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFile: vi.fn((_p: string, _d: string, _e: string, cb?: (err: Error | null) => void) => cb?.(null)),
  rename: vi.fn((_a: string, _b: string, cb?: (err: Error | null) => void) => cb?.(null)),
  unlink: vi.fn((_p: string, cb?: (err: Error | null) => void) => cb?.(null)),
  promises: { readFile: vi.fn(), writeFile: vi.fn() },
}));

// Mock electron app.getPath so PersistentCache can construct cache path
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'userData' ? './test-cache' : './cache')),
  },
}));

// Mock safe-logger to avoid EPIPE/process streams in test env
vi.mock('../../../electron/safe-logger.js', () => ({
  logger: {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { PersistentCache } from '../../../electron/persistent-cache';

describe('PersistentCache', () => {
  let cache: PersistentCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new PersistentCache('test-cache.json');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('set and get', () => {
    it('returns stored value for a key', () => {
      cache.set('key1', { name: 'Elden Ring' });
      expect(cache.get('key1')).toEqual({ name: 'Elden Ring' });
    });

    it('returns null for missing key', () => {
      expect(cache.get('missing')).toBeNull();
    });

    it('overwrites value for same key', () => {
      cache.set('key1', 'first');
      cache.set('key1', 'second');
      expect(cache.get('key1')).toBe('second');
    });
  });

  describe('TTL expiry', () => {
    it('returns null when data is past TTL (without allowStale)', () => {
      const shortTtl = 100;
      cache.set('key1', 'value', shortTtl);
      expect(cache.get('key1')).toBe('value');

      vi.advanceTimersByTime(shortTtl + 1);
      expect(cache.get('key1')).toBeNull();
    });

    it('returns stale data when allowStale is true', () => {
      const shortTtl = 100;
      cache.set('key1', 'stale-value', shortTtl);

      vi.advanceTimersByTime(shortTtl + 1);
      expect(cache.get('key1', false)).toBeNull();
      expect(cache.get('key1', true)).toBe('stale-value');
    });
  });

  describe('has and isStale', () => {
    it('has returns true when data is fresh', () => {
      cache.set('key1', 'value', 5000);
      expect(cache.has('key1')).toBe(true);
    });

    it('has returns false when data is past TTL', () => {
      cache.set('key1', 'value', 100);
      vi.advanceTimersByTime(101);
      expect(cache.has('key1')).toBe(false);
    });

    it('isStale returns false when data is fresh', () => {
      cache.set('key1', 'value', 5000);
      expect(cache.isStale('key1')).toBe(false);
    });

    it('isStale returns true when data is past TTL', () => {
      cache.set('key1', 'value', 100);
      vi.advanceTimersByTime(101);
      expect(cache.isStale('key1')).toBe(true);
    });

    it('isStale returns true for missing key', () => {
      expect(cache.isStale('missing')).toBe(true);
    });
  });

  describe('getStats', () => {
    it('reports fresh and stale counts correctly', () => {
      cache.set('fresh1', 'a', 10_000);
      cache.set('fresh2', 'b', 10_000);
      cache.set('stale1', 'c', 50);

      vi.advanceTimersByTime(51);

      const stats = cache.getStats();
      expect(stats.total).toBe(3);
      expect(stats.fresh).toBe(2);
      expect(stats.stale).toBe(1);
    });

    it('returns zeros for empty cache', () => {
      const stats = cache.getStats();
      expect(stats).toEqual({ total: 0, fresh: 0, stale: 0 });
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      cache.set('key1', 'a');
      cache.set('key2', 'b');
      expect(cache.get('key1')).toBe('a');
      expect(cache.get('key2')).toBe('b');

      cache.clear();
      expect(cache.get('key1')).toBeNull();
      expect(cache.get('key2')).toBeNull();
    });
  });

  describe('eviction (over the 2,000-entry memory cap)', () => {
    it('keeps a long-lived entry through 2,001 short-lived sets', () => {
      cache.set('app-list', [1, 2, 3], 24 * 60 * 60 * 1000);
      for (let i = 0; i < 2_001; i++) cache.set(`d${i}`, i);
      expect(cache.get('app-list')).toEqual([1, 2, 3]);
      expect(cache.getStats().total).toBe(2_000);
      expect(cache.get('d0')).toBeNull(); // oldest short-lived went first
      expect(cache.get('d2000')).toBe(2000);
    });

    it('sweeps fully expired entries before evicting live ones', () => {
      cache.set('old', 'x', 100);
      vi.advanceTimersByTime(25 * 60 * 60 * 1000); // past the 24h hard expiry
      for (let i = 0; i < 2_000; i++) cache.set(`d${i}`, i);
      expect(cache.getStats().total).toBe(2_000);
      expect(cache.get('d0')).toBe(0); // the expired entry made room, not d0
    });

    it('falls back to evicting long-lived entries when they alone exceed the cap', () => {
      for (let i = 0; i < 2_001; i++) cache.set(`l${i}`, i, 2 * 60 * 60 * 1000);
      expect(cache.getStats().total).toBe(2_000);
      expect(cache.get('l0')).toBeNull();
      expect(cache.get('l2000')).toBe(2000);
    });
  });

  describe('disk save policy', () => {
    const writes = () => vi.mocked(fs.writeFile).mock.calls.length;

    beforeEach(() => {
      vi.mocked(fs.writeFile).mockClear();
      vi.mocked(fs.writeFileSync).mockClear();
    });

    it('debounces a single set by 15 s', () => {
      cache.set('a', 1);
      vi.advanceTimersByTime(14_999);
      expect(writes()).toBe(0);
      vi.advanceTimersByTime(1);
      expect(writes()).toBe(1);
    });

    it('still saves by 60 s when sets keep arriving every 5 s', () => {
      for (let t = 0; t < 60_000; t += 5_000) {
        cache.set(`k${t}`, t);
        vi.advanceTimersByTime(5_000);
      }
      expect(writes()).toBeGreaterThanOrEqual(1);
    });

    it('a set during an in-flight async save stays dirty and is written by flushSync', () => {
      let finishWrite: (() => void) | null = null;
      vi.mocked(fs.writeFile).mockImplementationOnce(((_p: string, _d: string, _e: string, cb: (err: Error | null) => void) => {
        finishWrite = () => cb(null);
      }) as never);
      cache.set('a', 1);
      vi.advanceTimersByTime(15_000); // async save starts, write not finished
      cache.set('b', 2); // arrives mid-save
      finishWrite!();
      cache.flushSync();
      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(Object.keys(written).sort()).toEqual(['a', 'b']);
    });

    it('an async save finishing after a newer flushSync does not replace the file', () => {
      let finishWrite: (() => void) | null = null;
      vi.mocked(fs.writeFile).mockImplementationOnce(((_p: string, _d: string, _e: string, cb: (err: Error | null) => void) => {
        finishWrite = () => cb(null);
      }) as never);
      vi.mocked(fs.rename).mockClear();
      cache.set('a', 1);
      vi.advanceTimersByTime(15_000);
      cache.set('b', 2);
      cache.flushSync();
      finishWrite!();
      expect(fs.rename).not.toHaveBeenCalled();
    });

    it('flushSync is a no-op on a clean, non-empty cache', () => {
      cache.set('a', 1);
      vi.advanceTimersByTime(15_000); // async save completes
      expect(writes()).toBe(1);
      cache.flushSync();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('flushSync writes pending changes and cancels the debounced save', () => {
      cache.set('a', 1);
      cache.flushSync();
      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(writes()).toBe(0);
      cache.flushSync();
      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    });

    it('delete removes an entry and marks the cache dirty', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.flushSync();
      cache.delete('a');
      expect(cache.get('a')).toBeNull();
      cache.flushSync();
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[1][1] as string);
      expect(Object.keys(written)).toEqual(['b']);
    });
  });

  describe('lazy loading', () => {
    it('does not read the file until first use', () => {
      vi.mocked(fs.existsSync).mockClear();
      const c = new PersistentCache('lazy.json');
      expect(fs.existsSync).not.toHaveBeenCalled();
      c.get('x');
      expect(fs.existsSync).toHaveBeenCalledTimes(1);
      c.get('y');
      expect(fs.existsSync).toHaveBeenCalledTimes(1);
    });

    it('flushSync loads first so it never writes an empty map over the file', () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({ keep: { data: 1, timestamp: Date.now(), ttl: 60_000 } }));
      vi.mocked(fs.writeFileSync).mockClear();
      const c = new PersistentCache('lazy2.json');
      c.flushSync(); // clean after load -> nothing to write
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      c.set('new', 2);
      c.flushSync();
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(Object.keys(written).sort()).toEqual(['keep', 'new']);
    });
  });
});
