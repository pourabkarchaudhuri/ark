import { describe, expect, it } from 'vitest';
import { sanitizeResult, sanitizeString } from '../../scripts/perf/lib/sanitize.mjs';

describe('perf result sanitising', () => {
  it('replaces absolute paths with their last segment', () => {
    expect(sanitizeString('C:\\Users\\jdoe\\AppData\\Local\\Temp\\ark-perf-seed')).toBe('<path>/ark-perf-seed');
    expect(sanitizeString('seed at C:/Users/jdoe/AppData/Local/Temp/ark-perf-seed, ok')).toBe('seed at <path>/ark-perf-seed, ok');
    expect(sanitizeString('/home/jdoe/work/ark/dist')).toBe('<path>/dist');
  });

  it('removes extra user names and leaves numbers and labels alone', () => {
    const out = sanitizeResult({ a: 1, label: 'v1.0.97', note: 'run by jdoe on build 12', nested: [{ p: 'D:\\x\\y.json' }] }, ['jdoe']);
    expect(out).toEqual({ a: 1, label: 'v1.0.97', note: 'run by <user> on build 12', nested: [{ p: '<path>/y.json' }] });
  });

  it('keeps the hardware description', () => {
    const m = '12th Gen Intel(R) Core(TM) i9-12900H x20, 32 GB, win32 10.0.26200';
    expect(sanitizeString(m)).toBe(m);
  });
});
