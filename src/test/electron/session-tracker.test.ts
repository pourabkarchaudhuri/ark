/**
 * Session tracker (1.0.97 B10) — playtime correctness in the main-process poll
 * loop: system sleep, failing process snapshots, same-name exes in other
 * folders, two entries sharing one exe, AFK idle, untrack end time, and a
 * read-only store keeping its tracked games.
 *
 * `require('electron')` resolves to the npm stub (a path string) under
 * vitest, so the tracker is driven entirely through its test seams: injected
 * clock / idle / native snapshot / subprocess runner, a fake BrowserWindow
 * that collects `session:*` sends, and a manual poll tick.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import * as tracker from '../../../electron/session-tracker';
import type { NativeProcessInfo } from '../../../electron/native-bridge';

const POLL = 15_000;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const GAME_A = 'C:\\Games\\A\\Game.exe';

let now = T0;
let idleS = 0;
let native: NativeProcessInfo[] | null = [];
let tasklist: () => string = () => { throw new Error('tasklist not expected'); };
let powershell: () => string = () => { throw new Error('powershell not expected'); };
let realpaths: Record<string, string> = {};
let sent: Array<[string, any]> = [];
let runFile: ReturnType<typeof vi.fn>;

const BG: NativeProcessInfo[] = [
  { pid: 4, name: 'system' },
  { pid: 100, path: 'c:\\windows\\explorer.exe', name: 'explorer.exe' },
];

function withGame(path = 'c:\\games\\a\\game.exe', name = 'game.exe'): NativeProcessInfo[] {
  return [...BG, { pid: 500, path, name }];
}

const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, data: unknown) => { sent.push([channel, data]); } },
};

async function tick(ms = POLL): Promise<void> {
  now += ms;
  await tracker.__pollTickForTests();
}

async function ticks(n: number, ms = POLL): Promise<void> {
  for (let i = 0; i < n; i++) await tick(ms);
}

const events = (channel: string) => sent.filter(([c]) => c === channel).map(([, d]) => d);
const ended = () => events('session:ended').map((d) => d.session as tracker.CompletedSession);
const started = () => events('session:started').map((d) => d.gameId as string);

beforeEach(() => {
  now = T0;
  idleS = 0;
  native = [...BG];
  tasklist = () => { throw new Error('tasklist not expected'); };
  powershell = () => { throw new Error('powershell not expected'); };
  realpaths = {};
  sent = [];
  runFile = vi.fn(async (file: string) => {
    if (file === 'tasklist') return tasklist();
    if (file === 'powershell.exe') return powershell();
    throw new Error(`unexpected ${file}`);
  });
  tracker.__resetSessionTrackerForTests(fakeWindow as never, {
    now: () => now,
    getSystemIdleTime: () => idleS,
    nativeEnumerate: () => native,
    runFile,
    realpath: (p: string) => {
      if (realpaths[p]) return realpaths[p];
      throw new Error('ENOENT');
    },
    platform: 'win32',
  });
});

describe('system sleep (main-apis#18)', () => {
  it('an 8h gap between ticks with the process still running counts as idle, not play', async () => {
    tracker.setTrackedGames([{ gameId: 'steam-1', executablePath: GAME_A }]);
    native = withGame();
    await tick(); // started
    await ticks(4); // 1 min of play
    await tick(8 * 60 * 60_000); // PC slept 8h, game still open on resume
    await ticks(4); // 1 more min
    native = [...BG];
    await ticks(4);

    const [s] = ended();
    expect(s.gameId).toBe('steam-1');
    expect(s.durationMinutes).toBeGreaterThan(1.9);
    expect(s.durationMinutes).toBeLessThan(2.6);
    expect(s.idleMinutes).toBeGreaterThan(479);
    expect(s.idleMinutes).toBeLessThan(481);
  });

  it('suspend/resume adds the suspended span as idle (no double count with the gap check)', async () => {
    tracker.setTrackedGames([{ gameId: 'steam-1', executablePath: GAME_A }]);
    native = withGame();
    await tick();
    await ticks(4);
    tracker.handlePowerSuspend(now);
    now += 2 * 60 * 60_000;
    tracker.handlePowerResume(now);
    await tick(5_000);
    const [active] = tracker.getActiveSessions();
    // 1 min + 5s of play; 2h asleep.
    expect(active.elapsedMinutes).toBeGreaterThan(0.9);
    expect(active.elapsedMinutes).toBeLessThan(1.5);
  });

  it('a short suspend the gap check cannot see is still removed', async () => {
    tracker.setTrackedGames([{ gameId: 'steam-1', executablePath: GAME_A }]);
    native = withGame();
    await tick();
    await ticks(4);
    tracker.handlePowerSuspend(now);
    now += 40_000;
    tracker.handlePowerResume(now);
    await tick(5_000);
    const [active] = tracker.getActiveSessions();
    expect(active.elapsedMinutes).toBeCloseTo(65 / 60, 1);
  });

  it('normal 15s ticks are unaffected', async () => {
    tracker.setTrackedGames([{ gameId: 'steam-1', executablePath: GAME_A }]);
    native = withGame();
    await tick();
    await ticks(8);
    native = [...BG];
    await ticks(4);
    const [s] = ended();
    expect(s.durationMinutes).toBe(2);
    expect(s.idleMinutes).toBe(0);
    expect(s.activeInputMinutes).toBe(2);
  });
});

describe('process snapshot sources (main-apis#7)', () => {
  it('a native snapshot with basenames skips tasklist entirely', async () => {
    tracker.setTrackedGames([{ gameId: 'steam-1', executablePath: GAME_A }]);
    native = withGame();
    await ticks(3);
    expect(started()).toEqual(['steam-1']);
    expect(runFile).not.toHaveBeenCalled();
  });

  it('falls back to tasklist (no shell) only when native is unavailable', async () => {
    tracker.setTrackedGames([{ gameId: 'steam-1', executablePath: GAME_A }]);
    native = null;
    tasklist = () => '"explorer.exe","100","Console","1","10 K"\r\n"Game.exe","500","Console","1","10 K"\r\n';
    powershell = () => 'C:\\Windows\\explorer.exe\r\nC:\\Games\\A\\Game.exe\r\n';
    await tick();
    expect(started()).toEqual(['steam-1']);
    expect(runFile).toHaveBeenCalledWith('tasklist', ['/FO', 'CSV', '/NH'], expect.anything());
  });

  it('a failing tasklist does not keep an exited game alive from stale basenames', async () => {
    tracker.setTrackedGames([{ gameId: 'steam-1', executablePath: GAME_A }]);
    // Older native binary: no basenames, and an unresolved process → tasklist needed.
    native = [{ pid: 4 }, { pid: 100, path: 'c:\\windows\\explorer.exe' }, { pid: 500, path: 'c:\\games\\a\\game.exe' }];
    tasklist = () => '"System","4","Services","0","1 K"\r\n"explorer.exe","100","Console","1","10 K"\r\n"Game.exe","500","Console","1","10 K"\r\n';
    await tick();
    await ticks(2);
    const lastSeen = now;
    expect(started()).toEqual(['steam-1']);

    native = [{ pid: 4 }, { pid: 100, path: 'c:\\windows\\explorer.exe' }];
    tasklist = () => { throw new Error('blocked by policy'); };
    await ticks(4);
    const [s] = ended();
    expect(s?.gameId).toBe('steam-1');
    expect(Date.parse(s.endTime)).toBe(lastSeen);
  });

  it('when every snapshot fails, sessions neither extend nor end', async () => {
    tracker.setTrackedGames([{ gameId: 'steam-1', executablePath: GAME_A }]);
    native = withGame();
    await tick();
    await ticks(4);
    const lastSeen = now;

    native = null;
    tasklist = () => { throw new Error('av pause'); };
    powershell = () => { throw new Error('av pause'); };
    const liveBefore = events('session:liveUpdate').length;
    await ticks(10);
    expect(ended()).toHaveLength(0);
    expect(events('session:liveUpdate')).toHaveLength(liveBefore);

    native = [...BG];
    await ticks(4);
    const [s] = ended();
    expect(Date.parse(s.endTime)).toBe(lastSeen);
    expect(s.durationMinutes).toBe(1);
  });
});

describe('basename fallback (main-apis#21)', () => {
  it('a same-named exe in another folder is not the tracked game', async () => {
    tracker.setTrackedGames([{ gameId: 'steam-1', executablePath: GAME_A }]);
    native = withGame('d:\\b\\game.exe');
    await ticks(3);
    expect(started()).toEqual([]);
  });

  it('a process with that name whose path is unreadable still matches (elevated game)', async () => {
    tracker.setTrackedGames([{ gameId: 'steam-1', executablePath: GAME_A }]);
    native = [...BG, { pid: 500, name: 'game.exe' }];
    await tick();
    expect(started()).toEqual(['steam-1']);
  });

  it('a tracked path behind a junction matches its real path', async () => {
    realpaths['C:\\Link\\Game.exe'] = 'D:\\Real\\Game.exe';
    tracker.setTrackedGames([{ gameId: 'steam-1', executablePath: 'C:\\Link\\Game.exe' }]);
    native = withGame('d:\\real\\game.exe');
    await tick();
    expect(started()).toEqual(['steam-1']);
  });
});

describe('two entries sharing one exe (main-apis#37)', () => {
  it('only one session is recorded, owned by the library entry', async () => {
    tracker.setTrackedGames([
      { gameId: 'custom-x', executablePath: GAME_A },
      { gameId: 'steam-1', executablePath: 'c:\\games\\a\\game.exe' },
    ]);
    native = withGame();
    await ticks(4);
    native = [...BG];
    await ticks(4);
    expect(started()).toEqual(['steam-1']);
    expect(ended().map((s) => s.gameId)).toEqual(['steam-1']);
  });

  it('a resync mid-session keeps the entry that already owns the running session', async () => {
    tracker.setTrackedGames([{ gameId: 'custom-x', executablePath: GAME_A }]);
    native = withGame();
    await ticks(2);
    tracker.setTrackedGames([
      { gameId: 'steam-1', executablePath: GAME_A },
      { gameId: 'custom-x', executablePath: GAME_A },
    ]);
    await ticks(3);
    expect(started()).toEqual(['custom-x']);
    expect(ended()).toHaveLength(0);
    expect(tracker.getActiveSessions().map((s) => s.gameId)).toEqual(['custom-x']);
  });
});

describe('AFK idle (main-apis#42)', () => {
  it('a 10-minute AFK break removes ~10 minutes, including the first 5', async () => {
    tracker.setTrackedGames([{ gameId: 'steam-1', executablePath: GAME_A }]);
    native = withGame();
    await tick();
    await ticks(4);
    for (let i = 1; i <= 40; i++) {
      idleS = i * 15;
      await tick();
    }
    idleS = 0;
    await ticks(4);
    // getActiveSessions subtracts idle exactly like liveUpdate does.
    const live = events('session:liveUpdate').at(-1)!;
    expect(tracker.getActiveSessions()[0].elapsedMinutes).toBe(live.activeMinutes);
    native = [...BG];
    await ticks(4);
    const [s] = ended();
    expect(s.idleMinutes).toBeGreaterThan(9.7);
    expect(s.idleMinutes).toBeLessThanOrEqual(10.01);
    expect(s.durationMinutes).toBeGreaterThan(1.9);
    expect(s.durationMinutes).toBeLessThan(2.4);
  });

  it('idle that started before the game launched is clamped to the session', async () => {
    idleS = 3600;
    tracker.setTrackedGames([{ gameId: 'steam-1', executablePath: GAME_A }]);
    native = withGame();
    await tick();
    await ticks(3);
    expect(tracker.getActiveSessions()[0].elapsedMinutes).toBe(0);
  });
});

describe('untracking a game (main-apis#11)', () => {
  it('ends the session when it was last seen, not now', async () => {
    tracker.setTrackedGames([{ gameId: 'steam-1', executablePath: GAME_A }]);
    native = withGame();
    await tick();
    await ticks(4);
    const lastSeen = now;
    native = [...BG];
    await ticks(3); // inside the miss window
    tracker.setTrackedGames([]);
    const [s] = ended();
    expect(Date.parse(s.endTime)).toBe(lastSeen);
    expect(s.durationMinutes).toBe(1);
  });
});

describe('keepSources for a read-only store (hooks#16)', () => {
  it('a custom-only resync with keepSources library keeps the running library session', async () => {
    tracker.setTrackedGames([
      { gameId: 'steam-1', executablePath: GAME_A },
      { gameId: 'custom-1', executablePath: 'C:\\Games\\C\\c.exe' },
    ]);
    native = withGame();
    await ticks(2);

    tracker.setTrackedGames([{ gameId: 'custom-1', executablePath: 'C:\\Games\\C\\c.exe' }], { keepSources: ['library'] });
    expect(ended()).toHaveLength(0);
    await ticks(2);
    expect(tracker.getActiveSessions().map((s) => s.gameId)).toEqual(['steam-1']);

    // Library exes are still tracked: the session ends normally when the game exits.
    native = [...BG];
    await ticks(4);
    expect(ended().map((s) => s.gameId)).toEqual(['steam-1']);
  });

  it('without keepSources the missing library game is finalized as before', async () => {
    tracker.setTrackedGames([{ gameId: 'steam-1', executablePath: GAME_A }]);
    native = withGame();
    await ticks(2);
    tracker.setTrackedGames([]);
    expect(ended().map((s) => s.gameId)).toEqual(['steam-1']);
  });
});
