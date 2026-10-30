/**
 * session:setTrackedGames options (1.0.97 B10, hooks#16): only the known
 * store names pass through as keepSources; anything else from the renderer
 * is dropped, so a malformed call can never keep a source by accident.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sanitizeKeepSources } from '../../../electron/ipc/session-handlers';

describe('sanitizeKeepSources', () => {
  it('passes the known sources through', () => {
    expect(sanitizeKeepSources({ keepSources: ['library'] })).toEqual(['library']);
    expect(sanitizeKeepSources({ keepSources: ['custom', 'library'] })).toEqual(['library', 'custom']);
  });

  it('drops unknown values and malformed options', () => {
    expect(sanitizeKeepSources({ keepSources: ['steam', 42, null] })).toEqual([]);
    expect(sanitizeKeepSources({ keepSources: 'library' })).toEqual([]);
    expect(sanitizeKeepSources(undefined)).toEqual([]);
    expect(sanitizeKeepSources(null)).toEqual([]);
  });
});
