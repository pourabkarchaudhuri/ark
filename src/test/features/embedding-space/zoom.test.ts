import { describe, it, expect } from 'vitest';
import { computeZoomState, nextZone, D_FAR, D_NODE, D_SOLID } from '@/features/embedding-space/engine/zoom';

describe('Embedding Space zoom model', () => {
  it('shows only the GLTF cosmos beyond D_FAR', () => {
    const z = computeZoomState(5000);
    expect(z.gltfOpacity).toBe(1);
    expect(z.embedFade).toBe(0);
  });

  it('crossfades GLTF → embedding between D_SOLID and D_FAR', () => {
    const atSolid = computeZoomState(D_SOLID);
    expect(atSolid.gltfOpacity).toBeCloseTo(0.15);
    expect(atSolid.embedFade).toBeCloseTo(1);
    const mid = computeZoomState((D_SOLID + D_FAR) / 2);
    expect(mid.gltfOpacity).toBeGreaterThan(0.15);
    expect(mid.gltfOpacity).toBeLessThan(1);
    expect(mid.embedFade).toBeCloseTo(1 - (mid.gltfOpacity - 0.15) / 0.85, 5);
  });

  it('drops the embedding galaxy to a 10% backdrop inside node view', () => {
    const z = computeZoomState(D_NODE - 100);
    expect(z.gltfOpacity).toBe(0);
    expect(z.embedFade).toBeCloseTo(0.1);
  });

  it('is continuous across every boundary (no pops)', () => {
    for (const d of [D_NODE, D_SOLID, D_FAR]) {
      const a = computeZoomState(d - 0.01), b = computeZoomState(d + 0.01);
      expect(Math.abs(a.gltfOpacity - b.gltfOpacity)).toBeLessThan(0.01);
      expect(Math.abs(a.embedFade - b.embedFade)).toBeLessThan(0.01);
      expect(Math.abs(a.fov - b.fov)).toBeLessThan(0.05);
    }
  });

  it('places the depth-rail marker on the design stops', () => {
    expect(computeZoomState(6500).railTop).toBeCloseTo(0);
    expect(computeZoomState(D_FAR).railTop).toBeCloseTo(12);
    expect(computeZoomState(D_SOLID).railTop).toBeCloseTo(50);
    expect(computeZoomState(D_NODE).railTop).toBeCloseTo(86);
    expect(computeZoomState(50).railTop).toBeCloseTo(100);
    expect(computeZoomState(9000).railTop).toBe(0);
  });

  it('breathes the FOV during the approach and settles in node view', () => {
    expect(computeZoomState(D_FAR).fov).toBeCloseTo(52);
    expect(computeZoomState((D_FAR + D_NODE) / 2).fov).toBeCloseTo(61);
    expect(computeZoomState(D_NODE - 600).fov).toBeCloseTo(48);
  });

  it('applies hysteresis around the node boundary', () => {
    expect(nextZone(1500, 0.5, 'approach')).toBe('node');
    expect(nextZone(1650, 0.5, 'node')).toBe('node');
    expect(nextZone(1650, 0.5, 'approach')).toBe('approach');
    expect(nextZone(1750, 0.5, 'node')).toBe('approach');
    expect(nextZone(4500, 0, 'approach')).toBe('cosmos');
  });
});
