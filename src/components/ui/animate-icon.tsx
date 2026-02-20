import { useRef, useCallback, type ReactNode } from 'react';
import { motion, type TargetAndTransition } from 'framer-motion';
import { cn } from '@/lib/utils';

// ─── Hover animation presets ───────────────────────────────────────────────────

const hoverPresets: Record<string, TargetAndTransition> = {
  spin:    { rotate: 180, transition: { duration: 0.35, ease: 'easeInOut' } },
  sparkle: { rotate: [0, -5, 5, -3, 0], scale: [1, 1.18, 1.05, 1.12, 1], transition: { duration: 0.5 } },
  wiggle:  { rotate: [0, -8, 8, -4, 0], transition: { duration: 0.4 } },
  swing:   { rotate: [0, 12, -8, 5, 0], transition: { duration: 0.5 } },
  pulse:   { scale: [1, 1.15, 1], transition: { duration: 0.35 } },
  lift:    { y: -2, transition: { type: 'spring', stiffness: 400, damping: 17 } },
  float:   { y: [0, -3, 0], transition: { duration: 0.4, ease: 'easeInOut' } },
  'float-up': { y: [0, -3, 0], transition: { duration: 0.4, ease: 'easeInOut' } },
  shrink:  { scale: 0.85, transition: { type: 'spring', stiffness: 400, damping: 17 } },
};

// ─── Tap animation presets ─────────────────────────────────────────────────────

const tapPresets: Record<string, TargetAndTransition> = {
  beat:  { scale: 1.3, transition: { type: 'spring', stiffness: 500, damping: 15 } },
  pop:   { scale: 0.85, transition: { type: 'spring', stiffness: 500, damping: 15 } },
  send:  { x: 3, rotate: -10, transition: { type: 'spring', stiffness: 500, damping: 15 } },
  spin:  { rotate: 90, transition: { duration: 0.25, ease: 'easeInOut' } },
};

// ─── AnimateIcon ───────────────────────────────────────────────────────────────

interface AnimateIconProps {
  children: ReactNode;
  className?: string;
  hover?: keyof typeof hoverPresets;
  tap?: keyof typeof tapPresets;
}

export function AnimateIcon({ children, className, hover, tap }: AnimateIconProps) {
  return (
    <motion.span
      className={cn('inline-flex items-center justify-center', className)}
      whileHover={hover ? hoverPresets[hover] : undefined}
      whileTap={tap ? tapPresets[tap] : undefined}
    >
      {children}
    </motion.span>
  );
}

// ─── MagneticWrap ──────────────────────────────────────────────────────────────

interface MagneticWrapProps {
  children: ReactNode;
  className?: string;
  strength?: number;
}

export function MagneticWrap({ children, className, strength = 0.3 }: MagneticWrapProps) {
  const ref = useRef<HTMLDivElement>(null);

  const onMove = useCallback((e: React.MouseEvent) => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    ref.current.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * strength}px, ${(e.clientY - r.top - r.height / 2) * strength}px)`;
  }, [strength]);

  const onLeave = useCallback(() => {
    if (ref.current) ref.current.style.transform = '';
  }, []);

  return (
    <div
      ref={ref}
      className={cn('transition-transform duration-200 ease-out', className)}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      {children}
    </div>
  );
}
