/**
 * Shared title/name collator. `a.localeCompare(b, undefined, { sensitivity: 'base' })` builds a
 * new collator on every comparison — sorting the ~155k Steam app list that way took ~19 s in the
 * main process versus ~0.5 s with one reused Intl.Collator. Same locale and options, same order.
 *
 * Imported by both the renderer and the main process (listed in tsconfig.node.json).
 */
export const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base' });

/** Case- and accent-insensitive A–Z comparator (drop-in for the options-form localeCompare). */
export function compareTitles(a: string, b: string): number {
  return titleCollator.compare(a, b);
}
