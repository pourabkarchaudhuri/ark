import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Hyperspeed from '@/components/Hyperspeed/Hyperspeed';
import { Terminal, AnimatedSpan, TypingAnimation } from '@/components/ui/terminal';
import { libraryStore } from '@/services/library-store';

interface LoadingScreenProps {
  onComplete: () => void;
  duration?: number;
}

export function LoadingScreen({ onComplete, duration = 6000 }: LoadingScreenProps) {
  const [isVisible, setIsVisible] = useState(true);
  const [libraryCount, setLibraryCount] = useState(0);
  
  // Use ref to store the callback to avoid timer reset when onComplete reference changes
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  // Fetch library count on mount
  useEffect(() => {
    setLibraryCount(libraryStore.getSize());
  }, []);

  const prefersReducedMotion =
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;

  const actualDuration = prefersReducedMotion ? 500 : duration;

  // Auto-complete after duration - uses ref to avoid resetting timer
  useEffect(() => {
    let fadeOutTimer: ReturnType<typeof setTimeout> | null = null;
    
    const timer = setTimeout(() => {
      setIsVisible(false);
      fadeOutTimer = setTimeout(() => onCompleteRef.current(), 300);
    }, actualDuration);

    return () => {
      clearTimeout(timer);
      if (fadeOutTimer) clearTimeout(fadeOutTimer);
    };
  }, [actualDuration]);

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: prefersReducedMotion ? 0.1 : 0.3 }}
          className="fixed inset-0 z-50 bg-black"
        >
          {/* Hyperspeed animated background */}
          {!prefersReducedMotion && (
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
                  sticks: 0x03b3c3
                }
              }}
            />
          )}

          {/* Centered Terminal - Fixed size */}
          <div className="absolute inset-0 flex items-center justify-center p-4 z-10">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="w-full max-w-2xl"
            >
              <Terminal className="border border-white/10 backdrop-blur-md">
                <AnimatedSpan delay={0}>$ gametracker init --database</AnimatedSpan>
                <TypingAnimation delay={400} duration={30}>
                  Initializing game database...
                </TypingAnimation>
                <AnimatedSpan delay={1200} className="text-cyan-400">
                  ✓ Game library loaded
                </AnimatedSpan>
                <AnimatedSpan delay={1600} className="text-cyan-400">
                  ✓ {libraryCount} game{libraryCount !== 1 ? 's' : ''} in your library
                </AnimatedSpan>
                <AnimatedSpan delay={2000} className="text-cyan-400">
                  ✓ Recommendations ready
                </AnimatedSpan>
                <TypingAnimation delay={2600} duration={30}>
                  Building dashboard...
                </TypingAnimation>
                <AnimatedSpan delay={3600} className="text-fuchsia-400">
                  🎮 Game Tracker ready
                </AnimatedSpan>
              </Terminal>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
