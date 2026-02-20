/**
 * Steam Tag Classification
 *
 * Maps well-known Steam tag IDs to categories (genre / theme / mode / other).
 * The full tag list (450+) is fetched at runtime from IStoreService/GetTagList;
 * this static map provides the classification layer so we know which tags are
 * genres vs themes vs game modes for the recommendation engine.
 *
 * Tags not listed here default to 'theme'.
 */

import type { TagCategory } from '@/types/catalog';

const GENRE_TAG_IDS = new Set([
  19,    // Action
  21,    // Adventure
  597,   // Casual
  492,   // Indie
  122,   // RPG
  9,     // Strategy
  599,   // Simulation
  701,   // Sports
  699,   // Racing
  1625,  // Platformer
  1628,  // Metroidvania
  1645,  // Tower Defense
  1646,  // Hack and Slash
  1662,  // Survival
  1663,  // FPS
  1667,  // Horror
  1684,  // Fantasy
  1693,  // Shooter
  1695,  // Open World
  1697,  // Third Person
  1698,  // Point & Click
  1702,  // Crafting
  1708,  // Tactical
  1716,  // Roguelike
  1720,  // Dungeon Crawler
  1741,  // Turn-Based Strategy
  1742,  // Story Rich
  1752,  // City Builder
  1755,  // Space
  1770,  // Board Game
  1773,  // Stealth
  1774,  // Shooter
  1777,  // Card Game
  3799,  // Visual Novel
  3834,  // Exploration
  3859,  // Multiplayer
  3871,  // Real-Time Strategy
  3942,  // Sci-fi
  3959,  // Rogue-lite
  4106,  // Action RPG
  4166,  // Atmospheric
  4191,  // 3D
  4325,  // Turn-Based
  4345,  // Arena Shooter
  4604,  // Dark Fantasy
  5577,  // 2D Platformer
  5611,  // Mature
  5716,  // Soulslike
  6426,  // Choices Matter
  7918,  // Dwarf
  29482, // Souls-like
  128,   // Massively Multiplayer
]);

const MODE_TAG_IDS = new Set([
  1685,   // Co-op
  3839,   // First-Person
  3843,   // Online Co-Op
  3841,   // Local Co-Op
  4182,   // Singleplayer
  1775,   // PvP
  5125,   // Procedural Generation
  4155,   // Class-Based
  4236,   // Loot
  6730,   // PvE
  5055,   // eSports
  17770,  // Asynchronous Multiplayer
  4508,   // Co-op Campaign
  3878,   // Competitive
  5711,   // Team-Based
]);

const THEME_TAG_IDS = new Set([
  1643,  // Building
  1644,  // Driving
  1647,  // Moddable
  1654,  // Relaxing
  1659,  // Zombies
  1664,  // Puzzle
  1669,  // Colorful
  1670,  // Pixel Graphics
  1671,  // Retro
  1678,  // War
  1687,  // Stealthy
  1710,  // World War II
  1719,  // Comedy
  1721,  // Psychological
  1723,  // Post-Apocalyptic
  1738,  // Cyberpunk
  1743,  // Emotional
  1756,  // Great Soundtrack
  4168,  // Medieval
  4172,  // Medieval
  4231,  // Action RPG
  4305,  // Colorful
  4342,  // Dark
  4667,  // Violent
  4747,  // Character Customization
  5350,  // Family Friendly
  5851,  // Anime
  5984,  // Dystopian
  6041,  // Horses
  6650,  // Nudity
  6691,  // Addictive
  6971,  // Multiple Endings
  7208,  // Female Protagonist
  7250,  // Linear
  7332,  // Base Building
  7481,  // Thriller
  8945,  // Resource Management
  14720, // Nostalgia
  42804, // Action Roguelike
  353880, // Looter Shooter
]);

/**
 * Classify a Steam tag ID into a category.
 * Unknown tags default to 'theme' since they're often descriptive adjectives.
 */
export function classifyTagId(tagId: number): TagCategory {
  if (GENRE_TAG_IDS.has(tagId)) return 'genre';
  if (MODE_TAG_IDS.has(tagId)) return 'mode';
  if (THEME_TAG_IDS.has(tagId)) return 'theme';
  return 'theme';
}

/**
 * Given a list of Steam tags (id + name), split them into genres, themes,
 * and modes using the static classification.
 */
export function classifyTags(
  tags: Array<{ tagid: number; name: string }>,
): { genres: string[]; themes: string[]; modes: string[] } {
  const genres: string[] = [];
  const themes: string[] = [];
  const modes: string[] = [];

  for (const tag of tags) {
    const cat = classifyTagId(tag.tagid);
    if (cat === 'genre') genres.push(tag.name);
    else if (cat === 'mode') modes.push(tag.name);
    else themes.push(tag.name);
  }

  return { genres, themes, modes };
}
