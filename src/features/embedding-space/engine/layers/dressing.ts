import * as THREE from 'three';
import { NEB_BAKE_VS, NEB_FS, NEB_SHOW_FS, NEB_SHOW_VS } from '../shaders';

type Disposable = { dispose: () => void };

/**
 * Space dressing for the approach + node zones: instanced asteroid belts,
 * metal debris, three wrecked shuttles, and seven camera-facing nebulae baked
 * once into 384² textures. Lit by one directional key light whose intensity is
 * zeroed (never removed) while hidden.
 */
export class SpaceDressing {
  readonly group = new THREE.Group();
  private disposables: Disposable[] = [];
  private belts: Array<{ bg: THREE.Group; w: number }> = [];
  private wrecks: Array<{ w: THREE.Group; spin: THREE.Vector3 }> = [];
  private nebulae: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[] = [];

  constructor(private scene: THREE.Scene, renderer: THREE.WebGLRenderer, private keyLight: THREE.DirectionalLight) {
    const group = this.group;
    const track = <T extends Disposable>(o: T): T => { this.disposables.push(o); return o; };
    let seed = 913;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

    // Asteroids: one deformed rock geometry, instanced across three tilted belts
    const rockGeo = track(new THREE.IcosahedronGeometry(1, 1));
    const p = rockGeo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const n = 0.72 + 0.5 * Math.abs(Math.sin(v.x * 3.1 + v.y * 1.7) * Math.cos(v.z * 2.3));
      v.multiplyScalar(n); p.setXYZ(i, v.x, v.y, v.z);
    }
    rockGeo.computeVertexNormals();
    const rockMat = track(new THREE.MeshStandardMaterial({ color: 0x5b5650, roughness: 0.95, metalness: 0.05, flatShading: true }));
    const belts = [
      { c: [-170, 110, -20], r: 78, n: 150, tilt: [0.5, 0, 0.2] },
      { c: [190, -70, 120], r: 64, n: 120, tilt: [-0.3, 0, 0.6] },
      { c: [40, -230, -140], r: 92, n: 160, tilt: [0.9, 0, -0.2] },
    ];
    const dummy = new THREE.Object3D();
    for (const b of belts) {
      const bg = new THREE.Group();
      bg.position.set(b.c[0], b.c[1], b.c[2]);
      bg.rotation.set(b.tilt[0], b.tilt[1], b.tilt[2]);
      const mesh = track(new THREE.InstancedMesh(rockGeo, rockMat, b.n));
      for (let i = 0; i < b.n; i++) {
        const a = rnd() * Math.PI * 2, rr = b.r + (rnd() - 0.5) * 22;
        dummy.position.set(Math.cos(a) * rr, (rnd() - 0.5) * 7, Math.sin(a) * rr);
        dummy.rotation.set(rnd() * 6, rnd() * 6, rnd() * 6);
        const sc = 0.35 + Math.pow(rnd(), 3) * 2.6;
        dummy.scale.set(sc, sc * (0.6 + rnd() * 0.5), sc * (0.7 + rnd() * 0.4));
        dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
      }
      bg.add(mesh); group.add(bg);
      this.belts.push({ bg, w: (0.004 + rnd() * 0.004) * (rnd() < 0.5 ? -1 : 1) });
    }

    // Debris: small metal shards scattered loosely along the belts
    const shardGeo = track(new THREE.TetrahedronGeometry(1, 0));
    const shardMat = track(new THREE.MeshStandardMaterial({ color: 0x8b8f96, roughness: 0.45, metalness: 0.7, flatShading: true }));
    const shards = track(new THREE.InstancedMesh(shardGeo, shardMat, 360));
    for (let i = 0; i < 360; i++) {
      const b = belts[i % belts.length];
      const a = rnd() * Math.PI * 2, rr = b.r + (rnd() - 0.5) * 60;
      dummy.position.set(b.c[0] + Math.cos(a) * rr, b.c[1] + (rnd() - 0.5) * 40, b.c[2] + Math.sin(a) * rr);
      dummy.rotation.set(rnd() * 6, rnd() * 6, rnd() * 6);
      const sc = 0.15 + rnd() * 0.45; dummy.scale.set(sc, sc * 0.3, sc * 1.6);
      dummy.updateMatrix(); shards.setMatrixAt(i, dummy.matrix);
    }
    group.add(shards);

    // Wrecked shuttles: hull + nose + one wing attached, one wing drifting free
    const hullMat = track(new THREE.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.6, metalness: 0.35 }));
    const scorchMat = track(new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.9, metalness: 0.2 }));
    const hullGeo = track(new THREE.CylinderGeometry(1, 1.1, 7, 14));
    const noseGeo = track(new THREE.ConeGeometry(1, 2.2, 14));
    const wingGeo = track(new THREE.BoxGeometry(5.5, 0.18, 2.4));
    const finGeo = track(new THREE.BoxGeometry(0.16, 2.2, 1.6));
    const wreckSpots = [[-120, 160, 30], [240, -20, 60], [-20, -260, -60]];
    for (const ws of wreckSpots) {
      const w = new THREE.Group();
      const hull = new THREE.Mesh(hullGeo, hullMat); hull.rotation.z = Math.PI / 2; w.add(hull);
      const nose = new THREE.Mesh(noseGeo, scorchMat); nose.rotation.z = -Math.PI / 2; nose.position.x = 4.6; w.add(nose);
      const wing = new THREE.Mesh(wingGeo, hullMat); wing.position.set(-0.6, -0.4, 2.2); w.add(wing);
      const fin = new THREE.Mesh(finGeo, scorchMat); fin.position.set(-3, 1.3, 0); w.add(fin);
      const loose = new THREE.Mesh(wingGeo, hullMat); loose.position.set(-2, 3.2, -5.5); loose.rotation.set(0.6, 0.8, 1.2); w.add(loose);
      w.position.set(ws[0], ws[1], ws[2]);
      w.rotation.set(rnd() * 6, rnd() * 6, rnd() * 6);
      w.scale.setScalar(1.1);
      group.add(w);
      this.wrecks.push({ w, spin: new THREE.Vector3((rnd() - 0.5) * 0.0016, (rnd() - 0.5) * 0.0016, (rnd() - 0.5) * 0.0016) });
    }

    // Nebulae: procedural shader baked once into a 384² texture each, then displayed cheaply
    const palettes = [
      [[0.55, 0.08, 0.18], [0.85, 0.25, 0.35], [1.0, 0.75, 0.6]],   // H-alpha emission
      [[0.04, 0.22, 0.32], [0.12, 0.55, 0.62], [0.7, 0.95, 1.0]],    // OIII teal
      [[0.28, 0.08, 0.38], [0.62, 0.22, 0.7], [1.0, 0.7, 0.95]],     // magenta
      [[0.1, 0.12, 0.35], [0.3, 0.38, 0.85], [0.85, 0.9, 1.0]],      // reflection blue
    ];
    const nebGeo = track(new THREE.PlaneGeometry(1, 1));
    const bakeCam = new THREE.Camera();
    const NEB = 7;
    for (let i = 0; i < NEB; i++) {
      const pal = palettes[i % palettes.length];
      const uniforms = {
        uOpacity: { value: 1 }, uSeed: { value: rnd() * 40 }, uTime: { value: 0 },
        uA: { value: new THREE.Color(pal[0][0], pal[0][1], pal[0][2]) },
        uB: { value: new THREE.Color(pal[1][0], pal[1][1], pal[1][2]) },
        uC: { value: new THREE.Color(pal[2][0], pal[2][1], pal[2][2]) },
      };
      const rt = track(new THREE.WebGLRenderTarget(384, 384));
      const bakeMat = new THREE.ShaderMaterial({
        uniforms, vertexShader: NEB_BAKE_VS, fragmentShader: NEB_FS,
        blending: THREE.NoBlending, depthTest: false, depthWrite: false,
      });
      const bakeScene = new THREE.Scene();
      bakeScene.add(new THREE.Mesh(nebGeo, bakeMat));
      const prevRT = renderer.getRenderTarget(), prevTM = renderer.toneMapping;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0); renderer.clear();
      renderer.render(bakeScene, bakeCam);
      renderer.setRenderTarget(prevRT);
      renderer.toneMapping = prevTM;
      renderer.setClearColor(0x020208, 1);
      bakeMat.dispose();
      const showMat = track(new THREE.ShaderMaterial({
        uniforms: { uTex: { value: rt.texture }, uOpacity: { value: 0 } },
        vertexShader: NEB_SHOW_VS, fragmentShader: NEB_SHOW_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      const m = new THREE.Mesh(nebGeo, showMat);
      const az = (i / NEB) * Math.PI * 2 + rnd() * 0.6, el = (rnd() - 0.5) * 0.9, rr = 330 + rnd() * 260;
      m.position.set(Math.cos(az) * Math.cos(el) * rr, Math.sin(el) * rr * 0.6, Math.sin(az) * Math.cos(el) * rr);
      m.scale.setScalar(380 + rnd() * 320);
      m.renderOrder = -8;
      m.userData.spin = rnd() * 6.28;
      group.add(m);
      this.nebulae.push(m);
    }
    group.visible = false;
    scene.add(group);
  }

  update(fade: number, d: number, camera: THREE.Camera) {
    const on = fade > 0.04 && d < 3900;
    this.group.visible = on;
    this.keyLight.intensity = on ? 0.9 : 0;
    if (!on) return;
    // Rocks and wrecks fully present in approach + node; nebula haze fades back in node view
    const nebO = 0.5 * fade;
    for (const m of this.nebulae) {
      m.quaternion.copy(camera.quaternion);
      m.rotateZ(m.userData.spin);
      m.material.uniforms.uOpacity.value = nebO;
    }
    for (const b of this.belts) b.bg.rotation.y += b.w * 0.016;
    for (const w of this.wrecks) { w.w.rotation.x += w.spin.x; w.w.rotation.y += w.spin.y; w.w.rotation.z += w.spin.z; }
  }

  dispose() {
    this.scene.remove(this.group);
    for (const o of this.disposables) o.dispose();
    this.disposables = [];
  }
}
