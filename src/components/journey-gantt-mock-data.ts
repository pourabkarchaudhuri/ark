/**
 * Mock data generator for the OCD Gantt chart view.
 * Uses real Steam App IDs and realistic status transitions for development/demo.
 */
import { JourneyEntry, StatusChangeEntry, GameStatus } from '@/types/game';

const STEAM_CDN = 'https://cdn.akamai.steamstatic.com/steam/apps';

interface MockGame {
  gameId: number;
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
      { status: 'Want to Play', date: '2023-10-05T10:00:00.000Z' },
      { status: 'Playing', date: '2023-10-12T18:00:00.000Z' },
    ],
  },
  {
    gameId: 1245620,
    title: 'Elden Ring',
    genre: ['Action', 'RPG'],
    platform: ['Windows'],
    releaseDate: '2022-02-25',
    hoursPlayed: 156,
    rating: 5,
    addedAt: '2023-06-15T14:00:00.000Z',
    currentStatus: 'Completed',
    transitions: [
      { status: 'Want to Play', date: '2023-06-15T14:00:00.000Z' },
      { status: 'Playing', date: '2023-07-01T20:00:00.000Z' },
      { status: 'On Hold', date: '2023-09-15T12:00:00.000Z' },
      { status: 'Playing', date: '2024-01-10T16:00:00.000Z' },
      { status: 'Completed', date: '2024-03-28T22:00:00.000Z' },
    ],
  },
  {
    gameId: 1086940,
    title: "Baldur's Gate 3",
    genre: ['RPG', 'Adventure'],
    platform: ['Windows'],
    releaseDate: '2023-08-03',
    hoursPlayed: 210,
    rating: 5,
    addedAt: '2023-08-10T09:00:00.000Z',
    currentStatus: 'Completed',
    transitions: [
      { status: 'Playing', date: '2023-08-10T09:00:00.000Z' },
      { status: 'On Hold', date: '2023-11-20T15:00:00.000Z' },
      { status: 'Playing', date: '2024-02-05T19:00:00.000Z' },
      { status: 'Completed', date: '2024-05-12T23:00:00.000Z' },
    ],
  },
  {
    gameId: 292030,
    title: 'The Witcher 3: Wild Hunt',
    genre: ['RPG', 'Adventure'],
    platform: ['Windows'],
    releaseDate: '2015-05-18',
    hoursPlayed: 98,
    rating: 5,
    addedAt: '2023-04-01T08:00:00.000Z',
    currentStatus: 'Completed',
    transitions: [
      { status: 'Want to Play', date: '2023-04-01T08:00:00.000Z' },
      { status: 'Playing', date: '2023-04-20T17:00:00.000Z' },
      { status: 'Completed', date: '2023-08-05T21:00:00.000Z' },
    ],
  },
  {
    gameId: 814380,
    title: 'Sekiro: Shadows Die Twice',
    genre: ['Action', 'Adventure'],
    platform: ['Windows'],
    releaseDate: '2019-03-22',
    hoursPlayed: 65,
    rating: 4,
    addedAt: '2024-01-20T11:00:00.000Z',
    currentStatus: 'On Hold',
    transitions: [
      { status: 'Want to Play', date: '2024-01-20T11:00:00.000Z' },
      { status: 'Playing', date: '2024-02-14T19:00:00.000Z' },
      { status: 'On Hold', date: '2024-04-30T14:00:00.000Z' },
    ],
  },
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
      { status: 'Want to Play', date: '2024-03-10T13:00:00.000Z' },
      { status: 'Playing', date: '2024-04-01T20:00:00.000Z' },
    ],
  },
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
      { status: 'On Hold', date: '2023-06-01T10:00:00.000Z' },
      { status: 'Playing', date: '2023-09-01T18:00:00.000Z' },
      { status: 'On Hold', date: '2024-06-15T12:00:00.000Z' },
      { status: 'Playing', date: '2024-10-01T16:00:00.000Z' },
    ],
  },
  {
    gameId: 252490,
    title: 'Rust',
    genre: ['Survival', 'Action'],
    platform: ['Windows'],
    releaseDate: '2018-02-08',
    hoursPlayed: 45,
    rating: 3,
    addedAt: '2024-06-01T15:00:00.000Z',
    removedAt: '2024-09-15T10:00:00.000Z',
    currentStatus: 'On Hold',
    transitions: [
      { status: 'Want to Play', date: '2024-06-01T15:00:00.000Z' },
      { status: 'Playing', date: '2024-06-20T20:00:00.000Z' },
      { status: 'On Hold', date: '2024-08-10T14:00:00.000Z' },
    ],
  },
  {
    gameId: 2358720,
    title: 'Black Myth: Wukong',
    genre: ['Action', 'RPG'],
    platform: ['Windows'],
    releaseDate: '2024-08-20',
    hoursPlayed: 38,
    rating: 4,
    addedAt: '2024-08-20T06:00:00.000Z',
    currentStatus: 'Completed',
    transitions: [
      { status: 'Playing', date: '2024-08-20T06:00:00.000Z' },
      { status: 'Completed', date: '2024-09-28T22:00:00.000Z' },
    ],
  },
  {
    gameId: 1151640,
    title: 'Horizon Zero Dawn',
    genre: ['Action', 'RPG'],
    platform: ['Windows'],
    releaseDate: '2020-08-07',
    hoursPlayed: 0,
    rating: 0,
    addedAt: '2025-01-05T10:00:00.000Z',
    currentStatus: 'Want to Play',
    transitions: [
      { status: 'Want to Play', date: '2025-01-05T10:00:00.000Z' },
    ],
  },
];

/**
 * Generate mock Gantt chart data with realistic journey entries and status history.
 * Returns data in the same shape the Gantt view consumes from the real stores.
 */
export function generateMockGanttData(): {
  journeyEntries: JourneyEntry[];
  statusHistory: StatusChangeEntry[];
} {
  const journeyEntries: JourneyEntry[] = MOCK_GAMES.map((game) => ({
    gameId: game.gameId,
    title: game.title,
    coverUrl: `${STEAM_CDN}/${game.gameId}/library_600x900.jpg`,
    genre: game.genre,
    platform: game.platform,
    releaseDate: game.releaseDate,
    status: game.currentStatus,
    hoursPlayed: game.hoursPlayed,
    rating: game.rating,
    addedAt: game.addedAt,
    removedAt: game.removedAt,
  }));

  const statusHistory: StatusChangeEntry[] = [];
  for (const game of MOCK_GAMES) {
    for (let i = 0; i < game.transitions.length; i++) {
      const t = game.transitions[i];
      statusHistory.push({
        gameId: game.gameId,
        title: game.title,
        previousStatus: i === 0 ? null : game.transitions[i - 1].status,
        newStatus: t.status,
        timestamp: t.date,
      });
    }
  }

  // Sort status history chronologically
  statusHistory.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return { journeyEntries, statusHistory };
}
