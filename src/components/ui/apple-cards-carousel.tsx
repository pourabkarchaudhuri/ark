/**
 * Apple Cards Carousel
 * Adapted from Aceternity UI for a non-Next.js React + Electron project.
 * Features: snap scroll, auto-scroll with pause-on-hover, blur-up lazy images.
 */

import React, {
  useEffect,
  useRef,
  useState,
  createContext,
  useContext,
  useCallback,
} from 'react';
import { cn } from '@/lib/utils';
import { AnimatePresence, motion } from 'framer-motion';

/* ---------- Types ---------- */

interface CarouselProps {
  items: JSX.Element[];
  initialScroll?: number;
  /** Auto-scroll interval in ms. Set 0 to disable. Default 4000. */
  autoScrollInterval?: number;
}

export type CardType = {
  src: string;
  title: string;
  category: string;
  /** If provided, clicking the card opens this URL instead of expanding content. */
  href?: string;
  content?: React.ReactNode;
};

/* ---------- Context ---------- */

export const CarouselContext = createContext<{
  onCardClose: (index: number) => void;
  currentIndex: number;
}>({
  onCardClose: () => {},
  currentIndex: 0,
});

/* ---------- Carousel ---------- */

export const Carousel = ({
  items,
  initialScroll = 0,
  autoScrollInterval = 4000,
}: CarouselProps) => {
  const carouselRef = useRef<HTMLDivElement>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const isPaused = useRef(false);
  const autoScrollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Set initial scroll position
  useEffect(() => {
    if (carouselRef.current) {
      carouselRef.current.scrollLeft = initialScroll;
    }
  }, [initialScroll]);

  // Auto-scroll logic
  useEffect(() => {
    if (!autoScrollInterval || items.length === 0) return;

    const container = carouselRef.current;
    if (!container) return;

    const tick = () => {
      if (isPaused.current || !container) return;

      const maxScroll = container.scrollWidth - container.clientWidth;
      // Don't auto-scroll if all cards fit without scrolling
      if (maxScroll <= 5) return;
      if (container.scrollLeft >= maxScroll - 5) {
        // Snap back to start
        container.scrollTo({ left: 0, behavior: 'smooth' });
      } else {
        // Scroll by one card width (snap will handle alignment)
        const firstChild = container.querySelector('[data-carousel-card]') as HTMLElement | null;
        const cardWidth = firstChild ? firstChild.offsetWidth + 16 : 260; // card + gap
        container.scrollBy({ left: cardWidth, behavior: 'smooth' });
      }
    };

    autoScrollTimer.current = setInterval(tick, autoScrollInterval);

    return () => {
      if (autoScrollTimer.current) clearInterval(autoScrollTimer.current);
    };
  }, [autoScrollInterval, items.length]);

  const handleMouseEnter = useCallback(() => {
    isPaused.current = true;
  }, []);

  const handleMouseLeave = useCallback(() => {
    isPaused.current = false;
  }, []);

  const handleCardClose = useCallback((index: number) => {
    if (carouselRef.current) {
      const firstChild = carouselRef.current.querySelector('[data-carousel-card]') as HTMLElement | null;
      const cardWidth = firstChild ? firstChild.offsetWidth : 230;
      const gap = 16;
      const scrollPosition = (cardWidth + gap) * (index + 1);
      carouselRef.current.scrollTo({
        left: scrollPosition,
        behavior: 'smooth',
      });
      setCurrentIndex(index);
    }
  }, []);

  return (
    <CarouselContext.Provider
      value={{ onCardClose: handleCardClose, currentIndex }}
    >
      <div
        className="relative w-full"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div
          className={cn(
            'flex w-full overflow-x-auto overscroll-x-auto py-6 [scrollbar-width:none]',
            'snap-x snap-mandatory scroll-smooth'
          )}
          ref={carouselRef}
        >
          <div className="flex flex-row justify-start gap-4 pl-4 max-w-7xl">
            {items.map((item, index) => (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{
                  opacity: 1,
                  y: 0,
                  transition: {
                    duration: 0.5,
                    delay: Math.min(0.15 * index, 0.8),
                    ease: 'easeOut',
                  },
                }}
                key={'card' + index}
                data-carousel-card
                className="snap-start"
              >
                {item}
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </CarouselContext.Provider>
  );
};

/* ---------- Card ---------- */

export const Card = ({
  card,
  index,
  layout = false,
}: {
  card: CardType;
  index: number;
  layout?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { onCardClose } = useContext(CarouselContext);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        handleClose();
      }
    }

    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'auto';
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;

    const listener = (event: MouseEvent | TouchEvent) => {
      if (!containerRef.current || containerRef.current.contains(event.target as Node)) {
        return;
      }
      handleClose();
    };

    document.addEventListener('mousedown', listener);
    document.addEventListener('touchstart', listener);
    return () => {
      document.removeEventListener('mousedown', listener);
      document.removeEventListener('touchstart', listener);
    };
  }, [open]);

  const handleOpen = () => {
    // If the card has an href, navigate there instead of opening modal
    if (card.href) {
      if (window.electron?.openExternal) {
        window.electron.openExternal(card.href);
      } else {
        window.open(card.href, '_blank');
      }
      return;
    }
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
    onCardClose(index);
  };

  return (
    <>
      <AnimatePresence>
        {open && card.content && (
          <div className="fixed inset-0 z-50 h-screen overflow-auto">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 h-full w-full bg-black/80 backdrop-blur-lg"
            />
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              ref={containerRef}
              layoutId={layout ? `card-${card.title}` : undefined}
              className="relative z-[60] mx-auto my-10 h-fit max-w-5xl rounded-3xl bg-neutral-900 p-4 font-sans md:p-10"
            >
              <button
                className="sticky top-4 right-0 ml-auto flex h-8 w-8 items-center justify-center rounded-full bg-white"
                onClick={handleClose}
              >
                <span className="text-neutral-900 text-lg font-bold">&times;</span>
              </button>
              <motion.p
                layoutId={layout ? `category-${card.title}` : undefined}
                className="text-base font-medium text-white"
              >
                {card.category}
              </motion.p>
              <motion.p
                layoutId={layout ? `title-${card.title}` : undefined}
                className="mt-4 text-2xl font-semibold text-white md:text-5xl"
              >
                {card.title}
              </motion.p>
              <div className="py-10">{card.content}</div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <motion.button
        layoutId={layout ? `card-${card.title}` : undefined}
        onClick={handleOpen}
        className="relative z-10 flex h-48 w-34 flex-col items-start justify-start overflow-hidden rounded-3xl bg-neutral-900 md:h-[24rem] md:w-60"
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 z-30 h-full bg-gradient-to-b from-black/50 via-transparent to-transparent" />
        <div className="relative z-40 p-4 md:p-5">
          <motion.p
            layoutId={layout ? `category-${card.category}` : undefined}
            className="text-left font-sans text-xs font-medium text-white md:text-sm"
          >
            {card.category}
          </motion.p>
          <motion.p
            layoutId={layout ? `title-${card.title}` : undefined}
            className="mt-1 max-w-xs text-left font-sans text-sm font-semibold [text-wrap:balance] text-white md:text-lg leading-snug line-clamp-3"
          >
            {card.title}
          </motion.p>
        </div>
        <BlurImage
          src={card.src}
          alt={card.title}
          className="absolute inset-0 z-10 object-cover"
        />
      </motion.button>
    </>
  );
};

/* ---------- BlurImage ---------- */

export const BlurImage = ({
  height,
  width,
  src,
  className,
  alt,
  ...rest
}: React.ImgHTMLAttributes<HTMLImageElement>) => {
  const [isLoading, setLoading] = useState(true);

  return (
    <img
      className={cn(
        'h-full w-full transition duration-300',
        isLoading ? 'blur-sm scale-105' : 'blur-0 scale-100',
        className
      )}
      onLoad={() => setLoading(false)}
      src={src}
      width={width}
      height={height}
      loading="lazy"
      decoding="async"
      alt={alt || 'Background of a beautiful view'}
      {...rest}
    />
  );
};
