import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// WebGL can't run in jsdom: stub the canvas and record what the loader is asked to do.
const gltf = vi.hoisted(() => {
  const fn = Object.assign(vi.fn(() => ({ nodes: {} })), { preload: vi.fn(), clear: vi.fn() });
  return { useGLTF: fn };
});
vi.mock('@react-three/drei', () => ({
  useGLTF: gltf.useGLTF,
  OrbitControls: () => null,
  PerspectiveCamera: () => null,
  Stars: () => null,
}));
vi.mock('@react-three/fiber', () => ({
  Canvas: () => <div data-testid="canvas" />,
  useFrame: () => {},
}));

import { Splash3DScene } from '@/components/splash-3d-scene';

describe('Splash3DScene', () => {
  it('preloads the planet without Draco or Meshopt decoders', () => {
    expect(gltf.useGLTF.preload).toHaveBeenCalledWith(expect.stringMatching(/scene\.glb$/), false, false);
  });

  it('drops the cached model when the splash unmounts', () => {
    const { unmount } = render(<Splash3DScene progressRef={{ current: 0 }} />);
    expect(gltf.useGLTF.clear).not.toHaveBeenCalled();
    unmount();
    expect(gltf.useGLTF.clear).toHaveBeenCalledTimes(1);
    expect(gltf.useGLTF.clear).toHaveBeenCalledWith(expect.stringMatching(/scene\.glb$/));
  });

  it('ships scene.glb uncompressed (no Draco extension, so no decoder workers or remote fetch)', () => {
    const glb = readFileSync(resolve(__dirname, '../../../public/scene.glb'));
    expect(glb.readUInt32LE(0)).toBe(0x46546c67); // 'glTF'
    const jsonLen = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8')) as {
      extensionsUsed?: string[]; extensionsRequired?: string[]; meshes: Array<{ primitives: Array<{ extensions?: object }> }>;
    };
    expect(json.extensionsUsed ?? []).not.toContain('KHR_draco_mesh_compression');
    expect(json.extensionsRequired ?? []).not.toContain('KHR_draco_mesh_compression');
    for (const m of json.meshes) for (const p of m.primitives) expect(p.extensions).toBeUndefined();
  });
});
