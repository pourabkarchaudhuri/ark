/**
 * Badge Vault — Neon Medal Collection
 *
 * Dark glass cards with neon tier-glow outlines, branch motifs rendered inside
 * each medal shape, lore always visible, and comfortable readable font sizes.
 * Designed for the Ark's archival aesthetic.
 */
import { memo, useMemo, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Filter, ChevronDown, X, Lock } from 'lucide-react';
import type { BadgeProgress, BadgeBranch, BadgeTier, MedalShape } from '@/data/badge-types';
import {
  TIER_POINTS, MEDAL_PATHS, TIER_GRADIENTS,
  BRANCH_MOTIFS, TIER_NEON, TIER_COLORS, BRANCH_META,
} from '@/data/badge-types';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ui/evervault-card';
import { ensureUnlockedAt } from '@/services/badge-unlock-timestamps';

// ─── Neon Medal SVG ─────────────────────────────────────────────────────────

const MedalIcon = memo(function MedalIcon({
  shape, tier, branch, unlocked, size = 110,
}: {
  shape: MedalShape; tier: BadgeTier; branch: BadgeBranch; unlocked: boolean; size?: number;
}) {
  const uid = `nm-${tier}-${shape}-${branch}-${size}`;
  const [c1, c2, c3] = TIER_GRADIENTS[tier];
  const neon = TIER_NEON[tier];
  const motif = BRANCH_MOTIFS[branch];

  return (
    <svg width={size} height={size} viewBox="0 0 100 116" className="flex-shrink-0">
      <defs>
        <linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="0.7" y2="1">
          <stop offset="0%" stopColor={unlocked ? c1 : '#1a1a1a'} />
          <stop offset="50%" stopColor={unlocked ? c2 : '#2a2a2a'} />
          <stop offset="100%" stopColor={unlocked ? c3 : '#111'} />
        </linearGradient>
        <clipPath id={`${uid}-clip`}>
          <path d={MEDAL_PATHS[shape]} />
        </clipPath>
        <filter id={`${uid}-neon`}>
          <feGaussianBlur in="SourceGraphic" stdDeviation={unlocked ? 5 : 2} />
        </filter>
      </defs>

      {/* Neon glow outline — always present, brighter when unlocked */}
      <path d={MEDAL_PATHS[shape]} fill="none"
        stroke={neon.color} strokeWidth={unlocked ? 3.5 : 1.5}
        opacity={unlocked ? 0.5 : 0.12}
        filter={`url(#${uid}-neon)`} />

      {/* Second glow pass for unlocked — wider diffuse */}
      {unlocked && (
        <path d={MEDAL_PATHS[shape]} fill="none"
          stroke={neon.color} strokeWidth={6}
          opacity={0.15}
          filter={`url(#${uid}-neon)`} />
      )}

      {/* Medal body */}
      <path d={MEDAL_PATHS[shape]} fill={`url(#${uid}-fill)`}
        stroke={unlocked ? neon.color : '#333'} strokeWidth={1.2}
        strokeLinejoin="round" opacity={unlocked ? 1 : 0.5} />

      {/* Inner edge highlight */}
      {unlocked && (
        <path d={MEDAL_PATHS[shape]} fill="none"
          stroke="rgba(255,255,255,0.1)" strokeWidth={0.5}
          transform="translate(2,2) scale(0.96)" />
      )}

      {/* Branch motif, clipped to medal */}
      <g clipPath={`url(#${uid}-clip)`}>
        <path d={motif}
          transform="translate(26,28) scale(2)"
          fill="none"
          stroke={unlocked ? `${neon.color}55` : 'rgba(255,255,255,0.03)'}
          strokeWidth={unlocked ? 0.7 : 0.5}
          strokeLinecap="round" strokeLinejoin="round" />
      </g>

      {/* Lock overlay */}
      {!unlocked && (
        <g transform="translate(35,35)" opacity={0.25}>
          <rect x="4" y="14" width="22" height="17" rx="3" fill="none" stroke="#888" strokeWidth="1.5" />
          <path d="M9 14 V9 A6 6 0 0 1 21 9 V14" fill="none" stroke="#888" strokeWidth="1.5" />
          <circle cx="15" cy="22.5" r="2" fill="#888" />
        </g>
      )}
    </svg>
  );
});

// Shield: almost background, just visible. Lock: neon purple, centered.
const SHIELD_FILL = 'rgba(255,255,255,0.06)'; // subtle on dark cards; use class for light if needed
const NEON_PURPLE = '#a855f7';

// Shield scale: 1.44 = 20% bigger twice; viewBox expanded so inner icons stay same size
const SHIELD_SCALE = 1.44;
const VB_PAD_X = 15;
const VB_PAD_Y = 20;
const VB_W = 100 + VB_PAD_X * 2;
const VB_H = 116 + VB_PAD_Y * 2;
const SHIELD_CX = 50;
const SHIELD_CY = 58;
const SHIELD_TRANSFORM = `translate(${SHIELD_CX},${SHIELD_CY}) scale(${SHIELD_SCALE}) translate(${-SHIELD_CX},${-SHIELD_CY})`;

// ─── Compact tier medal: subtle shield (44% larger than base); branch or lock unchanged in center ───
const TierMedal = memo(function TierMedal({
  badge,
  unlocked,
  size = 56,
}: {
  badge: BadgeProgress['badge'];
  unlocked: boolean;
  size?: number;
}) {
  const tierColor = TIER_NEON[badge.tier].color;
  const clipId = `vault-${badge.id}`;
  return (
    <svg width={size} height={size} viewBox={`${-VB_PAD_X} ${-VB_PAD_Y} ${VB_W} ${VB_H}`} className="flex-shrink-0">
      <defs>
        <clipPath id={clipId}><path d={MEDAL_PATHS[badge.shape]} transform={SHIELD_TRANSFORM} /></clipPath>
      </defs>
      <path
        d={MEDAL_PATHS[badge.shape]}
        transform={SHIELD_TRANSFORM}
        fill={SHIELD_FILL}
        stroke="rgba(255,255,255,0.15)"
        strokeWidth={1.5}
      />
      <g clipPath={`url(#${clipId})`}>
        {unlocked ? (
          <path
            d={BRANCH_MOTIFS[badge.branch]}
            transform="translate(26,28) scale(2)"
            fill="none"
            stroke={tierColor}
            strokeWidth={0.9}
          />
        ) : (
          /* Lock icon centered in shield (viewBox center ~50,58), neon purple */
          <g transform="translate(28, 27) scale(1.8)" stroke={NEON_PURPLE} strokeWidth={1.2} fill="none" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="12" rx="2" />
            <path d="M7 11 V7 a5 5 0 0 1 10 0 v4" />
            <circle cx="12" cy="16" r="1.5" fill={NEON_PURPLE} />
          </g>
        )}
      </g>
    </svg>
  );
});

// ─── Badge Card: compact, 6 per row, lore, timestamp, tier-matched medal ───

function formatObtained(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `Today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const BadgeCard = memo(function BadgeCard({ bp, index }: { bp: BadgeProgress; index: number }) {
  const { badge, unlocked, current, target } = bp;
  const neon = TIER_NEON[badge.tier];
  const isSecret = badge.secret && !unlocked;
  const unlockedAt = unlocked ? ensureUnlockedAt(badge.id) : undefined;
  const branchLabel = BRANCH_META[badge.branch]?.label ?? badge.branch;
  const progressPct = target > 0 ? Math.min(100, (current / target) * 100) : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ delay: Math.min(index * 0.012, 0.3), duration: 0.3 }}
      className={cn(
        'group/card border border-black/[0.2] dark:border-white/[0.2] flex flex-col items-stretch w-full p-3 relative min-h-0 rounded-xl',
        'bg-white/[0.02] dark:bg-black/40',
        'transition-shadow duration-200',
        'hover:shadow-[0_0_20px_rgba(0,212,255,0.12)] hover:border-cyan-500/30',
        !unlocked && 'opacity-60'
      )}
    >
      {/* Corner crosses — positioned relative to card border so outline and icons align */}
      <Icon className="absolute top-2 left-2 h-4 w-4 dark:text-white text-black z-10" />
      <Icon className="absolute top-2 right-2 h-4 w-4 dark:text-white text-black z-10" />
      <Icon className="absolute bottom-2 left-2 h-4 w-4 dark:text-white text-black z-10" />
      <Icon className="absolute bottom-2 right-2 h-4 w-4 dark:text-white text-black z-10" />

      {/* Dim overlay for locked cards — entire card content looks dimmed */}
      {!unlocked && (
        <div
          className="absolute inset-0 rounded-xl bg-black/40 pointer-events-none z-[1]"
          aria-hidden
        />
      )}

      <div className="relative z-[2]">
      {/* Branch and Obtained — top left, same style */}
      <div className="mt-[20px] mb-1.5 min-h-[2rem]">
        <span className="text-[9px] font-mono uppercase tracking-wider text-white/40 truncate block">
          // {branchLabel.toUpperCase()}
        </span>
        {unlocked && unlockedAt !== undefined && (
          <span className="text-[9px] font-mono uppercase tracking-wider text-white/40 block mt-0.5">
            Obtained {formatObtained(unlockedAt)}
          </span>
        )}
      </div>

      <div className="w-full flex-shrink-0 flex justify-center aspect-square max-h-[200px] min-h-[160px] mt-[32px]">
        <div className="relative w-[161px] h-[161px] flex items-center justify-center flex-shrink-0">
          <TierMedal badge={badge} unlocked={unlocked} size={161} />
        </div>
      </div>

      <h2 className="dark:text-white text-black mt-1 text-sm font-semibold w-full text-center line-clamp-2">
        {isSecret ? (
          <span className="flex items-center justify-center gap-1">
            <Lock className="w-3 h-3 inline flex-shrink-0" /> Classified
          </span>
        ) : (
          badge.name
        )}
      </h2>

      {/* Objective — reserved space so all cards align */}
      <div className="mt-2 min-h-[4rem] flex flex-col justify-center">
        {!isSecret && badge.description && (
          <div className="px-2 py-2 rounded-lg bg-white/[0.04] dark:bg-black/30 border border-white/[0.06] dark:border-white/[0.06]">
            <p className="text-[9px] font-mono uppercase tracking-wider text-white/40 dark:text-white/35 mb-1">
              To unlock
            </p>
            <p className="text-xs text-white/70 dark:text-white/60 leading-snug line-clamp-3">
              {badge.description}
            </p>
          </div>
        )}
      </div>

      {/* Lore — reserved space */}
      <div className="min-h-[2rem] flex items-center justify-center">
        {!isSecret && badge.lore && (
          <p className="text-[10px] text-white/50 dark:text-white/40 italic text-center w-full line-clamp-2 px-0.5">
            &ldquo;{badge.lore}&rdquo;
          </p>
        )}
      </div>

      {/* Progress bar — reserved space when locked */}
      <div className="min-h-[2.5rem] flex flex-col justify-center">
        {!unlocked && !isSecret && target > 0 && (
          <div className="mt-1.5">
            <div className="h-1.5 rounded-full overflow-hidden bg-white/[0.06] dark:bg-black/30">
              <motion.div
                className="h-full rounded-full"
                style={{ background: neon.color, opacity: 0.7 }}
                initial={{ width: 0 }}
                animate={{ width: `${progressPct}%` }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
              />
            </div>
            <p className="text-[9px] font-mono text-white/40 text-center mt-0.5">
              {current} / {target}
            </p>
          </div>
        )}
      </div>

      {/* Obtained — reserved space so card height stays consistent */}
      <div className="min-h-[1.25rem]" aria-hidden />

      {/* Tier + XP tags — same pill style (rounded-full, border); tier uses tier color */}
      <div className="mt-auto pt-1.5 flex flex-wrap items-center justify-center gap-1.5">
        <span
          className="text-[10px] font-medium rounded-full px-2 py-0.5 border dark:border-white/[0.2] border-black/[0.2]"
          style={{ borderColor: `${neon.color}50`, color: neon.color }}
        >
          {badge.tier}
        </span>
        <p
          className={cn(
            'text-[10px] border font-medium rounded-full px-2 py-0.5',
            'dark:border-white/[0.2] border-black/[0.2] text-black dark:text-white'
          )}
          style={unlocked ? { borderColor: `${neon.color}50`, color: neon.color } : undefined}
        >
          {unlocked ? `Decoded · +${TIER_POINTS[badge.tier]} XP` : isSecret ? 'Decrypt to reveal' : `+${TIER_POINTS[badge.tier]} XP when decoded`}
        </p>
      </div>
      <div className="min-h-[1.25rem] flex items-center justify-center">
        {badge.genre && (
          <span className="text-[9px] font-mono text-white/30 uppercase text-center block">{badge.genre}</span>
        )}
      </div>
      </div>
    </motion.div>
  );
});

// ─── Filter types ───────────────────────────────────────────────────────────

type VaultFilter = 'all' | 'unlocked' | 'locked' | BadgeBranch | BadgeTier;

const FILTER_OPTIONS: { value: VaultFilter; label: string }[] = [
  { value: 'all', label: 'All Signals' },
  { value: 'unlocked', label: 'Decoded' },
  { value: 'locked', label: 'Encrypted' },
  { value: 'voyager', label: 'Voyager' },
  { value: 'conqueror', label: 'Conqueror' },
  { value: 'sentinel', label: 'Sentinel' },
  { value: 'timekeeper', label: 'Timekeeper' },
  { value: 'scholar', label: 'Scholar' },
  { value: 'chronicler', label: 'Chronicler' },
  { value: 'pioneer', label: 'Pioneer' },
  { value: 'stargazer', label: 'Stargazer' },
  { value: 'genre', label: 'Genre' },
  { value: 'legendary', label: 'Legendary' },
  { value: 'secret', label: 'Secret' },
  { value: 'bronze', label: 'Bronze' },
  { value: 'silver', label: 'Silver' },
  { value: 'gold', label: 'Gold' },
  { value: 'platinum', label: 'Platinum' },
  { value: 'diamond', label: 'Diamond' },
];

const TIERS: BadgeTier[] = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
const BRANCHES: BadgeBranch[] = ['voyager','conqueror','sentinel','timekeeper','scholar','chronicler','pioneer','stargazer','genre','legendary','secret'];

interface BadgeVaultProps {
  badges: BadgeProgress[];
  unlockedCount: number;
}

// ─── Vault ──────────────────────────────────────────────────────────────────

export const BadgeVault = memo(function BadgeVault({ badges, unlockedCount }: BadgeVaultProps) {
  const [filter, setFilter] = useState<VaultFilter>('all');
  const [search, setSearch] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [visibleCount, setVisibleCount] = useState(16);

  const filtered = useMemo(() => {
    let list = badges;
    if (filter !== 'all') {
      if (filter === 'unlocked') list = list.filter(b => b.unlocked);
      else if (filter === 'locked') list = list.filter(b => !b.unlocked);
      else if (TIERS.includes(filter as BadgeTier)) list = list.filter(b => b.badge.tier === filter);
      else if (BRANCHES.includes(filter as BadgeBranch)) list = list.filter(b => b.badge.branch === filter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(b =>
        b.badge.name.toLowerCase().includes(q) ||
        b.badge.description.toLowerCase().includes(q) ||
        b.badge.lore?.toLowerCase().includes(q) ||
        (b.badge.genre && b.badge.genre.toLowerCase().includes(q))
      );
    }
    return list;
  }, [badges, filter, search]);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visibleCount;
  const loadMore = useCallback(() => setVisibleCount(v => v + 16), []);

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-base font-bold text-white/80 font-mono tracking-wide">ARK SIGNAL VAULT</h3>
          <p className="text-xs text-white/30 font-mono mt-0.5">
            {unlockedCount} decoded · {badges.length - unlockedCount} encrypted · {badges.length} total transmissions
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
            <input
              type="text"
              value={search}
              onChange={e => { setSearch(e.target.value); setVisibleCount(16); }}
              placeholder="Search transmissions..."
              className="w-52 pl-8 pr-8 py-2 text-sm bg-white/[0.04] border border-white/10 rounded-xl text-white/70 placeholder:text-white/20 focus:outline-none focus:border-fuchsia-500/40 transition-colors"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2">
                <X className="w-3.5 h-3.5 text-white/30 hover:text-white/60 transition-colors" />
              </button>
            )}
          </div>
          <button
            onClick={() => setShowFilters(f => !f)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 text-xs font-mono rounded-xl border transition-all',
              showFilters
                ? 'bg-fuchsia-500/15 border-fuchsia-500/30 text-fuchsia-300'
                : 'bg-white/[0.04] border-white/10 text-white/40 hover:text-white/60',
            )}
          >
            <Filter className="w-3.5 h-3.5" />
            Filter
            <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', showFilters && 'rotate-180')} />
          </button>
        </div>
      </div>

      {/* Filter pills */}
      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="flex flex-wrap gap-2 pb-1">
              {FILTER_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => { setFilter(opt.value); setVisibleCount(16); }}
                  className={cn(
                    'px-3 py-1.5 text-xs font-mono rounded-lg border transition-all',
                    filter === opt.value
                      ? 'bg-fuchsia-500/15 border-fuchsia-500/40 text-fuchsia-300'
                      : 'bg-white/[0.03] border-white/[0.06] text-white/30 hover:text-white/50 hover:border-white/15',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Card grid — 6 per row, consistent gap */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5 gap-y-6">
        <AnimatePresence mode="popLayout">
          {visible.map((bp, i) => (
            <BadgeCard key={bp.badge.id} bp={bp} index={i} />
          ))}
        </AnimatePresence>
      </div>

      {/* Load more */}
      {hasMore && (
        <button
          onClick={loadMore}
          className="mx-auto px-8 py-2.5 text-sm font-mono text-white/40 hover:text-white/70 border border-white/10 rounded-xl hover:border-fuchsia-500/30 transition-all hover:bg-white/[0.02]"
        >
          Decrypt more signals ({filtered.length - visibleCount} remaining)
        </button>
      )}

      {visible.length === 0 && (
        <p className="text-center text-white/20 text-sm font-mono py-16">
          No transmissions match your query.
        </p>
      )}
    </div>
  );
});
