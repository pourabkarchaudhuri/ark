/**
 * SpotlightCard — Adapted from ReactBits (MIT + Commons Clause)
 * https://github.com/DavidHDev/react-bits
 *
 * Card with a cursor-following spotlight glow effect.
 */
import { useRef, useState, type ReactNode, type CSSProperties } from 'react';

interface SpotlightCardProps {
  children: ReactNode;
  className?: string;
  spotlightColor?: string;
  borderColor?: string;
}

export default function SpotlightCard({
  children,
  className = '',
  spotlightColor = 'rgba(168, 85, 247, 0.12)',
  borderColor = 'rgba(255, 255, 255, 0.06)',
}: SpotlightCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [hovering, setHovering] = useState(false);

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const overlayStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    borderRadius: 'inherit',
    pointerEvents: 'none',
    opacity: hovering ? 1 : 0,
    transition: 'opacity 0.3s ease',
    background: `radial-gradient(circle 180px at ${pos.x}px ${pos.y}px, ${spotlightColor}, transparent 70%)`,
  };

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      className={className}
      style={{ position: 'relative', overflow: 'hidden', border: `1px solid ${borderColor}` }}
    >
      <div style={overlayStyle} />
      {children}
    </div>
  );
}
