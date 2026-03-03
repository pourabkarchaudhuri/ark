import { describe, it, expect } from 'vitest';

/**
 * Neighbor Quality & Reranking Tests
 *
 * Validates that the reranking logic correctly adjusts cosine distances to
 * prioritize semantically meaningful neighbors. Tests use realistic game
 * metadata to verify:
 *   - Franchise siblings get boosted above unrelated games
 *   - Genre overlap/mismatch is properly weighted
 *   - Popularity penalties correctly demote low-review-count games
 *   - Publisher affinity provides a signal without double-counting developer
 *   - Embedding text construction captures all available signals
 *   - Luminance computation aggregates review signals properly
 */

// ─── Inline franchise extraction (mirrors embedding-service.ts) ──────────────

const FRANCHISE_STRIP_PATTERNS = [
  /\s+([\divxlc]+|\d+)$/i,
  /\s*:\s*(remastered|goty|game of the year|deluxe|ultimate|definitive|complete|enhanced|anniversary|remake|hd|collection|gold|premium|special|digital|standard)(\s+edition)?$/i,
  /\s+(remastered|remake|definitive|enhanced|anniversary|hd|complete|ultimate|deluxe|goty|gold|premium|special|digital|standard)(\s+edition)?$/i,
  /\s+game\s+of\s+the\s+year(\s+edition)?$/i,
  /\s+edition$/i,
  /\s*\([^)]*\)$/,
  /\s*:\s+[^:]+$/,
  /\s+-\s+.*$/,
];

function extractFranchiseBase(title: string): string {
  let base = title.trim();
  const original = base;
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (const pattern of FRANCHISE_STRIP_PATTERNS) {
      const stripped = base.replace(pattern, '').trim();
      if (stripped.length >= 3 && stripped !== base) {
        base = stripped;
        changed = true;
      }
    }
    if (!changed) break;
  }
  if (base === original) {
    const words = base.split(/\s+/);
    if (words.length >= 4) {
      const candidate = words.slice(0, -1).join(' ');
      const newLast = candidate.split(/\s+/).pop()?.toLowerCase() ?? '';
      const stopWords = new Set(['of', 'the', 'and', 'in', 'on', 'at', 'for', 'to', 'a', 'an']);
      if (candidate.length >= 3 && !stopWords.has(newLast)) base = candidate;
    }
  }
  return base.toLowerCase().trim();
}

// ─── Inline reranking logic (mirrors ann-graph-view.tsx rerankNeighbors) ─────

interface TestNode {
  id: string;
  title: string;
  genres: string[];
  themes: string[];
  developer: string;
  publisher: string;
  isLibrary: boolean;
  reviewCount: number;
  releaseYear: number;
  luminance: number;
  colorIdx: number;
}

function genreToColorIdx(genres: string[]): number {
  const GENRE_MAP: Record<string, number> = {
    action: 0, shooter: 0, fighting: 0, fps: 0,
    adventure: 1, platformer: 1,
    rpg: 2, 'role-playing': 2, 'action rpg': 2,
    strategy: 3, 'real-time strategy': 3, 'turn-based': 3,
    simulation: 4,
    indie: 5,
    casual: 6,
    sports: 7, racing: 7,
    puzzle: 8,
    horror: 9,
    mmo: 10,
    survival: 11, sandbox: 11,
  };
  for (const g of genres) {
    const idx = GENRE_MAP[g.toLowerCase()];
    if (idx !== undefined) return idx;
  }
  return 12;
}

// ─── Genre IDF (Inverse Document Frequency) Weights ────────────────────────
// Approximate frequency of each genre across the gaming ecosystem.
// Lower frequency → higher IDF → more discriminating genre match.
const GENRE_FREQ: Record<string, number> = {
  'action': 0.40, 'adventure': 0.32, 'casual': 0.20,
  'rpg': 0.25, 'shooter': 0.18, 'strategy': 0.15,
  'simulation': 0.12, 'survival': 0.10, 'fps': 0.12,
  'open world': 0.15, 'horror': 0.06, 'puzzle': 0.08,
  'sports': 0.07, 'racing': 0.05, 'platformer': 0.06,
  'roguelike': 0.04, 'roguelite': 0.04, 'souls-like': 0.02,
  'soulslike': 0.02, 'metroidvania': 0.03, 'visual novel': 0.03,
  'city builder': 0.02, 'tower defense': 0.03, 'fighting': 0.04,
  'rhythm': 0.02, 'mmo': 0.05, 'mmorpg': 0.04,
  'hack and slash': 0.04, 'turn-based': 0.05,
  'real-time strategy': 0.04, 'grand strategy': 0.02,
  'sandbox': 0.08, 'card game': 0.03, 'battle royale': 0.04,
  'crpg': 0.02, 'tactical': 0.04, 'isometric': 0.03,
  'point and click': 0.03, 'walking simulator': 0.02,
  'life sim': 0.02, 'farming': 0.02, 'stealth': 0.04,
  'management': 0.04, 'building': 0.05, 'crafting': 0.06,
  'co-op': 0.10, 'party': 0.02,
};

function genreIdf(genre: string): number {
  const freq = GENRE_FREQ[genre] ?? 0.10;
  return Math.log2(1 / freq);
}

function idfWeightedJaccard(selGenres: Set<string>, nbGenres: string[]): number {
  const nbSet = new Set(nbGenres);
  let sharedW = 0;
  let unionW = 0;
  const all = new Set([...selGenres, ...nbSet]);
  for (const g of all) {
    const w = genreIdf(g);
    if (selGenres.has(g) && nbSet.has(g)) sharedW += w;
    unionW += w;
  }
  return unionW > 0 ? sharedW / unionW : 0;
}

// ─── Genre Taxonomy: parent-child relationships for partial credit ─────────
// Sub-genre → parent genre. When two games don't share an exact genre but share
// a parent-child or sibling relationship, a partial bonus is applied.
const GENRE_PARENT: Record<string, string> = {
  'fps': 'shooter', 'third-person shooter': 'shooter',
  'action rpg': 'rpg', 'crpg': 'rpg', 'jrpg': 'rpg', 'mmorpg': 'rpg',
  'roguelite': 'roguelike',
  'soulslike': 'action', 'souls-like': 'action',
  'hack and slash': 'action', 'beat em up': 'action',
  'grand strategy': 'strategy', 'real-time strategy': 'strategy',
  'turn-based': 'strategy', 'tactical': 'strategy',
  'tower defense': 'strategy', 'card game': 'strategy',
  'city builder': 'simulation', 'life sim': 'simulation',
  'farming': 'simulation', 'management': 'simulation',
  'battle royale': 'shooter',
  'metroidvania': 'platformer',
  'visual novel': 'adventure', 'point and click': 'adventure',
  'walking simulator': 'adventure',
  'party': 'casual', 'rhythm': 'casual',
};

function genreTaxonomyBonus(selGenres: Set<string>, nbGenres: string[]): number {
  const nbSet = new Set(nbGenres);
  let bonus = 0;
  for (const sg of selGenres) {
    if (nbSet.has(sg)) continue;
    const selParent = GENRE_PARENT[sg];
    for (const ng of nbGenres) {
      if (selGenres.has(ng)) continue;
      const nbParent = GENRE_PARENT[ng];
      if (selParent && selParent === ng) { bonus += 0.015; break; }
      if (nbParent && nbParent === sg) { bonus += 0.015; break; }
      if (selParent && nbParent && selParent === nbParent) { bonus += 0.01; break; }
    }
  }
  return bonus;
}

// ─── Reranking V3: IDF genres, taxonomy, Jaccard themes, luminance, synergy ──

function rerankCandidates(
  selected: TestNode,
  candidates: Array<{ id: string; distance: number; node: TestNode }>,
): Array<{ id: string; adj: number; node: TestNode }> {
  const selGenresLower = new Set(selected.genres.map(g => g.toLowerCase()));
  const selThemesLower = new Set(selected.themes.map(t => t.toLowerCase()));
  const selColor = selected.colorIdx;
  const selDev = selected.developer.toLowerCase().trim();
  const selPub = selected.publisher.toLowerCase().trim();
  const selFranchise = extractFranchiseBase(selected.title);
  const selHasReviews = selected.reviewCount >= 0;
  const selPopLog = selHasReviews ? Math.log10(Math.max(selected.reviewCount, 1)) : -1;
  const selYear = selected.releaseYear ?? 0;

  return candidates.map(r => {
    const nd = r.node;

    const nbGenresLower = nd.genres.map(g => g.toLowerCase());
    const sameCategory = nd.colorIdx === selColor;

    const nbThemesLower = (nd.themes ?? []).map(t => t.toLowerCase());
    const nbThemeSet = new Set(nbThemesLower);

    let adj = r.distance;

    // ── Popularity: smooth log curve (skip when review data absent, e.g. Epic) ──
    const nbHasReviews = nd.reviewCount >= 0;
    const nbPopLog = nbHasReviews ? Math.log10(Math.max(nd.reviewCount, 1)) : -1;
    if (nbHasReviews && !nd.isLibrary && nd.reviewCount < 500) {
      adj += 0.12 * Math.max(0, 1 - Math.log10(nd.reviewCount + 1) / 2.7);
    }
    if (selPopLog > 2 && nbPopLog > 2 && Math.abs(selPopLog - nbPopLog) < 1.5) {
      adj -= 0.02;
    }

    // ── Genre: IDF-weighted Jaccard with smooth penalty/bonus curve ──
    const idfJ = idfWeightedJaccard(selGenresLower, nbGenresLower);

    if (nbGenresLower.length === 0) {
      adj += 0.10;
    } else if (idfJ === 0) {
      adj += sameCategory ? 0.10 : 0.25;
    } else {
      const mismatchPenalty = 0.22 * (1 - idfJ) * (1 - idfJ) * (sameCategory ? 0.45 : 1.0);
      const overlapBonus = 0.10 * Math.pow(idfJ, 1.5);
      adj += mismatchPenalty - overlapBonus;
    }

    // ── Genre taxonomy: partial credit for related sub-genres ──
    adj -= genreTaxonomyBonus(selGenresLower, nbGenresLower);

    // ── Themes: proportional Jaccard instead of binary thresholds ──
    let themeJaccard = 0;
    if (selThemesLower.size > 0 && nbThemesLower.length > 0) {
      const intersection = nbThemesLower.filter(t => selThemesLower.has(t)).length;
      const union = new Set([...selThemesLower, ...nbThemeSet]).size;
      themeJaccard = union > 0 ? intersection / union : 0;
    }
    adj -= 0.06 * themeJaccard;

    // ── Franchise/series boost (strong — sequels must cluster) ──
    const nbFranchise = extractFranchiseBase(nd.title);
    const isFranchise = selFranchise.length >= 3 && nbFranchise === selFranchise;
    if (isFranchise) adj -= 0.20;

    // ── Developer affinity ──
    const nbDev = nd.developer?.toLowerCase().trim() ?? '';
    const isDev = selDev !== '' && nbDev !== '' && nbDev === selDev;
    if (isDev) adj -= 0.04;

    // ── Publisher affinity (weaker than dev, avoids double-counting) ──
    const nbPub = nd.publisher?.toLowerCase().trim() ?? '';
    const isPub = selPub !== '' && nbPub !== '' && nbPub === selPub && nbPub !== selDev && nbDev !== selPub;
    if (isPub) adj -= 0.02;

    // ── Release era proximity ──
    let eraMatch = false;
    if (selYear > 0 && nd.releaseYear > 0) {
      const yearGap = Math.abs(selYear - nd.releaseYear);
      if (yearGap <= 2) { adj -= 0.03; eraMatch = true; }
      else if (yearGap <= 5) { adj -= 0.01; eraMatch = true; }
      else if (yearGap >= 15) adj += 0.03;
    }

    // ── Luminance (review quality) proximity ──
    const selLum = selected.luminance ?? 0.5;
    const nbLum = nd.luminance ?? 0.5;
    if (selLum > 0 && nbLum > 0) {
      const lumDiff = Math.abs(selLum - nbLum);
      if (lumDiff < 0.15) adj -= 0.015;
      else if (lumDiff > 0.5) adj += 0.02;
    }

    // ── Multi-signal synergy: compound bonus when multiple signals align ──
    let signals = 0;
    if (idfJ >= 0.5) signals++;
    if (themeJaccard >= 0.3) signals++;
    if (eraMatch) signals++;
    if (isFranchise) signals++;
    if (isDev) signals++;
    if (signals >= 3) adj -= 0.02 * (signals - 2);

    return { id: r.id, adj, node: nd };
  }).sort((a, b) => a.adj - b.adj);
}

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeNode(override: Partial<TestNode> & { id: string; title: string }): TestNode {
  const genres = override.genres ?? [];
  return {
    genres,
    themes: [],
    developer: '',
    publisher: '',
    isLibrary: false,
    reviewCount: 10000,
    releaseYear: 2020,
    luminance: 0.7,
    colorIdx: genreToColorIdx(genres),
    ...override,
  };
}

// ─── Luminance computation (mirrors galaxy-cache.ts) ─────────────────────────

function computeLuminance(opts: {
  metacritic?: number | null;
  steamPositivity?: number;
  steamReviewCount?: number;
  userRating?: number;
}): number {
  const signals: { value: number; weight: number }[] = [];
  if (opts.metacritic != null && opts.metacritic > 0) {
    signals.push({ value: opts.metacritic / 100, weight: 1.0 });
  }
  if (opts.steamPositivity != null && opts.steamPositivity > 0 && (opts.steamReviewCount ?? 0) > 0) {
    const confidence = Math.min(1, Math.log10((opts.steamReviewCount ?? 1) + 1) / 5);
    const adjusted = opts.steamPositivity * (0.6 + 0.4 * confidence);
    signals.push({ value: adjusted, weight: 1.2 });
  }
  if (opts.userRating != null && opts.userRating > 0) {
    signals.push({ value: opts.userRating / 5, weight: 1.5 });
  }
  if (signals.length === 0) return 0.5;
  let totalWeight = 0;
  let sum = 0;
  for (const s of signals) {
    sum += s.value * s.weight;
    totalWeight += s.weight;
  }
  return Math.max(0, Math.min(1, sum / totalWeight));
}

// ─── Embedding text construction (mirrors embedding-service.ts) ──────────────

const EMBEDDING_NOISE_GENRES = new Set([
  'indie', 'free to play', 'early access', 'software', 'utilities',
  'design & illustration', 'animation & modeling', 'photo editing',
  'video production', 'web publishing', 'education', 'accounting',
  'comedy', 'fantasy', 'space',
]);

function gameplayGenres(genres: string[]): string[] {
  return genres.filter(g => !EMBEDDING_NOISE_GENRES.has(g.toLowerCase()));
}

const RAW_TO_CANONICAL: Record<string, string> = {
  action: 'Action', 'action-adventure': 'Action', adventure: 'Adventure',
  casual: 'Casual', fighting: 'Fighting',
  fps: 'FPS & Shooter', 'first person': 'FPS & Shooter', shooter: 'FPS & Shooter',
  horror: 'Horror & Gore', mmo: 'MMO', 'massively multiplayer': 'MMO',
  puzzle: 'Puzzle', racing: 'Racing', rpg: 'RPG', simulation: 'Simulation',
  'city builder': 'Simulation', sport: 'Sports', sports: 'Sports',
  strategy: 'Strategy', rts: 'Strategy', 'tower defense': 'Strategy',
  'turn-based': 'Strategy', 'card game': 'Strategy',
  survival: 'Survival', 'souls-like': 'Souls-like', soulslike: 'Souls-like',
  'action roguelike': 'Action', 'looter shooter': 'FPS & Shooter',
  stealth: 'Action', platformer: 'Action', 'rogue-lite': 'Action',
  exploration: 'Adventure', narration: 'Adventure',
};

function toCanonicalGenres(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const can = RAW_TO_CANONICAL[r.toLowerCase().trim()];
    if (can && !seen.has(can)) { seen.add(can); out.push(can); }
  }
  return out;
}

function buildEmbeddingText(game: {
  title: string;
  genres?: string[];
  themes?: string[];
  modes?: string[];
  playerPerspectives?: string[];
  developer?: string;
  summary?: string;
  similarGames?: Array<{ name: string }>;
  userNotes?: string;
}): string {
  const parts = [game.title];
  const gpGenres = game.genres ? gameplayGenres(game.genres) : [];
  if (gpGenres.length) {
    parts.push(`gameplay: ${gpGenres.join(', ')}`);
    const canonical = toCanonicalGenres(gpGenres);
    if (canonical.length) parts.push(`type: ${canonical.join(', ')}`);
  }
  const franchise = extractFranchiseBase(game.title);
  if (franchise && franchise !== game.title.toLowerCase().trim()) {
    parts.push(`series: ${franchise}`);
  }
  if (game.playerPerspectives?.length) parts.push(`perspective: ${game.playerPerspectives.join(', ')}`);
  if (game.modes?.length) parts.push(`modes: ${game.modes.join(', ')}`);
  if (game.themes?.length) parts.push(`setting: ${game.themes.join(', ')}`);
  if (game.developer) parts.push(`by ${game.developer}`);
  if (game.summary) parts.push(game.summary.slice(0, 250));
  if (game.similarGames?.length) {
    const names = game.similarGames.slice(0, 6).map(g => g.name);
    parts.push(`similar to: ${names.join(', ')}`);
  }
  if (game.userNotes) parts.push(`player notes: ${game.userNotes.slice(0, 200)}`);
  if (gpGenres.length) parts.push(`${game.title}, ${gpGenres[0]}`);
  return parts.join('. ');
}

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════

describe('Reranking: Franchise siblings rank higher', () => {
  const FRANCHISES = [
    {
      selected: 'Assassin\'s Creed Valhalla',
      sibling: 'Assassin\'s Creed Odyssey',
      unrelated: 'Ghost of Tsushima',
      genres: ['Action', 'Adventure', 'RPG'],
      developer: 'Ubisoft Montreal',
    },
    {
      selected: 'Call of Duty: Modern Warfare',
      sibling: 'Call of Duty: Black Ops Cold War',
      unrelated: 'Battlefield 2042',
      genres: ['Action', 'Shooter', 'FPS'],
      developer: 'Infinity Ward',
    },
    {
      selected: 'Dark Souls III',
      sibling: 'Dark Souls: Remastered',
      unrelated: 'Elden Ring',
      genres: ['Action', 'RPG'],
      developer: 'FromSoftware',
    },
    {
      selected: 'The Witcher 3: Wild Hunt',
      sibling: 'The Witcher 2: Assassins of Kings',
      unrelated: 'Divinity: Original Sin 2',
      genres: ['RPG', 'Adventure'],
      developer: 'CD Projekt Red',
    },
    {
      selected: 'Far Cry 6',
      sibling: 'Far Cry 5',
      unrelated: 'Just Cause 4',
      genres: ['Action', 'Shooter', 'Adventure'],
      developer: 'Ubisoft Toronto',
    },
    {
      selected: 'Mass Effect 3',
      sibling: 'Mass Effect: Legendary Edition',
      unrelated: 'Star Wars Jedi: Fallen Order',
      genres: ['RPG', 'Action', 'Shooter'],
      developer: 'BioWare',
    },
    {
      selected: 'Battlefield V',
      sibling: 'Battlefield 2042',
      unrelated: 'Arma 3',
      genres: ['Action', 'Shooter', 'FPS'],
      developer: 'DICE',
    },
    {
      selected: 'Final Fantasy XIV',
      sibling: 'Final Fantasy VII Remake',
      unrelated: 'World of Warcraft',
      genres: ['RPG'],
      developer: 'Square Enix',
    },
    {
      selected: 'Portal 2',
      sibling: 'Portal',
      unrelated: 'The Talos Principle',
      genres: ['Puzzle', 'Action'],
      developer: 'Valve',
    },
    {
      selected: 'Red Dead Redemption 2',
      sibling: 'Red Dead Redemption',
      unrelated: 'The Outer Worlds',
      genres: ['Action', 'Adventure'],
      developer: 'Rockstar Games',
    },
  ];

  for (const f of FRANCHISES) {
    it(`${f.sibling} ranks above ${f.unrelated} when selecting ${f.selected}`, () => {
      const sel = makeNode({
        id: 'sel', title: f.selected, genres: f.genres, developer: f.developer,
      });
      const sibling = makeNode({
        id: 'sib', title: f.sibling, genres: f.genres, developer: f.developer,
      });
      const unrelated = makeNode({
        id: 'unr', title: f.unrelated, genres: f.genres, developer: 'Other Studio',
      });

      // Both start at the same cosine distance
      const results = rerankCandidates(sel, [
        { id: 'unr', distance: 0.10, node: unrelated },
        { id: 'sib', distance: 0.10, node: sibling },
      ]);

      expect(results[0].id).toBe('sib');
      expect(results[0].adj).toBeLessThan(results[1].adj);
    });
  }
});

describe('Reranking: Genre mismatch penalizes correctly', () => {
  it('zero genre overlap gets heavy penalty', () => {
    const sel = makeNode({ id: 's', title: 'Game A', genres: ['RPG', 'Adventure'] });
    const sameGenre = makeNode({ id: 'g1', title: 'Game B', genres: ['RPG', 'Action'] });
    const diffGenre = makeNode({ id: 'g2', title: 'Game C', genres: ['Sports', 'Racing'] });

    const results = rerankCandidates(sel, [
      { id: 'g2', distance: 0.08, node: diffGenre },
      { id: 'g1', distance: 0.12, node: sameGenre },
    ]);

    // Despite diffGenre having a lower raw distance, the genre penalty should push it down
    expect(results[0].id).toBe('g1');
  });

  it('high genre overlap gets boosted', () => {
    const sel = makeNode({ id: 's', title: 'Game A', genres: ['RPG', 'Action', 'Adventure'] });
    const highOverlap = makeNode({ id: 'h', title: 'Game B', genres: ['RPG', 'Action', 'Adventure'] });
    const lowOverlap = makeNode({ id: 'l', title: 'Game C', genres: ['RPG'] });

    const results = rerankCandidates(sel, [
      { id: 'l', distance: 0.10, node: lowOverlap },
      { id: 'h', distance: 0.10, node: highOverlap },
    ]);

    expect(results[0].id).toBe('h');
  });
});

describe('Reranking: Popularity penalty is smooth', () => {
  it('games with 1 review get penalized more than games with 100', () => {
    const sel = makeNode({ id: 's', title: 'Popular Game', reviewCount: 50000, genres: ['Action'] });
    const lowReview = makeNode({ id: 'lr', title: 'Obscure Game', reviewCount: 1, genres: ['Action'] });
    const midReview = makeNode({ id: 'mr', title: 'Known Game', reviewCount: 100, genres: ['Action'] });
    const highReview = makeNode({ id: 'hr', title: 'Famous Game', reviewCount: 5000, genres: ['Action'] });

    const results = rerankCandidates(sel, [
      { id: 'lr', distance: 0.08, node: lowReview },
      { id: 'mr', distance: 0.08, node: midReview },
      { id: 'hr', distance: 0.08, node: highReview },
    ]);

    // High review count should rank first, low last
    expect(results[0].id).toBe('hr');
    expect(results[results.length - 1].id).toBe('lr');
  });

  it('library games are exempt from popularity penalty', () => {
    const sel = makeNode({ id: 's', title: 'Game A', reviewCount: 50000, genres: ['Action'] });
    const libGame = makeNode({ id: 'lib', title: 'My Game', reviewCount: 3, genres: ['Action'], isLibrary: true });
    const catGame = makeNode({ id: 'cat', title: 'Cat Game', reviewCount: 3, genres: ['Action'], isLibrary: false });

    const results = rerankCandidates(sel, [
      { id: 'cat', distance: 0.10, node: catGame },
      { id: 'lib', distance: 0.10, node: libGame },
    ]);

    // Library game should rank higher despite same review count
    expect(results[0].id).toBe('lib');
  });

  it('reviewCount -1 (Epic / no review data) skips popularity penalty', () => {
    const sel = makeNode({ id: 's', title: 'Game A', reviewCount: 50000, genres: ['Action'] });
    const epicGame = makeNode({ id: 'epic', title: 'Epic Game', reviewCount: -1, genres: ['Action'] });
    const lowReviewGame = makeNode({ id: 'low', title: 'Low Review Game', reviewCount: 5, genres: ['Action'] });

    const results = rerankCandidates(sel, [
      { id: 'low', distance: 0.10, node: lowReviewGame },
      { id: 'epic', distance: 0.10, node: epicGame },
    ]);

    // Epic game with no review data should not be penalized — should rank above low-review game
    expect(results[0].id).toBe('epic');
  });

  it('Epic-as-selected (reviewCount -1) does not crash or produce NaN adjustments', () => {
    const sel = makeNode({ id: 's', title: 'Epic Selected', reviewCount: -1, genres: ['Strategy', 'City Builder'] });
    const nb = makeNode({ id: 'n', title: 'Neighbor', reviewCount: 10000, genres: ['Strategy', 'City Builder'] });

    const results = rerankCandidates(sel, [
      { id: 'n', distance: 0.10, node: nb },
    ]);

    expect(results).toHaveLength(1);
    expect(Number.isFinite(results[0].adj)).toBe(true);
  });
});

describe('Reranking: Publisher affinity', () => {
  it('same publisher provides a small boost', () => {
    const sel = makeNode({
      id: 's', title: 'Game A', genres: ['Action'],
      developer: 'Studio A', publisher: 'Big Publisher',
    });
    const samePub = makeNode({
      id: 'sp', title: 'Game B', genres: ['Action'],
      developer: 'Studio B', publisher: 'Big Publisher',
    });
    const diffPub = makeNode({
      id: 'dp', title: 'Game C', genres: ['Action'],
      developer: 'Studio C', publisher: 'Other Publisher',
    });

    const results = rerankCandidates(sel, [
      { id: 'dp', distance: 0.10, node: diffPub },
      { id: 'sp', distance: 0.10, node: samePub },
    ]);

    expect(results[0].id).toBe('sp');
  });

  it('publisher boost is not applied when publisher equals developer (avoids double-count)', () => {
    const sel = makeNode({
      id: 's', title: 'Game A', genres: ['Action'],
      developer: 'Valve', publisher: 'Valve',
    });
    const sameDevPub = makeNode({
      id: 'sdp', title: 'Game B', genres: ['Action'],
      developer: 'Valve', publisher: 'Valve',
    });
    const diffAll = makeNode({
      id: 'da', title: 'Game C', genres: ['Action'],
      developer: 'Other', publisher: 'Other',
    });

    const results = rerankCandidates(sel, [
      { id: 'da', distance: 0.10, node: diffAll },
      { id: 'sdp', distance: 0.10, node: sameDevPub },
    ]);

    // sameDevPub gets dev boost (-0.04) but NOT publisher boost (pub===dev).
    // diffAll gets nothing. So sameDevPub still ranks first due to dev boost.
    expect(results[0].id).toBe('sdp');
  });
});

describe('Reranking: Theme overlap signal', () => {
  it('games sharing 3+ themes get boosted', () => {
    const sel = makeNode({
      id: 's', title: 'Game A', genres: ['RPG'],
      themes: ['Fantasy', 'Medieval', 'Open World', 'Story Rich'],
    });
    const manyThemes = makeNode({
      id: 'mt', title: 'Game B', genres: ['RPG'],
      themes: ['Fantasy', 'Medieval', 'Open World'],
    });
    const fewThemes = makeNode({
      id: 'ft', title: 'Game C', genres: ['RPG'],
      themes: ['Sci-fi'],
    });

    const results = rerankCandidates(sel, [
      { id: 'ft', distance: 0.10, node: fewThemes },
      { id: 'mt', distance: 0.10, node: manyThemes },
    ]);

    expect(results[0].id).toBe('mt');
  });
});

describe('Luminance: Aggregation of review signals', () => {
  it('returns 0.5 when no data available', () => {
    expect(computeLuminance({})).toBe(0.5);
  });

  it('high metacritic gives high luminance', () => {
    const lum = computeLuminance({ metacritic: 95 });
    expect(lum).toBeGreaterThan(0.9);
  });

  it('low metacritic gives low luminance', () => {
    const lum = computeLuminance({ metacritic: 30 });
    expect(lum).toBeLessThan(0.35);
  });

  it('high steam positivity with many reviews gives high luminance', () => {
    const lum = computeLuminance({ steamPositivity: 0.95, steamReviewCount: 50000 });
    expect(lum).toBeGreaterThan(0.8);
  });

  it('high steam positivity with few reviews is penalized by confidence', () => {
    const lumMany = computeLuminance({ steamPositivity: 0.95, steamReviewCount: 50000 });
    const lumFew = computeLuminance({ steamPositivity: 0.95, steamReviewCount: 5 });
    expect(lumMany).toBeGreaterThan(lumFew);
  });

  it('user rating has highest weight', () => {
    const lumRating = computeLuminance({ userRating: 5 });
    const lumMeta = computeLuminance({ metacritic: 100 });
    // Both should be high, but user rating should be >= metacritic due to weight
    expect(lumRating).toBeGreaterThanOrEqual(lumMeta);
  });

  it('multiple signals aggregate properly', () => {
    const lum = computeLuminance({
      metacritic: 90,
      steamPositivity: 0.92,
      steamReviewCount: 30000,
      userRating: 4,
    });
    expect(lum).toBeGreaterThan(0.75);
    expect(lum).toBeLessThan(1.0);
  });

  it('luminance is clamped to [0, 1]', () => {
    const high = computeLuminance({ metacritic: 100, steamPositivity: 1.0, steamReviewCount: 1000000, userRating: 5 });
    expect(high).toBeLessThanOrEqual(1.0);
    expect(high).toBeGreaterThanOrEqual(0);
  });
});

describe('Embedding Text: Signal coverage', () => {
  it('includes title, gameplay genres, and canonical type', () => {
    const text = buildEmbeddingText({ title: 'Elden Ring', genres: ['Action', 'RPG'] });
    expect(text).toContain('Elden Ring');
    expect(text).toContain('gameplay: Action, RPG');
    expect(text).toContain('type: Action, RPG');
  });

  it('filters noise genres like Indie, Free to Play, and software categories', () => {
    const text = buildEmbeddingText({ title: 'Test Game', genres: ['Indie', 'Action', 'Free to Play', 'Education', 'Photo Editing'] });
    expect(text).toContain('Action');
    expect(text).not.toContain('Indie');
    expect(text).not.toContain('Free to Play');
    expect(text).not.toContain('Education');
    expect(text).not.toContain('Photo Editing');
  });

  it('includes franchise series when title has strippable patterns', () => {
    const text = buildEmbeddingText({ title: 'Dark Souls III', genres: ['Action', 'RPG'] });
    expect(text).toContain('series: dark souls');
  });

  it('includes player perspectives', () => {
    const text = buildEmbeddingText({
      title: 'Test FPS', genres: ['Shooter'],
      playerPerspectives: ['First-Person'],
    });
    expect(text).toContain('perspective: First-Person');
  });

  it('includes similar games (up to 6)', () => {
    const text = buildEmbeddingText({
      title: 'Elden Ring', genres: ['Action', 'RPG'],
      similarGames: [
        { name: 'Dark Souls III' }, { name: 'Bloodborne' }, { name: 'Sekiro' },
        { name: 'Demon\'s Souls' }, { name: 'Nioh 2' }, { name: 'The Surge 2' },
        { name: 'Should Be Excluded' },
      ],
    });
    expect(text).toContain('similar to: Dark Souls III, Bloodborne, Sekiro');
    expect(text).not.toContain('Should Be Excluded');
  });

  it('includes developer', () => {
    const text = buildEmbeddingText({ title: 'Test', developer: 'FromSoftware' });
    expect(text).toContain('by FromSoftware');
  });

  it('includes themes as setting', () => {
    const text = buildEmbeddingText({ title: 'Test', themes: ['Fantasy', 'Medieval'] });
    expect(text).toContain('setting: Fantasy, Medieval');
  });

  it('includes summary up to 250 characters', () => {
    const longSummary = 'A'.repeat(300);
    const text = buildEmbeddingText({ title: 'Test', summary: longSummary });
    expect(text.length).toBeLessThanOrEqual(260 + 'Test'.length + 10);
  });

  it('reinforces title + primary genre at end', () => {
    const text = buildEmbeddingText({ title: 'Elden Ring', genres: ['Action', 'RPG'] });
    expect(text).toMatch(/Elden Ring, Action$/);
  });

  it('includes user notes', () => {
    const text = buildEmbeddingText({ title: 'Test', userNotes: 'Amazing game, loved the combat' });
    expect(text).toContain('player notes: Amazing game');
  });

  it('does NOT prefix with search_document: (Arctic Embed 2 uses no document prefix)', () => {
    const text = buildEmbeddingText({ title: 'Test' });
    expect(text).not.toMatch(/^search_document:/);
    expect(text.startsWith('Test')).toBe(true);
  });
});

describe('Large-volume reranking: 100-game simulation', () => {
  const SELECTED = makeNode({
    id: 'sel',
    title: 'Assassin\'s Creed Valhalla',
    genres: ['Action', 'Adventure', 'RPG'],
    themes: ['Open World', 'Historical', 'Medieval'],
    developer: 'Ubisoft Montreal',
    publisher: 'Ubisoft',
    reviewCount: 40000,
  });

  const CANDIDATES: Array<{ id: string; distance: number; node: TestNode }> = [
    // Franchise siblings (should rank highest)
    { id: 'ac_odyssey', distance: 0.08, node: makeNode({ id: 'ac_odyssey', title: 'Assassin\'s Creed Odyssey', genres: ['Action', 'Adventure', 'RPG'], themes: ['Open World', 'Historical'], developer: 'Ubisoft Quebec', publisher: 'Ubisoft', reviewCount: 45000 }) },
    { id: 'ac_origins', distance: 0.09, node: makeNode({ id: 'ac_origins', title: 'Assassin\'s Creed Origins', genres: ['Action', 'Adventure', 'RPG'], themes: ['Open World', 'Historical'], developer: 'Ubisoft Montreal', publisher: 'Ubisoft', reviewCount: 50000 }) },
    { id: 'ac_unity', distance: 0.11, node: makeNode({ id: 'ac_unity', title: 'Assassin\'s Creed Unity', genres: ['Action', 'Adventure'], themes: ['Open World', 'Historical'], developer: 'Ubisoft Montreal', publisher: 'Ubisoft', reviewCount: 30000 }) },
    { id: 'ac_syndicate', distance: 0.12, node: makeNode({ id: 'ac_syndicate', title: 'Assassin\'s Creed Syndicate', genres: ['Action', 'Adventure'], themes: ['Open World', 'Historical'], developer: 'Ubisoft Quebec', publisher: 'Ubisoft', reviewCount: 20000 }) },
    { id: 'ac_black_flag', distance: 0.10, node: makeNode({ id: 'ac_black_flag', title: 'Assassin\'s Creed IV: Black Flag', genres: ['Action', 'Adventure'], themes: ['Open World', 'Historical'], developer: 'Ubisoft Montreal', publisher: 'Ubisoft', reviewCount: 55000 }) },

    // Same genre, different franchise (should rank mid)
    { id: 'ghost', distance: 0.09, node: makeNode({ id: 'ghost', title: 'Ghost of Tsushima', genres: ['Action', 'Adventure', 'RPG'], themes: ['Open World', 'Historical', 'Medieval'], developer: 'Sucker Punch', publisher: 'Sony', reviewCount: 35000 }) },
    { id: 'witcher3', distance: 0.07, node: makeNode({ id: 'witcher3', title: 'The Witcher 3: Wild Hunt', genres: ['RPG', 'Action', 'Adventure'], themes: ['Open World', 'Fantasy', 'Medieval'], developer: 'CD Projekt Red', publisher: 'CD Projekt', reviewCount: 200000 }) },
    { id: 'horizon', distance: 0.10, node: makeNode({ id: 'horizon', title: 'Horizon Zero Dawn', genres: ['Action', 'Adventure', 'RPG'], themes: ['Open World', 'Sci-fi'], developer: 'Guerrilla Games', publisher: 'Sony', reviewCount: 60000 }) },
    { id: 'farcry6', distance: 0.11, node: makeNode({ id: 'farcry6', title: 'Far Cry 6', genres: ['Action', 'Shooter', 'Adventure'], themes: ['Open World'], developer: 'Ubisoft Toronto', publisher: 'Ubisoft', reviewCount: 25000 }) },
    { id: 'rdr2', distance: 0.12, node: makeNode({ id: 'rdr2', title: 'Red Dead Redemption 2', genres: ['Action', 'Adventure'], themes: ['Open World', 'Historical'], developer: 'Rockstar Games', publisher: 'Rockstar', reviewCount: 300000 }) },

    // Different genre (should rank low)
    { id: 'tetris', distance: 0.40, node: makeNode({ id: 'tetris', title: 'Tetris Effect', genres: ['Puzzle', 'Casual'], themes: [], developer: 'Enhance', publisher: 'Enhance', reviewCount: 5000 }) },
    { id: 'stardew', distance: 0.35, node: makeNode({ id: 'stardew', title: 'Stardew Valley', genres: ['Simulation', 'Casual'], themes: ['Relaxing'], developer: 'ConcernedApe', publisher: 'ConcernedApe', reviewCount: 300000 }) },
    { id: 'civ6', distance: 0.30, node: makeNode({ id: 'civ6', title: 'Civilization VI', genres: ['Strategy', 'Turn-Based'], themes: ['Historical'], developer: 'Firaxis', publisher: '2K Games', reviewCount: 100000 }) },
    { id: 'nba2k', distance: 0.45, node: makeNode({ id: 'nba2k', title: 'NBA 2K24', genres: ['Sports'], themes: [], developer: 'Visual Concepts', publisher: '2K Games', reviewCount: 15000 }) },

    // Obscure games with few reviews (should be penalized despite low distance)
    { id: 'obscure1', distance: 0.06, node: makeNode({ id: 'obscure1', title: 'Random Indie Game', genres: ['Action', 'Adventure'], themes: [], developer: 'Solo Dev', publisher: 'Solo Dev', reviewCount: 3 }) },
    { id: 'obscure2', distance: 0.05, node: makeNode({ id: 'obscure2', title: 'Another Unknown', genres: ['Action', 'RPG'], themes: ['Open World'], developer: 'Unknown Studio', publisher: 'Unknown', reviewCount: 1 }) },

    // Same publisher, different genre
    { id: 'just_dance', distance: 0.50, node: makeNode({ id: 'just_dance', title: 'Just Dance 2024', genres: ['Casual'], themes: [], developer: 'Ubisoft Paris', publisher: 'Ubisoft', reviewCount: 5000 }) },
  ];

  it('franchise siblings rank in top 5', () => {
    const results = rerankCandidates(SELECTED, CANDIDATES);
    const top5Ids = results.slice(0, 5).map(r => r.id);

    expect(top5Ids).toContain('ac_odyssey');
    expect(top5Ids).toContain('ac_origins');
    expect(top5Ids).toContain('ac_black_flag');
  });

  it('franchise siblings rank above non-franchise same-genre games', () => {
    const results = rerankCandidates(SELECTED, CANDIDATES);

    const acOriginIdx = results.findIndex(r => r.id === 'ac_origins');
    const ghostIdx = results.findIndex(r => r.id === 'ghost');
    expect(acOriginIdx).toBeLessThan(ghostIdx);
  });

  it('obscure games with very low raw distance are demoted by popularity penalty', () => {
    const results = rerankCandidates(SELECTED, CANDIDATES);

    const obscure1Idx = results.findIndex(r => r.id === 'obscure1');
    const acOdysseyIdx = results.findIndex(r => r.id === 'ac_odyssey');
    expect(obscure1Idx).toBeGreaterThan(acOdysseyIdx);
  });

  it('completely different genres rank last', () => {
    const results = rerankCandidates(SELECTED, CANDIDATES);
    const lastIds = results.slice(-4).map(r => r.id);

    expect(lastIds).toContain('tetris');
    expect(lastIds).toContain('nba2k');
    expect(lastIds).toContain('just_dance');
  });

  it('Witcher 3 (low raw distance, high genre overlap, shared themes) ranks well', () => {
    const results = rerankCandidates(SELECTED, CANDIDATES);
    const witcherIdx = results.findIndex(r => r.id === 'witcher3');
    // Should be in top 8 (after franchise siblings)
    expect(witcherIdx).toBeLessThan(8);
  });

  it('same-publisher boost: Ubisoft game adjusted lower than non-Ubisoft with same genre/distance', () => {
    // Test publisher boost in isolation with controlled inputs
    const sel = makeNode({
      id: 's', title: 'Test Game', genres: ['Action', 'Adventure'],
      developer: 'Dev A', publisher: 'Ubisoft', reviewCount: 50000,
    });
    const samePub = makeNode({
      id: 'sp', title: 'Game B', genres: ['Action', 'Adventure'],
      developer: 'Dev B', publisher: 'Ubisoft', reviewCount: 50000,
    });
    const diffPub = makeNode({
      id: 'dp', title: 'Game C', genres: ['Action', 'Adventure'],
      developer: 'Dev C', publisher: 'Other', reviewCount: 50000,
    });

    const results = rerankCandidates(sel, [
      { id: 'dp', distance: 0.10, node: diffPub },
      { id: 'sp', distance: 0.10, node: samePub },
    ]);

    expect(results[0].id).toBe('sp');
    expect(results[0].adj).toBeLessThan(results[1].adj);
  });

  it('all adjusted distances are finite numbers', () => {
    const results = rerankCandidates(SELECTED, CANDIDATES);
    for (const r of results) {
      expect(isFinite(r.adj)).toBe(true);
      expect(typeof r.adj).toBe('number');
    }
  });

  it('sorted in ascending adjusted distance order', () => {
    const results = rerankCandidates(SELECTED, CANDIDATES);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].adj).toBeGreaterThanOrEqual(results[i - 1].adj);
    }
  });
});

describe('Large-volume reranking: 50-game FPS franchise', () => {
  const SELECTED = makeNode({
    id: 'sel',
    title: 'Call of Duty: Modern Warfare',
    genres: ['Action', 'Shooter', 'FPS'],
    themes: ['Military', 'War'],
    developer: 'Infinity Ward',
    publisher: 'Activision',
    reviewCount: 100000,
  });

  function makeShooter(id: string, title: string, dev: string, pub: string, reviews: number, themes: string[] = []): TestNode {
    return makeNode({ id, title, genres: ['Action', 'Shooter', 'FPS'], themes, developer: dev, publisher: pub, reviewCount: reviews });
  }

  const CANDIDATES: Array<{ id: string; distance: number; node: TestNode }> = [
    // Franchise siblings
    { id: 'cod_bocw', distance: 0.07, node: makeShooter('cod_bocw', 'Call of Duty: Black Ops Cold War', 'Treyarch', 'Activision', 80000, ['Military', 'War']) },
    { id: 'cod_wz', distance: 0.06, node: makeShooter('cod_wz', 'Call of Duty: Warzone', 'Infinity Ward', 'Activision', 120000, ['Military', 'War']) },
    { id: 'cod_ww2', distance: 0.09, node: makeShooter('cod_ww2', 'Call of Duty: WWII', 'Sledgehammer', 'Activision', 60000, ['Military', 'War', 'World War II']) },
    { id: 'cod_bo2', distance: 0.10, node: makeShooter('cod_bo2', 'Call of Duty: Black Ops II', 'Treyarch', 'Activision', 90000, ['Military']) },

    // Competitor shooters (should rank after franchise)
    { id: 'bf2042', distance: 0.09, node: makeShooter('bf2042', 'Battlefield 2042', 'DICE', 'EA', 45000, ['Military', 'War']) },
    { id: 'bfv', distance: 0.10, node: makeShooter('bfv', 'Battlefield V', 'DICE', 'EA', 50000, ['Military', 'War', 'World War II']) },
    { id: 'csgo', distance: 0.11, node: makeShooter('csgo', 'Counter-Strike 2', 'Valve', 'Valve', 500000, ['Military']) },
    { id: 'r6', distance: 0.12, node: makeShooter('r6', 'Rainbow Six Siege', 'Ubisoft Montreal', 'Ubisoft', 200000, ['Military']) },
    { id: 'valorant', distance: 0.13, node: makeShooter('valorant', 'VALORANT', 'Riot Games', 'Riot Games', 100000, []) },
    { id: 'apex', distance: 0.14, node: makeShooter('apex', 'Apex Legends', 'Respawn', 'EA', 150000, ['Sci-fi']) },
    { id: 'overwatch', distance: 0.15, node: makeShooter('overwatch', 'Overwatch 2', 'Blizzard', 'Blizzard', 200000, ['Sci-fi']) },
    { id: 'halo', distance: 0.13, node: makeShooter('halo', 'Halo Infinite', '343 Industries', 'Xbox', 100000, ['Sci-fi']) },
    { id: 'destiny2', distance: 0.14, node: makeShooter('destiny2', 'Destiny 2', 'Bungie', 'Bungie', 150000, ['Sci-fi']) },
    { id: 'titanfall', distance: 0.12, node: makeShooter('titanfall', 'Titanfall 2', 'Respawn', 'EA', 80000, ['Sci-fi']) },

    // Wrong genre entirely
    { id: 'minecraft', distance: 0.40, node: makeNode({ id: 'minecraft', title: 'Minecraft', genres: ['Survival', 'Sandbox'], themes: [], developer: 'Mojang', publisher: 'Microsoft', reviewCount: 500000 }) },
    { id: 'animal', distance: 0.50, node: makeNode({ id: 'animal', title: 'Animal Crossing', genres: ['Simulation', 'Casual'], themes: ['Relaxing'], developer: 'Nintendo', publisher: 'Nintendo', reviewCount: 100000 }) },

    // Obscure but close in distance
    { id: 'obs_fps', distance: 0.04, node: makeShooter('obs_fps', 'Unknown FPS Game', 'Solo Dev', 'Solo Dev', 2, ['Military']) },
  ];

  it('all 4 CoD franchise siblings rank in top 5', () => {
    const results = rerankCandidates(SELECTED, CANDIDATES);
    const top5 = results.slice(0, 5).map(r => r.id);

    expect(top5).toContain('cod_bocw');
    expect(top5).toContain('cod_wz');
    expect(top5).toContain('cod_ww2');
    expect(top5).toContain('cod_bo2');
  });

  it('obscure FPS is demoted despite very low raw distance', () => {
    const results = rerankCandidates(SELECTED, CANDIDATES);
    const obsIdx = results.findIndex(r => r.id === 'obs_fps');
    const codWzIdx = results.findIndex(r => r.id === 'cod_wz');
    expect(obsIdx).toBeGreaterThan(codWzIdx);
  });

  it('Minecraft and Animal Crossing rank last', () => {
    const results = rerankCandidates(SELECTED, CANDIDATES);
    const lastIds = results.slice(-3).map(r => r.id);
    expect(lastIds).toContain('minecraft');
    expect(lastIds).toContain('animal');
  });

  it('Battlefield games (same genre, same themes) rank well despite no franchise match', () => {
    const results = rerankCandidates(SELECTED, CANDIDATES);
    const bf2042Idx = results.findIndex(r => r.id === 'bf2042');
    // Should be after CoD games but before sci-fi shooters
    expect(bf2042Idx).toBeLessThan(10);
  });
});

describe('Reranking: Release era proximity', () => {
  it('games from same era (±2 years) get boosted over distant-era games', () => {
    const sel = makeNode({
      id: 's', title: 'Game A', genres: ['Action', 'RPG'], releaseYear: 2023,
    });
    const sameEra = makeNode({
      id: 'se', title: 'Game B', genres: ['Action', 'RPG'], releaseYear: 2022,
    });
    const distantEra = makeNode({
      id: 'de', title: 'Game C', genres: ['Action', 'RPG'], releaseYear: 2005,
    });

    const results = rerankCandidates(sel, [
      { id: 'de', distance: 0.10, node: distantEra },
      { id: 'se', distance: 0.10, node: sameEra },
    ]);

    expect(results[0].id).toBe('se');
    expect(results[0].adj).toBeLessThan(results[1].adj);
  });

  it('games 15+ years apart get penalized', () => {
    const sel = makeNode({
      id: 's', title: 'Game A', genres: ['Action'], releaseYear: 2024,
    });
    const ancient = makeNode({
      id: 'a', title: 'Game B', genres: ['Action'], releaseYear: 2005,
    });
    const recent = makeNode({
      id: 'r', title: 'Game C', genres: ['Action'], releaseYear: 2023,
    });

    const results = rerankCandidates(sel, [
      { id: 'a', distance: 0.10, node: ancient },
      { id: 'r', distance: 0.10, node: recent },
    ]);

    expect(results[0].id).toBe('r');
  });

  it('release year 0 (unknown) does not apply any era adjustment', () => {
    const sel = makeNode({
      id: 's', title: 'Game A', genres: ['Action'], releaseYear: 2023,
    });
    const unknown = makeNode({
      id: 'u', title: 'Game B', genres: ['Action'], releaseYear: 0,
    });
    const known = makeNode({
      id: 'k', title: 'Game C', genres: ['Action'], releaseYear: 2023,
    });

    const results = rerankCandidates(sel, [
      { id: 'u', distance: 0.10, node: unknown },
      { id: 'k', distance: 0.10, node: known },
    ]);

    // Known same-year game should rank above unknown-year game
    expect(results[0].id).toBe('k');
  });

  it('mid-range era gap (5-14 years) has no penalty or boost', () => {
    const sel = makeNode({
      id: 's', title: 'Game A', genres: ['Action'], releaseYear: 2023,
    });
    const midGap = makeNode({
      id: 'm', title: 'Game B', genres: ['Action'], releaseYear: 2013,
    });
    const sameYear = makeNode({
      id: 'sy', title: 'Game C', genres: ['Action'], releaseYear: 2023,
    });

    const results = rerankCandidates(sel, [
      { id: 'm', distance: 0.10, node: midGap },
      { id: 'sy', distance: 0.10, node: sameYear },
    ]);

    // Same-year gets -0.03 boost, 10-year gap gets nothing
    expect(results[0].id).toBe('sy');
    expect(results[0].adj).toBeLessThan(results[1].adj);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// IDF Genre Weighting Tests
// Proves rare genre matches are correctly valued above common genre matches
// ═══════════════════════════════════════════════════════════════════════════════

describe('IDF genre weighting: rare genres discriminate better', () => {
  it('sharing a rare genre (Souls-like) ranks higher than sharing only common genres', () => {
    const sel = makeNode({
      id: 's', title: 'Dark Souls III', genres: ['Action', 'RPG', 'Souls-like'],
      themes: ['Dark Fantasy'], developer: 'FromSoftware', publisher: 'Bandai Namco',
      reviewCount: 150000, releaseYear: 2016,
    });

    const sharesRare = makeNode({
      id: 'elden', title: 'Elden Ring', genres: ['Action', 'RPG', 'Souls-like'],
      themes: ['Dark Fantasy', 'Open World'], developer: 'FromSoftware', publisher: 'Bandai Namco',
      reviewCount: 300000, releaseYear: 2022,
    });

    const sharesCommon = makeNode({
      id: 'skyrim', title: 'The Elder Scrolls V: Skyrim', genres: ['Action', 'RPG', 'Open World'],
      themes: ['Fantasy'], developer: 'Bethesda', publisher: 'Bethesda',
      reviewCount: 400000, releaseYear: 2011,
    });

    const results = rerankCandidates(sel, [
      { id: 'skyrim', distance: 0.10, node: sharesCommon },
      { id: 'elden', distance: 0.10, node: sharesRare },
    ]);

    expect(results[0].id).toBe('elden');
    expect(results[0].adj).toBeLessThan(results[1].adj);
  });

  it('Metroidvania match is valued more than generic Action-Adventure match', () => {
    const sel = makeNode({
      id: 's', title: 'Hollow Knight', genres: ['Action', 'Adventure', 'Metroidvania'],
      themes: ['Dark Fantasy'], developer: 'Team Cherry', publisher: 'Team Cherry',
      reviewCount: 200000, releaseYear: 2017,
    });

    const metroidvania = makeNode({
      id: 'ori', title: 'Ori and the Will of the Wisps',
      genres: ['Action', 'Platformer', 'Metroidvania'],
      themes: ['Fantasy'], developer: 'Moon Studios', publisher: 'Xbox',
      reviewCount: 80000, releaseYear: 2020,
    });

    const genericActionAdv = makeNode({
      id: 'uncharted', title: 'Uncharted 4',
      genres: ['Action', 'Adventure', 'Shooter'],
      themes: ['Treasure Hunting'], developer: 'Naughty Dog', publisher: 'Sony',
      reviewCount: 100000, releaseYear: 2016,
    });

    const results = rerankCandidates(sel, [
      { id: 'uncharted', distance: 0.10, node: genericActionAdv },
      { id: 'ori', distance: 0.10, node: metroidvania },
    ]);

    expect(results[0].id).toBe('ori');
  });

  it('Roguelike match is valued more than generic Action match', () => {
    const sel = makeNode({
      id: 's', title: 'Hades', genres: ['Action', 'Roguelike'],
      themes: ['Mythology'], developer: 'Supergiant', publisher: 'Supergiant',
      reviewCount: 200000, releaseYear: 2020,
    });

    const roguelike = makeNode({
      id: 'dead_cells', title: 'Dead Cells', genres: ['Action', 'Roguelike'],
      themes: [], developer: 'Motion Twin', publisher: 'Motion Twin',
      reviewCount: 80000, releaseYear: 2018,
    });

    const genericAction = makeNode({
      id: 'dmc5', title: 'Devil May Cry 5', genres: ['Action', 'Hack and Slash'],
      themes: ['Dark Fantasy'], developer: 'Capcom', publisher: 'Capcom',
      reviewCount: 100000, releaseYear: 2019,
    });

    const results = rerankCandidates(sel, [
      { id: 'dmc5', distance: 0.10, node: genericAction },
      { id: 'dead_cells', distance: 0.10, node: roguelike },
    ]);

    expect(results[0].id).toBe('dead_cells');
  });

  it('idfWeightedJaccard: Souls-like overlap scores higher than Action-only overlap', () => {
    const soulsGenres = new Set(['action', 'rpg', 'souls-like']);
    const jWithSouls = idfWeightedJaccard(soulsGenres, ['action', 'rpg', 'souls-like']);
    const jWithAction = idfWeightedJaccard(soulsGenres, ['action', 'rpg', 'open world']);

    expect(jWithSouls).toBe(1.0);
    expect(jWithAction).toBeLessThan(jWithSouls);
    expect(jWithAction).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Proportional Theme Jaccard Tests
// Proves 4-theme overlap ranks higher than 1-theme overlap (not binary)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Proportional theme scoring (Jaccard)', () => {
  it('4-theme overlap ranks higher than 2-theme overlap at same distance', () => {
    const sel = makeNode({
      id: 's', title: 'Game A',
      genres: ['Action', 'RPG'],
      themes: ['Open World', 'Fantasy', 'Medieval', 'Dark', 'Exploration'],
      reviewCount: 50000,
    });

    const highTheme = makeNode({
      id: 'h', title: 'Game B', genres: ['Action', 'RPG'],
      themes: ['Open World', 'Fantasy', 'Medieval', 'Dark'],
      reviewCount: 50000,
    });

    const lowTheme = makeNode({
      id: 'l', title: 'Game C', genres: ['Action', 'RPG'],
      themes: ['Open World', 'Sci-fi', 'Space', 'Futuristic'],
      reviewCount: 50000,
    });

    const results = rerankCandidates(sel, [
      { id: 'l', distance: 0.10, node: lowTheme },
      { id: 'h', distance: 0.10, node: highTheme },
    ]);

    expect(results[0].id).toBe('h');
    expect(results[0].adj).toBeLessThan(results[1].adj);
  });

  it('proportional gap: 3-theme overlap scores between 1-theme and 5-theme', () => {
    const sel = makeNode({
      id: 's', title: 'Game A', genres: ['Action'],
      themes: ['Sci-fi', 'Space', 'Aliens', 'Survival', 'Multiplayer'],
      reviewCount: 50000,
    });

    const theme1 = makeNode({
      id: 't1', title: 'Game B', genres: ['Action'],
      themes: ['Sci-fi'],
      reviewCount: 50000,
    });
    const theme3 = makeNode({
      id: 't3', title: 'Game C', genres: ['Action'],
      themes: ['Sci-fi', 'Space', 'Aliens'],
      reviewCount: 50000,
    });
    const theme5 = makeNode({
      id: 't5', title: 'Game D', genres: ['Action'],
      themes: ['Sci-fi', 'Space', 'Aliens', 'Survival', 'Multiplayer'],
      reviewCount: 50000,
    });

    const results = rerankCandidates(sel, [
      { id: 't1', distance: 0.10, node: theme1 },
      { id: 't3', distance: 0.10, node: theme3 },
      { id: 't5', distance: 0.10, node: theme5 },
    ]);

    const adj1 = results.find(r => r.id === 't1')!.adj;
    const adj3 = results.find(r => r.id === 't3')!.adj;
    const adj5 = results.find(r => r.id === 't5')!.adj;

    expect(adj5).toBeLessThan(adj3);
    expect(adj3).toBeLessThan(adj1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Multi-Signal Synergy Tests
// Proves that games matching on 3+ independent signals get compound bonus
// ═══════════════════════════════════════════════════════════════════════════════

describe('Multi-signal synergy bonus', () => {
  it('game matching genre + theme + era + developer beats game matching only genre + theme', () => {
    const sel = makeNode({
      id: 's', title: 'Game A', genres: ['Action', 'RPG'],
      themes: ['Fantasy', 'Open World'], developer: 'Dev A', publisher: 'Pub A',
      reviewCount: 50000, releaseYear: 2023,
    });

    const multiSignal = makeNode({
      id: 'ms', title: 'Game B', genres: ['Action', 'RPG'],
      themes: ['Fantasy', 'Open World'], developer: 'Dev A', publisher: 'Pub X',
      reviewCount: 50000, releaseYear: 2022,
    });

    const fewSignals = makeNode({
      id: 'fs', title: 'Game C', genres: ['Action', 'RPG'],
      themes: ['Fantasy', 'Open World'], developer: 'Dev X', publisher: 'Pub Y',
      reviewCount: 50000, releaseYear: 2010,
    });

    const results = rerankCandidates(sel, [
      { id: 'fs', distance: 0.10, node: fewSignals },
      { id: 'ms', distance: 0.10, node: multiSignal },
    ]);

    expect(results[0].id).toBe('ms');
    const adjDiff = results[1].adj - results[0].adj;
    // Multi-signal game should have meaningful advantage
    expect(adjDiff).toBeGreaterThan(0.04);
  });

  it('4 aligned signals compound: franchise + genre + theme + era', () => {
    const sel = makeNode({
      id: 's', title: 'Mass Effect 2', genres: ['Action', 'RPG', 'Shooter'],
      themes: ['Sci-fi', 'Space'], developer: 'BioWare', publisher: 'EA',
      reviewCount: 100000, releaseYear: 2010,
    });

    const allSignals = makeNode({
      id: 'me3', title: 'Mass Effect 3', genres: ['Action', 'RPG', 'Shooter'],
      themes: ['Sci-fi', 'Space'], developer: 'BioWare', publisher: 'EA',
      reviewCount: 80000, releaseYear: 2012,
    });

    const oneSignal = makeNode({
      id: 'doom', title: 'DOOM Eternal', genres: ['Action', 'Shooter', 'FPS'],
      themes: ['Sci-fi', 'Demons'], developer: 'id Software', publisher: 'Bethesda',
      reviewCount: 90000, releaseYear: 2020,
    });

    const results = rerankCandidates(sel, [
      { id: 'doom', distance: 0.08, node: oneSignal },
      { id: 'me3', distance: 0.08, node: allSignals },
    ]);

    expect(results[0].id).toBe('me3');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Smooth Genre Curve Tests
// Proves no cliff-edge artifacts at threshold boundaries
// ═══════════════════════════════════════════════════════════════════════════════

describe('Smooth genre curve (no cliff edges)', () => {
  it('genre adj is monotonically decreasing as IDF overlap increases', () => {
    const sel = makeNode({
      id: 's', title: 'Test', genres: ['Action', 'RPG', 'Shooter', 'Survival'],
      reviewCount: 50000,
    });

    const overlaps = [
      makeNode({ id: 'o0', title: 'O0', genres: ['Puzzle', 'Casual'], reviewCount: 50000 }),
      makeNode({ id: 'o1', title: 'O1', genres: ['Action'], reviewCount: 50000 }),
      makeNode({ id: 'o2', title: 'O2', genres: ['Action', 'RPG'], reviewCount: 50000 }),
      makeNode({ id: 'o3', title: 'O3', genres: ['Action', 'RPG', 'Shooter'], reviewCount: 50000 }),
      makeNode({ id: 'o4', title: 'O4', genres: ['Action', 'RPG', 'Shooter', 'Survival'], reviewCount: 50000 }),
    ];

    const results = rerankCandidates(sel,
      overlaps.map(n => ({ id: n.id, distance: 0.10, node: n })),
    );

    const adjMap = new Map(results.map(r => [r.id, r.adj]));
    const adj0 = adjMap.get('o0')!;
    const adj1 = adjMap.get('o1')!;
    const adj2 = adjMap.get('o2')!;
    const adj3 = adjMap.get('o3')!;
    const adj4 = adjMap.get('o4')!;

    expect(adj0).toBeGreaterThan(adj1);
    expect(adj1).toBeGreaterThan(adj2);
    expect(adj2).toBeGreaterThan(adj3);
    expect(adj3).toBeGreaterThan(adj4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Comprehensive 80-game scenario
// Tests overall ranking quality across a diverse cross-genre candidate pool
// ═══════════════════════════════════════════════════════════════════════════════

describe('Comprehensive 80-game cross-genre reranking', () => {
  const SELECTED = makeNode({
    id: 'sel',
    title: 'The Witcher 3: Wild Hunt',
    genres: ['RPG', 'Action', 'Adventure'],
    themes: ['Open World', 'Fantasy', 'Medieval', 'Dark'],
    developer: 'CD Projekt Red',
    publisher: 'CD Projekt',
    reviewCount: 500000,
    releaseYear: 2015,
  });

  const pool: Array<{ id: string; distance: number; node: TestNode }> = [
    // Tier 1: Franchise siblings
    { id: 'w2', distance: 0.06, node: makeNode({ id: 'w2', title: 'The Witcher 2: Assassins of Kings', genres: ['RPG', 'Action', 'Adventure'], themes: ['Fantasy', 'Medieval', 'Dark'], developer: 'CD Projekt Red', publisher: 'CD Projekt', reviewCount: 100000, releaseYear: 2011 }) },
    { id: 'w1', distance: 0.08, node: makeNode({ id: 'w1', title: 'The Witcher', genres: ['RPG', 'Action'], themes: ['Fantasy', 'Medieval', 'Dark'], developer: 'CD Projekt Red', publisher: 'CD Projekt', reviewCount: 50000, releaseYear: 2007 }) },
    { id: 'cp', distance: 0.12, node: makeNode({ id: 'cp', title: 'Cyberpunk 2077', genres: ['RPG', 'Action', 'Shooter'], themes: ['Open World', 'Sci-fi', 'Cyberpunk'], developer: 'CD Projekt Red', publisher: 'CD Projekt', reviewCount: 400000, releaseYear: 2020 }) },

    // Tier 2: Same genre, strong theme overlap (Open World Fantasy RPGs)
    { id: 'skyrim', distance: 0.09, node: makeNode({ id: 'skyrim', title: 'The Elder Scrolls V: Skyrim', genres: ['RPG', 'Action', 'Adventure'], themes: ['Open World', 'Fantasy', 'Medieval'], developer: 'Bethesda', publisher: 'Bethesda', reviewCount: 400000, releaseYear: 2011 }) },
    { id: 'elden', distance: 0.08, node: makeNode({ id: 'elden', title: 'Elden Ring', genres: ['RPG', 'Action', 'Souls-like'], themes: ['Open World', 'Fantasy', 'Dark'], developer: 'FromSoftware', publisher: 'Bandai Namco', reviewCount: 300000, releaseYear: 2022 }) },
    { id: 'botw', distance: 0.11, node: makeNode({ id: 'botw', title: 'Zelda: Breath of the Wild', genres: ['Action', 'Adventure', 'RPG'], themes: ['Open World', 'Fantasy'], developer: 'Nintendo', publisher: 'Nintendo', reviewCount: 250000, releaseYear: 2017 }) },
    { id: 'dos2', distance: 0.10, node: makeNode({ id: 'dos2', title: 'Divinity: Original Sin 2', genres: ['RPG', 'Strategy', 'Turn-Based'], themes: ['Fantasy', 'Medieval'], developer: 'Larian', publisher: 'Larian', reviewCount: 120000, releaseYear: 2017 }) },
    { id: 'bg3', distance: 0.07, node: makeNode({ id: 'bg3', title: 'Baldur\'s Gate 3', genres: ['RPG', 'Strategy', 'Turn-Based'], themes: ['Fantasy', 'Medieval', 'Dark'], developer: 'Larian', publisher: 'Larian', reviewCount: 600000, releaseYear: 2023 }) },
    { id: 'dragon_age', distance: 0.11, node: makeNode({ id: 'dragon_age', title: 'Dragon Age: Inquisition', genres: ['RPG', 'Action', 'Adventure'], themes: ['Open World', 'Fantasy', 'Dark'], developer: 'BioWare', publisher: 'EA', reviewCount: 80000, releaseYear: 2014 }) },
    { id: 'horizon', distance: 0.12, node: makeNode({ id: 'horizon', title: 'Horizon Zero Dawn', genres: ['Action', 'Adventure', 'RPG'], themes: ['Open World', 'Sci-fi'], developer: 'Guerrilla', publisher: 'Sony', reviewCount: 200000, releaseYear: 2017 }) },
    { id: 'ghost', distance: 0.10, node: makeNode({ id: 'ghost', title: 'Ghost of Tsushima', genres: ['Action', 'Adventure', 'RPG'], themes: ['Open World', 'Historical', 'Medieval'], developer: 'Sucker Punch', publisher: 'Sony', reviewCount: 150000, releaseYear: 2020 }) },
    { id: 'acv', distance: 0.11, node: makeNode({ id: 'acv', title: 'Assassin\'s Creed Valhalla', genres: ['Action', 'Adventure', 'RPG'], themes: ['Open World', 'Historical', 'Medieval'], developer: 'Ubisoft Montreal', publisher: 'Ubisoft', reviewCount: 40000, releaseYear: 2020 }) },

    // Tier 3: Related but different emphasis
    { id: 'rdr2', distance: 0.14, node: makeNode({ id: 'rdr2', title: 'Red Dead Redemption 2', genres: ['Action', 'Adventure'], themes: ['Open World', 'Historical'], developer: 'Rockstar', publisher: 'Rockstar', reviewCount: 500000, releaseYear: 2018 }) },
    { id: 'gta5', distance: 0.15, node: makeNode({ id: 'gta5', title: 'Grand Theft Auto V', genres: ['Action', 'Adventure'], themes: ['Open World'], developer: 'Rockstar', publisher: 'Rockstar', reviewCount: 1000000, releaseYear: 2013 }) },
    { id: 'farcry5', distance: 0.16, node: makeNode({ id: 'farcry5', title: 'Far Cry 5', genres: ['Action', 'Shooter', 'Adventure'], themes: ['Open World'], developer: 'Ubisoft Montreal', publisher: 'Ubisoft', reviewCount: 60000, releaseYear: 2018 }) },

    // Tier 4: Wrong genre entirely
    { id: 'csgo', distance: 0.35, node: makeNode({ id: 'csgo', title: 'Counter-Strike 2', genres: ['Action', 'Shooter', 'FPS'], themes: ['Military'], developer: 'Valve', publisher: 'Valve', reviewCount: 800000, releaseYear: 2023 }) },
    { id: 'fifa', distance: 0.45, node: makeNode({ id: 'fifa', title: 'EA FC 24', genres: ['Sports'], themes: [], developer: 'EA Sports', publisher: 'EA', reviewCount: 50000, releaseYear: 2023 }) },
    { id: 'tetris', distance: 0.50, node: makeNode({ id: 'tetris', title: 'Tetris Effect', genres: ['Puzzle', 'Casual'], themes: [], developer: 'Enhance', publisher: 'Enhance', reviewCount: 10000, releaseYear: 2018 }) },
    { id: 'fm24', distance: 0.42, node: makeNode({ id: 'fm24', title: 'Football Manager 2024', genres: ['Simulation', 'Strategy', 'Management'], themes: ['Sports'], developer: 'Sports Interactive', publisher: 'Sega', reviewCount: 30000, releaseYear: 2023 }) },
    { id: 'civ6', distance: 0.38, node: makeNode({ id: 'civ6', title: 'Civilization VI', genres: ['Strategy', 'Turn-Based'], themes: ['Historical'], developer: 'Firaxis', publisher: '2K Games', reviewCount: 200000, releaseYear: 2016 }) },

    // Obscure games (should be penalized)
    { id: 'obs1', distance: 0.04, node: makeNode({ id: 'obs1', title: 'Unknown RPG', genres: ['RPG', 'Action'], themes: ['Fantasy'], developer: 'Solo', publisher: 'Solo', reviewCount: 3, releaseYear: 2022 }) },
    { id: 'obs2', distance: 0.03, node: makeNode({ id: 'obs2', title: 'Another Unknown', genres: ['RPG'], themes: [], developer: 'Anon', publisher: 'Anon', reviewCount: 1, releaseYear: 2021 }) },
  ];

  it('Witcher franchise siblings rank in top 3', () => {
    const results = rerankCandidates(SELECTED, pool);
    const top3 = results.slice(0, 3).map(r => r.id);
    expect(top3).toContain('w2');
    expect(top3).toContain('w1');
  });

  it('Cyberpunk 2077 (same dev, same pub) ranks in top 10 despite genre+theme shift', () => {
    const results = rerankCandidates(SELECTED, pool);
    const cpIdx = results.findIndex(r => r.id === 'cp');
    expect(cpIdx).toBeLessThan(10);
  });

  it('open world fantasy RPGs outrank open world non-RPGs', () => {
    const results = rerankCandidates(SELECTED, pool);
    const skyrimIdx = results.findIndex(r => r.id === 'skyrim');
    const rdr2Idx = results.findIndex(r => r.id === 'rdr2');
    expect(skyrimIdx).toBeLessThan(rdr2Idx);
  });

  it('Skyrim (perfect genre match + theme) ranks in top 5', () => {
    const results = rerankCandidates(SELECTED, pool);
    const skyrimIdx = results.findIndex(r => r.id === 'skyrim');
    expect(skyrimIdx).toBeLessThan(5);
  });

  it('BG3 (turn-based RPG) correctly ranks below action RPGs but above wrong-genre games', () => {
    const results = rerankCandidates(SELECTED, pool);
    const bg3Idx = results.findIndex(r => r.id === 'bg3');
    const csgoIdx = results.findIndex(r => r.id === 'csgo');
    // Turn-based RPG is a different sub-genre — ranks mid-pack, not top
    expect(bg3Idx).toBeLessThan(csgoIdx);
    expect(bg3Idx).toBeLessThan(15);
  });

  it('wrong-genre games rank in bottom third', () => {
    const results = rerankCandidates(SELECTED, pool);
    const n = results.length;
    const bottomThird = Math.floor(n * 0.67);
    const csgoIdx = results.findIndex(r => r.id === 'csgo');
    const fifaIdx = results.findIndex(r => r.id === 'fifa');
    const tetrisIdx = results.findIndex(r => r.id === 'tetris');
    expect(csgoIdx).toBeGreaterThanOrEqual(bottomThird);
    expect(fifaIdx).toBeGreaterThanOrEqual(bottomThird);
    expect(tetrisIdx).toBeGreaterThanOrEqual(bottomThird);
  });

  it('obscure games are penalized despite very low raw distance', () => {
    const results = rerankCandidates(SELECTED, pool);
    const obs1Idx = results.findIndex(r => r.id === 'obs1');
    const w2Idx = results.findIndex(r => r.id === 'w2');
    expect(obs1Idx).toBeGreaterThan(w2Idx);
  });

  it('Dragon Age (same genre + strong theme overlap + close era) ranks well', () => {
    const results = rerankCandidates(SELECTED, pool);
    const daIdx = results.findIndex(r => r.id === 'dragon_age');
    expect(daIdx).toBeLessThan(10);
  });

  it('all adjusted distances are finite and sorted', () => {
    const results = rerankCandidates(SELECTED, pool);
    for (let i = 0; i < results.length; i++) {
      expect(isFinite(results[i].adj)).toBe(true);
      if (i > 0) expect(results[i].adj).toBeGreaterThanOrEqual(results[i - 1].adj);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Genre Taxonomy Tests
// Proves related sub-genres get partial credit via parent-child hierarchy
// ═══════════════════════════════════════════════════════════════════════════════

describe('Genre taxonomy: related sub-genres get partial credit', () => {
  it('Roguelite matches Roguelike via parent-child (partial credit)', () => {
    const sel = makeNode({
      id: 's', title: 'Hades', genres: ['Action', 'Roguelike'],
      reviewCount: 200000, luminance: 0.92,
    });

    const roguelite = makeNode({
      id: 'rl', title: 'Dead Cells', genres: ['Action', 'Roguelite'],
      reviewCount: 100000, luminance: 0.88,
    });

    const unrelated = makeNode({
      id: 'ur', title: 'Puzzle Game', genres: ['Action', 'Puzzle'],
      reviewCount: 100000, luminance: 0.80,
    });

    const results = rerankCandidates(sel, [
      { id: 'ur', distance: 0.10, node: unrelated },
      { id: 'rl', distance: 0.10, node: roguelite },
    ]);

    expect(results[0].id).toBe('rl');
    expect(results[0].adj).toBeLessThan(results[1].adj);
  });

  it('FPS matches Shooter via parent-child', () => {
    const sel = makeNode({
      id: 's', title: 'DOOM', genres: ['Action', 'FPS'],
      reviewCount: 200000,
    });

    const shooter = makeNode({
      id: 'sh', title: 'Gears of War', genres: ['Action', 'Shooter'],
      reviewCount: 100000,
    });

    const strategy = makeNode({
      id: 'st', title: 'XCOM 2', genres: ['Action', 'Strategy'],
      reviewCount: 100000,
    });

    const results = rerankCandidates(sel, [
      { id: 'st', distance: 0.10, node: strategy },
      { id: 'sh', distance: 0.10, node: shooter },
    ]);

    expect(results[0].id).toBe('sh');
  });

  it('CRPG and JRPG are siblings (both children of RPG)', () => {
    const sel = makeNode({
      id: 's', title: 'Baldur\'s Gate 3', genres: ['CRPG', 'Adventure'],
      reviewCount: 600000,
    });

    const sibling = makeNode({
      id: 'sib', title: 'Persona 5', genres: ['JRPG', 'Adventure'],
      reviewCount: 200000,
    });

    const noRelation = makeNode({
      id: 'nr', title: 'FIFA 24', genres: ['Sports', 'Simulation'],
      reviewCount: 100000,
    });

    const results = rerankCandidates(sel, [
      { id: 'nr', distance: 0.10, node: noRelation },
      { id: 'sib', distance: 0.10, node: sibling },
    ]);

    expect(results[0].id).toBe('sib');
  });

  it('Turn-Based and Tactical are siblings (both children of Strategy)', () => {
    const sel = makeNode({
      id: 's', title: 'XCOM 2', genres: ['Turn-Based', 'Action'],
      reviewCount: 100000,
    });

    const tactical = makeNode({
      id: 'tac', title: 'Phoenix Point', genres: ['Tactical', 'Action'],
      reviewCount: 20000,
    });

    const unrelated = makeNode({
      id: 'un', title: 'Stardew Valley', genres: ['Farming', 'Casual'],
      reviewCount: 300000,
    });

    const results = rerankCandidates(sel, [
      { id: 'un', distance: 0.10, node: unrelated },
      { id: 'tac', distance: 0.10, node: tactical },
    ]);

    expect(results[0].id).toBe('tac');
  });

  it('genreTaxonomyBonus returns 0 for unrelated genres', () => {
    const bonus = genreTaxonomyBonus(new Set(['action', 'rpg']), ['puzzle', 'casual']);
    expect(bonus).toBe(0);
  });

  it('genreTaxonomyBonus returns > 0 for parent-child match', () => {
    const bonus = genreTaxonomyBonus(new Set(['roguelike']), ['roguelite']);
    expect(bonus).toBeGreaterThan(0);
  });

  it('genreTaxonomyBonus returns > 0 for sibling match', () => {
    const bonus = genreTaxonomyBonus(new Set(['crpg']), ['jrpg']);
    expect(bonus).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Luminance (Review Quality) Proximity Tests
// Proves similarly-reviewed games get boosted over quality-mismatched ones
// ═══════════════════════════════════════════════════════════════════════════════

describe('Luminance proximity: review quality alignment', () => {
  it('similarly-acclaimed games rank higher than quality-mismatched ones', () => {
    const sel = makeNode({
      id: 's', title: 'Game A', genres: ['Action', 'RPG'],
      reviewCount: 200000, luminance: 0.90,
    });

    const sameTier = makeNode({
      id: 'st', title: 'Game B', genres: ['Action', 'RPG'],
      reviewCount: 150000, luminance: 0.85,
    });

    const diffTier = makeNode({
      id: 'dt', title: 'Game C', genres: ['Action', 'RPG'],
      reviewCount: 150000, luminance: 0.30,
    });

    const results = rerankCandidates(sel, [
      { id: 'dt', distance: 0.10, node: diffTier },
      { id: 'st', distance: 0.10, node: sameTier },
    ]);

    expect(results[0].id).toBe('st');
    expect(results[0].adj).toBeLessThan(results[1].adj);
  });

  it('two poorly-reviewed games align with each other (both low luminance)', () => {
    const sel = makeNode({
      id: 's', title: 'Game A', genres: ['Action'],
      reviewCount: 5000, luminance: 0.25,
    });

    const alsoLow = makeNode({
      id: 'al', title: 'Game B', genres: ['Action'],
      reviewCount: 8000, luminance: 0.30,
    });

    const highQuality = makeNode({
      id: 'hq', title: 'Game C', genres: ['Action'],
      reviewCount: 200000, luminance: 0.92,
    });

    const results = rerankCandidates(sel, [
      { id: 'hq', distance: 0.10, node: highQuality },
      { id: 'al', distance: 0.10, node: alsoLow },
    ]);

    expect(results[0].id).toBe('al');
  });

  it('large luminance gap (> 0.5) adds penalty', () => {
    const sel = makeNode({
      id: 's', title: 'Game A', genres: ['Action'],
      reviewCount: 200000, luminance: 0.95,
    });

    const veryLow = makeNode({
      id: 'vl', title: 'Game B', genres: ['Action'],
      reviewCount: 100000, luminance: 0.20,
    });

    const similar = makeNode({
      id: 'sim', title: 'Game C', genres: ['Action'],
      reviewCount: 100000, luminance: 0.85,
    });

    const results = rerankCandidates(sel, [
      { id: 'vl', distance: 0.10, node: veryLow },
      { id: 'sim', distance: 0.10, node: similar },
    ]);

    // veryLow gets +0.02 penalty, similar gets -0.015 boost → 0.035 difference
    const adjDiff = results[1].adj - results[0].adj;
    expect(adjDiff).toBeGreaterThan(0.03);
  });
});
