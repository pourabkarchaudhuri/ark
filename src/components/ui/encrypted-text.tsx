import { useEffect, useRef } from 'react';
import { useInView } from 'framer-motion';
import { cn } from '@/lib/utils';

type EncryptedTextProps = {
  text: string;
  className?: string;
  /**
   * Time in ms between revealing each subsequent real character.
   * Lower = faster. Defaults to 50.
   */
  revealDelayMs?: number;
  /** Custom character set for the scramble effect. */
  charset?: string;
  /**
   * Time in ms between gibberish flips for unrevealed characters.
   * Lower = more jittery. Defaults to 50.
   */
  flipDelayMs?: number;
  encryptedClassName?: string;
  revealedClassName?: string;
};

const DEFAULT_CHARSET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-={}[];:,.<>/?';

function randomChar(charset: string): string {
  return charset.charAt(Math.floor(Math.random() * charset.length));
}

/**
 * Scramble-reveal text effect driven entirely by direct DOM writes —
 * no React state updates during animation, so zero re-renders per frame.
 * Uses two sibling <span>s (revealed + encrypted) instead of per-character elements.
 */
export function EncryptedText({
  text,
  className,
  revealDelayMs = 50,
  charset = DEFAULT_CHARSET,
  flipDelayMs = 50,
  encryptedClassName,
  revealedClassName,
}: EncryptedTextProps) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const isInView = useInView(containerRef, { once: true });

  useEffect(() => {
    if (!isInView || !text) return;
    const el = containerRef.current;
    if (!el) return;

    const revealedSpan = el.children[0] as HTMLSpanElement;
    const encryptedSpan = el.children[1] as HTMLSpanElement;
    if (!revealedSpan || !encryptedSpan) return;

    const len = text.length;
    const scrambled = new Array<string>(len);
    for (let i = 0; i < len; i++) {
      scrambled[i] = text[i] === ' ' ? ' ' : randomChar(charset);
    }

    revealedSpan.textContent = '';
    encryptedSpan.textContent = scrambled.join('');

    let prevRevealed = 0;
    let cancelled = false;
    const t0 = performance.now();
    let lastFlip = t0;
    let rafId = 0;

    const tick = (now: number) => {
      if (cancelled) return;

      const elapsed = now - t0;
      const revealed = Math.min(len, Math.floor(elapsed / Math.max(1, revealDelayMs)));

      if (revealed !== prevRevealed) {
        revealedSpan.textContent = text.slice(0, revealed);
        prevRevealed = revealed;
      }

      if (revealed >= len) {
        encryptedSpan.textContent = '';
        return;
      }

      if (now - lastFlip >= flipDelayMs) {
        for (let i = revealed; i < len; i++) {
          scrambled[i] = text[i] === ' ' ? ' ' : randomChar(charset);
        }
        encryptedSpan.textContent = scrambled.slice(revealed).join('');
        lastFlip = now;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [isInView, text, revealDelayMs, charset, flipDelayMs]);

  if (!text) return null;

  return (
    <span ref={containerRef} className={cn(className)} aria-label={text} role="text">
      <span className={revealedClassName}>{text}</span>
      <span className={encryptedClassName} />
    </span>
  );
}
