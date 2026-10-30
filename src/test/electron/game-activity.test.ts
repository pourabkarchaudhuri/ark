import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  reportGameActivity,
  resetGameActivityForTests,
  setGameActivityListener,
} from '../../../electron/game-activity';

beforeEach(() => {
  resetGameActivityForTests();
});

describe('game activity signal', () => {
  it('fires only when the active-session count crosses zero', () => {
    const seen: boolean[] = [];
    setGameActivityListener((active) => seen.push(active));

    reportGameActivity(0); // still idle — nothing
    reportGameActivity(1); // game started
    reportGameActivity(1); // poll tick, same state
    reportGameActivity(2); // a second game — still "active"
    reportGameActivity(0); // last one ended
    reportGameActivity(0);
    reportGameActivity(1); // next game

    expect(seen).toEqual([true, false, true]);
  });

  it('a throwing listener does not break the tracker', () => {
    setGameActivityListener(() => { throw new Error('boom'); });
    expect(() => reportGameActivity(1)).not.toThrow();
  });
});
