/**
 * ML score post-processing.
 *
 * Raw P(recommended) from the model sits in a narrow band (the training base rate is
 * ~86%), so a raw weight would mostly encode "popular, well-reviewed". Converting to a
 * within-pool percentile keeps the layer discriminative; ties share their average rank.
 */

/** Percentile in [0,1] of each value among `values` (average rank for ties). Single value -> 0.5. */
export function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const out = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j++;
    const avg = (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out[order[k]] = avg;
    i = j + 1;
  }
  return out;
}

/** Median of finite numbers; 0 when empty. */
export function median(values: number[]): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Share of values equal to the most common (rounded to 3 dp) value — saturation check. */
export function modeShare(values: number[]): number {
  if (values.length === 0) return 0;
  const counts = new Map<string, number>();
  let max = 0;
  for (const v of values) {
    const k = v.toFixed(3);
    const c = (counts.get(k) ?? 0) + 1;
    counts.set(k, c);
    if (c > max) max = c;
  }
  return max / values.length;
}
