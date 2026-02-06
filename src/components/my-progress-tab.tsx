/**
 * My Progress Tab Component
 * Displays and allows editing of user's progress for a library game
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
import { LibraryGameEntry, GameStatus, GamePriority } from '@/types/game';
import { libraryStore } from '@/services/library-store';
import { cn } from '@/lib/utils';

interface MyProgressTabProps {
  gameId: number;
  gameName?: string; // Reserved for future use (display purposes)
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
    case 'Dropped':
      return 'bg-red-500/20 text-red-400 border-red-500/30';
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

export function MyProgressTab({ gameId, gameName: _gameName }: MyProgressTabProps) {
  // gameName is available for future use (e.g., display in the header)
  void _gameName;
  const [entry, setEntry] = useState<LibraryGameEntry | null>(null);
  const [hoursPlayed, setHoursPlayed] = useState(0);
  const [rating, setRating] = useState(0);
  const [status, setStatus] = useState<GameStatus>('Want to Play');
  const [priority, setPriority] = useState<GamePriority>('Medium');
  const [notes, setNotes] = useState('');
  const [recommendationSource, setRecommendationSource] = useState('Personal Discovery');
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Load entry data
  useEffect(() => {
    const loadedEntry = libraryStore.getEntry(gameId);
    if (loadedEntry) {
      setEntry(loadedEntry);
      setHoursPlayed(loadedEntry.hoursPlayed || 0);
      setRating(loadedEntry.rating || 0);
      setStatus(loadedEntry.status);
      setPriority(loadedEntry.priority);
      setNotes(loadedEntry.publicReviews || '');
      setRecommendationSource(loadedEntry.recommendationSource || 'Personal Discovery');
    }
  }, [gameId]);

  // Track changes
  useEffect(() => {
    if (!entry) return;
    const changed =
      hoursPlayed !== (entry.hoursPlayed || 0) ||
      rating !== (entry.rating || 0) ||
      status !== entry.status ||
      priority !== entry.priority ||
      notes !== (entry.publicReviews || '') ||
      recommendationSource !== (entry.recommendationSource || 'Personal Discovery');
    setHasChanges(changed);
  }, [entry, hoursPlayed, rating, status, priority, notes, recommendationSource]);

  // Save changes
  const handleSave = useCallback(() => {
    if (!entry) return;
    
    setIsSaving(true);
    
    libraryStore.updateEntry(gameId, {
      hoursPlayed,
      rating,
      status,
      priority,
      publicReviews: notes,
      recommendationSource,
    });

    // Show success feedback
    setTimeout(() => {
      setIsSaving(false);
      setSaveSuccess(true);
      setHasChanges(false);
      
      // Reload entry
      const updatedEntry = libraryStore.getEntry(gameId);
      if (updatedEntry) {
        setEntry(updatedEntry);
      }
      
      // Hide success after 2 seconds
      setTimeout(() => {
        setSaveSuccess(false);
      }, 2000);
    }, 300);
  }, [entry, gameId, hoursPlayed, rating, status, priority, notes, recommendationSource]);

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

  if (!entry) {
    return (
      <div className="p-6 text-center text-white/60">
        Loading progress data...
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
          Added {new Date(entry.addedAt).toLocaleDateString()}
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
                {hoursPlayed}h
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
              <span>0h</span>
              <span>100h</span>
              <span>200h</span>
              <span>300h</span>
              <span>400h</span>
              <span>500h+</span>
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
