/**
 * settings:getApiKeyHint (v1.0.97): the renderer only ever sees whether a Gemini
 * key exists plus a short hint, never the decrypted key.
 */
import { describe, it, expect } from 'vitest';
import { secretHint } from '../../../electron/secret-hint';

describe('secretHint', () => {
  it('reports no key for null/empty', () => {
    expect(secretHint(null)).toEqual({ has: false, hint: '' });
    expect(secretHint('')).toEqual({ has: false, hint: '' });
  });

  it('shows the first and last 4 characters of a normal key', () => {
    const key = 'AIzaSyD-1234567890abcdefWXYZ';
    const r = secretHint(key);
    expect(r).toEqual({ has: true, hint: 'AIza…WXYZ' });
    expect(r.hint).not.toContain('1234567890');
  });

  it('reveals nothing of a short key', () => {
    expect(secretHint('abc12345')).toEqual({ has: true, hint: '••••' });
  });
});
