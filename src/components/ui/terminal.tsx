import { cn } from '@/lib/utils';
import { motion, MotionProps } from 'framer-motion';
import { useEffect, useState } from 'react';

interface AnimatedSpanProps extends MotionProps {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}

export const AnimatedSpan = ({
  children,
  delay = 0,
  className,
  ...props
}: AnimatedSpanProps) => (
  <motion.span
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    transition={{ duration: 0.2, delay: delay / 1000 }}
    className={cn('block font-mono text-sm leading-tight', className)}
    {...props}
  >
    {children}
  </motion.span>
);

interface TypingAnimationProps extends MotionProps {
  children: string;
  className?: string;
  duration?: number;
  delay?: number;
}

export const TypingAnimation = ({
  children,
  className,
  duration = 60,
  delay = 0,
  ...props
}: TypingAnimationProps) => {
  const [displayedText, setDisplayedText] = useState('');
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const startTimeout = setTimeout(() => setStarted(true), delay);
    return () => clearTimeout(startTimeout);
  }, [delay]);

  useEffect(() => {
    if (!started) return;
    let i = 0;
    const typingEffect = setInterval(() => {
      if (i < children.length) {
        setDisplayedText(children.substring(0, i + 1));
        i++;
      } else {
        clearInterval(typingEffect);
      }
    }, duration);
    return () => clearInterval(typingEffect);
  }, [children, duration, started]);

  return (
    <motion.span
      className={cn('block font-mono text-sm leading-tight', className)}
      {...props}
    >
      {displayedText}
    </motion.span>
  );
};

interface TerminalProps {
  children: React.ReactNode;
  className?: string;
}

export const Terminal = ({ children, className }: TerminalProps) => {
  return (
    <div
      className={cn(
        'z-10 w-full rounded-xl border',
        'border-white/20 dark:border-white/10',
        'bg-black/40 dark:bg-black/60',
        'backdrop-blur-xl shadow-2xl',
        'h-[400px] flex flex-col overflow-hidden',
        className
      )}
    >
      <div className="flex flex-col gap-y-1 border-b border-white/20 dark:border-white/10 px-4 py-2 flex-shrink-0">
        <div className="flex flex-row gap-x-2">
          <div className="h-2.5 w-2.5 rounded-full bg-red-500" />
          <div className="h-2.5 w-2.5 rounded-full bg-yellow-500" />
          <div className="h-2.5 w-2.5 rounded-full bg-green-500" />
        </div>
      </div>
      <pre className="flex-1 overflow-y-auto p-4 m-0">
        <code className="block space-y-0.5 text-white font-mono text-sm leading-tight">
          {children}
        </code>
      </pre>
    </div>
  );
};

