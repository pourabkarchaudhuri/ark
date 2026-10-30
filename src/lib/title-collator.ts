/**
 * Shared title collator (1.0.97). `a.localeCompare(b, undefined, { sensitivity: 'base' })` builds
 * a new collator on every comparison (~90x slower than reusing one), which made the library
 * status sort block render for tens of ms per click. Same locale and options, so the order is
 * identical. Plain no-argument localeCompare calls are already fast and stay as they are.
 */
export const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base' });
