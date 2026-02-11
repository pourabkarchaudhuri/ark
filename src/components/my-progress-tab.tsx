/**
 * My Progress Tab Component
 * Unified progress / tracking interface used by ALL game types:
 * Steam, Epic, and custom games.
 */

import { useState, useEffect, useCallback } from 'react';
import { Star, Clock, Save, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { GameStatus, GamePriority } from '@/types/game';
import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';
import { cn, formatHours } from '@/lib/utils';

interface MyProgressTabProps {
  gameId: string;
  gameName?: string; // Reserved for future use (display purposes)
}

/** Normalised shape used internally — works for both library and custom entries. */
interface ProgressData {
  status: GameStatus;
  priority: GamePriority;
  hoursPlayed: number;
  rating: number;
  publicReviews: string;
  recommendationSource: string;
  addedAt: Date;
}

const statusOptions: GameStatus[] = [
  'Want to Play',
  'Playing',
  'Completed',
  'On Hold',
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function isCustomId(gameId: string): boolean {
  return gameId.startsWith('custom-');
}

/** Read from the correct store and normalise into ProgressData. */
function loadProgressData(gameId: string): ProgressData | null {
  if (isCustomId(gameId)) {
    const entry = customGameStore.getGame(gameId);
    if (!entry) return null;
    return {
      status: entry.status,
      priority: entry.priority || 'Medium',
      hoursPlayed: entry.hoursPlayed ?? 0,
      rating: entry.rating ?? 0,
      publicReviews: entry.publicReviews ?? '',
      recommendationSource: entry.recommendationSource || 'Personal Discovery',
      addedAt: entry.addedAt instanceof Date ? entry.addedAt : new Date(entry.addedAt),
    };
  }

  const entry = libraryStore.getEntry(gameId);
  if (!entry) return null;
  return {
    status: entry.status,
    priority: entry.priority,
    hoursPlayed: entry.hoursPlayed || 0,
    rating: entry.rating || 0,
    publicReviews: entry.publicReviews || '',
    recommendationSource: entry.recommendationSource || 'Personal Discovery',
    addedAt: entry.addedAt instanceof Date ? entry.addedAt : new Date(entry.addedAt),
  };
}

/** Persist back to the correct store. */
function saveProgressData(
  gameId: string,
  data: {
    status: GameStatus;
    priority: GamePriority;
    hoursPlayed: number;
    rating: number;
    publicReviews: string;
    recommendationSource: string;
  },
): void {
  if (isCustomId(gameId)) {
    customGameStore.updateGame(gameId, {
      status: data.status,
      priority: data.priority,
      hoursPlayed: data.hoursPlayed,
      rating: data.rating,
      publicReviews: data.publicReviews,
      recommendationSource: data.recommendationSource,
    });
  } else {
    libraryStore.updateEntry(gameId, {
      hoursPlayed: data.hoursPlayed,
      rating: data.rating,
      status: data.status,
      priority: data.priority,
      publicReviews: data.publicReviews,
      recommendationSource: data.recommendationSource,
    });
  }
}

// Get status badge color
function getStatusColor(status: GameStatus): string {
  switch (status) {
    case 'Playing':
      return 'bg-green-500/20 text-green-400 border-green-500/30';
    case 'Completed':
      return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
    case 'Want to Play':
      return 'bg-fuchsia-500/20 text-fuchsia-400 border-fuchsia-500/30';
    case 'On Hold':
      return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
    case 'Playing Now':
      return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
    default:
      return 'bg-white/10 text-white/60';
  }
}

// Get priority badge color
function getPriorityColor(priority: GamePriority): string {
  switch (priority) {
    case 'High':
      return 'bg-red-500/20 text-red-400 border-red-500/30';
    case 'Medium':
      return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
    case 'Low':
      return 'bg-green-500/20 text-green-400 border-green-500/30';
    default:
      return 'bg-white/10 text-white/60';
  }
}

// Format date as "3rd Jan, 2025" for My Progress view
function formatProgressDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  const day = d.getDate();
  const ord =
    day === 1 || day === 21 || day === 31
      ? 'st'
      : day === 2 || day === 22
        ? 'nd'
        : day === 3 || day === 23
          ? 'rd'
          : 'th';
  const month = d.toLocaleDateString('en-GB', { month: 'short' });
  const year = d.getFullYear();
  return `${day}${ord} ${month}, ${year}`;
}

// Skeleton loader for My Progress tab
export function MyProgressSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <div className="h-6 w-24 rounded-md bg-white/10" />
          <div className="h-6 w-20 rounded-md bg-white/10" />
        </div>
        <div className="h-4 w-28 rounded bg-white/10" />
      </div>
      {/* Two columns */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-6">
          <div className="space-y-3">
            <div className="h-4 w-24 rounded bg-white/10" />
            <div className="h-2 w-full rounded-full bg-white/10" />
            <div className="flex justify-between gap-2">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="h-3 flex-1 rounded bg-white/10" />
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <div className="h-4 w-20 rounded bg-white/10" />
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-7 w-7 rounded bg-white/10" />
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <div className="h-4 w-20 rounded bg-white/10" />
            <div className="h-10 w-full rounded-md bg-white/10" />
          </div>
          <div className="space-y-2">
            <div className="h-4 w-16 rounded bg-white/10" />
            <div className="h-10 w-full rounded-md bg-white/10" />
          </div>
        </div>
        <div className="space-y-6">
          <div className="space-y-2">
            <div className="h-4 w-40 rounded bg-white/10" />
            <div className="h-10 w-full rounded-md bg-white/10" />
          </div>
          <div className="space-y-2">
            <div className="h-4 w-24 rounded bg-white/10" />
            <div className="h-[180px] w-full rounded-md bg-white/10" />
          </div>
        </div>
      </div>
      {/* Save button row */}
      <div className="flex justify-end pt-4 border-t border-white/10">
        <div className="h-10 w-32 rounded-md bg-white/10" />
      </div>
    </div>
  );
}

export function MyProgressTab({ gameId, gameName: _gameName }: MyProgressTabProps) {
  // gameName is available for future use (e.g., display in the header)
  void _gameName;

  // Initialise state eagerly from the synchronous store so the first render
  // already has data and the skeleton never flickers.
  const initialData = loadProgressData(gameId);
  const [data, setData] = useState<ProgressData | null>(initialData);
  const [hoursPlayed, setHoursPlayed] = useState(initialData?.hoursPlayed || 0);
  const [rating, setRating] = useState(initialData?.rating || 0);
  const [status, setStatus] = useState<GameStatus>(initialData?.status || 'Want to Play');
  const [priority, setPriority] = useState<GamePriority>(initialData?.priority || 'Medium');
  const [notes, setNotes] = useState(initialData?.publicReviews || '');
  const [recommendationSource, setRecommendationSource] = useState(
    initialData?.recommendationSource || 'Personal Discovery'
  );
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Re-sync when navigating to a different game
  useEffect(() => {
    const loaded = loadProgressData(gameId);
    if (loaded) {
      setData(loaded);
      setHoursPlayed(loaded.hoursPlayed);
      setRating(loaded.rating);
      setStatus(loaded.status);
      setPriority(loaded.priority);
      setNotes(loaded.publicReviews);
      setRecommendationSource(loaded.recommendationSource);
    }
  }, [gameId]);

  // Track changes
  useEffect(() => {
    if (!data) return;
    const changed =
      hoursPlayed !== data.hoursPlayed ||
      rating !== data.rating ||
      status !== data.status ||
      priority !== data.priority ||
      notes !== data.publicReviews ||
      recommendationSource !== data.recommendationSource;
    setHasChanges(changed);
  }, [data, hoursPlayed, rating, status, priority, notes, recommendationSource]);

  // Save changes
  const handleSave = useCallback(() => {
    if (!data) return;
    
    setIsSaving(true);

    saveProgressData(gameId, {
      status,
      priority,
      hoursPlayed,
      rating,
      publicReviews: notes,
      recommendationSource,
    });

    // Show success feedback
    setTimeout(() => {
      setIsSaving(false);
      setSaveSuccess(true);
      setHasChanges(false);
      
      // Reload entry
      const updated = loadProgressData(gameId);
      if (updated) setData(updated);
      
      // Hide success after 2 seconds
      setTimeout(() => {
        setSaveSuccess(false);
      }, 2000);
    }, 300);
  }, [data, gameId, hoursPlayed, rating, status, priority, notes, recommendationSource]);

  // Star rating component
  const StarRating = ({ value, onChange }: { value: number; onChange: (v: number) => void }) => {
    const [hoverValue, setHoverValue] = useState(0);
    
    return (
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            className="p-0.5 transition-transform hover:scale-110"
            onMouseEnter={() => setHoverValue(star)}
            onMouseLeave={() => setHoverValue(0)}
            onClick={() => onChange(star === value ? 0 : star)}
          >
            <Star
              className={cn(
                "w-7 h-7 transition-colors",
                (hoverValue || value) >= star
                  ? "fill-yellow-400 text-yellow-400"
                  : "fill-transparent text-white/30 hover:text-white/50"
              )}
            />
          </button>
        ))}
        {value > 0 && (
          <span className="ml-2 text-sm text-white/60">
            {value}/5
          </span>
        )}
      </div>
    );
  };

  if (!data) {
    return (
      <div className="p-6">
        <MyProgressSkeleton />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with status badges */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={getStatusColor(status)}>
            {status}
          </Badge>
          <Badge variant="outline" className={getPriorityColor(priority)}>
            {priority} Priority
          </Badge>
        </div>
        <div className="text-sm text-white/50">
          Added {formatProgressDate(data.addedAt)}
        </div>
      </div>

      {/* Main form */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Left Column */}
        <div className="space-y-6">
          {/* Hours Played Slider */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-fuchsia-400" />
                Hours Played
              </Label>
              <span className="text-lg font-semibold text-fuchsia-400">
                {formatHours(hoursPlayed)}
              </span>
            </div>
            <Slider
              value={[hoursPlayed]}
              onValueChange={(values) => setHoursPlayed(values[0])}
              max={500}
              step={1}
              className="py-2"
            />
            <div className="flex justify-between text-xs text-white/40">
              <span>0 Hrs</span>
              <span>100 Hrs</span>
              <span>200 Hrs</span>
              <span>300 Hrs</span>
              <span>400 Hrs</span>
              <span>500+ Hrs</span>
            </div>
          </div>

          {/* Rating */}
          <div className="space-y-3">
            <Label className="flex items-center gap-2">
              <Star className="w-4 h-4 text-fuchsia-400" />
              Your Rating
            </Label>
            <StarRating value={rating} onChange={setRating} />
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

          {/* Priority */}
          <div className="space-y-2">
            <Label>Priority</Label>
            <Select
              value={priority}
              onValueChange={(value: GamePriority) => setPriority(value)}
            >
              <SelectTrigger className="bg-white/5 border-white/10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {priorityOptions.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          {/* Recommendation Source */}
          <div className="space-y-2">
            <Label>How did you discover this game?</Label>
            <Select
              value={recommendationSource}
              onValueChange={setRecommendationSource}
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

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Your Notes</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add personal notes, reviews, or thoughts about the game..."
              className="bg-white/5 border-white/10 min-h-[180px] resize-none"
            />
          </div>
        </div>
      </div>

      {/* Save Button */}
      <div className="flex items-center justify-end gap-3 pt-4 border-t border-white/10">
        {saveSuccess && (
          <div className="flex items-center gap-2 text-green-400 text-sm">
            <CheckCircle className="w-4 h-4" />
            Changes saved!
          </div>
        )}
        <Button
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
          className={cn(
            "bg-fuchsia-500 hover:bg-fuchsia-600 text-white",
            !hasChanges && "opacity-50"
          )}
        >
          {isSaving ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2" />
              Saving...
            </>
          ) : (
            <>
              <Save className="w-4 h-4 mr-2" />
              Save Changes
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
