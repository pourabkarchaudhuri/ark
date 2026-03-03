/**
 * Transmissions decode history — which items have been opened in the Decode Bay.
 * Used to show "Already decoded" state on stream cards. Persisted in localStorage.
 */

const STORAGE_KEY = 'ark-transmissions-decoded';
const MAX_IDS = 2000; // cap to avoid bloat

function load(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(ids: string[]) {
  try {
    const trimmed = ids.slice(-MAX_IDS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // ignore
  }
}

export const transmissionsHistoryStore = {
  markDecoded(id: string): void {
    const ids = load();
    const set = new Set(ids);
    set.add(id);
    save(Array.from(set));
  },

  hasDecoded(id: string): boolean {
    return load().includes(id);
  },

  getDecodedIds(): Set<string> {
    return new Set(load());
  },
};
