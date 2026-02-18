/**
 * GradientText — Adapted from ReactBits (MIT + Commons Clause)
 * https://github.com/DavidHDev/react-bits
 *
 * Animated gradient text with configurable colors and speed.
 */
import { ReactNode, useRef, useCallback } from 'react';
import { motion, useMotionValue, useTransform } from 'framer-motion';

interface GradientTextProps {
  children: ReactNode;
  className?: string;
  colors?: string[];
  animationSpeed?: number;
  showBorder?: boolean;
}

export default function GradientText({
  children,
  className = '',
  colors = ['#5227FF', '#FF9FFC', '#B19EEF'],
  animationSpeed = 8,
  showBorder = false,
}: GradientTextProps) {
  const progress = useMotionValue(0);
  const elapsedRef = useRef(0);
  const lastTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number>();

  const animationDuration = animationSpeed * 1000;

  const startAnimation = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        return;
      }
      const loop = (time: number) => {
        if (lastTimeRef.current === null) {
          lastTimeRef.current = time;
          rafRef.current = requestAnimationFrame(loop);
          return;
        }
        const dt = time - lastTimeRef.current;
        lastTimeRef.current = time;
        elapsedRef.current += dt;

        const fullCycle = animationDuration * 2;
        const cycleTime = elapsedRef.current % fullCycle;
        if (cycleTime < animationDuration) {
          progress.set((cycleTime / animationDuration) * 100);
        } else {
          progress.set(100 - ((cycleTime - animationDuration) / animationDuration) * 100);
        }
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    },
    [animationDuration, progress],
  );

  const backgroundPosition = useTransform(progress, (p) => `${p}% 50%`);

  const gradientColors = [...colors, colors[0]].join(', ');
  const gradientStyle = {
    backgroundImage: `linear-gradient(to right, ${gradientColors})`,
    backgroundSize: '300% 100%',
    backgroundRepeat: 'repeat' as const,
  };

  return (
    <div ref={startAnimation} className={`relative inline-block ${className}`}>
      {showBorder && (
        <motion.div
          className="absolute -inset-[2px] rounded-lg z-0"
          style={{ ...gradientStyle, backgroundPosition }}
        >
          <div className="absolute inset-[2px] bg-black rounded-lg" />
        </motion.div>
      )}
      <motion.span
        className="relative z-10 bg-clip-text text-transparent"
        style={{ ...gradientStyle, backgroundPosition, WebkitBackgroundClip: 'text' }}
      >
        {children}
      </motion.span>
    </div>
  );
}
