/**
 * Window Controls Component
 * Provides minimize, maximize, and close buttons for Electron windows
 * Reusable across all pages for consistent window control behavior
 */

import { useState, useEffect } from 'react';
import { X, Minus, Maximize2, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface WindowControlsProps {
  className?: string;
}

export function WindowControls({ className }: WindowControlsProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const checkMaximized = async () => {
      if (window.electron) {
        const maximized = await window.electron.isMaximized();
        setIsMaximized(maximized);
      }
    };
    checkMaximized();
    const interval = setInterval(checkMaximized, 500);
    return () => clearInterval(interval);
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
    <div className={`flex items-center gap-2 no-drag ${className || ''}`}>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 rounded-full bg-gray-700/80 hover:bg-gray-600 p-0 transition-colors"
        onClick={handleClose}
        aria-label="Close window"
      >
        <X className="h-3 w-3 text-white pointer-events-none" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 rounded-full bg-gray-700/80 hover:bg-gray-600 p-0 transition-colors"
        onClick={handleMinimize}
        aria-label="Minimize window"
      >
        <Minus className="h-3 w-3 text-white pointer-events-none" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 rounded-full bg-gray-700/80 hover:bg-gray-600 p-0 transition-colors"
        onClick={handleMaximize}
        aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
      >
        {isMaximized ? (
          <Maximize2 className="h-2.5 w-2.5 text-white pointer-events-none" />
        ) : (
          <Square className="h-3 w-3 text-white pointer-events-none" />
        )}
      </Button>
    </div>
  );
}
