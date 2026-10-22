import * as THREE from 'three';
import type { NeighborInfo } from '@/services/galaxy-cache';

interface PlanetSpec {
  ring: number; size: number; kind: 'rock' | 'gas' | 'ice';
  colors: string[]; a: number; w: number; ringed?: boolean;
}

interface OrbitShared {
  ringGeo: THREE.BufferGeometry;
  tilts: Array<[number, number]>;
  planetSpecs: PlanetSpec[];
  textures: THREE.CanvasTexture[];
  sphereGeo: THREE.SphereGeometry;
  bandGeo: THREE.RingGeometry;
}

interface OrbitPlanet {
  spec: PlanetSpec; holder: THREE.Object3D; mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial; ringMesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> | null;
}

export interface OrbitSystem {
  group: THREE.Group;
  rings: THREE.Group[];
  ringMats: THREE.LineBasicMaterial[];
  planets: OrbitPlanet[];
  light: THREE.PointLight | null;
  pos: THREE.Vector3;
  o: number;
  target: number;
}

function buildShared(): OrbitShared {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 192; i++) { const a = i / 192 * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a))); }
  const ringGeo = new THREE.BufferGeometry().setFromPoints(pts);
  const tilts: Array<[number, number]> = [[1.25, 0.1], [1.4, -0.3], [1.05, 0.42]];
  const planetSpecs: PlanetSpec[] = [
    { ring: 0, size: 0.45, kind: 'rock', colors: ['#b5694a', '#7a3f2c', '#d49a72'], a: 0.4, w: 0.07 },
    { ring: 1, size: 0.85, kind: 'gas', colors: ['#d8c39a', '#a77b4f', '#efe2c4', '#8a5f3a'], a: 2.2, w: 0.045 },
    { ring: 1, size: 0.35, kind: 'ice', colors: ['#cfe6f2', '#8fb4cc', '#ffffff'], a: 5.1, w: 0.055 },
    { ring: 2, size: 1.0, kind: 'gas', colors: ['#7fa6c9', '#3f6a96', '#bcd6ea', '#2c4c70'], a: 1.1, w: 0.028, ringed: true },
    { ring: 2, size: 0.5, kind: 'rock', colors: ['#6f7d6a', '#4a5546', '#9aa58f'], a: 3.9, w: 0.035 },
  ];
  const planetTex = (spec: PlanetSpec) => {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
    const ctx = cv.getContext('2d')!;
    let seed = Math.floor(spec.a * 1000) + 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    ctx.fillStyle = spec.colors[0]; ctx.fillRect(0, 0, 256, 128);
    if (spec.kind === 'gas') {
      for (let y = 0; y < 128; y += 2 + Math.floor(rnd() * 6)) {
        ctx.globalAlpha = 0.25 + rnd() * 0.5;
        ctx.fillStyle = spec.colors[Math.floor(rnd() * spec.colors.length)];
        ctx.fillRect(0, y, 256, 2 + rnd() * 7);
      }
    } else {
      for (let i = 0; i < 220; i++) {
        ctx.globalAlpha = 0.15 + rnd() * 0.35;
        ctx.fillStyle = spec.colors[Math.floor(rnd() * spec.colors.length)];
        ctx.beginPath(); ctx.ellipse(rnd() * 256, rnd() * 128, 3 + rnd() * 18, 2 + rnd() * 9, rnd() * 3, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  };
  return {
    ringGeo, tilts, planetSpecs, textures: planetSpecs.map(planetTex),
    sphereGeo: new THREE.SphereGeometry(1, 32, 16), bandGeo: new THREE.RingGeometry(1.4, 2.3, 64),
  };
}

/**
 * Per-star similarity orbit systems (rings + small lit planets). Pooled so the
 * previous and next star can both show theirs during a hop. Lights never
 * enter/leave the scene — adding lights recompiles every lit material and
 * caused hitches — they're pooled and dimmed instead.
 */
export class OrbitLayer {
  private shared = buildShared();
  private systems: OrbitSystem[] = [];
  private preview: OrbitSystem | null = null;
  private lights: THREE.PointLight[];
  private keepAlive: THREE.Material[] = [];

  constructor(private scene: THREE.Scene) {
    this.lights = [0, 1, 2].map(() => {
      const l = new THREE.PointLight(0xfff1e0, 0, 0, 0);
      l.userData.busy = false;
      scene.add(l);
      return l;
    });
  }

  private make(pos: THREE.Vector3, radii: number[]): OrbitSystem {
    const sh = this.shared;
    const group = new THREE.Group();
    const ringMats: THREE.LineBasicMaterial[] = [], rings: THREE.Group[] = [];
    for (let ri = 0; ri < 3; ri++) {
      const m = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
      const g = new THREE.Group(); g.rotation.set(sh.tilts[ri][0], 0, sh.tilts[ri][1]); g.add(new THREE.Line(sh.ringGeo, m));
      const rr = Math.max(6, Math.min(radii[ri] || radii[0], 28 + ri * 16));
      g.scale.setScalar(rr); g.userData.radius = rr;
      group.add(g); rings.push(g); ringMats.push(m);
    }
    const planets: OrbitPlanet[] = sh.planetSpecs.map((spec, k) => {
      const mat = new THREE.MeshStandardMaterial({ map: sh.textures[k], roughness: 0.92, metalness: 0, transparent: true, opacity: 0 });
      const mesh = new THREE.Mesh(sh.sphereGeo, mat); mesh.rotation.z = 0.3;
      const holder = new THREE.Object3D(); holder.add(mesh);
      let ringMesh: OrbitPlanet['ringMesh'] = null;
      if (spec.ringed) {
        ringMesh = new THREE.Mesh(sh.bandGeo, new THREE.MeshBasicMaterial({ color: 0xd9cdb4, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
        ringMesh.rotation.x = Math.PI / 2 - 0.45; holder.add(ringMesh);
      }
      holder.scale.setScalar(spec.size / rings[spec.ring].userData.radius);
      rings[spec.ring].add(holder);
      return { spec, holder, mesh, mat, ringMesh };
    });
    const light = this.lights.find(l => !l.userData.busy) || null;
    if (light) { light.userData.busy = true; light.position.copy(pos); light.intensity = 0; }
    group.position.copy(pos);
    group.visible = false;
    this.scene.add(group);
    const sys: OrbitSystem = { group, rings, ringMats, planets, light, pos: pos.clone(), o: 0, target: 1 };
    this.systems.push(sys);
    return sys;
  }

  private disposeSystem(sys: OrbitSystem) {
    if (sys.light) { sys.light.userData.busy = false; sys.light.intensity = 0; }
    this.scene.remove(sys.group);
    sys.ringMats.forEach(m => m.dispose());
    for (const p of sys.planets) { p.mat.dispose(); if (p.ringMesh) p.ringMesh.material.dispose(); }
  }

  /** Fade every system out (they dispose themselves once invisible). */
  fadeAll() { for (const sy of this.systems) sy.target = 0; }

  set(neighborList: NeighborInfo[], at: THREE.Vector3 | null, opts: { preview?: boolean } = {}): OrbitSystem | null {
    const sp = at;
    const list = neighborList.filter(nb => nb.node);
    if (!sp || list.length === 0) { this.fadeAll(); return null; }
    // Promote a matching preview (built during the flight) instead of rebuilding — no pop on arrival
    if (!opts.preview && this.preview && this.preview.target === 1 && this.preview.pos.distanceTo(sp) < 0.01) {
      const keep = this.preview; this.preview = null;
      for (const sy of this.systems) if (sy !== keep) sy.target = 0;
      return keep;
    }
    const ds = list.map(nb => {
      const n = nb.node!;
      const dx = n.x - sp.x, dy = n.y - sp.y, dz = n.z - sp.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }).sort((a, b) => a - b);
    const third = Math.max(1, Math.floor(ds.length / 3));
    const avg = (arr: number[]) => arr.reduce((x, y) => x + y, 0) / Math.max(1, arr.length);
    const radii = [avg(ds.slice(0, third)), avg(ds.slice(third, third * 2)), avg(ds.slice(third * 2))];
    if (opts.preview) {
      if (this.preview) this.preview.target = 0;
      this.preview = this.make(sp, radii);
      return this.preview;
    }
    for (const sy of this.systems) sy.target = 0;
    if (this.preview) this.preview = null;
    return this.make(sp, radii);
  }

  update(now: number, inNode: boolean, keepAlive: boolean) {
    if (!keepAlive) for (const sy of this.systems) sy.target = 0;
    const T = now * 0.001;
    for (let k = this.systems.length - 1; k >= 0; k--) {
      const sy = this.systems[k];
      const want = sy.target * (inNode ? 1 : 0);
      sy.o += (want - sy.o) * 0.05;
      if (sy.target === 0 && sy.o < 0.01) {
        this.disposeSystem(sy); this.systems.splice(k, 1);
        if (this.preview === sy) this.preview = null;
        continue;
      }
      const o = sy.o;
      sy.group.visible = o > 0.01;
      if (!sy.group.visible) continue;
      if (sy.light) sy.light.intensity = 3.2 * o;
      sy.ringMats.forEach((m, i) => { m.opacity = o * (i === 0 ? 0.07 : 0.045); });
      sy.rings.forEach((g, i) => { g.rotation.y = now * 0.000006 * (i + 1) * (i % 2 ? -1 : 1); });
      for (const p of sy.planets) {
        const a = p.spec.a + T * p.spec.w;
        p.holder.position.set(Math.cos(a), 0, Math.sin(a));
        p.mesh.rotation.y = T * 0.06;
        p.mat.opacity = o;
        if (p.ringMesh) p.ringMesh.material.opacity = o * 0.45;
      }
    }
  }

  /**
   * Throwaway objects using the same material setups as a real orbit system, for
   * shader prewarming. Their materials stay alive for the layer's lifetime so the
   * (reference-counted) programs survive systems coming and going.
   */
  prewarmObjects(): THREE.Object3D[] {
    const sh = this.shared;
    const ringMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    const planetMat = new THREE.MeshStandardMaterial({ map: sh.textures[0], roughness: 0.92, metalness: 0, transparent: true, opacity: 0 });
    const bandMat = new THREE.MeshBasicMaterial({ color: 0xd9cdb4, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
    this.keepAlive.push(ringMat, planetMat, bandMat);
    return [new THREE.Line(sh.ringGeo, ringMat), new THREE.Mesh(sh.sphereGeo, planetMat), new THREE.Mesh(sh.bandGeo, bandMat)];
  }

  dispose() {
    for (const m of this.keepAlive) m.dispose();
    this.keepAlive = [];
    for (const sy of this.systems) this.disposeSystem(sy);
    this.systems = [];
    this.preview = null;
    for (const l of this.lights) this.scene.remove(l);
    const sh = this.shared;
    sh.ringGeo.dispose(); sh.sphereGeo.dispose(); sh.bandGeo.dispose(); sh.textures.forEach(t => t.dispose());
  }
}
