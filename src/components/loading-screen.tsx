import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Hyperspeed from '@/components/Hyperspeed/Hyperspeed';
import { Terminal } from '@/components/ui/terminal';
import { libraryStore } from '@/services/library-store';
import { journeyStore } from '@/services/journey-store';
import { customGameStore } from '@/services/custom-game-store';
import {
  getCachedBrowseData,
  prefetchBrowseData,
  isPrefetchReady,
  getPrefetchedGames,
  type PrefetchProgress,
} from '@/services/prefetch-store';
import { ErrorBoundary } from '@/components/error-boundary';
import { cn } from '@/lib/utils';

interface LoadingScreenProps {
  onComplete: () => void;
  duration?: number; // minimum display time
}

/** A single status line in the terminal log. */
interface LogLine {
  text: string;
  type: 'command' | 'info' | 'success' | 'warn' | 'ready';
}

/** Renders a single log line with appropriate styling and fade-in. */
function LogEntry({ line }: { line: LogLine }) {
  return (
    <motion.span
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className={cn(
        'block font-mono text-sm leading-relaxed',
        line.type === 'command' && 'text-white/80',
        line.type === 'info' && 'text-white/50',
        line.type === 'success' && 'text-cyan-400',
        line.type === 'warn' && 'text-amber-400',
        line.type === 'ready' && 'text-fuchsia-400 font-semibold',
      )}
    >
      {line.text}
    </motion.span>
  );
}

export function LoadingScreen({ onComplete, duration = 2500 }: LoadingScreenProps) {
  const [isVisible, setIsVisible] = useState(true);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [progress, setProgress] = useState(0); // 0..1
  const hasCompletedRef = useRef(false);
  const startTimeRef = useRef(Date.now());

  // Stable ref for onComplete so the effect doesn't re-run
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  const prefersReducedMotion =
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;

  /** Append a line to the terminal. Returns a small delay promise for visual pacing. */
  const log = useCallback((text: string, type: LogLine['type'] = 'info') => {
    setLines(prev => [...prev, { text, type }]);
    // Small stagger so lines appear one-by-one (kept snappy to avoid slowing boot)
    return new Promise<void>(r => setTimeout(r, prefersReducedMotion ? 5 : 60));
  }, [prefersReducedMotion]);

  /** Finish the loading screen — respects minimum display time. */
  const finish = useCallback(() => {
    if (hasCompletedRef.current) return;
    hasCompletedRef.current = true;

    setProgress(1);
    const elapsed = Date.now() - startTimeRef.current;
    const minDisplay = prefersReducedMotion ? 400 : duration;
    const remaining = Math.max(0, minDisplay - elapsed);

    setTimeout(() => {
      setIsVisible(false);
      setTimeout(() => onCompleteRef.current(), 300);
    }, remaining);
  }, [duration, prefersReducedMotion]);

  // Run the actual initialization sequence on mount.
  // Reset lines to prevent duplicates (React 18 strict mode runs effects twice).
  useEffect(() => {
    let cancelled = false;
    setLines([]);
    setProgress(0);

    const run = async () => {
      // --- 1. Boot ---
      await log('$ ark init --boot', 'command');
      if (cancelled) return;
      await log('Initializing Ark engine...');
      if (cancelled) return;

      // --- 2. Local stores ---
      const libCount = libraryStore.getSize();
      const customCount = customGameStore.getCount();
      const journeyCount = journeyStore.getSize();
      const totalLocal = libCount + customCount;

      await log(`✓ Library loaded — ${libCount} game${libCount !== 1 ? 's' : ''} tracked`, 'success');

      if (customCount > 0) {
        await log(`  + ${customCount} custom game${customCount !== 1 ? 's' : ''}`, 'success');
      }
      if (journeyCount > 0) {
        await log(`✓ Journey history — ${journeyCount} entr${journeyCount !== 1 ? 'ies' : 'y'} loaded`, 'success');
      }

      // --- 3. Store connections + data prefetch (parallelized) ---
      if (cancelled) return;
      const steamAvailable = typeof window !== 'undefined' && !!window.steam;
      const epicAvailable = typeof window !== 'undefined' && !!window.epic;

      // Check if splash screen already loaded data into memory
      const alreadyPrefetched = isPrefetchReady();
      const prefetchedGames = alreadyPrefetched ? getPrefetchedGames() : null;

      if (alreadyPrefetched && prefetchedGames) {
        // Data was loaded during the splash screen — fast-forward!
        setProgress(1);
        await log(`✓ Data pre-loaded during cold boot — ${prefetchedGames.length} games in memory`, 'success');

        if (steamAvailable) {
          await log('✓ Steam API connected', 'success');
        }
        if (epicAvailable) {
          await log('✓ Epic Games API connected', 'success');
        }
      } else {
        // Data not yet ready — do the full fetch here (splash didn't finish in time)

        // Fire cache stats + browse data prefetch in parallel.
        const cacheStatsPromise = Promise.allSettled([
          steamAvailable ? window.steam!.getCacheStats().catch(() => null) : Promise.resolve(null),
          epicAvailable ? window.epic!.getCacheStats().catch(() => null) : Promise.resolve(null),
        ]);
        const browseDataPromise = getCachedBrowseData();

        // Log store connections while data loads in the background
        if (steamAvailable) {
          await log('✓ Steam API connected', 'success');
        } else {
          await log('⚠ Steam API not available (running outside Electron?)', 'warn');
        }
        if (epicAvailable) {
          await log('✓ Epic Games API connected', 'success');
        }

        // Await cache stats (should be fast) and display results
        const [steamStats, epicStats] = await cacheStatsPromise;
        if (steamStats.status === 'fulfilled' && steamStats.value && (steamStats.value as any).total > 0) {
          const s = steamStats.value as { total: number; fresh: number; stale: number };
          await log(`  Steam: ${s.total} cached (${s.fresh} fresh, ${s.stale} stale)`, 'info');
        }
        if (epicStats.status === 'fulfilled' && epicStats.value && (epicStats.value as any).total > 0) {
          const s = epicStats.value as { total: number; fresh: number; stale: number };
          await log(`  Epic: ${s.total} cached (${s.fresh} fresh, ${s.stale} stale)`, 'info');
        }

        // --- 4. Data prefetch ---
        if (cancelled) return;
        const cached = await browseDataPromise;

        if (cached) {
          // Cache hit — instant
          setProgress(1);
          const freshLabel = cached.isFresh ? 'fresh' : 'stale';
          await log(
            `✓ Loaded ${cached.games.length} games from cache (${freshLabel})`,
            'success',
          );

          if (!cached.isFresh) {
            await log('  Data will refresh silently in the background', 'info');
          }
        } else {
          // Cache miss — first launch or expired cache. Do a full fetch with progress.
          await log('First launch — fetching game catalogs...', 'info');

          if (cancelled) return;

          const handleProgress = (p: PrefetchProgress) => {
            if (cancelled) return;
            setProgress(p.current / p.total);
          };

          try {
            // This is the heavy lift: 6 parallel API calls + dedup
            // If the splash already started this, prefetchBrowseData() will share the same promise
            const games = await prefetchBrowseData(handleProgress);

            if (cancelled) return;
            setProgress(1);
            await log(
              `✓ Aggregation complete — ${games.length} unique games ready`,
              'success',
            );
          } catch (err) {
            if (cancelled) return;
            console.error('[LoadingScreen] Prefetch failed:', err);
            await log('⚠ Some game sources failed — partial data available', 'warn');
          }
        }
      }

      // --- 5. Done ---
      if (cancelled) return;
      if (totalLocal > 0) {
        await log(`✓ ${totalLocal} game${totalLocal !== 1 ? 's' : ''} in library`, 'success');
      }
      await log('');
      await log('🎮 Ark ready — launching', 'ready');

      finish();
    };

    // Timeout safety: finish after 45s no matter what (Epic catalog can be large)
    const safetyTimeout = setTimeout(() => {
      if (!hasCompletedRef.current) {
        console.warn('[LoadingScreen] Safety timeout — finishing with partial data');
        finish();
      }
    }, 45_000);

    run().catch(() => finish());

    return () => {
      cancelled = true;
      clearTimeout(safetyTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: prefersReducedMotion ? 0.1 : 0.3 }}
          className="fixed inset-0 z-[9999] bg-black"
        >
          {/* Hyperspeed animated background — fallback to gradient if WebGL unavailable */}
          {!prefersReducedMotion && (
            <ErrorBoundary
              fallback={
                <div className="absolute inset-0 bg-gradient-to-b from-zinc-950 via-zinc-900 to-black" />
              }
            >
              <Hyperspeed
                effectOptions={{
                  distortion: 'turbulentDistortion',
                  length: 400,
                  roadWidth: 10,
                  islandWidth: 2,
                  lanesPerRoad: 3,
                  fov: 90,
                  fovSpeedUp: 150,
                  speedUp: 2,
                  carLightsFade: 0.4,
                  totalSideLightSticks: 20,
                  lightPairsPerRoadWay: 40,
                  shoulderLinesWidthPercentage: 0.05,
                  brokenLinesWidthPercentage: 0.1,
                  brokenLinesLengthPercentage: 0.5,
                  lightStickWidth: [0.12, 0.5],
                  lightStickHeight: [1.3, 1.7],
                  movingAwaySpeed: [60, 80],
                  movingCloserSpeed: [-120, -160],
                  carLightsLength: [400 * 0.03, 400 * 0.2],
                  carLightsRadius: [0.05, 0.14],
                  carWidthPercentage: [0.3, 0.5],
                  carShiftX: [-0.8, 0.8],
                  carFloorSeparation: [0, 5],
                  colors: {
                    roadColor: 0x080808,
                    islandColor: 0x0a0a0a,
                    background: 0x000000,
                    shoulderLines: 0x131318,
                    brokenLines: 0x131318,
                    leftCars: [0xd856bf, 0x6750a2, 0xc247ac],
                    rightCars: [0x03b3c3, 0x0e5ea5, 0x324555],
                    sticks: 0x03b3c3,
                  },
                }}
              />
            </ErrorBoundary>
          )}

          {/* Centered Terminal */}
          <div className="absolute inset-0 flex items-center justify-center p-4 z-10">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="w-full max-w-2xl"
            >
              <Terminal className="border border-white/10 backdrop-blur-md">
                {lines.map((line, i) => (
                  <LogEntry key={i} line={line} />
                ))}
                {/* Blinking cursor at the end */}
                {lines.length > 0 && !hasCompletedRef.current && (
                  <span className="inline-block w-2 h-4 bg-white/60 animate-pulse ml-0.5" />
                )}

                {/* Progress bar — visible during data fetching */}
                {progress > 0 && progress < 1 && (
                  <div className="mt-3 h-1 w-full rounded-full bg-white/10 overflow-hidden">
                    <motion.div
                      className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-fuchsia-500"
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.round(progress * 100)}%` }}
                      transition={{ duration: 0.4, ease: 'easeOut' }}
                    />
                  </div>
                )}
              </Terminal>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
