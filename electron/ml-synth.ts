/**
 * Synthesised ML game profiles for games outside the bundled Kaggle profile set.
 *
 * The ML ensemble scores a game from per-game review aggregates (g_* — only in the 2023 Kaggle set),
 * store facts (price, platforms, positive ratio, review count) and Steam tags. For games without a
 * Kaggle profile (Epic, newer or niche Steam titles) we can rebuild the store facts and part of the
 * tags from catalog metadata; the g_* aggregates stay at the model's defaults. Those scores are less
 * reliable, so the caller scales them separately and gives them less weight.
 */
import type { GameProfile } from './ml-features.js';

/** Candidate metadata the renderer sends for a game without a Kaggle profile. */
export interface SynthMeta {
  /** Steam-style positive review share, 0–1. */
  positivity?: number;
  /** Total reviews. */
  reviews?: number;
  /** Price in USD when known. */
  priceUsd?: number;
  isFree?: boolean;
  windows?: boolean;
  mac?: boolean;
  linux?: boolean;
  /** Genre / theme / mode names (store-provided); matched to the model's tag vocabulary. */
  tags?: string[];
}

/** Below this much metadata a synthesised score is noise (measured: tags alone do not correlate). */
export const MIN_SYNTH_TAGS = 2;

const ALIASES: Record<string, string> = {
  'role-playing': 'rpg',
  'role playing': 'rpg',
  'role-playing game': 'rpg',
  'massively multiplayer': 'mmo',
  'first person': 'first-person',
  'third-person': 'third person',
  'science fiction': 'sci-fi',
  'sci fi': 'sci-fi',
  'free-to-play': 'free to play',
  'single-player': 'singleplayer',
  'single player': 'singleplayer',
  'multi-player': 'multiplayer',
  'co-operative': 'co-op',
  'cooperative': 'co-op',
  'online co-op': 'online co-op',
  'open-world': 'open world',
  'turn based': 'turn-based',
  'real time strategy': 'rts',
  'real-time strategy': 'rts',
};

export function normalizeTagName(name: string): string {
  const n = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return ALIASES[n] ?? n;
}

/** Index lookup for the model's tag vocabulary (tag_mapping.json order). */
export function buildTagIndex(tagMapping: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  tagMapping.forEach((t, i) => m.set(t.toLowerCase(), i));
  return m;
}

/**
 * A profile for the feature builder, or null when there is too little to go on (needs a positive
 * ratio and at least MIN_SYNTH_TAGS recognised tags). g_* fields are left undefined → model defaults.
 */
export function buildSyntheticProfile(meta: SynthMeta, tagIndex: Map<string, number>): GameProfile | null {
  if (typeof meta.positivity !== 'number' || !(meta.positivity >= 0 && meta.positivity <= 1)) return null;
  const tags = [...new Set((meta.tags ?? []).map(normalizeTagName).map(t => tagIndex.get(t)).filter((i): i is number => i !== undefined))];
  if (tags.length < MIN_SYNTH_TAGS) return null;
  const profile: Partial<GameProfile> = {
    positive_ratio: Math.round(meta.positivity * 100),
    user_reviews: typeof meta.reviews === 'number' && meta.reviews >= 0 ? meta.reviews : undefined,
    price: meta.isFree ? 0 : typeof meta.priceUsd === 'number' && meta.priceUsd >= 0 ? meta.priceUsd : undefined,
    discount: 0,
    win: meta.windows ?? true,
    mac: meta.mac ?? false,
    linux: meta.linux ?? false,
    tags,
  };
  return profile as GameProfile;
}

/** Validate renderer-provided metadata (IPC input). */
export function parseSynthMeta(raw: unknown): Record<string, SynthMeta> {
  const out: Record<string, SynthMeta> = {};
  if (!raw || typeof raw !== 'object') return out;
  let n = 0;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (++n > 3000) break;
    if (typeof id !== 'string' || id.length > 80 || !v || typeof v !== 'object') continue;
    const m = v as Record<string, unknown>;
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
    const bool = (x: unknown) => (typeof x === 'boolean' ? x : undefined);
    out[id] = {
      positivity: num(m.positivity),
      reviews: num(m.reviews),
      priceUsd: num(m.priceUsd),
      isFree: bool(m.isFree),
      windows: bool(m.windows),
      mac: bool(m.mac),
      linux: bool(m.linux),
      tags: Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === 'string' && t.length <= 60).slice(0, 40) : undefined,
    };
  }
  return out;
}
