/**
 * Edit Progress Dialog
 *
 * Unified "Edit Library Entry" dialog for ALL game types (Steam, Epic, custom).
 * Renders the shared MyProgressTab inside a dialog with a game-info header.
 * The game's title, cover image, and "added at" date are resolved from the
 * appropriate store automatically based on the gameId prefix.
 */

import { useState, useEffect, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Library, Gamepad2 } from 'lucide-react';
import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';
import { MyProgressTab } from '@/components/my-progress-tab';

interface EditProgressDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gameId: string;
  /** Optional game title — avoids internal lookup when the caller already has it */
  gameTitle?: string;
  /** Optional cover image URL for the header */
  coverUrl?: string;
}

const STEAM_CDN = 'https://cdn.akamai.steamstatic.com/steam/apps';

function isCustomId(id: string): boolean {
  return id.startsWith('custom-');
}

function formatDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Generate a deterministic gradient from a title string */
function headerGradient(title: string): string {
  const hash = title.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const hue = hash % 360;
  return `linear-gradient(135deg, hsl(${hue}, 50%, 20%) 0%, hsl(${(hue + 60) % 360}, 50%, 10%) 100%)`;
}

/** Get up to 2 initials from a title */
function initials(title: string): string {
  return title
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

export function EditProgressDialog({
  open,
  onOpenChange,
  gameId,
  gameTitle: titleProp,
  coverUrl: coverProp,
}: EditProgressDialogProps) {
  const [title, setTitle] = useState(titleProp ?? '');
  const [addedAt, setAddedAt] = useState<Date | null>(null);
  const [coverUrl, setCoverUrl] = useState(coverProp ?? '');
  const [imgError, setImgError] = useState(false);

  const isCustom = useMemo(() => isCustomId(gameId), [gameId]);

  // Resolve game info from the correct store whenever the dialog opens
  useEffect(() => {
    if (!open) return;
    setImgError(false);

    if (isCustom) {
      const entry = customGameStore.getGame(gameId);
      if (entry) {
        setTitle(titleProp ?? entry.title);
        setAddedAt(
          entry.addedAt instanceof Date ? entry.addedAt : new Date(entry.addedAt),
        );
        setCoverUrl(coverProp ?? '');
      }
    } else {
      const libEntry = libraryStore.getEntry(gameId);
      if (libEntry) {
        setAddedAt(
          libEntry.addedAt instanceof Date
            ? libEntry.addedAt
            : new Date(libEntry.addedAt),
        );

        const meta = libEntry.cachedMeta;
        if (meta) {
          setTitle(titleProp ?? meta.title ?? '');
          // Build cover URL from cached metadata
          if (coverProp) {
            setCoverUrl(coverProp);
          } else if (meta.coverUrl) {
            setCoverUrl(meta.coverUrl);
          } else if (meta.headerImage) {
            setCoverUrl(meta.headerImage);
          } else if (meta.steamAppId) {
            setCoverUrl(`${STEAM_CDN}/${meta.steamAppId}/library_600x900.jpg`);
          } else {
            setCoverUrl('');
          }
        } else {
          // No cached meta — try to infer from gameId
          setTitle(titleProp ?? '');
          const steamMatch = gameId.match(/^steam-(\d+)/);
          if (steamMatch) {
            setCoverUrl(`${STEAM_CDN}/${steamMatch[1]}/library_600x900.jpg`);
          } else {
            setCoverUrl('');
          }
        }
      }
    }
  }, [open, gameId, isCustom, titleProp, coverProp]);

  const storeLabel = isCustom
    ? 'Custom Game'
    : gameId.startsWith('epic-')
      ? 'Epic Games'
      : 'Steam';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center gap-3">
            {/* Cover thumbnail */}
            {coverUrl && !imgError ? (
              <div className="flex-shrink-0 w-14 h-20 rounded-lg overflow-hidden bg-white/10">
                <img
                  src={coverUrl}
                  alt={title}
                  className="w-full h-full object-cover"
                  onError={() => setImgError(true)}
                />
              </div>
            ) : title ? (
              <div
                className="flex-shrink-0 w-14 h-20 rounded-lg overflow-hidden flex items-center justify-center"
                style={{ background: headerGradient(title) }}
              >
                <span className="text-white/60 font-bold text-sm">
                  {initials(title)}
                </span>
              </div>
            ) : (
              <div className="p-2 rounded-lg bg-fuchsia-500/20">
                {isCustom ? (
                  <Gamepad2 className="h-5 w-5 text-fuchsia-400" />
                ) : (
                  <Library className="h-5 w-5 text-fuchsia-400" />
                )}
              </div>
            )}

            <div className="min-w-0">
              <DialogTitle className="text-lg leading-tight line-clamp-2">
                {title || 'Edit Library Entry'}
              </DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                {storeLabel}
                {addedAt ? ` · Added ${formatDate(addedAt)}` : ''}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Scrollable body — MyProgressTab handles all progress fields */}
        <div className="flex-1 min-h-0 overflow-y-auto pr-1">
          <MyProgressTab gameId={gameId} gameName={title} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
