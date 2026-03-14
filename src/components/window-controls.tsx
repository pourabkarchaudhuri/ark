/**
 * Window Controls Component
 * Provides minimize, maximize, and close buttons for Electron windows
 * Reusable across all pages for consistent window control behavior
 */

import { useState, useEffect } from 'react';
import { X, Minus, Maximize2, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface WindowControlsProps {
  className?: string;
}

export function WindowControls({ className }: WindowControlsProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!window.electron) return;
    // Seed initial state
    window.electron.isMaximized().then(setIsMaximized);
    // Subscribe to push events (replaces 500ms polling)
    const unsub = window.electron.onMaximizedChange?.(setIsMaximized);
    return () => { unsub?.(); };
  }, []);

  const handleMinimize = async () => {
    if (window.electron) {
      await window.electron.minimize();
    }
  };

  const handleMaximize = async () => {
    if (window.electron) {
      await window.electron.maximize();
      const maximized = await window.electron.isMaximized();
      setIsMaximized(maximized);
    }
  };

  const handleClose = async () => {
    if (window.electron) {
      await window.electron.close();
    }
  };

  // Don't render if not in Electron
  if (typeof window === 'undefined' || !window.electron) {
    return null;
  }

  return (
    <div className={cn('flex items-center gap-0 no-drag', className)}>
      <Button
        variant="ghost"
        size="icon"
        className="group min-w-[44px] min-h-[44px] p-0 flex items-center justify-center rounded-full bg-transparent hover:bg-transparent transition-[background-color] duration-0"
        onClick={handleClose}
        aria-label="Close window"
      >
        <span className="h-6 w-6 rounded-full bg-gray-700/80 group-hover:bg-gray-600 flex items-center justify-center transition-[background-color] duration-0">
          <X className="h-3 w-3 text-white pointer-events-none" />
        </span>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="group min-w-[44px] min-h-[44px] p-0 flex items-center justify-center rounded-full bg-transparent hover:bg-transparent transition-[background-color] duration-0"
        onClick={handleMinimize}
        aria-label="Minimize window"
      >
        <span className="h-6 w-6 rounded-full bg-gray-700/80 group-hover:bg-gray-600 flex items-center justify-center transition-[background-color] duration-0">
          <Minus className="h-3 w-3 text-white pointer-events-none" />
        </span>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="group min-w-[44px] min-h-[44px] p-0 flex items-center justify-center rounded-full bg-transparent hover:bg-transparent transition-[background-color] duration-0"
        onClick={handleMaximize}
        aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
      >
        <span className="h-6 w-6 rounded-full bg-gray-700/80 group-hover:bg-gray-600 flex items-center justify-center transition-[background-color] duration-0">
          {isMaximized ? (
            <Maximize2 className="h-2.5 w-2.5 text-white pointer-events-none" />
          ) : (
            <Square className="h-3 w-3 text-white pointer-events-none" />
          )}
        </span>
      </Button>
    </div>
  );
}
