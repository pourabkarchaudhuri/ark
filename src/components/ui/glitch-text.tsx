import { cn } from '@/lib/utils';
import { useState } from 'react';

interface GlitchTextProps {
  children: string;
  className?: string;
  enableOnHover?: boolean;
}

export function GlitchText({
  children,
  className,
  enableOnHover = false,
}: GlitchTextProps) {
  const [isHovered, setIsHovered] = useState(false);

  const shouldAnimate = enableOnHover ? isHovered : true;

  return (
    <span
      className={cn('relative inline-block', className)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <span className="relative">
        {children}
        {shouldAnimate && (
          <>
            <span
              className="absolute left-0 top-0 text-cyan-400 animate-glitch-1"
              style={{ clipPath: 'polygon(0 0, 100% 0, 100% 45%, 0 45%)' }}
              aria-hidden="true"
            >
              {children}
            </span>
            <span
              className="absolute left-0 top-0 text-fuchsia-500 animate-glitch-2"
              style={{ clipPath: 'polygon(0 55%, 100% 55%, 100% 100%, 0 100%)' }}
              aria-hidden="true"
            >
              {children}
            </span>
          </>
        )}
      </span>
      <style>{`
        @keyframes glitch-1 {
          0%, 100% { transform: translate(0); }
          20% { transform: translate(-2px, 2px); }
          40% { transform: translate(-2px, -2px); }
          60% { transform: translate(2px, 2px); }
          80% { transform: translate(2px, -2px); }
        }
        @keyframes glitch-2 {
          0%, 100% { transform: translate(0); }
          20% { transform: translate(2px, -2px); }
          40% { transform: translate(2px, 2px); }
          60% { transform: translate(-2px, -2px); }
          80% { transform: translate(-2px, 2px); }
        }
        .animate-glitch-1 { animation: glitch-1 0.3s infinite; }
        .animate-glitch-2 { animation: glitch-2 0.3s infinite; }
      `}</style>
    </span>
  );
}

