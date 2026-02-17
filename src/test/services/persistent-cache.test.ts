import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs before any imports that use it
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  writeFile: vi.fn((_p: string, _d: string, _e: string, cb?: (err: Error | null) => void) => cb?.(null)),
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
});
