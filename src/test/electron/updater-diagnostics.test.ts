/**
 * classifyUpdateError — turns raw electron-updater / Node / Chromium failures into an actionable kind + hint.
 */
import { describe, it, expect } from 'vitest';
import { classifyUpdateError } from '../../../electron/updater-diagnostics';

const withCode = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});

describe('classifyUpdateError', () => {
  it.each([
    [withCode('net::ERR_CONNECTION_RESET'), 'network-reset', 'ERR_CONNECTION_RESET'],
    [withCode('read ECONNRESET', 'ECONNRESET'), 'network-reset', 'ECONNRESET'],
    [withCode('socket hang up'), 'network-reset', undefined],
    [withCode('net::ERR_BLOCKED_BY_CLIENT'), 'blocked-by-client', 'ERR_BLOCKED_BY_CLIENT'],
    [withCode('cut twice', 'BLOCKED_AT_OFFSET'), 'blocked-by-client', 'BLOCKED_AT_OFFSET'],
    [withCode('connect ETIMEDOUT 140.82.112.3:443', 'ETIMEDOUT'), 'network-timeout', 'ETIMEDOUT'],
    [withCode('net::ERR_TIMED_OUT'), 'network-timeout', 'ERR_TIMED_OUT'],
    [withCode('getaddrinfo ENOTFOUND github.com', 'ENOTFOUND'), 'dns', 'ENOTFOUND'],
    [withCode('unable to verify the first certificate', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'tls', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
    [withCode('sha512 checksum mismatch, expected abc, got def'), 'checksum', undefined],
    [withCode('ENOSPC: no space left on device', 'ENOSPC'), 'disk-full', 'ENOSPC'],
    [withCode("EPERM: operation not permitted, rename '…'", 'EPERM'), 'file-locked', 'EPERM'],
  ])('%s → %s', (err, kind, code) => {
    const info = classifyUpdateError(err);
    expect(info.kind).toBe(kind);
    expect(info.code).toBe(code);
    expect(info.hint.length).toBeGreaterThan(10);
  });

  it('reads HTTP status from statusCode or the message', () => {
    expect(classifyUpdateError(Object.assign(new Error('x'), { statusCode: 404 }))).toMatchObject({ kind: 'http', httpStatus: 404 });
    expect(classifyUpdateError(new Error('HttpError: 503 Service Unavailable status code 503'))).toMatchObject({ kind: 'http', httpStatus: 503 });
    expect(classifyUpdateError(Object.assign(new Error('x'), { statusCode: 429 })).hint).toMatch(/rate-limit/);
  });

  it('never throws on odd input and falls back to unknown', () => {
    expect(classifyUpdateError(null).kind).toBe('unknown');
    expect(classifyUpdateError(undefined).kind).toBe('unknown');
    expect(classifyUpdateError('weird string').kind).toBe('unknown');
    expect(classifyUpdateError({}).kind).toBe('unknown');
  });
});
