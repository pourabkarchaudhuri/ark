import { useState, useEffect, useCallback, useMemo } from 'react';
import { Game, GameStatus, GamePriority } from '@/types/game';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Library, Plus, ChevronDown, ChevronUp } from 'lucide-react';

interface GameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  game: Game | null;
  onSave: (game: Partial<Game>) => void;
  genres: string[];
  platforms: string[];
}

const statusOptions: GameStatus[] = [
  'Want to Play',
  'Playing',
  'Completed',
  'On Hold',
  'Dropped',
];

const priorityOptions: GamePriority[] = ['High', 'Medium', 'Low'];

const recommendationSources = [
  'Personal Discovery',
  'Friend Recommendation',
  'Online Review',
  'Social Media',
  'Gaming Forum',
  'Podcast',
  'Streaming',
  'Other',
];

const STEAM_CDN = 'https://cdn.akamai.steamstatic.com/steam/apps';

/** Generate a deterministic gradient from a game title for visual fallback */
function getDialogFallbackGradient(title: string): string {
  const hash = title.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const hue = hash % 360;
  return `linear-gradient(135deg, hsl(${hue}, 50%, 20%) 0%, hsl(${(hue + 60) % 360}, 50%, 10%) 100%)`;
}

/** Get up to 2 initials from a title */
function getDialogInitials(title: string): string {
  return title
    .split(' ')
    .slice(0, 2)
    .map(word => word[0])
    .join('')
    .toUpperCase();
}

/**
 * Cover image for the dialog with a deduplicated multi-step fallback chain.
 * Also detects tiny placeholder images that newer Steam games return from
 * the old CDN (200 status but < 50px dimensions) and advances the fallback.
 */
function DialogCoverImage({ game }: { game: Game }) {
  const [fallbackAttempt, setFallbackAttempt] = useState(0);
  const [imageError, setImageError] = useState(false);

  // Build a deduplicated fallback URL list so consecutive duplicates never stall the chain
  const fallbackUrls = useMemo(() => {
    const id = game.steamAppId;
    if (!id) return [game.coverUrl || ''];

    const candidates = [
      game.coverUrl || `${STEAM_CDN}/${id}/library_600x900.jpg`,
      game.headerImage || `${STEAM_CDN}/${id}/header.jpg`,
      `${STEAM_CDN}/${id}/header.jpg`,
      `${STEAM_CDN}/${id}/capsule_616x353.jpg`,
      `${STEAM_CDN}/${id}/capsule_231x87.jpg`,
      `${STEAM_CDN}/${id}/logo.png`,
      game.screenshots?.[0] || '',
    ];

    const seen = new Set<string>();
    return candidates.filter(url => {
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
  }, [game.steamAppId, game.coverUrl, game.headerImage, game.screenshots]);

  // Reset state when the game changes
  useEffect(() => {
    setFallbackAttempt(0);
    setImageError(false);
  }, [game.id, game.steamAppId]);

  const imageUrl = fallbackUrls[fallbackAttempt] || '';

  const advanceFallback = useCallback(() => {
    if (fallbackAttempt < fallbackUrls.length - 1) {
      setFallbackAttempt(prev => prev + 1);
    } else {
      setImageError(true);
    }
  }, [fallbackAttempt, fallbackUrls.length]);

  // Detect placeholder images (tiny dimensions) that newer Steam games return
  const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth < 50 || img.naturalHeight < 50) {
      advanceFallback();
    }
  }, [advanceFallback]);

  if (imageError || !imageUrl) {
    return (
      <div
        className="flex-shrink-0 w-20 h-28 rounded-lg overflow-hidden flex items-center justify-center"
        style={{ background: getDialogFallbackGradient(game.title) }}
      >
        <span className="text-white/60 font-bold text-lg">
          {getDialogInitials(game.title)}
        </span>
      </div>
    );
  }

  return (
    <div className="flex-shrink-0 w-20 h-28 rounded-lg overflow-hidden bg-white/10">
      <img
        src={imageUrl}
        alt={game.title}
        className="w-full h-full object-cover"
        onLoad={handleLoad}
        onError={advanceFallback}
      />
    </div>
  );
}

export function GameDialog({
  open,
  onOpenChange,
  game,
  onSave,
}: GameDialogProps) {
  const [formData, setFormData] = useState({
    status: 'Want to Play' as GameStatus,
    priority: 'Medium' as GamePriority,
    publicReviews: '',
    recommendationSource: 'Personal Discovery',
  });
  const [showAdvanced, setShowAdvanced] = useState(false);

  const isEditing = game?.isInLibrary ?? false;

  // Reset form when dialog opens/closes or game changes
  useEffect(() => {
    if (open && game) {
      setFormData({
        status: game.status || 'Want to Play',
        priority: game.priority || 'Medium',
        publicReviews: game.publicReviews || '',
        recommendationSource: game.recommendationSource || 'Personal Discovery',
      });
      // Show advanced options if editing and any advanced field has data
      const hasAdvancedData = Boolean(
        (game.priority && game.priority !== 'Medium') ||
        game.publicReviews ||
        (game.recommendationSource && game.recommendationSource !== 'Personal Discovery')
      );
      setShowAdvanced(isEditing && hasAdvancedData);
    } else if (open) {
      setFormData({
        status: 'Want to Play',
        priority: 'Medium',
        publicReviews: '',
        recommendationSource: 'Personal Discovery',
      });
      setShowAdvanced(false);
    }
  }, [game, open, isEditing]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      ...formData,
    });
  }, [formData, onSave]);

  const updateField = <K extends keyof typeof formData>(
    key: K,
    value: typeof formData[K]
  ) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  if (!game) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            {isEditing ? (
              <Library className="h-5 w-5 text-fuchsia-400" />
            ) : (
              <Plus className="h-5 w-5 text-fuchsia-400" />
            )}
            <DialogTitle>
              {isEditing ? 'Edit Library Entry' : 'Add to Library'}
            </DialogTitle>
          </div>
          <DialogDescription>
            {isEditing 
              ? 'Update your progress and notes for this game.' 
              : 'Set your preferences for tracking this game.'}
          </DialogDescription>
        </DialogHeader>

        {/* Game Info Header (Read-only from IGDB) */}
        <div className="flex gap-4 p-4 bg-white/5 rounded-lg border border-white/10">
          {/* Cover Image with fallback chain */}
          <DialogCoverImage game={game} />

          {/* Game Details */}
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-white text-lg leading-tight line-clamp-2">
              {game.title}
            </h3>
            <p className="text-white/60 text-sm mt-1">{game.developer}</p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {game.genre.slice(0, 3).map((g) => (
                <Badge 
                  key={g} 
                  variant="secondary" 
                  className="text-[10px] bg-white/10 text-white/70"
                >
                  {g}
                </Badge>
              ))}
              {game.metacriticScore !== null && (
                <Badge className="text-[10px] bg-green-500/20 text-green-400 border-none">
                  {game.metacriticScore}
                </Badge>
              )}
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {/* Required: Status */}
          <div className="space-y-2">
            <Label>Play Status</Label>
            <Select
              value={formData.status}
              onValueChange={(value: GameStatus) => updateField('status', value)}
            >
              <SelectTrigger className="bg-white/5 border-white/10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map((status) => (
                  <SelectItem key={status} value={status}>
                    {status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Advanced Options Toggle */}
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-2 text-sm text-white/60 hover:text-white transition-colors w-full"
          >
            {showAdvanced ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
            {showAdvanced ? 'Hide' : 'Show'} additional options
          </button>

          {/* Advanced Fields (collapsible) */}
          {showAdvanced && (
            <div className="space-y-4 pt-2 border-t border-white/10">
              <div className="grid grid-cols-2 gap-4">
                {/* Priority */}
                <div className="space-y-2">
                  <Label className="text-white/70">Priority</Label>
                  <Select
                    value={formData.priority}
                    onValueChange={(value: GamePriority) => updateField('priority', value)}
                  >
                    <SelectTrigger className="bg-white/5 border-white/10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {priorityOptions.map((priority) => (
                        <SelectItem key={priority} value={priority}>
                          {priority}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Recommendation Source */}
                <div className="space-y-2">
                  <Label className="text-white/70">How discovered?</Label>
                  <Select
                    value={formData.recommendationSource}
                    onValueChange={(value: string) => updateField('recommendationSource', value)}
                  >
                    <SelectTrigger className="bg-white/5 border-white/10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {recommendationSources.map((source) => (
                        <SelectItem key={source} value={source}>
                          {source}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Notes */}
              <div className="space-y-2">
                <Label htmlFor="publicReviews" className="text-white/70">Your Notes</Label>
                <Textarea
                  id="publicReviews"
                  value={formData.publicReviews}
                  onChange={(e) => updateField('publicReviews', e.target.value)}
                  placeholder="Add personal notes, reviews, or thoughts..."
                  className="bg-white/5 border-white/10 min-h-[80px] resize-none"
                />
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button 
              type="button" 
              variant="outline" 
              onClick={() => onOpenChange(false)}
              className="border-white/10"
            >
              Cancel
            </Button>
            <Button 
              type="submit"
              className="bg-fuchsia-500 hover:bg-fuchsia-600 text-white"
            >
              {isEditing ? 'Update Entry' : 'Add to Library'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
