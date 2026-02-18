/**
 * Persists first-unlock timestamp per badge id so we can show "Obtained: <date>" on vault cards.
 */
const STORAGE_KEY = 'ark-badge-unlock-timestamps';

type Stored = Record<number, number>;

function load(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Stored;
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (_) {}
  return {};
}

function save(data: Stored) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (_) {}
}

let cache: Stored | null = null;

function getData(): Stored {
  if (cache === null) cache = load();
  return cache;
}

export function getBadgeUnlockedAt(badgeId: number): number | undefined {
  const ts = getData()[badgeId];
  return ts === undefined ? undefined : ts;
}

export function setBadgeUnlockedAt(badgeId: number, timestamp: number): void {
  const data = getData();
  if (data[badgeId] !== undefined) return;
  data[badgeId] = timestamp;
  cache = data;
  save(data);
}

export function ensureUnlockedAt(badgeId: number): number {
  const data = getData();
  const existing = data[badgeId];
  if (existing !== undefined) return existing;
  const now = Date.now();
  data[badgeId] = now;
  cache = data;
  save(data);
  return now;
}
