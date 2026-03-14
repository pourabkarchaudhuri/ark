/**
 * Adult content filter — classifies games as "sexually explicit as prominent"
 * from title and description text (not store tags). Uses:
 * 1. A curated list of phrases/words that imply explicit sexual intent.
 * 2. The "cuss" linguistic library (profane words with sureness ratings) for
 *    word-boundary matching to reinforce the logic.
 * Results are cached in localStorage; cache is invalidated when CACHE_VERSION changes.
 */

import type { Game } from '@/types/game';
import { cuss } from 'cuss';

const CACHE_KEY = 'ark-adult-classification-cache';
const CACHE_VERSION_KEY = 'ark-adult-classification-cache-version';
const CACHE_VERSION = 2;
const CACHE_MAX_ENTRIES = 2000;

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

let cache: Record<string, boolean> | null = null;

function getCacheVersion(): number {
  try {
    const v = localStorage.getItem(CACHE_VERSION_KEY);
    return v ? parseInt(v, 10) : 0;
  } catch {
    return 0;
  }
}

function loadCache(): Record<string, boolean> {
  if (cache != null && getCacheVersion() === CACHE_VERSION) return cache;
  cache = null;
  try {
    if (getCacheVersion() !== CACHE_VERSION) {
      localStorage.setItem(CACHE_VERSION_KEY, String(CACHE_VERSION));
      localStorage.setItem(CACHE_KEY, '{}');
      cache = {};
      return cache;
    }
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      if (typeof parsed === 'object' && parsed !== null) {
        cache = parsed;
        return cache;
      }
    }
  } catch {
    /* ignore */
  }
  cache = {};
  return cache;
}

function saveCache() {
  if (cache == null) return;
  try {
    const keys = Object.keys(cache);
    if (keys.length > CACHE_MAX_ENTRIES) {
      const trimmed: Record<string, boolean> = {};
      keys.slice(-CACHE_MAX_ENTRIES).forEach((k) => (trimmed[k] = cache![k]!));
      cache = trimmed;
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    localStorage.setItem(CACHE_VERSION_KEY, String(CACHE_VERSION));
  } catch {
    /* quota */
  }
}

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
  if (id in c) return c[id]!;
  const text = getCombinedText(game);
  const result = isExplicitByDescription(text);
  c[id] = result;
  saveCache();
  return result;
}
