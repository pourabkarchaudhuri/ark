/**
 * Custom Game Progress Dialog
 *
 * A full-screen-style modal that shows progress & tracking data for a
 * custom (non-Steam) game.  Covers all the fields that the regular
 * game-details "My Progress" tab has, adapted for CustomGameEntry.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Clock,
  Save,
  CheckCircle,
  Star,
  Gamepad2,
  FolderOpen,
  X,
  Activity,
  CalendarDays,
  Timer,
} from 'lucide-react';
import { CustomGameEntry, GameStatus, GameSession } from '@/types/game';
import { customGameStore } from '@/services/custom-game-store';
import { sessionStore } from '@/services/session-store';
import { cn, formatHours } from '@/lib/utils';

interface CustomGameProgressDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gameId: string; // custom game ID (e.g., "custom-1")
}

const statusOptions: GameStatus[] = [
  'Want to Play',
  'Playing',
  'Completed',
  'On Hold',
];

function formatDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatSessionDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'Min' : 'Mins'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hrLabel = h === 1 ? 'Hr' : 'Hrs';
  if (m === 0) return `${h} ${hrLabel}`;
  const minLabel = m === 1 ? 'Min' : 'Mins';
  return `${h} ${hrLabel} ${m} ${minLabel}`;
}

// ── Star rating component ──────────────────────────────────────────────────
function StarRating({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const [hover, setHover] = useState(0);

  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={() => onChange(value === star ? 0 : star)}
          onMouseEnter={() => setHover(star)}
          onMouseLeave={() => setHover(0)}
          className="p-0.5 transition-transform hover:scale-110"
        >
          <Star
            className={cn(
              'h-5 w-5 transition-colors',
              (hover || value) >= star
                ? 'text-amber-400 fill-amber-400'
                : 'text-white/20'
            )}
          />
        </button>
      ))}
      {value > 0 && (
        <span className="ml-1.5 text-xs text-white/50">{value}/5</span>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export function CustomGameProgressDialog({
  open,
  onOpenChange,
  gameId,
}: CustomGameProgressDialogProps) {
  // ---- Load entry --------------------------------------------------------
  const [entry, setEntry] = useState<CustomGameEntry | undefined>(undefined);
  const [status, setStatus] = useState<GameStatus>('Want to Play');
  const [hoursPlayed, setHoursPlayed] = useState(0);
  const [rating, setRating] = useState(0);
  const [executablePath, setExecutablePath] = useState<string | undefined>(undefined);

  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Stable callbacks for child components
  const handleStatusChange = useCallback((v: string) => setStatus(v as GameStatus), []);
  const handleHoursChange = useCallback((v: number[]) => setHoursPlayed(v[0]), []);
  const handleClearExecutable = useCallback(() => setExecutablePath(undefined), []);

  // Re-sync from store whenever the dialog opens or gameId changes
  useEffect(() => {
    if (!open) return;
    const loaded = customGameStore.getGame(gameId);
    if (loaded) {
      setEntry(loaded);
      setStatus(loaded.status);
      setHoursPlayed(loaded.hoursPlayed ?? 0);
      setRating(0); // CustomGameEntry has no rating field yet — default 0
      setExecutablePath(loaded.executablePath);
    }
  }, [open, gameId]);

  // ---- Sessions ----------------------------------------------------------
  const sessions: GameSession[] = useMemo(() => {
    if (!open) return [];
    return sessionStore.getForGame(gameId);
  }, [open, gameId]);

  const sessionCount = sessions.length;
  const trackedHours = useMemo(
    () => sessionStore.getTotalHours(gameId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, gameId]
  );

  const lastSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;

  // ---- Change detection --------------------------------------------------
  useEffect(() => {
    if (!entry) return;
    const changed =
      status !== entry.status ||
      hoursPlayed !== (entry.hoursPlayed ?? 0) ||
      executablePath !== entry.executablePath;
    setHasChanges(changed);
  }, [entry, status, hoursPlayed, executablePath]);

  // ---- Save --------------------------------------------------------------
  const handleSave = useCallback(() => {
    if (!entry) return;
    setIsSaving(true);

    customGameStore.updateGame(gameId, {
      status,
      hoursPlayed,
      executablePath,
    });

    setTimeout(() => {
      setIsSaving(false);
      setSaveSuccess(true);
      setHasChanges(false);

      const updated = customGameStore.getGame(gameId);
      if (updated) setEntry(updated);

      setTimeout(() => setSaveSuccess(false), 2000);
    }, 300);
  }, [entry, gameId, status, hoursPlayed, executablePath]);

  // ---- Browse executable -------------------------------------------------
  const handleBrowseExecutable = useCallback(async () => {
    try {
      if (window.fileDialog?.selectExecutable) {
        const result = await window.fileDialog.selectExecutable();
        if (result.success && result.filePath) {
          setExecutablePath(result.filePath);
        }
      }
    } catch (err) {
      console.error('Failed to select executable:', err);
    }
  }, []);

  if (!entry) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-fuchsia-500/20">
              <Gamepad2 className="h-5 w-5 text-fuchsia-400" />
            </div>
            <div>
              <DialogTitle className="text-lg">{entry.title}</DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                Custom Game &middot; Added {formatDate(entry.addedAt)}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Scrollable body */}
        <div className="flex-1 min-h-0 overflow-y-auto space-y-5 pr-1">
          {/* ── Stat cards row ────────────────────────────────────── */}
          <div className="grid grid-cols-3 gap-3">
            {/* Total Playtime */}
            <div className="rounded-lg bg-white/5 border border-white/10 p-3 text-center">
              <Clock className="h-4 w-4 text-cyan-400 mx-auto mb-1" />
              <p className="text-lg font-bold text-cyan-400 font-['Orbitron']">
                {formatHours(trackedHours || hoursPlayed)}
              </p>
              <p className="text-[10px] text-white/40">playtime</p>
            </div>

            {/* Sessions */}
            <div className="rounded-lg bg-white/5 border border-white/10 p-3 text-center">
              <Activity className="h-4 w-4 text-emerald-400 mx-auto mb-1" />
              <p className="text-lg font-bold text-emerald-400 font-['Orbitron']">
                {sessionCount}
              </p>
              <p className="text-[10px] text-white/40">sessions</p>
            </div>

            {/* Last Played */}
            <div className="rounded-lg bg-white/5 border border-white/10 p-3 text-center">
              <CalendarDays className="h-4 w-4 text-amber-400 mx-auto mb-1" />
              <p className="text-sm font-semibold text-amber-400 mt-0.5">
                {lastSession ? formatDate(lastSession.endTime) : '—'}
              </p>
              <p className="text-[10px] text-white/40">last played</p>
            </div>
          </div>

          {/* ── Play Status ───────────────────────────────────────── */}
          <div className="space-y-2">
            <Label>Play Status</Label>
            <Select
              value={status}
              onValueChange={handleStatusChange}
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

          {/* ── Hours Played Slider ───────────────────────────────── */}
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
              onValueChange={handleHoursChange}
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

          {/* ── Rating ────────────────────────────────────────────── */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Star className="w-4 h-4 text-amber-400" />
              Rating
            </Label>
            <StarRating value={rating} onChange={setRating} />
          </div>

          {/* ── Executable Path ────────────────────────────────────── */}
          <div className="space-y-2 min-w-0">
            <Label className="flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-blue-400" />
              Game Executable
            </Label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleBrowseExecutable}
                className="border-white/10 hover:bg-white/10 flex items-center gap-1.5"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                Browse...
              </Button>
              {executablePath && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleClearExecutable}
                  className="text-red-400 hover:text-red-300 hover:bg-red-500/10 px-2"
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
            {executablePath ? (
              <p
                className="text-xs text-white/40 truncate"
                title={executablePath}
              >
                {executablePath}
              </p>
            ) : (
              <p className="text-xs text-white/30">
                No executable selected — browse to enable session tracking
              </p>
            )}
          </div>

          {/* ── Platforms ──────────────────────────────────────────── */}
          {entry.platform.length > 0 && (
            <div className="space-y-2">
              <Label className="text-white/50 text-xs">Platforms</Label>
              <div className="flex flex-wrap gap-1.5">
                {entry.platform.map((p) => (
                  <span
                    key={p}
                    className="px-2 py-0.5 text-[11px] rounded-md bg-white/5 border border-white/10 text-white/60"
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* ── Recent Sessions ────────────────────────────────────── */}
          {sessions.length > 0 && (
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Timer className="w-4 h-4 text-purple-400" />
                Recent Sessions
              </Label>
              <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                {[...sessions]
                  .reverse()
                  .slice(0, 10)
                  .map((s, i) => (
                    <div
                      key={s.id || i}
                      className="flex items-center justify-between px-3 py-2 rounded-md bg-white/5 text-xs"
                    >
                      <span className="text-white/60">
                        {formatDate(s.startTime)}
                      </span>
                      <span className="text-white/80 font-medium">
                        {formatSessionDuration(s.durationMinutes)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Footer: Save ────────────────────────────────────────── */}
        <div className="flex-shrink-0 flex items-center justify-end gap-3 pt-3 mt-2 border-t border-white/5">
          {saveSuccess && (
            <span className="flex items-center gap-1.5 text-xs text-emerald-400">
              <CheckCircle className="w-3.5 h-3.5" />
              Saved
            </span>
          )}
          <Button
            onClick={handleSave}
            disabled={!hasChanges || isSaving}
            className={cn(
              'gap-1.5 transition-all',
              hasChanges
                ? 'bg-fuchsia-500 hover:bg-fuchsia-600 text-white'
                : 'bg-white/10 text-white/40'
            )}
          >
            {isSaving ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save Changes
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
