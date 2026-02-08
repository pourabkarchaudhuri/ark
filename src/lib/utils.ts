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

