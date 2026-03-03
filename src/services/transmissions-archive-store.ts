/**
 * Transmissions Archive — save-for-later (queue for decode).
 * Persisted in localStorage; keyed by news item id.
 */

const STORAGE_KEY = 'ark-transmissions-archive';

export interface SavedTransmission {
  id: string;
  url: string;
  title: string;
  source: string;
  publishedAt: number;
  summary?: string;
  imageUrl?: string;
}

function load(): SavedTransmission[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedTransmission[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(items: SavedTransmission[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore
  }
}

const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((cb) => cb());
}

export const transmissionsArchiveStore = {
  add(item: SavedTransmission): void {
    const items = load();
    if (items.some((i) => i.id === item.id)) return;
    items.push(item);
    save(items);
    notify();
  },

  remove(id: string): void {
    const items = load().filter((i) => i.id !== id);
    save(items);
    notify();
  },

  getAll(): SavedTransmission[] {
    return load();
  },

  has(id: string): boolean {
    return load().some((i) => i.id === id);
  },

  subscribe(callback: () => void): () => void {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};
