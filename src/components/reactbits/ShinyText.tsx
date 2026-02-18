/**
 * ShinyText — Adapted from ReactBits (MIT + Commons Clause)
 * https://github.com/DavidHDev/react-bits
 *
 * Text with an animated shine / highlight sweep.
 */
import React, { useRef, useCallback } from 'react';
import { motion, useMotionValue, useTransform } from 'framer-motion';

interface ShinyTextProps {
  text: string;
  disabled?: boolean;
  speed?: number;
  className?: string;
  color?: string;
  shineColor?: string;
  spread?: number;
}

const ShinyText: React.FC<ShinyTextProps> = ({
  text,
  disabled = false,
  speed = 2,
  className = '',
  color = '#b5b5b5',
  shineColor = '#ffffff',
  spread = 120,
}) => {
  const progress = useMotionValue(0);
  const elapsedRef = useRef(0);
  const lastTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number>();

  const animationDuration = speed * 1000;

  const startAnimation = useCallback(
    (node: HTMLSpanElement | null) => {
      if (!node || disabled) {
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

        const cycleTime = elapsedRef.current % animationDuration;
        const p = (cycleTime / animationDuration) * 100;
        progress.set(p);

        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    },
    [animationDuration, disabled, progress],
  );

  const backgroundPosition = useTransform(progress, (p) => `${150 - p * 2}% center`);

  const gradientStyle: React.CSSProperties = {
    backgroundImage: `linear-gradient(${spread}deg, ${color} 0%, ${color} 35%, ${shineColor} 50%, ${color} 65%, ${color} 100%)`,
    backgroundSize: '200% auto',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  };

  return (
    <motion.span
      ref={startAnimation}
      className={className}
      style={{ ...gradientStyle, backgroundPosition } as any}
    >
      {text}
    </motion.span>
  );
};

export default ShinyText;
