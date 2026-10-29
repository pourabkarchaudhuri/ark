/**
 * safe-logger never writes query-string secrets (API keys travel as `?key=`).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger, redactSecrets } from '../../../electron/safe-logger';

afterEach(() => vi.restoreAllMocks());

describe('redactSecrets', () => {
  it('redacts key/token style query params and keeps the rest', () => {
    expect(redactSecrets('GET https://api.gg.deals/v1/prices/by-steam-app-id/?ids=1,2&key=abc123&region=us'))
      .toBe('GET https://api.gg.deals/v1/prices/by-steam-app-id/?ids=1,2&key=[redacted]&region=us');
    expect(redactSecrets('https://x.test/?access_token=zzz')).toBe('https://x.test/?access_token=[redacted]');
    expect(redactSecrets('https://api.steampowered.com/a?key=K&steamid=1')).toBe('https://api.steampowered.com/a?key=[redacted]&steamid=1');
    expect(redactSecrets('no secrets here, keyboard=1')).toBe('no secrets here, keyboard=1');
  });
});

describe('logger', () => {
  it('redacts strings, Error messages/stacks and shallow object fields before writing', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = new Error('failed https://a.test/?key=SECRET1');
    logger.log('url https://a.test/?key=SECRET2', err, { url: 'https://a.test/?token=SECRET3', n: 1 });
    const out = JSON.stringify(spy.mock.calls[0], (_k, v) => (v instanceof Error ? `${v.message} ${v.stack}` : v));
    expect(out).not.toMatch(/SECRET/);
    expect(out).toContain('[redacted]');
  });
});
