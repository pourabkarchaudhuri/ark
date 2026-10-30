/**
 * steam:launchGame — narrow channel for the audit's "Open it" button. steam:
 * stays off the generic openExternal allowlist; only a validated numeric
 * appId reaches shell.openExternal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { launchSteamGame, __setWindowDepsForTests } from '../../../electron/ipc/window-handlers';

let openExternal: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openExternal = vi.fn(async () => undefined);
  __setWindowDepsForTests({ openExternal });
});

describe('launchSteamGame', () => {
  it('opens the exact rungameid URL for a valid id', async () => {
    expect(await launchSteamGame(730)).toEqual({ success: true });
    expect(openExternal).toHaveBeenCalledWith('steam://rungameid/730');
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2 ** 32, '730', '730/../x', null, undefined, { appId: 730 }])(
    'rejects %j without calling openExternal',
    async (bad) => {
      const result = await launchSteamGame(bad);
      expect(result.success).toBe(false);
      expect(openExternal).not.toHaveBeenCalled();
    },
  );

  it('returns a structured failure when openExternal rejects', async () => {
    __setWindowDepsForTests({ openExternal: async () => { throw new Error('no handler for steam:'); } });
    const result = await launchSteamGame(730);
    expect(result.success).toBe(false);
    expect(result.error).toContain('no handler');
  });
});
