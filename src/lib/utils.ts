import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Hardcoded cover image overrides for games whose API-provided images
 * are missing or broken. Maps normalised (lowercase) game titles to
 * a local asset path served from /public.
 */
const HARDCODED_COVERS: Record<string, string> = {
  'battlefield 6': '/images/battlefield-6-cover.png',
  'battlefield™ 6': '/images/battlefield-6-cover.png',
};

/** Return a hardcoded cover URL for a game title, or undefined if none exists. */
export function getHardcodedCover(title: string): string | undefined {
  return HARDCODED_COVERS[title.toLowerCase()];
}

/**
 * Format a decimal-hours value (e.g. 1.52) into a human-friendly
 * hours-and-minutes string.
 *
 * Examples:
 *   0      → "0m"
 *   0.25   → "15m"
 *   1      → "1h"
 *   1.5    → "1h 30m"
 *   2.02   → "2h 1m"
 *   120.75 → "120h 45m"
 */
export function formatHours(decimalHours: number): string {
  if (decimalHours <= 0) return '0m';
  const totalMinutes = Math.round(decimalHours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

