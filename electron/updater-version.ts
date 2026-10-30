/**
 * Semver-ish version comparison for the updater. Kept free of Electron imports so the alternate
 * download's temp-folder cleanup (updater-fallback.ts) can use it and tests can load it directly.
 */

/**
 * Parse a semver-like version string into { nums: [major, minor, patch], suffix }.
 * "v1.2.3-beta.1" → { nums: [1, 2, 3], suffix: 'beta.1' }
 * "1.2"           → { nums: [1, 2, 0], suffix: '' }
 * Non-numeric segments are treated as 0.
 */
function parseVersion(v: string): { nums: number[]; suffix: string } {
  const cleaned = v.replace(/^v/, '').trim();
  const dashIdx = cleaned.indexOf('-');
  const numericPart = dashIdx === -1 ? cleaned : cleaned.slice(0, dashIdx);
  const suffix = dashIdx === -1 ? '' : cleaned.slice(dashIdx + 1);
  const segments = numericPart.split('.').map((s) => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  });
  // Pad to at least 3 segments (major.minor.patch)
  while (segments.length < 3) segments.push(0);
  return { nums: segments, suffix };
}

/**
 * Returns true only when a is a higher version than b (e.g. 1.0.16 > 1.0.15).
 * Semver-aware:
 *   - Compares numeric segments (major.minor.patch) first.
 *   - When numeric segments are equal, a pre-release suffix ("-beta") is LESS
 *     than the same version without a suffix (1.0.0-beta < 1.0.0).
 *   - When both have suffixes, suffixes are compared lexicographically.
 */
export function isVersionGreater(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const na = pa.nums[i] ?? 0;
    const nb = pb.nums[i] ?? 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  // Numeric segments are equal — factor in the pre-release suffix.
  // Rule: pre-release < release. So:
  //   a has suffix, b does not  → a < b  → return false
  //   b has suffix, a does not  → a > b  → return true
  //   both have suffixes        → lexicographic compare
  //   neither has a suffix      → equal, not greater
  if (pa.suffix && !pb.suffix) return false;
  if (!pa.suffix && pb.suffix) return true;
  if (pa.suffix && pb.suffix) return pa.suffix > pb.suffix;
  return false;
}
