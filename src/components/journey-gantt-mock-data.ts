/**
 * Mock data generator for the OCD Gantt chart view.
 * Uses real Steam App IDs and realistic status transitions for development/demo.
 *
 * Several games demonstrate "play in gaps" patterns — where a game is picked up,
 * put down, then picked up again weeks or months later, creating visible gaps
 * on the timeline with duration labels.
 */
import { JourneyEntry, StatusChangeEntry, GameStatus, GameSession, LibraryGameEntry, GamePriority } from '@/types/game';

const STEAM_CDN = 'https://cdn.akamai.steamstatic.com/steam/apps';

interface MockGame {
  gameId: number; // Steam appId — converted to "steam-{id}" string at output
  title: string;
  genre: string[];
  platform: string[];
  releaseDate: string;
  hoursPlayed: number;
  rating: number;
  addedAt: string;
  removedAt?: string;
  currentStatus: GameStatus;
  transitions: Array<{ status: GameStatus; date: string }>;
}

const MOCK_GAMES: MockGame[] = [
  // ── Continuous play (no gaps) ────────────────────────────────────────
  {
    gameId: 570,
    title: 'Dota 2',
    genre: ['Strategy', 'MOBA'],
    platform: ['Windows'],
    releaseDate: '2013-07-09',
    hoursPlayed: 1850,
    rating: 4,
    addedAt: '2023-01-15T07:00:00.000Z',
    currentStatus: 'Playing',
    transitions: [
      { status: 'Playing', date: '2023-01-15T07:00:00.000Z' },
    ],
  },

  // ── Games played in gaps ─────────────────────────────────────────────

  // CS2: Played Oct-Dec 2023, gap, then Feb-May 2024, gap, then Sep 2024-now
  {
    gameId: 730,
    title: 'Counter-Strike 2',
    genre: ['Action', 'FPS'],
    platform: ['Windows'],
    releaseDate: '2023-09-27',
    hoursPlayed: 342,
    rating: 4,
    addedAt: '2023-10-05T10:00:00.000Z',
    currentStatus: 'Playing',
    transitions: [
      { status: 'Playing',     date: '2023-10-12T18:00:00.000Z' },
      { status: 'Playing Now', date: '2023-12-20T10:00:00.000Z' },  // end first stint
      { status: 'Playing',     date: '2024-02-15T14:00:00.000Z' },  // ~2 month gap
      { status: 'Playing Now', date: '2024-05-10T08:00:00.000Z' },  // end second stint
      { status: 'Playing',     date: '2024-09-01T16:00:00.000Z' },  // ~4 month gap
    ],
  },

  // Elden Ring: Played Jul-Sep 2023, gap, Jan-Mar 2024, gap, Aug 2024-now
  {
    gameId: 1245620,
    title: 'Elden Ring',
    genre: ['Action', 'RPG'],
    platform: ['Windows'],
    releaseDate: '2022-02-25',
    hoursPlayed: 156,
    rating: 5,
    addedAt: '2023-06-15T14:00:00.000Z',
    currentStatus: 'Playing',
    transitions: [
      { status: 'Playing',     date: '2023-07-01T20:00:00.000Z' },
      { status: 'Playing Now', date: '2023-09-15T12:00:00.000Z' },  // end first run
      { status: 'Playing',     date: '2024-01-10T16:00:00.000Z' },  // ~4 month gap
      { status: 'Playing Now', date: '2024-03-28T22:00:00.000Z' },  // end second run
      { status: 'Playing',     date: '2024-08-05T10:00:00.000Z' },  // ~4 month gap, DLC drop
    ],
  },

  // BG3: Played Aug-Nov 2023, gap, then Feb-May 2024 (second playthrough), gap, then Nov 2024-now
  {
    gameId: 1086940,
    title: "Baldur's Gate 3",
    genre: ['RPG', 'Adventure'],
    platform: ['Windows'],
    releaseDate: '2023-08-03',
    hoursPlayed: 210,
    rating: 5,
    addedAt: '2023-08-10T09:00:00.000Z',
    currentStatus: 'Playing Now',
    transitions: [
      { status: 'Playing',     date: '2023-08-10T09:00:00.000Z' },
      { status: 'Playing Now', date: '2023-11-20T15:00:00.000Z' },  // end first playthrough
      { status: 'Playing',     date: '2024-02-05T19:00:00.000Z' },  // ~2.5 month gap
      { status: 'Playing Now', date: '2024-05-12T23:00:00.000Z' },  // end second playthrough
      { status: 'Playing',     date: '2024-11-01T10:00:00.000Z' },  // ~6 month gap, mod run
      { status: 'Playing Now', date: '2025-01-20T18:00:00.000Z' },  // currently active
    ],
  },

  // Witcher 3: Three short bursts across 2023-2024
  {
    gameId: 292030,
    title: 'The Witcher 3: Wild Hunt',
    genre: ['RPG', 'Adventure'],
    platform: ['Windows'],
    releaseDate: '2015-05-18',
    hoursPlayed: 98,
    rating: 5,
    addedAt: '2023-04-01T08:00:00.000Z',
    currentStatus: 'Playing',
    transitions: [
      { status: 'Playing',     date: '2023-04-20T17:00:00.000Z' },
      { status: 'Playing Now', date: '2023-06-10T20:00:00.000Z' },  // end burst 1
      { status: 'Playing',     date: '2023-10-15T12:00:00.000Z' },  // ~4 month gap
      { status: 'Playing Now', date: '2023-12-01T18:00:00.000Z' },  // end burst 2
      { status: 'Playing',     date: '2024-06-20T09:00:00.000Z' },  // ~7 month gap
    ],
  },

  // Sekiro: Two focused bursts with a gap
  {
    gameId: 814380,
    title: 'Sekiro: Shadows Die Twice',
    genre: ['Action', 'Adventure'],
    platform: ['Windows'],
    releaseDate: '2019-03-22',
    hoursPlayed: 65,
    rating: 4,
    addedAt: '2024-01-20T11:00:00.000Z',
    currentStatus: 'Playing',
    transitions: [
      { status: 'Playing',     date: '2024-02-14T19:00:00.000Z' },
      { status: 'Playing Now', date: '2024-04-30T14:00:00.000Z' },  // end first push
      { status: 'Playing',     date: '2024-10-01T10:00:00.000Z' },  // ~5 month gap
    ],
  },

  // RDR2: Long continuous play, then a gap, then revisit
  {
    gameId: 1174180,
    title: 'Red Dead Redemption 2',
    genre: ['Action', 'Adventure'],
    platform: ['Windows'],
    releaseDate: '2019-12-05',
    hoursPlayed: 120,
    rating: 5,
    addedAt: '2024-03-10T13:00:00.000Z',
    currentStatus: 'Playing',
    transitions: [
      { status: 'Playing',     date: '2024-04-01T20:00:00.000Z' },
      { status: 'Playing Now', date: '2024-08-15T22:00:00.000Z' },  // end main story
      { status: 'Playing',     date: '2025-01-10T14:00:00.000Z' },  // ~5 month gap, online revisit
    ],
  },

  // Rust: Short on-off bursts (wipe cycles)
  {
    gameId: 252490,
    title: 'Rust',
    genre: ['Survival', 'Action'],
    platform: ['Windows'],
    releaseDate: '2018-02-08',
    hoursPlayed: 45,
    rating: 3,
    addedAt: '2024-06-01T15:00:00.000Z',
    currentStatus: 'Playing',
    transitions: [
      { status: 'Playing',     date: '2024-06-20T20:00:00.000Z' },
      { status: 'Playing Now', date: '2024-07-15T10:00:00.000Z' },  // end wipe 1
      { status: 'Playing',     date: '2024-08-10T16:00:00.000Z' },  // ~1 month gap
      { status: 'Playing Now', date: '2024-09-05T22:00:00.000Z' },  // end wipe 2
      { status: 'Playing',     date: '2024-11-20T12:00:00.000Z' },  // ~2.5 month gap
      { status: 'Playing Now', date: '2024-12-15T18:00:00.000Z' },  // end wipe 3
      { status: 'Playing',     date: '2025-02-01T14:00:00.000Z' },  // ~1.5 month gap
    ],
  },

  // ── Recent / currently active (no gaps yet) ──────────────────────────

  // Wukong: Played at launch, gap, then revisiting now
  {
    gameId: 2358720,
    title: 'Black Myth: Wukong',
    genre: ['Action', 'RPG'],
    platform: ['Windows'],
    releaseDate: '2024-08-20',
    hoursPlayed: 38,
    rating: 4,
    addedAt: '2024-08-20T06:00:00.000Z',
    currentStatus: 'Playing Now',
    transitions: [
      { status: 'Playing',     date: '2024-08-20T06:00:00.000Z' },
      { status: 'Playing Now', date: '2024-09-28T22:00:00.000Z' },  // finished first run
      { status: 'Playing',     date: '2025-01-15T10:00:00.000Z' },  // ~3.5 month gap, NG+
      { status: 'Playing Now', date: '2025-02-01T18:00:00.000Z' },  // currently active
    ],
  },

  {
    gameId: 1151640,
    title: 'Horizon Zero Dawn',
    genre: ['Action', 'RPG'],
    platform: ['Windows'],
    releaseDate: '2020-08-07',
    hoursPlayed: 12,
    rating: 4,
    addedAt: '2025-01-05T10:00:00.000Z',
    currentStatus: 'Playing',
    transitions: [
      { status: 'Playing', date: '2025-01-05T10:00:00.000Z' },
    ],
  },

  // ── Completed games ──────────────────────────────────────────────────

  {
    gameId: 620,
    title: 'Portal 2',
    genre: ['Puzzle', 'FPS'],
    platform: ['Windows', 'Mac'],
    releaseDate: '2011-04-19',
    hoursPlayed: 22,
    rating: 5,
    addedAt: '2023-03-10T12:00:00.000Z',
    currentStatus: 'Completed',
    transitions: [
      { status: 'Playing',   date: '2023-03-10T12:00:00.000Z' },
      { status: 'Completed', date: '2023-04-05T20:00:00.000Z' },
    ],
  },

  {
    gameId: 504230,
    title: 'Celeste',
    genre: ['Platformer', 'Indie'],
    platform: ['Windows', 'Mac'],
    releaseDate: '2018-01-25',
    hoursPlayed: 35,
    rating: 5,
    addedAt: '2024-04-15T08:00:00.000Z',
    currentStatus: 'Completed',
    transitions: [
      { status: 'Playing',   date: '2024-04-15T08:00:00.000Z' },
      { status: 'Completed', date: '2024-06-10T22:00:00.000Z' },
    ],
  },

  // ── On Hold ──────────────────────────────────────────────────────────

  {
    gameId: 1091500,
    title: 'Cyberpunk 2077',
    genre: ['RPG', 'Action', 'Open World'],
    platform: ['Windows'],
    releaseDate: '2020-12-10',
    hoursPlayed: 30,
    rating: 3,
    addedAt: '2024-07-20T14:00:00.000Z',
    currentStatus: 'On Hold',
    transitions: [
      { status: 'Playing', date: '2024-07-20T14:00:00.000Z' },
      { status: 'On Hold', date: '2024-09-15T10:00:00.000Z' },
    ],
  },

  // ── Want to Play ─────────────────────────────────────────────────────

  {
    gameId: 1966720,
    title: 'Lethal Company',
    genre: ['Horror', 'Co-op', 'Indie'],
    platform: ['Windows'],
    releaseDate: '2023-10-23',
    hoursPlayed: 0,
    rating: 0,
    addedAt: '2025-01-20T10:00:00.000Z',
    currentStatus: 'Want to Play',
    transitions: [
      { status: 'Want to Play', date: '2025-01-20T10:00:00.000Z' },
    ],
  },

  {
    gameId: 413150,
    title: 'Stardew Valley',
    genre: ['Simulation', 'Indie', 'RPG'],
    platform: ['Windows', 'Mac'],
    releaseDate: '2016-02-26',
    hoursPlayed: 0,
    rating: 0,
    addedAt: '2025-02-01T09:00:00.000Z',
    currentStatus: 'Want to Play',
    transitions: [
      { status: 'Want to Play', date: '2025-02-01T09:00:00.000Z' },
    ],
  },
];

// ── Helpers for deterministic mock data generation ──────────────────────

/** Seeded PRNG (LCG) for deterministic, reproducible results across runs. */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const GAP_THRESHOLD_DAYS = 14;
const DAY_MS = 86_400_000;

// ── Per-game library metadata (priority + recommendation source) ────────

const LIBRARY_META: Record<number, { priority: GamePriority; recommendationSource: string }> = {
  570:     { priority: 'High',   recommendationSource: 'Friend Recommendation' },
  730:     { priority: 'High',   recommendationSource: 'Steam Sale' },
  1245620: { priority: 'High',   recommendationSource: 'YouTube' },
  1086940: { priority: 'High',   recommendationSource: 'Review Site' },
  292030:  { priority: 'Medium', recommendationSource: 'Series Fan' },
  814380:  { priority: 'Medium', recommendationSource: 'YouTube' },
  1174180: { priority: 'Medium', recommendationSource: 'Game Pass' },
  252490:  { priority: 'Low',    recommendationSource: 'Twitch' },
  2358720: { priority: 'Medium', recommendationSource: 'Steam Sale' },
  1151640: { priority: 'Low',    recommendationSource: 'Friend Recommendation' },
  620:     { priority: 'High',   recommendationSource: 'Reddit' },
  504230:  { priority: 'Medium', recommendationSource: 'Review Site' },
  1091500: { priority: 'High',   recommendationSource: 'YouTube' },
  1966720: { priority: 'Low',    recommendationSource: 'Twitch' },
  413150:  { priority: 'Medium', recommendationSource: 'Friend Recommendation' },
};

/**
 * Identify active play windows from a game's transitions, skipping gap periods.
 * A gap is detected when a "Playing Now" → "Playing" transition spans > GAP_THRESHOLD_DAYS.
 * @param offsetMs  Date shift to apply so windows land near "now"
 */
function getActiveWindows(game: MockGame, now: Date, offsetMs: number = 0): Array<{ start: Date; end: Date }> {
  const windows: Array<{ start: Date; end: Date }> = [];

  for (let i = 0; i < game.transitions.length; i++) {
    const tStart = new Date(new Date(game.transitions[i].date).getTime() + offsetMs);
    const tEnd = i < game.transitions.length - 1
      ? new Date(new Date(game.transitions[i + 1].date).getTime() + offsetMs)
      : now;

    // Skip gap windows: "Playing Now" → "Playing" spanning > GAP_THRESHOLD_DAYS
    if (
      i < game.transitions.length - 1 &&
      game.transitions[i].status === 'Playing Now' &&
      game.transitions[i + 1].status === 'Playing' &&
      (tEnd.getTime() - tStart.getTime()) > GAP_THRESHOLD_DAYS * DAY_MS
    ) {
      continue;
    }

    windows.push({ start: tStart, end: tEnd });
  }

  return windows;
}

/**
 * Generate realistic mock play sessions for all mock games.
 * Sessions are distributed across active play windows with varied
 * times (biased toward evenings) and durations (20–300 min).
 * @param now       Current date (used as end bound for last window)
 * @param offsetMs  Date shift to apply so sessions land near "now"
 */
function generateMockSessions(now: Date, offsetMs: number = 0): GameSession[] {
  const sessions: GameSession[] = [];
  const rng = seededRandom(42);

  for (const game of MOCK_GAMES) {
    const windows = getActiveWindows(game, now, offsetMs);
    if (windows.length === 0) continue;

    // Total sessions proportional to sqrt(hours), capped 3–20
    const targetTotal = Math.max(3, Math.min(20, Math.round(Math.sqrt(game.hoursPlayed) * 0.8)));

    const totalWindowMs = windows.reduce(
      (sum, w) => sum + (w.end.getTime() - w.start.getTime()), 0,
    );

    let sessionIdx = 0;
    for (const window of windows) {
      const windowMs = window.end.getTime() - window.start.getTime();
      const windowShare = totalWindowMs > 0 ? windowMs / totalWindowMs : 1 / windows.length;
      const windowSessions = Math.max(1, Math.round(targetTotal * windowShare));

      for (let j = 0; j < windowSessions; j++) {
        // Random position within window
        const frac = rng();
        const startMs = window.start.getTime() + frac * windowMs;
        const startDate = new Date(startMs);

        // Bias start hour toward evenings
        const hourRoll = rng();
        let hour: number;
        if (hourRoll < 0.1) hour = 8 + Math.floor(rng() * 4);        // 08–11 morning  (10%)
        else if (hourRoll < 0.4) hour = 12 + Math.floor(rng() * 5);   // 12–16 afternoon (30%)
        else hour = 17 + Math.floor(rng() * 6);                       // 17–22 evening   (60%)

        startDate.setUTCHours(hour, Math.floor(rng() * 60), 0, 0);

        // Duration: 20–300 min, bell-curve-ish toward 60–120
        const d1 = 20 + rng() * 80;   // 20–100
        const d2 = rng() * 200;        // 0–200
        const durationMinutes = Math.max(20, Math.min(Math.round(d1 + d2), 300));

        // Idle: 5–20% of duration
        const idleMinutes = Math.round(durationMinutes * (0.05 + rng() * 0.15));

        const endDate = new Date(startDate.getTime() + (durationMinutes + idleMinutes) * 60_000);

        sessions.push({
          id: `mock-sess-${game.gameId}-${sessionIdx}`,
          gameId: `steam-${game.gameId}`,
          executablePath: `C:\\Games\\${game.title.replace(/[^a-zA-Z0-9]/g, '')}\\game.exe`,
          startTime: startDate.toISOString(),
          endTime: endDate.toISOString(),
          durationMinutes,
          idleMinutes,
        });
        sessionIdx++;
      }
    }
  }

  // Sort chronologically across all games
  sessions.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  return sessions;
}

/**
 * Generate mock library entries for all mock games with
 * priority, recommendation source, hours, and ratings.
 */
function generateMockLibraryEntries(): LibraryGameEntry[] {
  return MOCK_GAMES.map((game) => {
    const meta = LIBRARY_META[game.gameId] ?? {
      priority: 'Medium' as GamePriority,
      recommendationSource: 'Steam Sale',
    };
    const addedDate = new Date(game.addedAt);

    return {
      gameId: `steam-${game.gameId}`,
      steamAppId: game.gameId,
      status: game.currentStatus,
      priority: meta.priority,
      publicReviews: '',
      recommendationSource: meta.recommendationSource,
      hoursPlayed: game.hoursPlayed,
      rating: game.rating,
      addedAt: addedDate,
      updatedAt: new Date(Math.max(addedDate.getTime(), Date.now() - 30 * DAY_MS)),
    };
  });
}

/**
 * Shift an ISO date string forward by `offsetMs` milliseconds.
 * Returns a new ISO string with the same time-of-day feel.
 */
function shiftDate(iso: string, offsetMs: number): string {
  return new Date(new Date(iso).getTime() + offsetMs).toISOString();
}

/**
 * Generate mock data for Gantt chart AND Analytics views.
 * All dates are shifted so the most recent mock event lands near "today",
 * keeping the activity chart, streaks, heatmap, and recent-activity list populated.
 */
export function generateMockGanttData(): {
  journeyEntries: JourneyEntry[];
  statusHistory: StatusChangeEntry[];
  sessions: GameSession[];
  libraryEntries: LibraryGameEntry[];
} {
  const now = new Date();

  // Find the latest date across all mock data (addedAt + transitions)
  let latestMs = 0;
  for (const game of MOCK_GAMES) {
    latestMs = Math.max(latestMs, new Date(game.addedAt).getTime());
    if (game.removedAt) latestMs = Math.max(latestMs, new Date(game.removedAt).getTime());
    for (const t of game.transitions) {
      latestMs = Math.max(latestMs, new Date(t.date).getTime());
    }
  }

  // Offset = how much to shift all dates so latest mock date ≈ now
  const dateOffset = now.getTime() - latestMs;

  const journeyEntries: JourneyEntry[] = MOCK_GAMES.map((game) => ({
    gameId: `steam-${game.gameId}`,
    title: game.title,
    coverUrl: `${STEAM_CDN}/${game.gameId}/library_600x900.jpg`,
    genre: game.genre,
    platform: game.platform,
    releaseDate: game.releaseDate,
    status: game.currentStatus,
    hoursPlayed: game.hoursPlayed,
    rating: game.rating,
    addedAt: shiftDate(game.addedAt, dateOffset),
    removedAt: game.removedAt ? shiftDate(game.removedAt, dateOffset) : undefined,
  }));

  const statusHistory: StatusChangeEntry[] = [];
  for (const game of MOCK_GAMES) {
    for (let i = 0; i < game.transitions.length; i++) {
      const t = game.transitions[i];
      statusHistory.push({
        gameId: `steam-${game.gameId}`,
        title: game.title,
        previousStatus: i === 0 ? null : game.transitions[i - 1].status,
        newStatus: t.status,
        timestamp: shiftDate(t.date, dateOffset),
      });
    }
  }

  // Sort status history chronologically
  statusHistory.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Generate mock sessions and library entries for Analytics view
  const sessions = generateMockSessions(now, dateOffset);
  const libraryEntries = generateMockLibraryEntries();

  return { journeyEntries, statusHistory, sessions, libraryEntries };
}
