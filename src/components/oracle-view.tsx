/**
 * Oracle View — Recommendation Engine UI
 *
 * Displays a sophisticated, cinematic recommendation page:
 *   - Terminal-style computing state with progress
 *   - Hero card for the #1 pick
 *   - Themed shelf carousels
 *   - Interactive taste DNA radar chart
 *   - Match score rings and reason pills
 */

import { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import {
  RefreshCw,
  Clock,
  Star,
  TrendingUp,
  Gem,
  Compass,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Zap,
  Eye,
  Award,
  Target,
  Layers,
  Heart,
  CalendarPlus,
  Rocket,
  Undo2,
  Brain,
  ListChecks,
  CalendarClock,
  DollarSign,
  Gift,
  Building2,
  X,
  Check,
  Loader2,
  Globe,
} from 'lucide-react';
import { cn, formatHours, buildGameImageChain } from '@/lib/utils';
import { AnimateIcon } from '@/components/ui/animate-icon';
import { recoStore } from '@/services/reco-store';
import { shelfBanditStore } from '@/services/shelf-bandit-store';
import { recoHistoryStore } from '@/services/reco-history-store';
import { embeddingService } from '@/services/embedding-service';
import { catalogStore, type CatalogSyncProgress } from '@/services/catalog-store';
import { libraryStore } from '@/services/library-store';
import { journeyStore } from '@/services/journey-store';
import { GameCard } from '@/components/game-card';
import { Badge } from '@/components/ui/badge';
import type { Game } from '@/types/game';
import type { RecoShelf, ScoredGame, TasteProfile, ShelfType } from '@/types/reco';
import { getCanonicalGenres } from '@/data/canonical-genres';

// ─── Background catalog embedding pipeline (persists across navigation) ──────

let _pipelineStarted = false;

function startCatalogEmbeddingPipeline() {
  if (_pipelineStarted) return;
  _pipelineStarted = true;

  (async () => {
    try {
      await catalogStore.sync();
    } catch { /* non-fatal */ }

    const available = await embeddingService.isAvailable();
    if (!available) { _pipelineStarted = false; return; }

    const entryCount = await catalogStore.getEntryCount();
    if (entryCount === 0) { _pipelineStarted = false; return; }

    await embeddingService.generateCatalogEmbeddings(
      (onBatch) => catalogStore.getAllEntries(onBatch),
    );
    _pipelineStarted = false;
  })();
}

// ─── Hook to subscribe to the reco store ───────────────────────────────────────

function useRecoStore() {
  const [state, setState] = useState(recoStore.getState());

  useEffect(() => {
    const unsub = recoStore.subscribe(() => setState({ ...recoStore.getState() }));
    return unsub;
  }, []);

  return state;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const SHELF_ICONS: Record<ShelfType, React.ElementType> = {
  'hero': Sparkles,
  'because-you-loved': Star,
  'deep-in-genre': Layers,
  'hidden-gems': Gem,
  'stretch-picks': Compass,
  'trending-now': TrendingUp,
  'critics-choice': Award,
  'unfinished-business': Clock,
  'for-your-mood': Heart,
  'new-releases-for-you': CalendarPlus,
  'coming-soon-for-you': Rocket,
  'finish-and-try': Undo2,
  // v3 shelf types
  'complete-the-series': ListChecks,
  'upcoming-sequels': CalendarClock,
  'deals-for-you': DollarSign,
  'free-for-you': Gift,
  'from-studios-you-love': Building2,
};

const WAVE_SPRING = { type: 'spring' as const, stiffness: 500, damping: 26, mass: 0.8 };

// ─── Skeleton Loading State ─────────────────────────────────────────────────────

function OracleSkeleton() {
  return (
    <div className="pointer-events-none select-none" aria-hidden>
      {/* Hero skeleton */}
      <div className="w-full h-[280px] rounded-xl overflow-hidden bg-white/[0.03] mb-8 relative">
        <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-white/[0.02] via-white/[0.05] to-white/[0.02]" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/50 to-transparent" />
        <div className="absolute bottom-6 left-6 lg:left-8 space-y-3">
          <div className="h-3 w-24 bg-fuchsia-500/20 rounded animate-pulse" />
          <div className="h-7 w-64 bg-white/10 rounded animate-pulse" />
          <div className="flex items-center gap-3">
            <div className="h-4 w-20 bg-fuchsia-500/15 rounded animate-pulse" />
            <div className="h-4 w-28 bg-white/5 rounded animate-pulse" />
          </div>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* Shelf skeletons */}
        <div className="flex-1 min-w-0 space-y-8">
          {[1, 2, 3].map((shelf) => (
            <div key={shelf}>
              <div className="flex items-center gap-2 mb-3 px-1">
                <div className="w-4 h-4 rounded bg-fuchsia-500/10 animate-pulse" />
                <div className="h-4 w-32 bg-white/10 rounded animate-pulse" />
              </div>
              <div className="flex gap-4 overflow-hidden px-1">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex-shrink-0 w-[160px]">
                    <div className="aspect-[2/3] rounded-lg bg-white/[0.04] animate-pulse mb-2" />
                    <div className="h-3 w-[80%] bg-white/8 rounded animate-pulse mb-1.5" />
                    <div className="h-2.5 w-[55%] bg-white/5 rounded animate-pulse" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Taste DNA sidebar skeleton */}
        <div className="lg:w-[280px] flex-shrink-0 space-y-4">
          <div className="flex items-center justify-center gap-2 mb-2">
            <div className="w-4 h-4 rounded bg-fuchsia-500/10 animate-pulse" />
            <div className="h-4 w-20 bg-white/10 rounded animate-pulse" />
          </div>
          <div className="w-[220px] h-[220px] mx-auto rounded-full border border-white/[0.04] animate-pulse" />
          <div className="space-y-2 px-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="h-2.5 w-20 bg-white/5 rounded animate-pulse" />
                <div className="h-2.5 w-12 bg-fuchsia-500/10 rounded animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Loading State with Detailed Progress ───────────────────────────────────────

/**
 * Detailed pipeline stage descriptions — maps short stage names from the worker
 * to richer explanations for the user.
 */
const STAGE_DETAILS: Record<string, { label: string; detail: string }> = {
  'Gathering data...': {
    label: 'Gathering data',
    detail: 'Reading your library, sessions, and play history from local stores',
  },
  'Analyzing your library...': {
    label: 'Analyzing library',
    detail: 'Building your taste profile across genres, themes, developers, and eras',
  },
  'Analyzing play patterns...': {
    label: 'Play pattern analysis',
    detail: 'Classifying engagement curves — long-tail, slow-burn, binge, honeymoon',
  },
  'Mining negative signals...': {
    label: 'Negative signal mining',
    detail: 'Identifying games you dropped or shelved to avoid similar recommendations',
  },
  'Building taste vectors...': {
    label: 'Taste vectorization',
    detail: 'Converting your preferences into multi-dimensional feature vectors',
  },
  'Building similarity graph...': {
    label: 'Similarity graph',
    detail: 'Linking games by shared tags (Jaccard similarity) for co-occurrence scoring',
  },
  'Detecting game franchises...': {
    label: 'Franchise detection',
    detail: 'Finding game series in your library (sequels, prequels, spin-offs)',
  },
  'Generating semantic embeddings...': {
    label: 'Generating embeddings',
    detail: 'Creating semantic vectors via Ollama for deep similarity matching',
  },
  'Building scoring contexts...': {
    label: 'Preparing scoring layers',
    detail: 'Pre-computing time-of-day affinity, session sequencing, and graph lookups',
  },
  'Scoring candidates...': {
    label: 'Scoring candidates',
    detail: 'Running 17-layer pipeline — content, semantic, graph, quality, franchise, and more',
  },
  'Applying diversity filter...': {
    label: 'Diversity filter',
    detail: 'MMR re-ranking to balance relevance with variety across recommendations',
  },
  'Detecting taste clusters...': {
    label: 'Taste cluster detection',
    detail: 'K-means clustering to find distinct "moods" in your gaming personality',
  },
  'Generating insights...': {
    label: 'Generating insights',
    detail: 'Writing personalized explanations for why each game was recommended',
  },
  'Building shelves...': {
    label: 'Assembling shelves',
    detail: 'Organizing results into themed collections — hero pick, genre deep-dives, hidden gems',
  },
};

function OracleLoadingOverlay({
  stage,
  percent,
  libraryCount,
  candidateCount,
  embeddingStatus,
  embeddingProgress,
}: {
  stage: string;
  percent: number;
  libraryCount: number;
  candidateCount: number;
  embeddingStatus: string;
  embeddingProgress: { completed: number; total: number } | null;
}) {
  // Accumulate completed stages with their associated percent for the log.
  // Stages that only differ by a parenthetical suffix (e.g. "Scoring candidates... (1/28k)")
  // are treated as in-place updates of the same step rather than new entries.
  const [completedStages, setCompletedStages] = useState<{ stage: string; percent: number }[]>([]);

  useEffect(() => {
    if (stage) {
      setCompletedStages(prev => {
        const last = prev[prev.length - 1];
        const baseOf = (s: string) => s.replace(/\s*\(.*\)\s*$/, '');
        const sameStep = last && baseOf(last.stage) === baseOf(stage);
        if (sameStep) {
          if (last.stage === stage && last.percent === percent) return prev;
          const updated = [...prev];
          updated[updated.length - 1] = { stage, percent };
          return updated;
        }
        return [...prev, { stage, percent }];
      });
    }
  }, [stage, percent]);

  // Reset on fresh compute (percent drops back to low)
  useEffect(() => {
    if (percent <= 5) setCompletedStages(stage ? [{ stage, percent }] : []);
  }, [percent <= 5]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentStageInfo = STAGE_DETAILS[stage] || { label: stage, detail: '' };

  const embeddingLabel = (() => {
    if (embeddingStatus === 'ready') return 'Semantic embeddings loaded';
    if (embeddingStatus === 'generating' && embeddingProgress && embeddingProgress.total > 0) {
      return `Embedding ${embeddingProgress.completed.toLocaleString()} / ${embeddingProgress.total.toLocaleString()} games...`;
    }
    if (embeddingStatus === 'generating') return 'Generating embeddings via Ollama...';
    if (embeddingStatus === 'loading') return 'Loading embeddings...';
    if (embeddingStatus === 'unavailable') return 'No embeddings (tag-based mode)';
    return 'Checking embeddings...';
  })();

  const embeddingPercent = (embeddingStatus === 'generating' && embeddingProgress && embeddingProgress.total > 0)
    ? Math.round((embeddingProgress.completed / embeddingProgress.total) * 100)
    : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.35 }}
      className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"
    >
      <div className="w-full max-w-xl pointer-events-auto">
        {/* Glass panel — scaled 20% larger */}
        <div className="rounded-2xl border border-white/[0.08] bg-black/70 backdrop-blur-xl shadow-2xl shadow-fuchsia-500/5 p-7">
          {/* Header row: Oracle icon + title + percent */}
          <div className="flex items-center gap-5 mb-6">
            {/* AI icon */}
            <div className="relative w-14 h-14 flex-shrink-0 flex items-center justify-center">
              <motion.div
                animate={{ scale: [1, 1.1, 1] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              >
                <Sparkles className="w-7 h-7 text-fuchsia-400/70" />
              </motion.div>
            </div>

            <div className="flex-1 min-w-0">
              <h3 className="text-base font-semibold text-white/80">Recommendation Engine</h3>
              <p className="text-xs text-white/25 mt-0.5">
                17-layer pipeline
                {libraryCount > 0 && <> · {libraryCount} games</>}
                {candidateCount > 0 && <> · {candidateCount} candidates</>}
              </p>
            </div>

            {/* Percentage ring */}
            <div className="relative w-14 h-14 flex-shrink-0">
              <svg width={56} height={56} className="rotate-[-90deg]">
                <circle cx={28} cy={28} r={22} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={3} />
                <motion.circle
                  cx={28} cy={28} r={22} fill="none"
                  stroke="url(#loadGrad)"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 22}
                  animate={{ strokeDashoffset: 2 * Math.PI * 22 * (1 - percent / 100) }}
                  transition={{ duration: 0.4, ease: 'easeOut' }}
                />
                <defs>
                  <linearGradient id="loadGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#d946ef" />
                    <stop offset="100%" stopColor="#a855f7" />
                  </linearGradient>
                </defs>
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-xs font-bold text-white/70">{percent}%</span>
              </div>
            </div>
          </div>

          {/* Progress bar */}
          <div className="relative h-1.5 bg-white/[0.04] rounded-full overflow-hidden mb-5">
            <motion.div
              className="absolute inset-y-0 left-0 bg-gradient-to-r from-fuchsia-500 to-purple-500 rounded-full"
              animate={{ width: `${percent}%` }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
            />
            <motion.div
              className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent"
              animate={{ x: ['-100%', '200%'] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
            />
          </div>

          {/* Current stage — prominent */}
          <AnimatePresence mode="wait">
            <motion.div
              key={stage}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
              className="mb-5"
            >
              <div className="flex items-center gap-2.5 mb-1">
                <span className="text-sm font-medium text-white/70">{currentStageInfo.label}</span>
              </div>
              {currentStageInfo.detail && (
                <p className="text-xs text-white/30 leading-relaxed">
                  {currentStageInfo.detail}
                </p>
              )}
            </motion.div>
          </AnimatePresence>

          {/* Stage log — terminal-style */}
          <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] p-4 max-h-[200px] overflow-y-auto scrollbar-hide">
            <div className="flex items-center gap-2 mb-3">
              <div className="flex gap-1.5">
                <div className="w-2 h-2 rounded-full bg-red-500/40" />
                <div className="w-2 h-2 rounded-full bg-yellow-500/40" />
                <div className="w-2 h-2 rounded-full bg-green-500/40" />
              </div>
              <span className="text-[10px] text-white/15 font-mono">reco.engine.v3</span>
            </div>

            <div className="space-y-1.5 font-mono text-xs">
              {/* Embedding status line */}
              <div>
                <div className="flex items-center gap-2.5">
                  {embeddingStatus === 'ready' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400/70 flex-shrink-0" />
                  ) : embeddingStatus === 'loading' || embeddingStatus === 'generating' ? (
                    <Loader2 className="w-3.5 h-3.5 text-fuchsia-400/70 animate-spin flex-shrink-0" />
                  ) : (
                    <span className="w-3.5 h-3.5 flex items-center justify-center text-white/20 flex-shrink-0">—</span>
                  )}
                  <span className={cn(
                    'transition-colors',
                    embeddingStatus === 'ready' ? 'text-emerald-400/60' :
                    embeddingStatus === 'generating' ? 'text-fuchsia-300/60' :
                    embeddingStatus === 'unavailable' ? 'text-white/20' : 'text-white/40',
                  )}>
                    {embeddingLabel}
                  </span>
                </div>

                {/* Embedding mini progress bar */}
                {embeddingPercent !== null && (
                  <div className="ml-6 mt-1.5">
                    <div className="relative h-1 w-full max-w-[200px] bg-white/[0.04] rounded-full overflow-hidden">
                      <motion.div
                        className="absolute inset-y-0 left-0 bg-gradient-to-r from-fuchsia-500/80 to-purple-400/80 rounded-full"
                        animate={{ width: `${embeddingPercent}%` }}
                        transition={{ duration: 0.3, ease: 'easeOut' }}
                      />
                    </div>
                    <span className="text-[10px] text-white/20 mt-0.5 block">{embeddingPercent}%</span>
                  </div>
                )}
              </div>

              {/* Pipeline stages */}
              {completedStages.map((entry, i) => {
                const info = STAGE_DETAILS[entry.stage];
                const isCurrent = entry.stage === stage;
                return (
                  <motion.div
                    key={`${entry.stage}-${i}`}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.15 }}
                    className="flex items-center gap-2.5"
                  >
                    {isCurrent ? (
                      <Loader2 className="w-3.5 h-3.5 text-fuchsia-400/70 animate-spin flex-shrink-0" />
                    ) : (
                      <Check className="w-3.5 h-3.5 text-fuchsia-400/50 flex-shrink-0" />
                    )}
                    <span className={cn(
                      'transition-colors flex-1 min-w-0 truncate',
                      isCurrent ? 'text-fuchsia-300/70' : 'text-white/25',
                    )}>
                      {entry.stage === 'Generating semantic embeddings...' && embeddingProgress && embeddingProgress.total > 0
                        ? `Generating embeddings ${embeddingProgress.completed.toLocaleString()} / ${embeddingProgress.total.toLocaleString()}`
                        : (info?.label || entry.stage)}
                    </span>
                    <span className={cn(
                      'text-[10px] tabular-nums flex-shrink-0',
                      isCurrent ? 'text-fuchsia-400/50' : 'text-white/15',
                    )}>
                      {entry.percent}%
                    </span>
                  </motion.div>
                );
              })}
            </div>
          </div>

          {/* Bottom note */}
          <p className="text-[11px] text-white/15 mt-4 text-center">
            Everything runs locally — no data leaves your machine
          </p>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Reason Pills ──────────────────────────────────────────────────────────────

function ReasonPills({ game }: { game: ScoredGame }) {
  const pills: string[] = [];

  if (game.reasons.isFranchiseEntry && game.reasons.franchiseOf) {
    pills.push(`${game.reasons.franchiseOf} Series`);
  }
  if (game.reasons.sharedGenres.length > 0) {
    pills.push(...game.reasons.sharedGenres.slice(0, 2));
  }
  if (game.reasons.similarTo.length > 0) {
    pills.push(`Like ${game.reasons.similarTo[0]}`);
  }
  if (game.price?.isFree) {
    pills.push('Free');
  }
  if (game.reasons.semanticRetrieved) {
    pills.push('Taste Match');
  }
  if (game.reasons.isHiddenGem) {
    pills.push('Hidden Gem');
  }

  if (pills.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {pills.slice(0, 3).map((label, i) => (
        <Badge key={i} variant="outline" className="text-xs border-white/20 text-white/80">
          {label}
        </Badge>
      ))}
    </div>
  );
}

// ─── Fallback Image Hook ───────────────────────────────────────────────────────

/** Walks the buildGameImageChain fallback list, advancing on each error. */
function useFallbackImage(gameId: string, title: string, coverUrl?: string, headerImage?: string) {
  const chain = buildGameImageChain(gameId, title, coverUrl, headerImage);
  const [idx, setIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  // Reset when the game OR its image sources change (fixes stale state after refresh)
  const chainKey = `${gameId}|${coverUrl ?? ''}|${headerImage ?? ''}`;
  useEffect(() => { setIdx(0); setLoaded(false); setFailed(false); }, [chainKey]);

  const src = chain[idx] ?? null;

  const onError = useCallback(() => {
    if (idx < chain.length - 1) {
      setIdx(i => i + 1);
    } else {
      setFailed(true);
    }
  }, [idx, chain.length]);

  const onLoad = useCallback(() => { setLoaded(true); }, []);

  return { src, loaded, failed, onError, onLoad };
}

// ─── ScoredGame → Game adapter ──────────────────────────────────────────────────

const EPOCH_DATE = new Date(0);

/** Resolve cover/header from ScoredGame or fallback to library/journey (e.g. Unfinished Business shelf). */
function getScoredGameImages(sg: ScoredGame): { coverUrl?: string; headerImage?: string } {
  let coverUrl = sg.coverUrl;
  let headerImage = sg.headerImage;
  if (!coverUrl || !headerImage) {
    const lib = libraryStore.getEntry(sg.gameId);
    const meta = lib?.cachedMeta;
    if (meta) {
      coverUrl = coverUrl ?? meta.coverUrl;
      headerImage = headerImage ?? meta.headerImage;
    }
    if (!coverUrl) {
      const journey = journeyStore.getEntry(sg.gameId);
      if (journey?.coverUrl) coverUrl = journey.coverUrl;
    }
  }
  return { coverUrl, headerImage };
}

/** Convert a ScoredGame from the reco pipeline into a Game object for GameCard. */
function scoredGameToGame(sg: ScoredGame): Game {
  const steamAppId = sg.gameId.startsWith('steam-')
    ? parseInt(sg.gameId.slice(6), 10) || undefined
    : undefined;

  const { coverUrl, headerImage } = getScoredGameImages(sg);

  return {
    id: sg.gameId,
    title: sg.title,
    developer: sg.developer,
    publisher: sg.publisher,
    genre: sg.genres,
    platform: sg.platforms,
    metacriticScore: sg.metacriticScore,
    releaseDate: sg.releaseDate,
    coverUrl,
    headerImage,
    playerCount: sg.playerCount ?? undefined,
    steamAppId,
    store: sg.gameId.startsWith('epic-') ? 'epic' : undefined,
    price: sg.price,
    isInLibrary: false,
    status: 'Want to Play',
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
    createdAt: EPOCH_DATE,
    updatedAt: EPOCH_DATE,
  } as Game;
}

// ─── Oracle Card (wraps GameCard) ───────────────────────────────────────────────

const NOOP = () => {};

/** Oracle-specific footer injected inside GameCard via its footer prop. */
const OracleFooter = memo(function OracleFooter({ game }: { game: ScoredGame }) {
  return (
    <div>
      <ReasonPills game={game} />
    </div>
  );
});

const OracleCard = memo(function OracleCard({
  game,
  index,
  shelfType,
  onDismiss,
}: {
  game: ScoredGame;
  index: number;
  shelfType?: string;
  onDismiss?: (gameId: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const gameObj = useMemo(() => scoredGameToGame(game), [game]);
  const oracleFooter = useMemo(() => <OracleFooter game={game} />, [game]);

  const handleClickCapture = useCallback(() => {
    if (shelfType) {
      shelfBanditStore.recordClick(shelfType);
      recoHistoryStore.recordClick(game.gameId, game.title, shelfType);
    }
  }, [game.gameId, game.title, shelfType]);

  const handleDismiss = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDismiss?.(game.gameId);
  }, [game.gameId, onDismiss]);

  const matchPct = Math.round(game.score * 100);
  const hasDiscount = game.reasons.isOnSale && game.price?.discountPercent;
  const hasMC = game.reasons.metacriticScore && game.reasons.metacriticScore >= 80;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{
        opacity: 1, y: 0, scale: 1,
        transition: { ...WAVE_SPRING, delay: index * 0.05 },
      }}
      exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
      className="relative flex-shrink-0 w-[calc((100vw-8rem)/6)]
                 min-w-[180px] max-w-[280px]"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClickCapture={handleClickCapture}
    >
      <GameCard
        game={gameObj}
        onEdit={NOOP}
        onDelete={NOOP}
        isInLibrary={false}
        hideLibraryBadge
        footer={oracleFooter}
      />

      {/* Protruding lower-third tabs — top-left over the card art */}
      <div className="absolute top-3 left-0 z-20 flex flex-col gap-1.5 pointer-events-none">
        <div className="flex items-center gap-1.5 bg-fuchsia-500/90 backdrop-blur-sm pl-2 pr-2.5 py-[3px] rounded-r-full shadow-lg shadow-fuchsia-500/25">
          <Zap className="w-3 h-3 text-white" />
          <span className="text-[11px] font-bold text-white tracking-wide">{matchPct}%</span>
        </div>

        {hasMC && (
          <div className="flex items-center gap-1.5 bg-amber-500/90 backdrop-blur-sm pl-2 pr-2.5 py-[3px] rounded-r-full shadow-lg shadow-amber-500/25">
            <span className="text-[11px] font-bold text-white tracking-wide">MC {game.reasons.metacriticScore}</span>
          </div>
        )}

        {hasDiscount && (
          <div className="flex items-center gap-1.5 bg-green-500/90 backdrop-blur-sm pl-2 pr-2.5 py-[3px] rounded-r-full shadow-lg shadow-green-500/25">
            <span className="text-[11px] font-bold text-white tracking-wide">-{game.price!.discountPercent}%</span>
          </div>
        )}
      </div>

      {/* Dismiss button — top-right */}
      {onDismiss && (
        <button
          onClick={handleDismiss}
          className={cn(
            "absolute top-2 right-2 z-20 p-1 rounded-full bg-black/60 text-white/40 hover:text-red-400 hover:bg-black/80 transition-all duration-200",
            hovered ? "opacity-100" : "opacity-0"
          )}
          title="Not interested"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </motion.div>
  );
});

// ─── Shelf Carousel ────────────────────────────────────────────────────────────

function ShelfCarousel({
  shelf,
  onDismiss,
}: {
  shelf: RecoShelf;
  onDismiss?: (gameId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);
  const Icon = SHELF_ICONS[shelf.type] || Sparkles;

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    checkScroll();
    el.addEventListener('scroll', checkScroll, { passive: true });
    return () => el.removeEventListener('scroll', checkScroll);
  }, [checkScroll]);

  const scroll = (dir: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === 'left' ? -400 : 400, behavior: 'smooth' });
  };

  // Record impression when shelf becomes visible
  const impressionRecorded = useRef(false);
  useEffect(() => {
    if (!impressionRecorded.current && shelf.games.length > 0) {
      impressionRecorded.current = true;
      shelfBanditStore.recordImpression(shelf.type);
    }
  }, [shelf.type, shelf.games.length]);

  if (shelf.games.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="mb-8"
    >
      {/* Shelf header */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-fuchsia-400/70" />
          <h3 className="text-sm font-semibold text-white/90">{shelf.title}</h3>
          {shelf.subtitle && (
            <span className="text-xs text-white/40 hidden sm:inline">{shelf.subtitle}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => scroll('left')}
            disabled={!canScrollLeft}
            className="p-1 rounded hover:bg-white/5 text-white/30 hover:text-white/60 disabled:opacity-20 transition-all"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => scroll('right')}
            disabled={!canScrollRight}
            className="p-1 rounded hover:bg-white/5 text-white/30 hover:text-white/60 disabled:opacity-20 transition-all"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Scrollable cards */}
      <div
        ref={scrollRef}
        className="flex gap-4 overflow-x-auto scrollbar-hide pb-2 px-1"
        style={{ scrollSnapType: 'x mandatory' }}
      >
        {shelf.games.map((game, i) => (
          <OracleCard key={game.gameId} game={game} index={i} shelfType={shelf.type} onDismiss={onDismiss} />
        ))}
      </div>
    </motion.div>
  );
}

// ─── Hero Card ─────────────────────────────────────────────────────────────────

function HeroCard({ game, onNavigate }: { game: ScoredGame; onNavigate: (gameId: string) => void }) {
  const { coverUrl, headerImage } = getScoredGameImages(game);
  const img = useFallbackImage(game.gameId, game.title, coverUrl, headerImage);
  const pct = Math.round(game.score * 100);
  const [displayPct, setDisplayPct] = useState(0);

  // Animate match percentage counter
  useEffect(() => {
    let frame = 0;
    const totalFrames = 40;
    const interval = setInterval(() => {
      frame++;
      setDisplayPct(Math.round((frame / totalFrames) * pct));
      if (frame >= totalFrames) clearInterval(interval);
    }, 25);
    return () => clearInterval(interval);
  }, [pct]);

  // Build reason string
  const reasonParts: string[] = [];
  if (game.reasons.similarTo.length > 0) {
    reasonParts.push(`Similar to ${game.reasons.similarTo.slice(0, 2).join(' & ')}`);
  }
  if (game.reasons.sharedGenres.length > 0) {
    reasonParts.push(game.reasons.sharedGenres.slice(0, 3).join(', '));
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.8, ease: 'easeOut' }}
      className="relative w-full h-[280px] rounded-xl overflow-hidden cursor-pointer group mb-8"
      onClick={() => onNavigate(game.gameId)}
    >
      {/* Background image with Ken Burns */}
      {img.src && !img.failed && (
        <motion.img
          src={img.src}
          alt={game.title}
          onLoad={img.onLoad}
          onError={img.onError}
          className={cn(
            'absolute inset-0 w-full h-full object-cover transition-opacity duration-1000',
            img.loaded ? 'opacity-100' : 'opacity-0',
          )}
          animate={{ scale: [1, 1.05] }}
          transition={{ duration: 20, ease: 'linear', repeat: Infinity, repeatType: 'reverse' }}
        />
      )}

      {/* Gradient overlays */}
      <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/60 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />

      {/* Fuchsia glow accent */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-fuchsia-500/60 via-fuchsia-500/20 to-transparent" />

      {/* Content */}
      <div className="absolute inset-0 flex flex-col justify-end p-6 lg:p-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.6 }}
        >
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-3.5 h-3.5 text-fuchsia-400" />
            <span className="text-[10px] uppercase tracking-widest text-fuchsia-400 font-semibold">
              Your Next Obsession
            </span>
          </div>

          <h2 className="text-2xl lg:text-3xl font-bold text-white mb-2 group-hover:text-fuchsia-100 transition-colors">
            {game.title}
          </h2>

          <div className="flex items-center gap-4 mb-3">
            <div className="flex items-center gap-1.5">
              <Target className="w-3.5 h-3.5 text-fuchsia-400" />
              <span className="text-sm font-bold text-fuchsia-300">{displayPct}% Match</span>
            </div>
            {game.metacriticScore && (
              <div className="flex items-center gap-1.5">
                <Award className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-sm text-amber-300">Metacritic {game.metacriticScore}</span>
              </div>
            )}
            {game.developer && (
              <span className="text-sm text-white/40">{game.developer}</span>
            )}
          </div>

          {reasonParts.length > 0 && (
            <p className="text-xs text-white/50 max-w-md">
              {reasonParts.join(' · ')}
            </p>
          )}
        </motion.div>
      </div>
    </motion.div>
  );
}

// ─── Taste DNA Radar Chart ─────────────────────────────────────────────────────

function TasteDNA({ profile }: { profile: TasteProfile }) {
  // Use all canonical genres for radar axes; fill in weight/gameCount from profile (0 if none)
  const canonical = getCanonicalGenres();
  const radarGenres = canonical.map((name) => {
    const fromProfile = profile.genres.find((g) => g.name === name);
    return {
      name,
      weight: fromProfile?.weight ?? 0,
      gameCount: fromProfile?.gameCount ?? 0,
      totalHours: fromProfile?.totalHours ?? 0,
    };
  });
  const maxWeight = Math.max(1, ...radarGenres.map((g) => g.weight));
  const count = radarGenres.length;
  const size = 260;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size / 2 - 36;

  // Compute polygon points (all 15 axes)
  const points = radarGenres.map((g, i) => {
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    const r = (g.weight / maxWeight) * maxR;
    return {
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      labelX: cx + Math.cos(angle) * (maxR + 20),
      labelY: cy + Math.sin(angle) * (maxR + 20),
      name: g.name,
      weight: g.weight,
      hours: g.totalHours,
      games: g.gameCount,
    };
  });

  const polygonPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z';

  // Grid rings
  const rings = [0.25, 0.5, 0.75, 1.0];
  const legendGenres = radarGenres.filter((g) => g.weight > 0).slice(0, 8);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.6, delay: 0.2 }}
      className="flex flex-col items-center gap-3 p-4"
    >
      <div className="flex items-center gap-2 mb-2">
        <Zap className="w-4 h-4 text-fuchsia-400" />
        <h3 className="text-sm font-semibold text-white/80">Taste DNA</h3>
      </div>

      <svg width={size} height={size} className="overflow-visible">
        {/* Grid rings */}
        {rings.map((scale, i) => {
          const ringPath = points
            .map((_, gi) => {
              const angle = (gi / count) * Math.PI * 2 - Math.PI / 2;
              const r = scale * maxR;
              return `${gi === 0 ? 'M' : 'L'} ${cx + Math.cos(angle) * r} ${cy + Math.sin(angle) * r}`;
            })
            .join(' ') + ' Z';
          return (
            <path key={i} d={ringPath} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
          );
        })}

        {/* Axis lines */}
        {points.map((_, i) => {
          const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
          return (
            <line
              key={i}
              x1={cx} y1={cy}
              x2={cx + Math.cos(angle) * maxR}
              y2={cy + Math.sin(angle) * maxR}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={1}
            />
          );
        })}

        {/* Filled polygon */}
        <motion.path
          d={polygonPath}
          fill="rgba(217,70,239,0.12)"
          stroke="rgba(217,70,239,0.6)"
          strokeWidth={1.5}
          initial={{ opacity: 0, scale: 0 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, delay: 0.4, ease: 'easeOut' }}
          style={{ transformOrigin: `${cx}px ${cy}px` }}
        />

        {/* Data points */}
        {points.map((p, i) => (
          <motion.circle
            key={i}
            cx={p.x} cy={p.y} r={3}
            fill="#d946ef"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.5 + i * 0.06, ...WAVE_SPRING }}
          />
        ))}

        {/* Labels — all 15 canonical genres; dim ones with no play */}
        {points.map((p, i) => (
          <text
            key={`label-${i}`}
            x={p.labelX}
            y={p.labelY}
            textAnchor="middle"
            dominantBaseline="middle"
            className={p.weight > 0 ? 'text-[8px] fill-white/50 font-medium select-none' : 'text-[7px] fill-white/25 select-none'}
          >
            {p.name}
          </text>
        ))}
      </svg>

      {/* Legend — genres you have play in */}
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-[10px] text-white/30 max-w-[320px]">
        {legendGenres.map((g) => (
          <span key={g.name}>
            <span className="text-fuchsia-400/70">{g.gameCount}</span> {g.name}
          </span>
        ))}
      </div>
    </motion.div>
  );
}

// ─── Empty / Cold Start State ──────────────────────────────────────────────────

function ColdStart({
  onSwitchToBrowse,
  libraryCount,
  candidateCount,
}: {
  onSwitchToBrowse: () => void;
  libraryCount: number;
  candidateCount: number;
}) {
  const needsLibrary = libraryCount < 3;
  const needsCandidates = candidateCount < 5;

  let title = 'The Oracle awaits';
  let message = '';
  let subtitle = '';

  if (needsLibrary && needsCandidates) {
    subtitle = 'Visions cannot form from nothing';
    message = 'The Oracle must first know you. Forge your library with games you\'ve conquered and explore the wider realm — only then can the threads of fate reveal what lies ahead.';
  } else if (needsLibrary) {
    subtitle = 'Your story is still unwritten';
    message = `The Oracle senses only ${libraryCount} tale${libraryCount !== 1 ? 's' : ''} in your chronicle. Inscribe more journeys into your library so the patterns of your destiny may emerge.`;
  } else if (needsCandidates) {
    subtitle = 'The scrying pool is empty';
    message = `${libraryCount} tales are etched in your chronicle — the Oracle knows your heart. But the realm beyond remains unseen. Venture into the catalog so the Oracle may gaze upon what awaits you.`;
  } else {
    subtitle = 'The stars are silent';
    message = 'The Oracle has searched the constellations but found no worthy paths — for now. Explore the catalog further and return. The visions will come.';
  }

  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[50vh] gap-4 text-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="flex flex-col items-center gap-4"
      >
        <div className="w-16 h-16 rounded-2xl bg-fuchsia-500/10 border border-fuchsia-500/20 flex items-center justify-center">
          <Eye className="w-8 h-8 text-fuchsia-400/50" />
        </div>
        <h3 className="text-lg font-semibold text-white/80">{title}</h3>
        {subtitle && (
          <p className="text-[11px] uppercase tracking-widest text-fuchsia-400/50 -mt-2">{subtitle}</p>
        )}
        <p className="text-sm text-white/40 max-w-sm leading-relaxed">{message}</p>
        <div className="flex items-center gap-2 text-[10px] text-white/20 mt-1">
          <span>{libraryCount} chronicle{libraryCount !== 1 ? 's' : ''} inscribed</span>
          <span>·</span>
          <span>{candidateCount} realm{candidateCount !== 1 ? 's' : ''} scouted</span>
        </div>
        <button
          onClick={onSwitchToBrowse}
          className="mt-2 px-4 py-2 text-xs font-medium bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30 rounded-lg hover:bg-fuchsia-500/30 transition-colors"
        >
          Explore the Realm
        </button>
      </motion.div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

export function OracleView({ onSwitchToBrowse }: { onSwitchToBrowse: () => void }) {
  const state = useRecoStore();
  const [, navigate] = useLocation();
  const hasTriggered = useRef(false);

  // If the store already has results (e.g. returning to the Oracle tab),
  // skip the initial animation and restore the embedding badge immediately.
  const alreadyDone = useRef(state.status === 'done');

  const [embeddingStatus, setEmbeddingStatus] = useState<'idle' | 'loading' | 'generating' | 'ready' | 'unavailable'>(() => {
    if (state.status === 'done') {
      return embeddingService.loadedCount > 0 ? 'ready' : 'unavailable';
    }
    // Restore from service if pipeline is mid-flight (e.g. navigated back)
    return embeddingService.libraryStatus;
  });
  const [embeddingProgress, setEmbeddingProgress] = useState<{ completed: number; total: number } | null>(() => {
    const s = embeddingService.libraryStatus;
    if (s === 'generating' && embeddingService.libraryProgress.total > 0) {
      return { ...embeddingService.libraryProgress };
    }
    return null;
  });
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set(recoHistoryStore.getDismissedIds()));
  const [dnaOpen, setDnaOpen] = useState(false);
  const [catalogSync, setCatalogSync] = useState<CatalogSyncProgress>(catalogStore.syncProgress);
  const [catalogEmbeddingProgress, setCatalogEmbeddingProgress] = useState<{ completed: number; total: number } | null>(
    () => embeddingService.isCatalogRunning ? { ...embeddingService.catalogProgress } : null,
  );
  

  // Subscribe to catalog sync + library/catalog embedding progress (survives unmount)
  useEffect(() => {
    const unsubCatalog = catalogStore.subscribe(() => setCatalogSync({ ...catalogStore.syncProgress }));
    const unsubEmbed = embeddingService.subscribe(() => {
      // Library embedding progress
      const ls = embeddingService.libraryStatus;
      setEmbeddingStatus(ls);
      if (ls === 'generating' && embeddingService.libraryProgress.total > 0) {
        setEmbeddingProgress({ ...embeddingService.libraryProgress });
      } else if (ls !== 'generating') {
        setEmbeddingProgress(null);
      }

      // Catalog embedding progress
      if (embeddingService.isCatalogRunning) {
        setCatalogEmbeddingProgress({ ...embeddingService.catalogProgress });
      } else {
        setCatalogEmbeddingProgress(null);
      }
    });
    return () => { unsubCatalog(); unsubEmbed(); };
  }, []);

  // Fire-and-forget: kick off catalog sync + embedding gen once pipeline is done.
  // The work runs in the singleton service and persists across page navigation.
  useEffect(() => {
    if (state.status !== 'done') return;
    startCatalogEmbeddingPipeline();
  }, [state.status]);

  // Load cached embeddings, generate missing ones via Ollama, then compute
  useEffect(() => {
    if (state.status === 'done') {
      hasTriggered.current = true;
      return;
    }
    if (!hasTriggered.current && state.status === 'idle') {
      hasTriggered.current = true;

      (async () => {
        setEmbeddingStatus('loading');
        setEmbeddingProgress(null);

        let cachedCount = 0;
        try {
          cachedCount = await embeddingService.loadCachedEmbeddings();
        } catch { /* ignore */ }

        if (cachedCount > 0) setEmbeddingStatus('ready');

        recoStore.compute(
          async (games) => {
            const available = await embeddingService.isAvailable();
            if (!available) {
              if (cachedCount === 0) setEmbeddingStatus('unavailable');
              return 0;
            }

            setEmbeddingStatus('generating');
            setEmbeddingProgress({ completed: 0, total: 0 });
            const generated = await embeddingService.generateMissing(games, (completed, total) => {
              setEmbeddingProgress({ completed, total });
            });
            setEmbeddingProgress(null);
            setEmbeddingStatus((generated > 0 || cachedCount > 0) ? 'ready' : 'unavailable');
            return generated;
          },
          (candidateIds) => embeddingService.enrichWithCatalogEmbeddings(candidateIds),
        );
      })();
    }
  }, [state.status]);

  const handleNavigate = useCallback((gameId: string) => {
    navigate(`/game/${gameId}`);
  }, [navigate]);

  const handleRefresh = useCallback(() => {
    hasTriggered.current = false;
    embeddingService.resetLibraryStatus();
    _pipelineStarted = false;
    recoStore.refresh();
  }, []);

  const handleDismiss = useCallback((gameId: string) => {
    recoHistoryStore.dismiss(gameId);
    setDismissedIds(new Set(recoHistoryStore.getDismissedIds()));
  }, []);

  // Filter dismissed games from shelves and apply bandit reordering
  const filterDismissed = (shelves: RecoShelf[]) =>
    shelves.map(s => ({
      ...s,
      games: s.games.filter(g => !dismissedIds.has(g.gameId)),
    })).filter(s => s.games.length > 0);

  const filteredShelves = filterDismissed(state.shelves);
  const heroShelf = filteredShelves.find(s => s.type === 'hero');
  const otherShelves = shelfBanditStore.reorderShelves(
    filteredShelves.filter(s => s.type !== 'hero'),
  );

  return (
    <div className="relative h-[calc(100vh-10rem)] overflow-hidden">
      <div className="h-full overflow-y-auto overflow-x-hidden scrollbar-hide">
      <AnimatePresence mode="wait" initial={!alreadyDone.current}>
        {/* Computing state — skeleton background + detailed progress overlay */}
        {state.status === 'computing' && (
          <motion.div
            key="computing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, filter: 'blur(6px)' }}
            transition={{ duration: 0.3 }}
            className="relative min-h-[calc(100vh-12rem)]"
          >
            {/* Skeleton layout as background — dimmed */}
            <div className="opacity-40">
              <OracleSkeleton />
            </div>

            {/* Detailed progress overlay on top */}
            <OracleLoadingOverlay
              stage={state.progress.stage}
              percent={state.progress.percent}
              libraryCount={state.libraryCount}
              candidateCount={state.candidateCount}
              embeddingStatus={embeddingStatus}
              embeddingProgress={embeddingProgress}
            />
          </motion.div>
        )}

        {/* Error state */}
        {state.status === 'error' && (
          <motion.div
            key="error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center h-[400px] gap-4"
          >
            <p className="text-sm text-red-400/70">{state.error}</p>
            <button
              onClick={handleRefresh}
              className="px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 text-white/60 rounded-lg transition-colors"
            >
              Try Again
            </button>
          </motion.div>
        )}

        {/* Results */}
        {state.status === 'done' && (
          <motion.div
            key="results"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
          >
            {/* Header with refresh + stats */}
            <div className="flex items-center justify-between mb-6 px-1">
              <div className="flex items-center gap-3">
                <Eye className="w-4 h-4 text-fuchsia-400/60" />
                <span className="text-xs text-white/30">
                  {state.shelves.reduce((s, shelf) => s + shelf.games.length, 0)} recommendations
                  {state.candidateCount > 0 && ` from ${state.candidateCount.toLocaleString()} candidates`}
                  {state.libraryCount > 0 && ` · ${state.libraryCount} in library`}
                  {state.computeTimeMs > 0 && ` · ${
                    state.computeTimeMs >= 60000
                      ? `${Math.floor(state.computeTimeMs / 60000)}m ${Math.round((state.computeTimeMs % 60000) / 1000)}s`
                      : state.computeTimeMs >= 1000
                        ? `${(state.computeTimeMs / 1000).toFixed(1)}s`
                        : `${state.computeTimeMs}ms`
                  }`}
                </span>
                {embeddingStatus === 'ready' && (
                  <span className="flex items-center gap-1 text-xs text-emerald-400/50">
                    <Brain className="w-4 h-4" />
                    Semantic
                  </span>
                )}
                {(catalogSync.stage === 'fetching-ids' || catalogSync.stage === 'fetching-tags') && (
                  <span className="flex items-center gap-1 text-[9px] text-cyan-400/40">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {catalogSync.stage === 'fetching-ids' ? 'Fetching Steam catalog...' : 'Resolving tags...'}
                  </span>
                )}
                {catalogSync.stage === 'fetching-metadata' && catalogSync.batchesTotal > 0 && (
                  <span className="flex items-center gap-1 text-[9px] text-cyan-400/40">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Syncing catalog {Math.round((catalogSync.batchesCompleted / catalogSync.batchesTotal) * 100)}%
                  </span>
                )}
                {catalogSync.stage === 'done' && catalogEmbeddingProgress && catalogEmbeddingProgress.total > 0 && (
                  <span className="flex items-center gap-1 text-xs text-fuchsia-400/50">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Updating Taste DNA {Math.round((catalogEmbeddingProgress.completed / catalogEmbeddingProgress.total) * 100)}%
                  </span>
                )}
                {catalogSync.stage === 'done' && !catalogEmbeddingProgress && catalogSync.gamesStored > 0 && (
                  <span className="flex items-center gap-1 text-xs text-cyan-400/50">
                    <Globe className="w-4 h-4" />
                    {catalogSync.gamesStored.toLocaleString()} Steam
                  </span>
                )}
                {catalogSync.stage === 'error' && (
                  <span className="flex items-center gap-1 text-[9px] text-red-400/40" title={catalogSync.error}>
                    <X className="w-3 h-3" />
                    Catalog sync failed
                  </span>
                )}
                {dismissedIds.size > 0 && (
                  <span className="text-[9px] text-white/20">
                    {dismissedIds.size} dismissed
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={handleRefresh}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] text-white/30 hover:text-fuchsia-400 hover:bg-white/5 rounded-md transition-colors"
                >
                  <AnimateIcon hover="spin"><RefreshCw className="w-3 h-3" /></AnimateIcon>
                  Refresh
                </button>
              </div>
            </div>

            {/* Hero card */}
            {heroShelf && heroShelf.games[0] && (
              <HeroCard game={heroShelf.games[0]} onNavigate={handleNavigate} />
            )}

            {/* Shelves */}
            <div>
              {otherShelves.length > 0 ? (
                otherShelves.map((shelf, idx) => (
                  <ShelfCarousel
                    key={`${shelf.type}-${shelf.seedGameTitle || ''}-${idx}`}
                    shelf={shelf}
                    onDismiss={handleDismiss}
                  />
                ))
              ) : (
                <ColdStart
                  onSwitchToBrowse={onSwitchToBrowse}
                  libraryCount={state.libraryCount}
                  candidateCount={state.candidateCount}
                />
              )}
            </div>
          </motion.div>
        )}

        {/* Idle — brief transitional state before useEffect triggers compute */}
        {state.status === 'idle' && (
          <motion.div
            key="idle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="opacity-40"
          >
            <OracleSkeleton />
          </motion.div>
        )}
      </AnimatePresence>
      </div>

      {/* Taste DNA collapsible right panel */}
      {state.status === 'done' && state.tasteProfile && state.tasteProfile.genres.length >= 3 && (
        <>
          {/* Toggle tab — vertical bookmark on right edge */}
          <button
            onClick={() => setDnaOpen(v => !v)}
            className={cn(
              'absolute z-40 right-0 top-1/3 transition-all duration-300 cursor-pointer',
              dnaOpen
                ? 'translate-x-full opacity-0 pointer-events-none'
                : 'flex flex-col items-center gap-1.5 px-1.5 py-3 rounded-l-lg bg-fuchsia-500/15 border border-r-0 border-fuchsia-500/25 text-fuchsia-400 hover:bg-fuchsia-500/25 backdrop-blur-sm',
            )}
          >
            <Zap className="w-3.5 h-3.5" />
            <span className="text-[9px] font-bold tracking-wider" style={{ writingMode: 'vertical-rl' }}>
              TASTE DNA
            </span>
          </button>

          {/* Slide-out panel */}
          <AnimatePresence>
            {dnaOpen && (
              <motion.div
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                className="absolute right-0 top-0 bottom-0 w-[310px] z-30 overflow-y-auto scrollbar-hide bg-black/90 backdrop-blur-xl border-l border-white/[0.08] shadow-2xl shadow-black/60"
              >
                {/* Sticky header with close */}
                <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 bg-black/80 backdrop-blur-md border-b border-white/[0.06]">
                  <div className="flex items-center gap-2">
                    <Zap className="w-3.5 h-3.5 text-fuchsia-400" />
                    <span className="text-xs font-semibold text-white/70">Taste DNA</span>
                  </div>
                  <button
                    onClick={() => setDnaOpen(false)}
                    className="p-1 rounded-md text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                <TasteDNA profile={state.tasteProfile} />

                {/* Quick stats */}
                <div className="flex flex-col gap-2 px-4 pb-2">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-white/30">Games Analyzed</span>
                    <span className="text-fuchsia-400/70 font-medium">{state.tasteProfile.totalGames}</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-white/30">Total Hours</span>
                    <span className="text-fuchsia-400/70 font-medium">{formatHours(state.tasteProfile.totalHours)}</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-white/30">Avg Rating</span>
                    <span className="text-fuchsia-400/70 font-medium">
                      {state.tasteProfile.avgRating > 0 ? state.tasteProfile.avgRating.toFixed(1) : '—'} / 5
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-white/30">Top Genre</span>
                    <span className="text-fuchsia-400/70 font-medium capitalize">{state.tasteProfile.topGenre || '—'}</span>
                  </div>
                </div>

                {/* Taste Clusters */}
                {state.tasteProfile.clusters.length > 0 && (
                  <div className="mx-4 mt-3 pt-4 border-t border-white/[0.06]">
                    <h4 className="text-[10px] uppercase tracking-widest text-white/25 font-semibold mb-3">Taste Clusters</h4>
                    <div className="space-y-2">
                      {state.tasteProfile.clusters.map(cluster => (
                        <div key={cluster.id} className="flex items-center justify-between text-[10px]">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-fuchsia-400/60" />
                            <span className="text-white/50 capitalize">{cluster.label}</span>
                          </div>
                          <span className="text-white/25">{cluster.gameCount} games</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Loyal Studios */}
                {state.tasteProfile.loyalDevelopers && state.tasteProfile.loyalDevelopers.length > 0 && (
                  <div className="mx-4 mt-4 pt-4 pb-6 border-t border-white/[0.06]">
                    <h4 className="text-[10px] uppercase tracking-widest text-white/25 font-semibold mb-3">Loyal Studios</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {state.tasteProfile.loyalDevelopers.slice(0, 6).map(dev => (
                        <span key={dev} className="text-[9px] px-2 py-0.5 rounded-full border border-purple-500/30 text-purple-400/70 capitalize">
                          {dev}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}
