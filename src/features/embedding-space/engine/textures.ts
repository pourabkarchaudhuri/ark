import * as THREE from 'three';

let glowTexture: THREE.CanvasTexture | null = null;

/** Soft radial sprite shared by sun glows and the GLTF point cloud. */
export function getGlowTexture(): THREE.Texture {
  if (glowTexture) return glowTexture;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.08, 'rgba(255,255,255,0.7)');
  grad.addColorStop(0.22, 'rgba(255,255,255,0.25)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.06)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  glowTexture = new THREE.CanvasTexture(canvas);
  return glowTexture;
}

/**
 * Procedural equirect nebula — shown immediately as the skybox, then swapped
 * for the real skybox image once it loads.
 */
export function createNebulaTexture(): THREE.CanvasTexture {
  const w = 2048, h = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#020208';
  ctx.fillRect(0, 0, w, h);
  let seed = 1337;
  const rng = () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const palettes = [[168, 85, 247], [217, 70, 239], [34, 211, 238], [59, 130, 246], [244, 114, 182]];
  for (let i = 0; i < 30; i++) {
    const x = rng() * w, y = h * 0.2 + rng() * h * 0.6;
    const r = 120 + rng() * 420;
    const [cr, cg, cb] = palettes[Math.floor(rng() * palettes.length)];
    const a = 0.10 + rng() * 0.20;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
    grad.addColorStop(0.55, `rgba(${cr},${cg},${cb},${a * 0.35})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  for (let i = 0; i < 900; i++) {
    const x = rng() * w, y = rng() * h;
    const b = 0.15 + rng() * 0.5;
    ctx.fillStyle = `rgba(255,255,255,${b * 0.4})`;
    ctx.fillRect(x, y, rng() < 0.15 ? 2 : 1, 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
