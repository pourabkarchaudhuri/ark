/**
 * Lasso Geometry — Phase 3.0 capture-only Lasso.
 *
 * Winding-number point-in-polygon. Robust for concave + self-intersecting paths
 * (unlike crossing-number, which mis-counts on self-overlap).
 *
 * Coordinates are screen-space (Y down) but the algorithm is parity-invariant —
 * any consistent 2D space works.
 */

export interface LassoPoint {
  x: number;
  y: number;
}

/**
 * Winding number test. Returns true when the point is inside the polygon
 * regardless of fill rule peculiarities of self-intersection.
 *
 * If `polygon` has fewer than 3 vertices, returns false.
 */
export function pointInPolygonWinding(p: LassoPoint, polygon: readonly LassoPoint[]): boolean {
  const n = polygon.length;
  if (n < 3) return false;
  let wn = 0;
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    if (a.y <= p.y) {
      if (b.y > p.y) {
        // upward crossing
        if (isLeft(a, b, p) > 0) wn++;
      }
    } else if (b.y <= p.y) {
      // downward crossing
      if (isLeft(a, b, p) < 0) wn--;
    }
  }
  return wn !== 0;
}

/** Cross product sign — >0 left, =0 on, <0 right of line AB. */
function isLeft(a: LassoPoint, b: LassoPoint, p: LassoPoint): number {
  return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
}

/**
 * Total path length — used to decide if the lasso is closed enough to commit
 * (gesture closes when the user releases with end-to-start distance below some threshold,
 * or has drawn enough perimeter to be meaningful).
 */
export function pathLength(points: readonly LassoPoint[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

/**
 * Format the polygon as an SVG path string for the overlay.
 * Auto-closes if `closed` is true.
 */
export function toSvgPath(points: readonly LassoPoint[], closed = false): string {
  if (points.length === 0) return '';
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i].x} ${points[i].y}`;
  if (closed) d += ' Z';
  return d;
}

/**
 * Build a screen-space-projected node list from world positions for one batch P-in-P test.
 * Returns indices of nodes whose projected (x, y) falls inside the polygon.
 * The caller supplies projection results; this keeps the service free of Three.js dependency.
 */
export function findNodesInsidePolygon(
  projected: ReadonlyArray<{ x: number; y: number; behindCamera: boolean }>,
  polygon: readonly LassoPoint[],
): number[] {
  const inside: number[] = [];
  for (let i = 0; i < projected.length; i++) {
    const p = projected[i];
    if (p.behindCamera) continue;
    if (pointInPolygonWinding(p, polygon)) inside.push(i);
  }
  return inside;
}

/**
 * Simplify a path with Douglas-Peucker-lite. Reduces vertices for smoother drawing
 * + cheaper P-in-P. Tolerance in pixels.
 */
export function simplifyPath(points: readonly LassoPoint[], tolerance = 3): LassoPoint[] {
  if (points.length <= 2) return [...points];
  const out: LassoPoint[] = [points[0]];
  let last = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const dx = points[i].x - last.x;
    const dy = points[i].y - last.y;
    if (Math.sqrt(dx * dx + dy * dy) >= tolerance) {
      out.push(points[i]);
      last = points[i];
    }
  }
  out.push(points[points.length - 1]);
  return out;
}
