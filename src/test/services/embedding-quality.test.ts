import { describe, it, expect } from 'vitest';

/**
 * Neighbor Quality Tests
 *
 * Validates the franchise detection and embedding text construction logic
 * that directly controls which games surface as neighbors in the galaxy map.
 * Tests use known game titles to verify:
 *   - Franchise siblings ARE matched (e.g. "Assassin's Creed Valhalla" → "Assassin's Creed")
 *   - Unrelated games with similar prefixes are NOT matched (e.g. "Call of Duty" ≠ "Call of Cthulhu")
 *   - Edge cases: short titles, editions, remasters, sequels
 */

// Inline the extractFranchiseBase logic (mirrors embedding-service.ts) for unit testing
// without Electron/IDB dependencies
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

describe('extractFranchiseBase', () => {
  describe('should correctly identify franchise bases', () => {
    // Titles with colons, numbers, or editions ARE stripped by regex patterns.
    // 3-word titles without these markers keep their fallback-stripped base
    // only when >= 4 words (to avoid "Grand Theft Auto" → "Grand Theft").
    // 2-3 word titles rely on embedding semantic similarity instead.
    const cases: [string, string][] = [
      // Colon-based stripping
      ['Call of Duty: Modern Warfare', 'call of duty'],
      ['Call of Duty: Black Ops III', 'call of duty'],
      ['Call of Duty: Warzone', 'call of duty'],
      ['The Witcher 3: Wild Hunt', 'the witcher'],
      ['The Witcher 3: Wild Hunt - Blood and Wine', 'the witcher'],
      ['Batman: Arkham Knight', 'batman'],
      ['Batman: Arkham City', 'batman'],
      ['Halo: The Master Chief Collection', 'halo'],
      ['The Elder Scrolls V: Skyrim', 'the elder scrolls'],
      // Number/numeral stripping
      ['Dark Souls III', 'dark souls'],
      ['Battlefield V', 'battlefield'],
      ['Battlefield 2042', 'battlefield'],
      ['Far Cry 6', 'far cry'],
      ['Mass Effect 3', 'mass effect'],
      ['Assassin\'s Creed II', 'assassin\'s creed'],
      ['Final Fantasy XIV', 'final fantasy'],
      ['Red Dead Redemption 2', 'red dead redemption'],
      // Edition/remaster stripping
      ['Dark Souls: Remastered', 'dark souls'],
      ['Mass Effect: Legendary Edition', 'mass effect'],
      ['Final Fantasy VII Remake', 'final fantasy'],
      ['Resident Evil 2 Remake', 'resident evil'],
      // 4+-word fallback stripping
      ['Assassin\'s Creed Valhalla DLC', 'assassin\'s creed valhalla'],
    ];

    for (const [input, expected] of cases) {
      it(`"${input}" → "${expected}"`, () => {
        expect(extractFranchiseBase(input)).toBe(expected);
      });
    }
  });

  describe('should NOT falsely match unrelated games', () => {
    const unrelatedPairs: [string, string][] = [
      ['Call of Duty: Modern Warfare', 'Call of Cthulhu'],
      ['Dark Souls III', 'Darkest Dungeon'],
      ['Dead Space', 'Dead by Daylight'],
      ['The Witcher 3: Wild Hunt', 'The Elder Scrolls V: Skyrim'],
      ['Grand Theft Auto V', 'Grand Strategy Game'],
      ['Final Fantasy XIV', 'Final Exam'],
    ];

    for (const [gameA, gameB] of unrelatedPairs) {
      it(`"${gameA}" should NOT match "${gameB}"`, () => {
        const baseA = extractFranchiseBase(gameA);
        const baseB = extractFranchiseBase(gameB);
        expect(baseA).not.toBe(baseB);
      });
    }
  });

  describe('should preserve short titles that are complete names', () => {
    const shortTitles: [string, string][] = [
      ['Hades', 'hades'],
      ['Celeste', 'celeste'],
      ['Portal', 'portal'],
      ['Portal 2', 'portal'],
      ['Doom', 'doom'],
      ['Prey', 'prey'],
      ['Stardew Valley', 'stardew valley'],
      ['Grand Theft Auto', 'grand theft auto'],  // 3 words — intentionally not stripped
      ['Halo Infinite', 'halo infinite'],  // 2 words — too short for fallback
      ['DOOM Eternal', 'doom eternal'],  // 2 words — too short for fallback
      ['Far Cry Primal', 'far cry primal'],  // 3 words — intentionally not stripped
      ['Resident Evil Village', 'resident evil village'],  // 3 words — no pattern match
    ];

    for (const [input, expected] of shortTitles) {
      it(`"${input}" → "${expected}"`, () => {
        expect(extractFranchiseBase(input)).toBe(expected);
      });
    }
  });

  describe('edition/remaster stripping', () => {
    const editionCases: [string, string][] = [
      ['Skyrim Special Edition', 'skyrim'],
      ['Horizon Zero Dawn Complete Edition', 'horizon zero dawn'],
      ['Persona 5 Royal Deluxe Edition', 'persona 5 royal'],
      ['God of War Ragnarök Deluxe Edition', 'god of war ragnarök'],
      ['Cyberpunk 2077 Ultimate Edition', 'cyberpunk'],
      ['Control Ultimate Edition', 'control'],
      ['Borderlands 3 Gold Edition', 'borderlands'],
    ];

    for (const [input, expected] of editionCases) {
      it(`"${input}" → "${expected}"`, () => {
        expect(extractFranchiseBase(input)).toBe(expected);
      });
    }
  });
});

// ─── Embedding text construction (mirrors embedding-service.ts buildEmbeddingText) ──

const EMBEDDING_NOISE_GENRES = new Set([
  'indie', 'free to play', 'early access', 'software', 'utilities',
  'design & illustration', 'animation & modeling', 'photo editing',
  'video production', 'web publishing', 'education', 'accounting',
]);

function gameplayGenres(genres: string[]): string[] {
  return genres.filter(g => !EMBEDDING_NOISE_GENRES.has(g.toLowerCase()));
}

function buildEmbeddingText(game: {
  title: string;
  genres?: string[];
  themes?: string[];
  modes?: string[];
  developer?: string;
  summary?: string;
  description?: string;
}): string {
  const parts = [game.title];
  const gpGenres = game.genres ? gameplayGenres(game.genres) : [];
  if (gpGenres.length) parts.push(`gameplay: ${gpGenres.join(', ')}`);
  const franchise = extractFranchiseBase(game.title);
  if (franchise && franchise !== game.title.toLowerCase().trim()) {
    parts.push(`series: ${franchise}`);
  }
  if (game.modes?.length) parts.push(`modes: ${game.modes.join(', ')}`);
  if (game.themes?.length) parts.push(`setting: ${game.themes.join(', ')}`);
  if (game.developer) parts.push(`by ${game.developer}`);
  if (game.summary) parts.push(game.summary.slice(0, 1000));
  if (game.description) parts.push(game.description.slice(0, 3000));
  if (gpGenres.length) parts.push(`${game.title}, ${gpGenres[0]}`);
  return parts.join('. ');
}

describe('Embedding text includes longDescription', () => {
  it('includes description (longDescription) in embedding text', () => {
    const text = buildEmbeddingText({
      title: 'Elden Ring',
      genres: ['Action', 'RPG'],
      developer: 'FromSoftware',
      summary: 'An action RPG set in the Lands Between.',
      description: 'THE NEW FANTASY ACTION RPG. Rise, Tarnished, and be guided by grace.',
    });
    expect(text).toContain('Rise, Tarnished');
    expect(text).toContain('An action RPG set in the Lands Between');
  });

  it('embedding text without description is shorter and less informative', () => {
    const withDesc = buildEmbeddingText({
      title: 'Elden Ring',
      genres: ['Action', 'RPG'],
      developer: 'FromSoftware',
      summary: 'Short summary.',
      description: 'A very long and detailed description of the game.',
    });
    const withoutDesc = buildEmbeddingText({
      title: 'Elden Ring',
      genres: ['Action', 'RPG'],
      developer: 'FromSoftware',
      summary: 'Short summary.',
    });
    expect(withDesc.length).toBeGreaterThan(withoutDesc.length);
    expect(withDesc).toContain('A very long and detailed description');
    expect(withoutDesc).not.toContain('A very long and detailed description');
  });

  it('truncates description to 3000 chars max', () => {
    const longDesc = 'A'.repeat(5000);
    const text = buildEmbeddingText({
      title: 'Test Game',
      description: longDesc,
    });
    expect(text).not.toContain('A'.repeat(5000));
    expect(text).toContain('A'.repeat(3000));
  });
});

describe('Epic catalog embedding text', () => {
  function buildEpicCatalogEmbeddingText(entry: {
    name: string; genres: string[]; themes: string[];
    developer: string; description: string; longDescription: string;
  }): string {
    const parts = [entry.name];
    const gpGenres = gameplayGenres(entry.genres);
    if (gpGenres.length) parts.push(`gameplay: ${gpGenres.join(', ')}`);
    const franchise = extractFranchiseBase(entry.name);
    if (franchise && franchise !== entry.name.toLowerCase().trim()) {
      parts.push(`series: ${franchise}`);
    }
    if (entry.themes.length) parts.push(`setting: ${entry.themes.join(', ')}`);
    if (entry.developer) parts.push(`by ${entry.developer}`);
    if (entry.description) parts.push(entry.description.slice(0, 1000));
    if (entry.longDescription) parts.push(entry.longDescription.slice(0, 3000));
    if (gpGenres.length) parts.push(`${entry.name}, ${gpGenres[0]}`);
    return parts.join('. ');
  }

  it('includes both short and long descriptions', () => {
    const text = buildEpicCatalogEmbeddingText({
      name: 'Fortnite',
      genres: ['Action', 'Shooter'],
      themes: ['Sci-Fi'],
      developer: 'Epic Games',
      description: 'A free-to-play Battle Royale game.',
      longDescription: 'Drop in, gear up, and compete in an ever-evolving Battle Royale experience.',
    });
    expect(text).toContain('A free-to-play Battle Royale game');
    expect(text).toContain('Drop in, gear up');
    expect(text).toContain('gameplay: Action, Shooter');
    expect(text).toContain('setting: Sci-Fi');
  });

  it('produces richer text than Steam catalog entries (which lack longDescription)', () => {
    const epicText = buildEpicCatalogEmbeddingText({
      name: 'Hades',
      genres: ['Action', 'RPG'],
      themes: [],
      developer: 'Supergiant Games',
      description: 'A rogue-like dungeon crawler.',
      longDescription: 'Battle your way out of the Underworld as the immortal Prince of the Underworld.',
    });
    // Steam catalog entries only have shortDescription (no longDescription)
    const steamLikeText = buildEpicCatalogEmbeddingText({
      name: 'Hades',
      genres: ['Action', 'RPG'],
      themes: [],
      developer: 'Supergiant Games',
      description: 'A rogue-like dungeon crawler.',
      longDescription: '',
    });
    expect(epicText.length).toBeGreaterThan(steamLikeText.length);
  });
});

describe('Neighbor Quality — Franchise Matching', () => {
  function areSameFranchise(a: string, b: string): boolean {
    const baseA = extractFranchiseBase(a);
    const baseB = extractFranchiseBase(b);
    return baseA.length >= 3 && baseA === baseB;
  }

  describe('same-franchise games should match (titles with strippable patterns)', () => {
    const franchisePairs: [string, string][] = [
      ['Call of Duty: Modern Warfare', 'Call of Duty: Black Ops'],
      ['Dark Souls III', 'Dark Souls: Remastered'],
      ['The Witcher 3: Wild Hunt', 'The Witcher 2: Assassins of Kings'],
      ['Battlefield V', 'Battlefield 2042'],
      ['Far Cry 6', 'Far Cry 5'],
      ['Portal 2', 'Portal'],
      ['Mass Effect 3', 'Mass Effect: Legendary Edition'],
      ['Red Dead Redemption 2', 'Red Dead Redemption'],
      ['Final Fantasy XIV', 'Final Fantasy VII Remake'],
      ['Batman: Arkham Knight', 'Batman: Arkham City'],
      ['Borderlands 3 Gold Edition', 'Borderlands 2'],
      ['Resident Evil 2 Remake', 'Resident Evil 4'],
      ['The Elder Scrolls V: Skyrim', 'The Elder Scrolls IV: Oblivion'],
    ];

    for (const [a, b] of franchisePairs) {
      it(`"${a}" ↔ "${b}"`, () => {
        expect(areSameFranchise(a, b)).toBe(true);
      });
    }
  });

  describe('different-franchise games should NOT match', () => {
    const nonFranchisePairs: [string, string][] = [
      ['Call of Duty: Modern Warfare', 'Call of Cthulhu'],
      ['Dark Souls III', 'Darkest Dungeon'],
      ['Dead Space', 'Dead by Daylight'],
      ['Hades', 'Halo Infinite'],
      ['The Witcher 3: Wild Hunt', 'The Elder Scrolls V: Skyrim'],
      ['Final Fantasy XIV', 'Final Exam'],
      ['Grand Theft Auto V', 'Granblue Fantasy Versus'],
      ['God of War Ragnarök', 'Godzilla'],
      ['Red Dead Redemption 2', 'Red Alert 3'],
      ['Assassin\'s Creed Valhalla', 'Assassin (2015)'],
      ['Battlefield V', 'Battle Brothers'],
      ['Far Cry 6', 'Farthest Frontier'],
    ];

    for (const [a, b] of nonFranchisePairs) {
      it(`"${a}" should NOT match "${b}"`, () => {
        expect(areSameFranchise(a, b)).toBe(false);
      });
    }
  });
});
