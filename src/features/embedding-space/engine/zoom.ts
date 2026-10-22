/**
 * Camera-distance zone model (Cosmos → Approach → Node). Pure math so it can
 * be unit-tested; the engine calls it once per frame with d = |camera|.
 */

export type Zone = 'cosmos' | 'approach' | 'node';

export const D_NODE = 1450;
export const D_SOLID = 1980;
export const D_FAR = 4200;
/** Resting distance the approach magnet snaps to, and that "APPROACH" flies to. */
export const APPROACH_REST = 2050;
/** Resting distance for the "NODE" rail button. */
export const NODE_REST = 1250;
export const COSMOS_CAM: [number, number, number] = [0, 900, 4700];

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export interface ZoomState {
  /** GLTF cosmos opacity before its intro fade multiplier. */
  gltfOpacity: number;
  /** Embedding-galaxy fade (10% backdrop floor inside node view). */
  embedFade: number;
  /** FOV without flight FX. */
  fov: number;
  /** Tone-mapping exposure without flight FX. */
  exposure: number;
  /** Depth-rail marker position, percent from top. */
  railTop: number;
}

// Piecewise rail: 6500→0%, D_FAR→12% (COSMOS), D_SOLID→50% (APPROACH), D_NODE→86% (NODE), 50→100%
const RAIL_STOPS: ReadonlyArray<readonly [number, number]> = [[6500, 0], [D_FAR, 12], [D_SOLID, 50], [D_NODE, 86], [50, 100]];

export function computeZoomState(d: number): ZoomState {
  let gltfOpacity: number, embedFade: number;
  if (d >= D_FAR) { gltfOpacity = 1; embedFade = 0; }
  else if (d >= D_SOLID) {
    const s = smooth((d - D_SOLID) / (D_FAR - D_SOLID));
    gltfOpacity = 0.15 + s * 0.85;
    embedFade = 1 - s;
  } else if (d >= D_NODE) {
    const s = smooth((d - D_NODE) / (D_SOLID - D_NODE));
    gltfOpacity = s * 0.15;
    embedFade = 0.1 + s * 0.9;
  } else { gltfOpacity = 0; embedFade = 0.1; }

  // Dolly-zoom breath: FOV opens during the approach, settles in node view
  const ap = clamp01((D_FAR - d) / (D_FAR - D_NODE));
  const fov = 52 + 9 * Math.sin(Math.PI * ap) - 4 * clamp01((D_NODE - d) / 600);
  const nodeness = clamp01((D_NODE - d) / 500);
  const exposure = 1.0 - 0.14 * Math.sin(Math.PI * ap) + 0.05 * nodeness;

  let railTop = 100;
  for (let i = 0; i < RAIL_STOPS.length - 1; i++) {
    const [d0, p0] = RAIL_STOPS[i], [d1, p1] = RAIL_STOPS[i + 1];
    if (d <= d0 && d >= d1) { railTop = p0 + (p1 - p0) * ((d0 - d) / (d0 - d1)); break; }
  }
  if (d > 6500) railTop = 0;

  return { gltfOpacity, embedFade, fov, exposure, railTop };
}

/** Zone with hysteresis around the Game Node View boundary (enter < 1550, leave > 1700). */
export function nextZone(d: number, embedFade: number, prev: Zone): Zone {
  if (d < 1550) return 'node';
  if (d <= 1700 && prev === 'node') return 'node';
  if (embedFade <= 0.02) return 'cosmos';
  return 'approach';
}
