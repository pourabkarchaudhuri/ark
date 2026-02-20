import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';

export interface CardItem {
  id: number | string;
  title: string;
  subtitle: string;
  summary: string;
  imageUrl?: string;
}

export function CardStack({
  items,
  offset = 8,
  scaleFactor = 0.04,
  flipInterval = 6000,
  className,
}: {
  items: CardItem[];
  offset?: number;
  scaleFactor?: number;
  flipInterval?: number;
  className?: string;
}) {
  const [cards, setCards] = useState<CardItem[]>(items);

  useEffect(() => {
    setCards(items);
  }, [items]);

  const flip = useCallback(() => {
    setCards(prev => {
      if (prev.length <= 1) return prev;
      const copy = [...prev];
      copy.unshift(copy.pop()!);
      return copy;
    });
  }, []);

  useEffect(() => {
    if (items.length <= 1) return;
    const id = setInterval(flip, flipInterval);
    return () => clearInterval(id);
  }, [items.length, flipInterval, flip]);

  return (
    <div className={`relative ${className ?? 'w-64 h-[220px]'}`}>
      {cards.map((card, index) => (
        <motion.div
          key={card.id}
          className="absolute inset-0 rounded-lg border border-white/[0.06] overflow-hidden
            shadow-lg shadow-black/20 cursor-default flex flex-col"
          style={{ transformOrigin: 'top center' }}
          animate={{
            top: index * -offset,
            scale: 1 - index * scaleFactor,
            zIndex: cards.length - index,
          }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          {/* Image section — fixed height */}
          <div className="h-[72px] shrink-0 bg-black/80 relative overflow-hidden">
            {card.imageUrl ? (
              <img
                src={card.imageUrl}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-900/30 to-violet-900/20" />
            )}
            {/* Bottom gradient fade into glass panel */}
            <div className="absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-black/80 to-transparent" />
          </div>

          {/* Glass text panel — fills remaining space */}
          <div className="flex-1 bg-black/60 backdrop-blur-md p-2.5 flex flex-col gap-1 min-h-0">
            <p className="text-[10px] font-medium text-white/85 leading-tight line-clamp-2">
              {card.title}
            </p>
            <p className="text-[9px] text-fuchsia-400/60 truncate shrink-0">
              {card.subtitle}
            </p>
            <p className="text-[9.5px] leading-[1.45] text-white/40 line-clamp-4 min-h-0">
              {card.summary}
            </p>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
