/**
 * Adult content filter — classifies games as "sexually explicit as prominent"
 * from title and description text (not store tags). Uses:
 * 1. A curated list of phrases/words that imply explicit sexual intent.
 * 2. The "cuss" linguistic library (profane words with sureness ratings) for
 *    word-boundary matching to reinforce the logic.
 * Results are cached in memory and persisted to localStorage (debounced); the cache is
 * invalidated when CACHE_VERSION changes.
 */

import type { Game } from '@/types/game';
import { cuss } from 'cuss';

const CACHE_KEY = 'ark-adult-classification-cache';
const CACHE_VERSION_KEY = 'ark-adult-classification-cache-version';
const CACHE_VERSION = 2;

// Words from cuss with sureness >= 1 (maybe or likely profanity) for word-boundary check.
// We use only the map; word-boundary matching avoids false positives like "ass" in "classic".
const CUSS_SURE_WORDS = new Set(
  Object.entries(cuss)
    .filter(([, rating]) => rating >= 1)
    .map(([word]) => word.toLowerCase()),
);

// Phrases and single words that strongly indicate the game's primary focus is sexual content.
// Includes title-signal words (lusty, lewd, futa, femboy) and multi-word phrases.
const EXPLICIT_PHRASES: string[] = [
  // Multi-word phrases
  'adult only',
  'adults only',
  'adult-only',
  'adults-only',
  'sexual content',
  'strong sexual content',
  'explicit sexual',
  'explicit sexual content',
  'sexual themes',
  'strong sexual themes',
  'interactive sexual content',
  'nsfw',
  'pornographic',
  'pornography',
  'erotic game',
  'adult game',
  'sex game',
  'sexual game',
  'uncensored sexual',
  'full nudity',
  'sexual gameplay',
  'dating sim with sexual',
  'visual novel adult',
  'adult visual novel',
  'lewd game',
  'hentai game',
  // Single-word signals common in adult game titles/descriptions
  'hentai',
  'lusty',
  'lewd',
  'lewds',
  'futa',
  'femboy',
  'femboys',
  'nsfw',
  'erotic',
  'xxx',
  'porn',
  'nude',
  'nudity',
  'uncensored',
  'sex',
  'sexual',
  'orgasm',
  'orgasms',
  'fetish',
  'fetishes',
  'bondage',
  'bdsm',
  'suggestive',
  'seduction',
  'stripper',
  'strippers',
  'escort',
  'escorts',
  'hooker',
  'hookers',
  'prostitute',
  'prostitution',
  'brothel',
  'brothels',
];

function getCombinedText(game: Pick<Game, 'title' | 'summary' | 'longDescription'>): string {
  const parts: string[] = [];
  if (game.title?.trim()) parts.push(game.title.trim());
  if (game.summary?.trim()) parts.push(game.summary.trim());
  if (game.longDescription?.trim()) {
    parts.push(game.longDescription.trim().slice(0, 1500));
  }
  return parts.join(' ').toLowerCase();
}

/** Match whole words (alphanumeric sequences) for cuss check. */
function getWords(text: string): string[] {
  return (text.toLowerCase().match(/\b[a-z0-9']+\b/g) ?? []).filter((w) => w.length > 1);
}

function isExplicitByDescription(text: string): boolean {
  if (!text || text.length < 10) return false;
  const normalized = text.replace(/\s+/g, ' ');

  // 1. Curated phrase/substring list (catches "lusty bubbles", "femboy futa", etc.)
  for (const phrase of EXPLICIT_PHRASES) {
    if (normalized.includes(phrase)) return true;
  }

  // 2. Linguistic library (cuss): word-boundary match for profane/explicit terms
  const words = getWords(normalized);
  for (const word of words) {
    if (CUSS_SURE_WORDS.has(word)) return true;
  }

  return false;
}

// 1.0.97: the in-memory Map is the source of truth. It is loaded once per session (one read of
// the version key and the stored JSON); hits never touch localStorage, and misses mark the cache
// dirty and schedule one debounced persist instead of re-stringifying it on every miss. The cap
// covers Browse (~6K), the release calendar and Oracle together, so passes stop evicting each
// other's verdicts; hits re-insert, so the trim keeps the most recently used entries.
export const ADULT_CACHE_MAX_ENTRIES = 30_000;
const PERSIST_DELAY_MS = 2000;

let cache: Map<string, boolean> | null = null;
let dirty = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function loadCache(): Map<string, boolean> {
  if (cache) return cache;
  cache = new Map();
  try {
    const v = localStorage.getItem(CACHE_VERSION_KEY);
    if ((v ? parseInt(v, 10) : 0) !== CACHE_VERSION) {
      localStorage.setItem(CACHE_VERSION_KEY, String(CACHE_VERSION));
      localStorage.setItem(CACHE_KEY, '{}');
      return cache;
    }
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [k, val] of Object.entries(parsed)) {
          if (typeof val === 'boolean') cache.set(k, val);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return cache;
}

function persistCache(): void {
  persistTimer = null;
  if (cache == null || !dirty) return;
  dirty = false;
  try {
    // Map iteration is insertion order (least recently used first): keep the newest entries.
    const excess = cache.size - ADULT_CACHE_MAX_ENTRIES;
    if (excess > 0) {
      let removed = 0;
      for (const k of cache.keys()) {
        if (removed >= excess) break;
        cache.delete(k);
        removed++;
      }
    }
    const out: Record<string, boolean> = {};
    for (const [k, val] of cache) out[k] = val;
    localStorage.setItem(CACHE_KEY, JSON.stringify(out));
  } catch {
    /* quota */
  }
}

function schedulePersist(): void {
  dirty = true;
  if (persistTimer != null) return;
  persistTimer = setTimeout(persistCache, PERSIST_DELAY_MS);
}

/** Test seam: the phrase/cuss scan, called through this object so tests can spy on it. */
export const __adultFilterInternals = {
  classify: (text: string): boolean => isExplicitByDescription(text),
};

/**
 * Returns true if the game is classified as sexually explicit (prominent focus)
 * based on title and description. Uses phrase list + cuss library; results cached.
 */
export function isAdultContentByDescription(
  game: Pick<Game, 'id' | 'title' | 'summary' | 'longDescription'>,
): boolean {
  const id = game.id;
  if (!id) return false;
  const c = loadCache();
  const hit = c.get(id);
  if (hit !== undefined) {
    // Re-insert so the persist trim acts as LRU. No localStorage access on a hit.
    c.delete(id);
    c.set(id, hit);
    return hit;
  }
  const text = getCombinedText(game);
  const result = __adultFilterInternals.classify(text);
  c.set(id, result);
  schedulePersist();
  return result;
}
