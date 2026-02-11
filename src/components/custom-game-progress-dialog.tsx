/**
 * Custom Game Progress Dialog
 *
 * A dialog wrapper that renders the shared MyProgressTab for custom
 * (non-Steam/Epic) games.  The progress interface is identical to
 * store-based games — only the dialog chrome (header with game name)
 * is custom-game-specific.
 */

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Gamepad2 } from 'lucide-react';
import { customGameStore } from '@/services/custom-game-store';
import { MyProgressTab } from '@/components/my-progress-tab';

interface CustomGameProgressDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gameId: string; // custom game ID (e.g., "custom-1")
}

function formatDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function CustomGameProgressDialog({
  open,
  onOpenChange,
  gameId,
}: CustomGameProgressDialogProps) {
  const [title, setTitle] = useState('');
  const [addedAt, setAddedAt] = useState<Date | null>(null);

  // Load the game title / addedAt whenever the dialog opens or gameId changes
  useEffect(() => {
    if (!open) return;
    const entry = customGameStore.getGame(gameId);
    if (entry) {
      setTitle(entry.title);
      setAddedAt(entry.addedAt instanceof Date ? entry.addedAt : new Date(entry.addedAt));
    }
  }, [open, gameId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-fuchsia-500/20">
              <Gamepad2 className="h-5 w-5 text-fuchsia-400" />
            </div>
            <div>
              <DialogTitle className="text-lg">{title}</DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                Custom Game{addedAt ? ` · Added ${formatDate(addedAt)}` : ''}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Scrollable body — renders the same MyProgressTab used by Steam/Epic games */}
        <div className="flex-1 min-h-0 overflow-y-auto pr-1">
          <MyProgressTab gameId={gameId} gameName={title} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
