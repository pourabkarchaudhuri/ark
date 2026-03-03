/**
 * Mock Galaxy Data — generates a synthetic galaxy for Embedding Space UI testing.
 *
 * Produces ~600 realistic game nodes clustered by genre, with proper spatial
 * distribution, color indices, and metadata. No external dependencies needed.
 */

import type { GraphNode } from './galaxy-cache';
import { CANONICAL_GENRE_LABELS } from './galaxy-cache';

// ─── Cluster definitions — centroid positions in 3D space ────────────────────

const CLUSTER_CENTROIDS: [number, number, number][] = [
  /* 0: Action      */ [-250, 50, -100],
  /* 1: Adventure   */ [-100, 180, 80],
  /* 2: RPG         */ [100, 200, -50],
  /* 3: Strategy    */ [250, 100, 100],
  /* 4: Simulation  */ [200, -120, 150],
  /* 5: Indie       */ [0, 0, 0],
  /* 6: Casual      */ [-180, -200, 80],
  /* 7: Sports      */ [300, -50, -150],
  /* 8: Puzzle      */ [-50, -250, -80],
  /* 9: Horror      */ [-300, -80, -200],
  /* 10: MMO        */ [150, -200, -100],
  /* 11: Survival   */ [50, -100, 200],
];

const CLUSTER_SPREAD = 80;

// ─── Game data by genre ─────────────────────────────────────────────────────

interface MockGameDef {
  title: string;
  developer: string;
  publisher: string;
  themes?: string[];
  reviewCount: number;
  luminance: number;
  releaseYear: number;
  isLibrary?: boolean;
  hoursPlayed?: number;
}

const GAMES_BY_GENRE: Record<number, MockGameDef[]> = {
  0: [ // Action
    { title: 'Cyber Strike', developer: 'Neon Forge', publisher: 'Titan Games', themes: ['Cyberpunk', 'Sci-fi'], reviewCount: 85000, luminance: 0.82, releaseYear: 2024 },
    { title: 'Iron Vanguard', developer: 'StormBreak Studios', publisher: 'Titan Games', themes: ['Military', 'War'], reviewCount: 42000, luminance: 0.75, releaseYear: 2023 },
    { title: 'Blazing Edge', developer: 'Katana Works', publisher: 'Eastern Wind', themes: ['Anime', 'Fantasy'], reviewCount: 31000, luminance: 0.7, releaseYear: 2024 },
    { title: 'Shadow Operative', developer: 'Black Veil', publisher: 'Stealth Corp', themes: ['Stealth', 'Espionage'], reviewCount: 27500, luminance: 0.68, releaseYear: 2022, isLibrary: true, hoursPlayed: 45 },
    { title: 'Pulse Runner', developer: 'Neon Forge', publisher: 'Titan Games', themes: ['Sci-fi', 'Parkour'], reviewCount: 19000, luminance: 0.65, releaseYear: 2024 },
    { title: 'Wrath Protocol', developer: 'Iron Anvil', publisher: 'Core Publishing', themes: ['Post-apocalyptic'], reviewCount: 55000, luminance: 0.78, releaseYear: 2023, isLibrary: true, hoursPlayed: 120 },
    { title: 'Bullet Heaven', developer: 'ArcadeVolt', publisher: 'Retro Wave', themes: ['Arcade'], reviewCount: 12000, luminance: 0.58, releaseYear: 2023 },
    { title: 'Nova Recoil', developer: 'Plasma Dev', publisher: 'Core Publishing', themes: ['Space', 'Sci-fi'], reviewCount: 8500, luminance: 0.52, releaseYear: 2024 },
    { title: 'Demon Edge', developer: 'Abyssal Studios', publisher: 'Dark Moon', themes: ['Dark Fantasy', 'Souls-like'], reviewCount: 95000, luminance: 0.88, releaseYear: 2024 },
    { title: 'Fury of the Ancients', developer: 'Mythic Forge', publisher: 'Titan Games', themes: ['Mythology', 'Fantasy'], reviewCount: 38000, luminance: 0.72, releaseYear: 2022 },
    { title: 'Neon Havoc', developer: 'Neon Forge', publisher: 'Retro Wave', themes: ['Cyberpunk', 'Neon'], reviewCount: 6200, luminance: 0.48, releaseYear: 2025 },
    { title: 'Arena of Valor', developer: 'StormBreak Studios', publisher: 'Titan Games', themes: ['Arena', 'PvP'], reviewCount: 72000, luminance: 0.8, releaseYear: 2021 },
    { title: 'Crimson Horizon', developer: 'Red Sands', publisher: 'Core Publishing', themes: ['Western', 'Frontier'], reviewCount: 15000, luminance: 0.6, releaseYear: 2023 },
    { title: 'Titanfall Echo', developer: 'Mech Division', publisher: 'Titan Games', themes: ['Mech', 'Sci-fi'], reviewCount: 44000, luminance: 0.76, releaseYear: 2024 },
    { title: 'Rift Breakers', developer: 'Quantum Leap', publisher: 'Eastern Wind', themes: ['Dimensional', 'Sci-fi'], reviewCount: 22000, luminance: 0.64, releaseYear: 2023 },
    { title: 'Dead Lock', developer: 'Iron Anvil', publisher: 'Dark Moon', themes: ['Tactical'], reviewCount: 33000, luminance: 0.71, releaseYear: 2024 },
    { title: 'Overcharge', developer: 'ArcadeVolt', publisher: 'Retro Wave', themes: ['Arcade', 'Sci-fi'], reviewCount: 9800, luminance: 0.54, releaseYear: 2023 },
    { title: 'Ghost Protocol', developer: 'Black Veil', publisher: 'Stealth Corp', themes: ['Stealth'], reviewCount: 18000, luminance: 0.62, releaseYear: 2025 },
  ],
  1: [ // Adventure
    { title: 'Winds of Atheria', developer: 'SkyForge', publisher: 'Dream Publishing', themes: ['Open World', 'Fantasy'], reviewCount: 120000, luminance: 0.92, releaseYear: 2024, isLibrary: true, hoursPlayed: 200 },
    { title: 'The Last Cartographer', developer: 'Wanderlust Games', publisher: 'Dream Publishing', themes: ['Exploration', 'Mystery'], reviewCount: 45000, luminance: 0.76, releaseYear: 2023 },
    { title: 'Echoes of the Forgotten', developer: 'Memoir Studios', publisher: 'Artisan Games', themes: ['Narrative', 'Mystery'], reviewCount: 28000, luminance: 0.69, releaseYear: 2024 },
    { title: 'Starbound Voyager', developer: 'Cosmic Trail', publisher: 'Galaxy Press', themes: ['Space', 'Exploration'], reviewCount: 56000, luminance: 0.79, releaseYear: 2023 },
    { title: 'Fable of Tides', developer: 'Oceanic Dev', publisher: 'Dream Publishing', themes: ['Maritime', 'Fantasy'], reviewCount: 19500, luminance: 0.63, releaseYear: 2024 },
    { title: 'Verdant Wilds', developer: 'Green Canopy', publisher: 'Nature Games', themes: ['Nature', 'Open World'], reviewCount: 35000, luminance: 0.73, releaseYear: 2022 },
    { title: 'Cipher Quest', developer: 'Puzzle Box', publisher: 'Artisan Games', themes: ['Mystery', 'Detective'], reviewCount: 14000, luminance: 0.59, releaseYear: 2023, isLibrary: true, hoursPlayed: 15 },
    { title: 'Moonlit Path', developer: 'Lantern Games', publisher: 'Dream Publishing', themes: ['Atmospheric', 'Story-rich'], reviewCount: 22000, luminance: 0.66, releaseYear: 2024 },
    { title: 'Pilgrim\'s Journey', developer: 'Wanderlust Games', publisher: 'Artisan Games', themes: ['Spiritual', 'Peaceful'], reviewCount: 8000, luminance: 0.5, releaseYear: 2022 },
    { title: 'Realm of Wonders', developer: 'SkyForge', publisher: 'Dream Publishing', themes: ['Fantasy', 'Magic'], reviewCount: 88000, luminance: 0.85, releaseYear: 2023 },
    { title: 'The Clockwork City', developer: 'Gear Works', publisher: 'Artisan Games', themes: ['Steampunk', 'Puzzle'], reviewCount: 17000, luminance: 0.61, releaseYear: 2024 },
    { title: 'Nomad\'s Rest', developer: 'Desert Rose', publisher: 'Dream Publishing', themes: ['Desert', 'Survival'], reviewCount: 11000, luminance: 0.56, releaseYear: 2023 },
  ],
  2: [ // RPG
    { title: 'Chronicles of Elysium', developer: 'Obsidian Moon', publisher: 'Grand RPG Co', themes: ['Fantasy', 'Epic'], reviewCount: 150000, luminance: 0.95, releaseYear: 2024, isLibrary: true, hoursPlayed: 350 },
    { title: 'Neon Dynasty', developer: 'Neon Forge', publisher: 'Grand RPG Co', themes: ['Cyberpunk', 'Sci-fi'], reviewCount: 78000, luminance: 0.84, releaseYear: 2023, isLibrary: true, hoursPlayed: 180 },
    { title: 'Ashes of Eternity', developer: 'Phoenix Rise', publisher: 'Dark Moon', themes: ['Dark Fantasy'], reviewCount: 62000, luminance: 0.8, releaseYear: 2024 },
    { title: 'Starweaver', developer: 'Cosmic Trail', publisher: 'Galaxy Press', themes: ['Space', 'Sci-fi RPG'], reviewCount: 41000, luminance: 0.74, releaseYear: 2023 },
    { title: 'The Iron Oath', developer: 'Iron Anvil', publisher: 'Grand RPG Co', themes: ['Medieval', 'Mercenary'], reviewCount: 24000, luminance: 0.66, releaseYear: 2022 },
    { title: 'Sakura Chronicles', developer: 'Eastern Wind Dev', publisher: 'Eastern Wind', themes: ['JRPG', 'Anime'], reviewCount: 55000, luminance: 0.78, releaseYear: 2024 },
    { title: 'Dread Hollow', developer: 'Abyssal Studios', publisher: 'Dark Moon', themes: ['Gothic', 'Horror RPG'], reviewCount: 32000, luminance: 0.71, releaseYear: 2023 },
    { title: 'Legends of Arcana', developer: 'Mythic Forge', publisher: 'Grand RPG Co', themes: ['High Fantasy', 'Magic'], reviewCount: 95000, luminance: 0.88, releaseYear: 2024 },
    { title: 'Vagrant Hearts', developer: 'Wanderlust Games', publisher: 'Artisan Games', themes: ['Emotional', 'Story-rich'], reviewCount: 18000, luminance: 0.62, releaseYear: 2022 },
    { title: 'The Sunken Crown', developer: 'Oceanic Dev', publisher: 'Grand RPG Co', themes: ['Maritime', 'Dark Fantasy'], reviewCount: 29000, luminance: 0.69, releaseYear: 2024 },
    { title: 'Quantum Requiem', developer: 'Quantum Leap', publisher: 'Galaxy Press', themes: ['Sci-fi', 'Time Travel'], reviewCount: 47000, luminance: 0.76, releaseYear: 2023 },
    { title: 'Ember Knights', developer: 'Phoenix Rise', publisher: 'Core Publishing', themes: ['Fantasy', 'Co-op'], reviewCount: 36000, luminance: 0.72, releaseYear: 2024 },
  ],
  3: [ // Strategy
    { title: 'Galactic Dominion', developer: 'StarCommand', publisher: 'Grand Strategy Co', themes: ['4X', 'Space'], reviewCount: 65000, luminance: 0.81, releaseYear: 2024, isLibrary: true, hoursPlayed: 280 },
    { title: 'Fortress of Empires', developer: 'Imperial Dev', publisher: 'Grand Strategy Co', themes: ['Medieval', 'Empire'], reviewCount: 48000, luminance: 0.76, releaseYear: 2023 },
    { title: 'Hex Wars', developer: 'Tactical Mind', publisher: 'Core Publishing', themes: ['Turn-based', 'War'], reviewCount: 22000, luminance: 0.65, releaseYear: 2022 },
    { title: 'Colony Alpha', developer: 'StarCommand', publisher: 'Galaxy Press', themes: ['Sci-fi', 'Base Building'], reviewCount: 38000, luminance: 0.73, releaseYear: 2024 },
    { title: 'Warlords of Avalon', developer: 'Mythic Forge', publisher: 'Grand Strategy Co', themes: ['Fantasy', 'Tactics'], reviewCount: 31000, luminance: 0.7, releaseYear: 2023 },
    { title: 'The Grand Campaign', developer: 'Imperial Dev', publisher: 'Grand Strategy Co', themes: ['Historical', 'Grand Strategy'], reviewCount: 82000, luminance: 0.84, releaseYear: 2024 },
    { title: 'Siege Masters', developer: 'Iron Anvil', publisher: 'Core Publishing', themes: ['Castle', 'Tactics'], reviewCount: 15000, luminance: 0.59, releaseYear: 2023 },
    { title: 'Zero Hour', developer: 'Tactical Mind', publisher: 'Grand Strategy Co', themes: ['Modern', 'RTS'], reviewCount: 27000, luminance: 0.68, releaseYear: 2024 },
    { title: 'Automata Empire', developer: 'Gear Works', publisher: 'Core Publishing', themes: ['Automation', 'Factory'], reviewCount: 44000, luminance: 0.75, releaseYear: 2023 },
    { title: 'Dynasty Builders', developer: 'Imperial Dev', publisher: 'Grand Strategy Co', themes: ['City Builder', 'Dynasty'], reviewCount: 52000, luminance: 0.77, releaseYear: 2024 },
  ],
  4: [ // Simulation
    { title: 'Farm & Fortune', developer: 'Green Canopy', publisher: 'Cozy Games Inc', themes: ['Farming', 'Relaxing'], reviewCount: 95000, luminance: 0.87, releaseYear: 2023, isLibrary: true, hoursPlayed: 150 },
    { title: 'SkyPort Tycoon', developer: 'Tycoon Studios', publisher: 'Sim Corp', themes: ['Airport', 'Management'], reviewCount: 32000, luminance: 0.71, releaseYear: 2024 },
    { title: 'Planet Architect', developer: 'Cosmic Trail', publisher: 'Galaxy Press', themes: ['Space', 'Terraforming'], reviewCount: 28000, luminance: 0.68, releaseYear: 2023 },
    { title: 'Train Valley Express', developer: 'Rail Works', publisher: 'Sim Corp', themes: ['Trains', 'Logistics'], reviewCount: 18000, luminance: 0.62, releaseYear: 2022 },
    { title: 'Zoo Paradise', developer: 'Green Canopy', publisher: 'Cozy Games Inc', themes: ['Animals', 'Management'], reviewCount: 42000, luminance: 0.74, releaseYear: 2024 },
    { title: 'Chef\'s Delight', developer: 'Kitchen Studios', publisher: 'Cozy Games Inc', themes: ['Cooking', 'Restaurant'], reviewCount: 24000, luminance: 0.66, releaseYear: 2023 },
    { title: 'Flight Command', developer: 'Mech Division', publisher: 'Sim Corp', themes: ['Aviation', 'Realistic'], reviewCount: 56000, luminance: 0.79, releaseYear: 2024 },
    { title: 'Tiny Town', developer: 'Green Canopy', publisher: 'Cozy Games Inc', themes: ['City Builder', 'Cute'], reviewCount: 35000, luminance: 0.72, releaseYear: 2023 },
  ],
  5: [ // Indie
    { title: 'Luminara', developer: 'Solo Vision', publisher: 'Indie Collective', themes: ['Atmospheric', 'Art'], reviewCount: 15000, luminance: 0.6, releaseYear: 2024 },
    { title: 'Pixel Odyssey', developer: 'RetroSpark', publisher: 'Indie Collective', themes: ['Retro', 'Pixel Art'], reviewCount: 28000, luminance: 0.69, releaseYear: 2023, isLibrary: true, hoursPlayed: 35 },
    { title: 'Hollow Gardens', developer: 'Silent Bloom', publisher: 'Artisan Games', themes: ['Peaceful', 'Nature'], reviewCount: 8200, luminance: 0.5, releaseYear: 2024 },
    { title: 'Ink & Bone', developer: 'Solo Vision', publisher: 'Indie Collective', themes: ['Hand-drawn', 'Dark'], reviewCount: 12000, luminance: 0.57, releaseYear: 2023 },
    { title: 'Stellar Drift', developer: 'Micro Cosmos', publisher: 'Indie Collective', themes: ['Space', 'Minimalist'], reviewCount: 6500, luminance: 0.46, releaseYear: 2022 },
    { title: 'Paper Trail', developer: 'Origami Dev', publisher: 'Artisan Games', themes: ['Origami', 'Puzzle'], reviewCount: 19000, luminance: 0.63, releaseYear: 2024 },
    { title: 'Void Echoes', developer: 'Abyssal Studios', publisher: 'Indie Collective', themes: ['Existential', 'Narrative'], reviewCount: 11000, luminance: 0.55, releaseYear: 2023 },
    { title: 'Glitch Garden', developer: 'RetroSpark', publisher: 'Indie Collective', themes: ['Glitch', 'Experimental'], reviewCount: 4800, luminance: 0.42, releaseYear: 2024 },
    { title: 'Candle Flame', developer: 'Lantern Games', publisher: 'Artisan Games', themes: ['Cozy', 'Emotional'], reviewCount: 22000, luminance: 0.66, releaseYear: 2023 },
    { title: 'Resonance', developer: 'Solo Vision', publisher: 'Indie Collective', themes: ['Music', 'Rhythm'], reviewCount: 16000, luminance: 0.61, releaseYear: 2024 },
  ],
  6: [ // Casual
    { title: 'Bubble Pop Galaxy', developer: 'Fun Factory', publisher: 'Casual Corp', themes: ['Match-3', 'Colorful'], reviewCount: 45000, luminance: 0.75, releaseYear: 2023 },
    { title: 'Cozy Kitchen', developer: 'Kitchen Studios', publisher: 'Cozy Games Inc', themes: ['Cooking', 'Cute'], reviewCount: 62000, luminance: 0.8, releaseYear: 2024 },
    { title: 'Garden Escape', developer: 'Green Canopy', publisher: 'Casual Corp', themes: ['Gardening', 'Relaxing'], reviewCount: 34000, luminance: 0.72, releaseYear: 2023 },
    { title: 'Word Wizard', developer: 'Puzzle Box', publisher: 'Casual Corp', themes: ['Word Game'], reviewCount: 18000, luminance: 0.62, releaseYear: 2022 },
    { title: 'Cat Café Manager', developer: 'Cozy Studios', publisher: 'Cozy Games Inc', themes: ['Cats', 'Management'], reviewCount: 28000, luminance: 0.68, releaseYear: 2024 },
    { title: 'Sushi Roll!', developer: 'Fun Factory', publisher: 'Casual Corp', themes: ['Food', 'Arcade'], reviewCount: 15000, luminance: 0.59, releaseYear: 2023 },
  ],
  7: [ // Sports / Racing
    { title: 'Velocity GT', developer: 'Apex Racing', publisher: 'Speed Demon', themes: ['Racing', 'Cars'], reviewCount: 78000, luminance: 0.84, releaseYear: 2024 },
    { title: 'Street League', developer: 'Urban Games', publisher: 'Sport Star', themes: ['Basketball', 'Street'], reviewCount: 42000, luminance: 0.74, releaseYear: 2023 },
    { title: 'Drift Kings', developer: 'Apex Racing', publisher: 'Speed Demon', themes: ['Drifting', 'Tuning'], reviewCount: 35000, luminance: 0.72, releaseYear: 2024, isLibrary: true, hoursPlayed: 60 },
    { title: 'Mountain Bike Extreme', developer: 'Trail Blazers', publisher: 'Sport Star', themes: ['Cycling', 'Extreme'], reviewCount: 12000, luminance: 0.56, releaseYear: 2023 },
    { title: 'Golf Paradise', developer: 'Fairway Dev', publisher: 'Sport Star', themes: ['Golf', 'Relaxing'], reviewCount: 25000, luminance: 0.66, releaseYear: 2022 },
    { title: 'Turbo Circuit', developer: 'Apex Racing', publisher: 'Speed Demon', themes: ['Formula', 'Racing'], reviewCount: 55000, luminance: 0.78, releaseYear: 2024 },
  ],
  8: [ // Puzzle
    { title: 'Mind Lattice', developer: 'Puzzle Box', publisher: 'Brainy Games', themes: ['Logic', 'Minimalist'], reviewCount: 32000, luminance: 0.71, releaseYear: 2024 },
    { title: 'Gravity Well', developer: 'Quantum Leap', publisher: 'Brainy Games', themes: ['Physics', 'Space'], reviewCount: 22000, luminance: 0.65, releaseYear: 2023 },
    { title: 'Color Theory', developer: 'Solo Vision', publisher: 'Indie Collective', themes: ['Color', 'Art'], reviewCount: 14000, luminance: 0.59, releaseYear: 2024, isLibrary: true, hoursPlayed: 25 },
    { title: 'The Witness II', developer: 'Puzzle Genius', publisher: 'Brainy Games', themes: ['Open World', 'Logic'], reviewCount: 88000, luminance: 0.86, releaseYear: 2024 },
    { title: 'Fold & Cut', developer: 'Origami Dev', publisher: 'Brainy Games', themes: ['Paper', 'Spatial'], reviewCount: 9500, luminance: 0.52, releaseYear: 2023 },
    { title: 'Circuit Breaker', developer: 'Gear Works', publisher: 'Brainy Games', themes: ['Electronics', 'Logic'], reviewCount: 18000, luminance: 0.62, releaseYear: 2022 },
  ],
  9: [ // Horror
    { title: 'Abyssal Descent', developer: 'Abyssal Studios', publisher: 'Dark Moon', themes: ['Cosmic Horror', 'Lovecraft'], reviewCount: 48000, luminance: 0.76, releaseYear: 2024 },
    { title: 'Whisper House', developer: 'Silent Bloom', publisher: 'Dark Moon', themes: ['Psychological', 'Ghost'], reviewCount: 35000, luminance: 0.72, releaseYear: 2023, isLibrary: true, hoursPlayed: 18 },
    { title: 'Crimson Ward', developer: 'Red Sands', publisher: 'Dark Moon', themes: ['Survival Horror', 'Hospital'], reviewCount: 27000, luminance: 0.68, releaseYear: 2024 },
    { title: 'The Hollow Man', developer: 'Black Veil', publisher: 'Dark Moon', themes: ['Psychological', 'Thriller'], reviewCount: 52000, luminance: 0.78, releaseYear: 2023 },
    { title: 'Dead Signal', developer: 'Plasma Dev', publisher: 'Dark Moon', themes: ['Sci-fi Horror', 'Space'], reviewCount: 19000, luminance: 0.63, releaseYear: 2024 },
    { title: 'Nocturne', developer: 'Silent Bloom', publisher: 'Dark Moon', themes: ['Gothic', 'Vampire'], reviewCount: 41000, luminance: 0.74, releaseYear: 2022 },
    { title: 'Flesh & Wire', developer: 'Abyssal Studios', publisher: 'Dark Moon', themes: ['Body Horror', 'Cyberpunk'], reviewCount: 15000, luminance: 0.6, releaseYear: 2024 },
  ],
  10: [ // MMO
    { title: 'Realms Eternal', developer: 'Massive World', publisher: 'MMO Corp', themes: ['Fantasy', 'PvP'], reviewCount: 180000, luminance: 0.94, releaseYear: 2022 },
    { title: 'Star Nexus Online', developer: 'StarCommand', publisher: 'MMO Corp', themes: ['Space', 'Sandbox'], reviewCount: 95000, luminance: 0.87, releaseYear: 2023 },
    { title: 'Guild of Ages', developer: 'Massive World', publisher: 'MMO Corp', themes: ['Medieval', 'Crafting'], reviewCount: 62000, luminance: 0.8, releaseYear: 2024, isLibrary: true, hoursPlayed: 500 },
    { title: 'Aether Online', developer: 'Cloud Nine', publisher: 'MMO Corp', themes: ['Fantasy', 'Anime'], reviewCount: 44000, luminance: 0.75, releaseYear: 2023 },
    { title: 'Warhaven', developer: 'Iron Anvil', publisher: 'MMO Corp', themes: ['War', 'PvP'], reviewCount: 28000, luminance: 0.68, releaseYear: 2024 },
  ],
  11: [ // Survival
    { title: 'Frostpeak', developer: 'Wild Studios', publisher: 'Survival Co', themes: ['Winter', 'Harsh'], reviewCount: 72000, luminance: 0.82, releaseYear: 2024, isLibrary: true, hoursPlayed: 90 },
    { title: 'Stranded Deep 2', developer: 'Ocean Floor', publisher: 'Survival Co', themes: ['Island', 'Ocean'], reviewCount: 48000, luminance: 0.76, releaseYear: 2023 },
    { title: 'Wasteland Nomad', developer: 'Red Sands', publisher: 'Survival Co', themes: ['Post-apocalyptic', 'Crafting'], reviewCount: 35000, luminance: 0.72, releaseYear: 2024 },
    { title: 'Green Hell 2', developer: 'Wild Studios', publisher: 'Survival Co', themes: ['Jungle', 'Realistic'], reviewCount: 55000, luminance: 0.78, releaseYear: 2023 },
    { title: 'Alien Biome', developer: 'Cosmic Trail', publisher: 'Galaxy Press', themes: ['Alien Planet', 'Sci-fi'], reviewCount: 22000, luminance: 0.65, releaseYear: 2024 },
    { title: 'Raft World', developer: 'Ocean Floor', publisher: 'Survival Co', themes: ['Ocean', 'Building'], reviewCount: 85000, luminance: 0.85, releaseYear: 2022 },
    { title: 'Solstice', developer: 'Wild Studios', publisher: 'Survival Co', themes: ['Seasonal', 'Crafting'], reviewCount: 16000, luminance: 0.6, releaseYear: 2024 },
  ],
};

// ─── Seeded PRNG for deterministic positioning ──────────────────────────────

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function gaussianPair(rng: () => number): [number, number] {
  let u: number, v: number, s: number;
  do { u = rng() * 2 - 1; v = rng() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
  const mul = Math.sqrt(-2 * Math.log(s) / s);
  return [u * mul, v * mul];
}

// ─── Generator ──────────────────────────────────────────────────────────────

export function generateMockGalaxy(): { nodes: GraphNode[]; allGenres: string[] } {
  const rng = mulberry32(42);
  const nodes: GraphNode[] = [];
  let idCounter = 0;

  for (const [genreIdxStr, games] of Object.entries(GAMES_BY_GENRE)) {
    const genreIdx = Number(genreIdxStr);
    const [cx, cy, cz] = CLUSTER_CENTROIDS[genreIdx] ?? [0, 0, 0];
    const genreLabel = CANONICAL_GENRE_LABELS[genreIdx] ?? 'Unknown';

    for (const game of games) {
      const [gx, gy] = gaussianPair(rng);
      const [gz] = gaussianPair(rng);

      nodes.push({
        id: `mock-${idCounter++}`,
        title: game.title,
        genres: [genreLabel],
        themes: game.themes ?? [],
        developer: game.developer,
        publisher: game.publisher,
        coverUrl: undefined,
        isLibrary: game.isLibrary ?? false,
        hoursPlayed: game.hoursPlayed ?? 0,
        reviewCount: game.reviewCount,
        luminance: game.luminance,
        releaseYear: game.releaseYear,
        x: cx + gx * CLUSTER_SPREAD,
        y: cy + gy * CLUSTER_SPREAD,
        z: cz + gz * CLUSTER_SPREAD,
        colorIdx: genreIdx,
      });
    }

    // Filler nodes to pad each cluster (5-15 extra unnamed nodes per cluster)
    const fillerCount = Math.floor(rng() * 10) + 5;
    for (let f = 0; f < fillerCount; f++) {
      const [gx, gy] = gaussianPair(rng);
      const [gz] = gaussianPair(rng);

      nodes.push({
        id: `mock-${idCounter++}`,
        title: `${genreLabel} Game ${f + 1}`,
        genres: [genreLabel],
        themes: [],
        developer: 'Unknown Studio',
        publisher: 'Unknown Publisher',
        coverUrl: undefined,
        isLibrary: false,
        hoursPlayed: 0,
        reviewCount: Math.floor(rng() * 5000) + 100,
        luminance: rng() * 0.4 + 0.2,
        releaseYear: 2020 + Math.floor(rng() * 5),
        x: cx + gx * CLUSTER_SPREAD * 1.2,
        y: cy + gy * CLUSTER_SPREAD * 1.2,
        z: cz + gz * CLUSTER_SPREAD * 1.2,
        colorIdx: genreIdx,
      });
    }
  }

  // Scatter some cross-genre "bridge" nodes between clusters
  for (let b = 0; b < 30; b++) {
    const g1 = Math.floor(rng() * 12);
    const g2 = (g1 + 1 + Math.floor(rng() * 11)) % 12;
    const [cx1, cy1, cz1] = CLUSTER_CENTROIDS[g1];
    const [cx2, cy2, cz2] = CLUSTER_CENTROIDS[g2];
    const t = rng() * 0.6 + 0.2;
    const [jx, jy] = gaussianPair(rng);
    const [jz] = gaussianPair(rng);

    nodes.push({
      id: `mock-${idCounter++}`,
      title: `${CANONICAL_GENRE_LABELS[g1]}/${CANONICAL_GENRE_LABELS[g2]} Hybrid ${b + 1}`,
      genres: [CANONICAL_GENRE_LABELS[g1], CANONICAL_GENRE_LABELS[g2]],
      themes: [],
      developer: 'Crossover Dev',
      publisher: 'Hybrid Games',
      coverUrl: undefined,
      isLibrary: false,
      hoursPlayed: 0,
      reviewCount: Math.floor(rng() * 3000) + 500,
      luminance: rng() * 0.3 + 0.3,
      releaseYear: 2021 + Math.floor(rng() * 4),
      x: cx1 + (cx2 - cx1) * t + jx * 30,
      y: cy1 + (cy2 - cy1) * t + jy * 30,
      z: cz1 + (cz2 - cz1) * t + jz * 30,
      colorIdx: g1,
    });
  }

  return { nodes, allGenres: [...CANONICAL_GENRE_LABELS] };
}
