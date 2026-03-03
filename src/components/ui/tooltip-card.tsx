import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';

export function TooltipCard({
  content,
  children,
  containerClassName,
}: {
  content: string | React.ReactNode;
  children: React.ReactNode;
  containerClassName?: string;
}) {
  const [isVisible, setIsVisible] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const contentRef = useRef<HTMLDivElement>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPosRef = useRef({ x: 0, y: 0 });

  const computePosition = useCallback((clientX: number, clientY: number) => {
    const tooltipW = 240;
    const tooltipH = contentRef.current?.scrollHeight ?? 60;
    const pad = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = clientX + pad;
    let y = clientY + pad;

    if (x + tooltipW > vw) x = clientX - tooltipW - pad;
    if (x < 0) x = pad;
    if (y + tooltipH > vh) y = clientY - tooltipH - pad;
    if (y < 0) y = pad;

    return { x, y };
  }, []);

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent) => {
      if (showTimerRef.current) clearTimeout(showTimerRef.current);
      pendingPosRef.current = computePosition(e.clientX, e.clientY);
      showTimerRef.current = setTimeout(() => {
        setPos(pendingPosRef.current);
        setIsVisible(true);
        showTimerRef.current = null;
      }, 2000);
    },
    [computePosition],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const p = computePosition(e.clientX, e.clientY);
      pendingPosRef.current = p;
      if (isVisible) setPos(p);
    },
    [isVisible, computePosition],
  );

  const handleMouseLeave = useCallback(() => {
    if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
    setIsVisible(false);
  }, []);

  const tooltip = (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          key="tooltip-card-portal"
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.12, ease: 'easeOut' }}
          className="pointer-events-none fixed z-[9999] min-w-[15rem] max-w-[18rem] overflow-hidden rounded-lg border border-white/10 bg-black/90 shadow-xl shadow-black/40 backdrop-blur-md"
          style={{ top: pos.y, left: pos.x }}
        >
          <div
            ref={contentRef}
            className="p-3 text-xs leading-relaxed text-white/70"
          >
            {content}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div
      className={cn('relative inline-block', containerClassName)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseMove={handleMouseMove}
    >
      {children}
      {createPortal(tooltip, document.body)}
    </div>
  );
}
