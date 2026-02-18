import type { JourneyEntry, StatusChangeEntry, GameSession, LibraryGameEntry } from '@/types/game';

// ─── Tier & Branch ────────────────────────────────────────────────────────────

export type BadgeTier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';
export type BadgeBranch =
  | 'voyager' | 'conqueror' | 'sentinel' | 'timekeeper'
  | 'scholar' | 'chronicler' | 'pioneer' | 'stargazer'
  | 'genre' | 'legendary' | 'secret';

export const TIER_POINTS: Record<BadgeTier, number> = {
  bronze: 10, silver: 25, gold: 50, platinum: 100, diamond: 250,
};

export const TIER_COLORS: Record<BadgeTier, { bg: string; text: string; border: string; glow: string }> = {
  bronze:   { bg: 'bg-amber-900/30',   text: 'text-amber-600',    border: 'border-amber-700/50',   glow: 'shadow-amber-700/20' },
  silver:   { bg: 'bg-slate-400/20',    text: 'text-slate-300',    border: 'border-slate-400/50',   glow: 'shadow-slate-400/20' },
  gold:     { bg: 'bg-yellow-500/20',   text: 'text-yellow-400',   border: 'border-yellow-500/50',  glow: 'shadow-yellow-500/30' },
  platinum: { bg: 'bg-violet-400/20',   text: 'text-violet-300',   border: 'border-violet-400/50',  glow: 'shadow-violet-400/30' },
  diamond:  { bg: 'bg-cyan-300/20',     text: 'text-cyan-300',     border: 'border-cyan-300/50',    glow: 'shadow-cyan-300/40' },
};

export const BRANCH_META: Record<BadgeBranch, { label: string; motto: string; icon: string }> = {
  voyager:    { label: 'The Voyager',    motto: 'The stars call to those who dare to seek.',                   icon: 'Compass' },
  conqueror:  { label: 'The Conqueror',  motto: 'Victory is forged in the crucible of persistence.',          icon: 'Trophy' },
  sentinel:   { label: 'The Sentinel',   motto: 'The vigilant never rest. The Ark demands constancy.',        icon: 'Shield' },
  timekeeper: { label: 'The Timekeeper', motto: 'Time is the currency of the cosmos.',                        icon: 'Clock' },
  scholar:    { label: 'The Scholar',    motto: 'To know all worlds is to understand the cosmos itself.',      icon: 'BookOpen' },
  chronicler: { label: 'The Chronicler', motto: 'To record is to remember. To judge is to refine.',           icon: 'Pen' },
  pioneer:    { label: 'The Pioneer',    motto: 'No frontier is beyond reach. No platform uncharted.',        icon: 'Rocket' },
  stargazer:  { label: 'The Stargazer',  motto: 'The stars whisper of what is to come.',                      icon: 'Star' },
  genre:      { label: 'Genre Mastery',  motto: 'Each world demands its own discipline.',                     icon: 'Layers' },
  legendary:  { label: 'Legendary',      motto: 'Forged in the convergence of discipline and destiny.',       icon: 'Crown' },
  secret:     { label: 'Secret',         motto: 'Some constellations reveal themselves only to wanderers.',    icon: 'Lock' },
};

// ─── Condition Descriptors ────────────────────────────────────────────────────
// Pure data — no functions. The evaluator resolves these.

export type BadgeCondition =
  | { type: 'gameCount'; min: number }
  | { type: 'completionCount'; min: number }
  | { type: 'totalHours'; min: number }
  | { type: 'sessionCount'; min: number }
  | { type: 'streakDays'; min: number }
  | { type: 'ratingCount'; min: number }
  | { type: 'reviewCount'; min: number }
  | { type: 'genreCount'; min: number }
  | { type: 'statusChangeCount'; min: number }
  | { type: 'storeGameCount'; store: string; min: number }
  | { type: 'platformGameCount'; platform: string; min: number }
  | { type: 'genreGameCount'; genre: string; min: number }
  | { type: 'genreHours'; genre: string; min: number }
  | { type: 'genreCompletions'; genre: string; min: number }
  | { type: 'singleGameHours'; min: number }
  | { type: 'singleSessionMinutes'; min: number }
  | { type: 'completionRate'; min: number }
  | { type: 'averageRating'; min?: number; max?: number }
  | { type: 'gamesInStatus'; status: string; min: number }
  | { type: 'releaseYearSpan'; min: number }
  | { type: 'metacriticAbove'; score: number; min: number }
  | { type: 'gamesPerYear'; year: 'current' | 'any'; min: number }
  | { type: 'hoursInMonth'; min: number }
  | { type: 'completionsInMonth'; min: number }
  | { type: 'gamesWithZeroHours'; min: number }
  | { type: 'multiGenreCompletion'; min: number }
  | { type: 'branchBadgeCount'; min: number }
  | { type: 'totalBadgeCount'; min: number }
  | { type: 'tierBadgeCount'; tier: BadgeTier; min: number }
  | { type: 'allBranchesUnlocked'; minPerBranch: number }
  | { type: 'tasteDnaAverage'; min: number }
  | { type: 'always' };

// ─── Medal Shape & Gradients ──────────────────────────────────────────────────

export type MedalShape = 'shield' | 'star' | 'cross' | 'circle' | 'hexagon' | 'wings' | 'ribbon' | 'chevron';

export const MEDAL_PATHS: Record<MedalShape, string> = {
  shield:  'M50 8 L88 28 L88 65 Q88 90 50 108 Q12 90 12 65 L12 28 Z',
  star:    'M50 5 L61 38 L95 38 L67 58 L78 92 L50 72 L22 92 L33 58 L5 38 L39 38 Z',
  cross:   'M35 8 L65 8 L65 35 L92 35 L92 65 L65 65 L65 92 L35 92 L35 65 L8 65 L8 35 L35 35 Z',
  circle:  'M50 6 A44 44 0 1 1 50 94 A44 44 0 1 1 50 6 Z',
  hexagon: 'M50 6 L90 28 L90 72 L50 94 L10 72 L10 28 Z',
  wings:   'M50 12 L70 25 L95 18 L82 45 L95 72 L70 65 L50 95 L30 65 L5 72 L18 45 L5 18 L30 25 Z',
  ribbon:  'M20 8 L80 8 L85 15 L80 22 L80 85 L65 75 L50 92 L35 75 L20 85 L20 22 L15 15 Z',
  chevron: 'M15 15 L50 5 L85 15 L85 70 L50 95 L15 70 Z',
};

export const TIER_GRADIENTS: Record<BadgeTier, [string, string, string]> = {
  bronze:   ['#92400e', '#b45309', '#78350f'],
  silver:   ['#94a3b8', '#cbd5e1', '#64748b'],
  gold:     ['#b8860b', '#fbbf24', '#92400e'],
  platinum: ['#7c3aed', '#a78bfa', '#5b21b6'],
  diamond:  ['#06b6d4', '#67e8f9', '#0891b2'],
};

export const TIER_NEON: Record<BadgeTier, { color: string; glow: string; bg: string }> = {
  bronze:   { color: '#ff8a00', glow: '0 0 12px #ff8a0066, 0 0 30px #ff8a0022', bg: 'rgba(255,138,0,0.06)' },
  silver:   { color: '#a0d2ff', glow: '0 0 12px #a0d2ff66, 0 0 30px #a0d2ff22', bg: 'rgba(160,210,255,0.06)' },
  gold:     { color: '#ffd000', glow: '0 0 12px #ffd00066, 0 0 30px #ffd00022', bg: 'rgba(255,208,0,0.06)' },
  platinum: { color: '#bf5af2', glow: '0 0 12px #bf5af266, 0 0 30px #bf5af222', bg: 'rgba(191,90,242,0.06)' },
  diamond:  { color: '#00ffd5', glow: '0 0 12px #00ffd566, 0 0 30px #00ffd522', bg: 'rgba(0,255,213,0.06)' },
};

// ─── Branch Motifs — simplified SVG paths for medal interiors ─────────────────
// Designed for viewBox="0 0 24 24", rendered centered inside medal shapes.

export const BRANCH_MOTIFS: Record<BadgeBranch, string> = {
  voyager:    'M12 2L4.5 20.3l.7.4L12 17.7l6.8 3 .7-.4L12 2zm0 3.5L16.5 18 12 15.8 7.5 18 12 5.5z', // compass rose
  conqueror:  'M12 2l3 6.3h6.6l-5.3 3.8 2 6.5L12 14.8l-6.3 3.8 2-6.5L2.4 8.3H9L12 2z', // star trophy
  sentinel:   'M12 2L3 7v6.5c0 5.3 3.8 10.2 9 11.5 5.2-1.3 9-6.2 9-11.5V7l-9-5zm0 2.2l7 3.9v5.4c0 4.3-3 8.3-7 9.4-4-1.1-7-5.1-7-9.4V8.1l7-3.9z', // shield
  timekeeper: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 2a8 8 0 110 16 8 8 0 010-16zm-.5 2v7l5 3 .8-1.2-4.3-2.5V6h-1.5z', // clock
  scholar:    'M12 3L1 9l4 2.2v6L12 21l7-3.8v-6L23 9 12 3zm0 2.3L19.3 9 12 12.7 4.7 9 12 5.3zM7 12.5v4L12 19l5-2.5v-4L12 15l-5-2.5z', // open book
  chronicler: 'M14.1 2L5 11.1v2.8L7.1 16l9.1-9.1L14.1 2zM4 18h16v2H4v-2z', // pen nib
  pioneer:    'M12 2.5l-2 5H5l4 3-1.5 5L12 13l4.5 2.5L15 10.5l4-3h-5l-2-5z', // rocket star
  stargazer:  'M12 2a1.5 1.5 0 00-1.5 1.5c0 2.5-1 5.5-3 7.5a1.5 1.5 0 000 2c2 2 3 5 3 7.5a1.5 1.5 0 003 0c0-2.5 1-5.5 3-7.5a1.5 1.5 0 000-2c-2-2-3-5-3-7.5A1.5 1.5 0 0012 2z', // 4-point star
  genre:      'M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z', // grid
  legendary:  'M12 2l-2.4 4.2H4.8l3.6 3.6-1.2 5.4L12 12.6l4.8 2.6-1.2-5.4 3.6-3.6h-4.8L12 2zm0 14.4l-4.8 2.6 1-4.5L4.5 11h4.7L12 6.8 14.8 11h4.7l-3.7 3.5 1 4.5L12 16.4z', // crown
  secret:     'M12 2a5 5 0 00-5 5v3H5v10h14V10h-2V7a5 5 0 00-5-5zm0 2a3 3 0 013 3v3H9V7a3 3 0 013-3zm0 10a1.5 1.5 0 110 3 1.5 1.5 0 010-3z', // lock
};

// ─── Badge Definition ─────────────────────────────────────────────────────────

export interface BadgeDefinition {
  id: number;
  name: string;
  description: string;
  lore: string;
  shape: MedalShape;
  branch: BadgeBranch;
  tier: BadgeTier;
  genre?: string;
  secret: boolean;
  condition: BadgeCondition;
}

// ─── Runtime state ────────────────────────────────────────────────────────────

export interface BadgeProgress {
  badge: BadgeDefinition;
  unlocked: boolean;
  current: number;
  target: number;
}

export interface BadgeContext {
  journeyEntries: JourneyEntry[];
  statusHistory: StatusChangeEntry[];
  sessions: GameSession[];
  libraryEntries: LibraryGameEntry[];
  now: Date;
  unlockedBadgeIds: Set<number>;
}

export interface TasteDnaAxis {
  label: string;
  key: string;
  value: number; // 0–100
}
