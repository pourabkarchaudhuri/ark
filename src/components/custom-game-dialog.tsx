import { useState, useCallback } from 'react';
import { GameStatus, CreateCustomGameEntry } from '@/types/game';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CustomGameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (game: CreateCustomGameEntry) => void;
}

const statusOptions: GameStatus[] = [
  'Want to Play',
  'Playing',
  'Completed',
  'On Hold',
];

const platformOptions = ['Windows', 'PlayStation', 'Xbox', 'Nintendo', 'Mobile', 'Other'];

export function CustomGameDialog({
  open,
  onOpenChange,
  onSave,
}: CustomGameDialogProps) {
  const [title, setTitle] = useState('');
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [status, setStatus] = useState<GameStatus>('Want to Play');
  const [error, setError] = useState<string | null>(null);

  const handlePlatformToggle = (platform: string) => {
    setSelectedPlatforms((prev) =>
      prev.includes(platform)
        ? prev.filter((p) => p !== platform)
        : [...prev, platform]
    );
  };

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();

      // Validation
      if (!title.trim()) {
        setError('Title is required');
        return;
      }

      if (selectedPlatforms.length === 0) {
        setError('Select at least one platform');
        return;
      }

      setError(null);
      onSave({
        title: title.trim(),
        platform: selectedPlatforms,
        status,
      });

      // Reset form
      setTitle('');
      setSelectedPlatforms([]);
      setStatus('Want to Play');
    },
    [title, selectedPlatforms, status, onSave]
  );

  const handleClose = () => {
    // Reset form on close
    setTitle('');
    setSelectedPlatforms([]);
    setStatus('Want to Play');
    setError(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Plus className="h-5 w-5 text-fuchsia-400" />
            <DialogTitle>Add Custom Game</DialogTitle>
          </div>
          <DialogDescription>
            Add a game that's not in the IGDB database to your library.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor="title">
              Game Title <span className="text-red-400">*</span>
            </Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter game title..."
              className="bg-white/5 border-white/10"
              autoFocus
            />
          </div>

          {/* Platforms */}
          <div className="space-y-2">
            <Label>
              Platforms <span className="text-red-400">*</span>
            </Label>
            <div className="flex flex-wrap gap-2">
              {platformOptions.map((platform) => {
                const isSelected = selectedPlatforms.includes(platform);
                return (
                  <button
                    key={platform}
                    type="button"
                    onClick={() => handlePlatformToggle(platform)}
                    className={cn(
                      'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border',
                      isSelected
                        ? 'bg-fuchsia-500/20 text-fuchsia-400 border-fuchsia-500/50'
                        : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10'
                    )}
                  >
                    {platform}
                    {isSelected && <X className="inline-block h-3 w-3 ml-1" />}
                  </button>
                );
              })}
            </div>
            {selectedPlatforms.length > 0 && (
              <p className="text-xs text-white/40">
                Selected: {selectedPlatforms.join(', ')}
              </p>
            )}
          </div>

          {/* Status */}
          <div className="space-y-2">
            <Label>Play Status</Label>
            <Select
              value={status}
              onValueChange={(value: GameStatus) => setStatus(value)}
            >
              <SelectTrigger className="bg-white/5 border-white/10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-3 rounded-lg bg-red-500/20 border border-red-500/30">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {/* Info Message */}
          <div className="p-3 rounded-lg bg-white/5 border border-white/10">
            <p className="text-xs text-white/60">
              Custom games will be marked with a special badge in your library.
              They won't have cover images or metadata from IGDB.
            </p>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              className="border-white/10"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="bg-fuchsia-500 hover:bg-fuchsia-600 text-white"
            >
              Add to Library
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

