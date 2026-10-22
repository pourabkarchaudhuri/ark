/**
 * Stellar classification + colour helpers shared by the engine and the
 * narrator layer. Pure functions, no three.js dependency.
 */

export type StellarClass =
  | 'Quasar'           // top PR + high hub  — canonical entry point
  | 'Pulsar'           // top PR + low hub   — cult masterpiece
  | 'Hypergiant'       // top PR + high luminance — universally adored heavy
  | 'NeutronStar'      // high authority + small community — niche-cluster icon
  | 'MDwarf';          // everything else in the top 50

export const STELLAR_CLASS_LABELS: Record<StellarClass, string> = {
  Quasar: 'Q-class Quasar',
  Pulsar: 'P-IV Pulsar',
  Hypergiant: 'O-class Hypergiant',
  NeutronStar: 'N-II Neutron Star',
  MDwarf: 'M-IV Crimson Dwarf',
};

export const STELLAR_CLASS_BLURBS: Record<StellarClass, string> = {
  Quasar: 'Bright across every map. The canonical entry point.',
  Pulsar: 'Burns hot in its own corner of the field. A cult masterpiece.',
  Hypergiant: 'Massive, universally adored. The gravity well its genre orbits.',
  NeutronStar: 'Tight, dense, devoted following. A niche-cluster icon.',
  MDwarf: 'Steady warm light. Notable in this region of the cosmos.',
};

export const STELLAR_CLASS_RGB: Record<StellarClass, [number, number, number]> = {
  Quasar: [0.75, 0.85, 1.00],
  Pulsar: [0.65, 0.40, 1.00],
  Hypergiant: [1.00, 0.92, 0.65],
  NeutronStar: [0.55, 0.95, 1.00],
  MDwarf: [1.00, 0.55, 0.45],
};

/**
 * Classify a node's stellar type for flavour copy. Inputs are pre-normalised
 * (0..1 except community size, which is a raw count).
 */
export function stellarClassify(
  prNorm: number,
  authNorm: number,
  hubNorm: number,
  luminance: number,
  communitySize: number,
): StellarClass {
  if (prNorm >= 0.92) {
    if (luminance >= 0.78) return 'Hypergiant';
    if (hubNorm >= 0.70) return 'Quasar';
    if (hubNorm <= 0.35) return 'Pulsar';
  }
  if (authNorm >= 0.75 && communitySize > 0 && communitySize < 80) return 'NeutronStar';
  return 'MDwarf';
}

/** Golden-angle HSL → RGB for Louvain community ids (maximally distinct adjacent hues). */
export function communityHueToRGB(communityId: number, out: Float32Array, offset: number): void {
  if (communityId < 0) {
    out[offset] = 0.6; out[offset + 1] = 0.6; out[offset + 2] = 0.62;
    return;
  }
  const h = ((communityId * 137.508) % 360) / 360;
  const s = 0.62, l = 0.58;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 1 / 6) { r = c; g = x; }
  else if (h < 2 / 6) { r = x; g = c; }
  else if (h < 3 / 6) { g = c; b = x; }
  else if (h < 4 / 6) { g = x; b = c; }
  else if (h < 5 / 6) { r = x; b = c; }
  else { r = c; b = x; }
  out[offset] = r + m; out[offset + 1] = g + m; out[offset + 2] = b + m;
}

/** djb2 → [0, 1) phase so twinkles / pulses don't fire in lockstep. */
export function hashPhase(id: string): number {
  let h = 5381;
  for (let k = 0; k < id.length; k++) h = ((h << 5) + h + id.charCodeAt(k)) >>> 0;
  return (h % 1000) / 1000;
}
