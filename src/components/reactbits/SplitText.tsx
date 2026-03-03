/**
 * SplitText — Adapted from ReactBits (MIT + Commons Clause)
 * https://github.com/DavidHDev/react-bits
 *
 * Character-by-character spring-physics text reveal.
 */
import { motion } from 'framer-motion';

interface SplitTextProps {
  text: string;
  className?: string;
  delay?: number;
  startWhen?: boolean;
  animateBy?: 'words' | 'letters';
}

export default function SplitText({
  text,
  className = '',
  delay = 30,
  startWhen = true,
  animateBy = 'letters',
}: SplitTextProps) {
  const segments = animateBy === 'words' ? text.split(' ') : text.split('');

  return (
    <span className={className} style={{ display: 'inline-flex', flexWrap: 'wrap' }}>
      {segments.map((char, i) => (
        <motion.span
          key={`${char}-${i}`}
          initial={{ opacity: 0, y: 40, rotateX: -90, scale: 0.8 }}
          animate={
            startWhen
              ? { opacity: 1, y: 0, rotateX: 0, scale: 1 }
              : { opacity: 0, y: 40, rotateX: -90, scale: 0.8 }
          }
          transition={{
            delay: (i * delay) / 1000,
            type: 'spring',
            damping: 12,
            stiffness: 200,
          }}
          style={{ display: 'inline-block', transformOrigin: 'bottom' }}
        >
          {char === ' ' ? '\u00A0' : char}
          {animateBy === 'words' && i < segments.length - 1 && '\u00A0'}
        </motion.span>
      ))}
    </span>
  );
}
