import * as THREE from 'three';
import {
  PATH_RIBBON_FRAGMENT, PATH_RIBBON_VERTEX, PATH_WAYPOINT_FRAGMENT, PATH_WAYPOINT_VERTEX,
} from '../shaders';

export interface PathPoint { x: number; y: number; z: number; hoursPlayed: number }

type RibbonUniforms = {
  uTime: THREE.IUniform<number>; uReveal: THREE.IUniform<number>; uHiT: THREE.IUniform<number>;
  uDim: THREE.IUniform<number>; uTravA: THREE.IUniform<number>; uTravB: THREE.IUniform<number>;
  uTravP: THREE.IUniform<number>; uTravOn: THREE.IUniform<number>;
};

/**
 * The Path as one continuous chronological ribbon: per-segment gentle arcs drawn
 * in over time, past→present blue→magenta gradient, a soft travelling comet,
 * and hour-sized waypoint rings. During a hop the flown segment lights up and a
 * bright head rides it in sync with the camera's flight progress.
 */
export class PathLayer {
  private line: THREE.Line<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private waypoints: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private n = 0;
  private travelOn = false;
  private keepAlive: Array<{ dispose: () => void }> = [];

  constructor(private scene: THREE.Scene, private getPixelRatio: () => number) {}

  get uniforms(): RibbonUniforms | null {
    return this.line ? (this.line.material.uniforms as unknown as RibbonUniforms) : null;
  }

  clear() {
    if (this.line) {
      this.scene.remove(this.line);
      this.line.geometry.dispose(); this.line.material.dispose();
      this.line = null;
    }
    if (this.waypoints) {
      this.scene.remove(this.waypoints);
      this.waypoints.geometry.dispose(); this.waypoints.material.dispose();
      this.waypoints = null;
    }
    this.travelOn = false;
  }

  draw(pathNodes: PathPoint[]) {
    this.clear();
    const n = pathNodes.length;
    if (n < 2) return;
    const pts = pathNodes.map(p => new THREE.Vector3(p.x, p.y, p.z));
    // Per-segment gentle quadratic arcs: close to the waypoint chords, lifted slightly
    // off the line so successive hops read as a journey, never loops.
    const PER = 28, SAMPLES = (n - 1) * PER;
    const pos = new Float32Array((SAMPLES + 1) * 3), tAttr = new Float32Array(SAMPLES + 1);
    const up = new THREE.Vector3(0, 1, 0), ab = new THREE.Vector3(), nrm = new THREE.Vector3(), ctrl = new THREE.Vector3(), q = new THREE.Vector3();
    let k = 0;
    for (let sgi = 0; sgi < n - 1; sgi++) {
      const a = pts[sgi], b = pts[sgi + 1];
      ab.subVectors(b, a); const len = ab.length() || 1;
      nrm.crossVectors(ab, up); if (nrm.lengthSq() < 1e-6) nrm.set(1, 0, 0);
      nrm.normalize().multiplyScalar(len * 0.1 * (sgi % 2 ? -1 : 1));
      nrm.addScaledVector(up, len * 0.06);
      ctrl.addVectors(a, b).multiplyScalar(0.5).add(nrm);
      for (let j = (sgi === 0 ? 0 : 1); j <= PER; j++) {
        const u = j / PER, iu = 1 - u;
        q.set(0, 0, 0).addScaledVector(a, iu * iu).addScaledVector(ctrl, 2 * iu * u).addScaledVector(b, u * u);
        pos[k * 3] = q.x; pos[k * 3 + 1] = q.y; pos[k * 3 + 2] = q.z;
        tAttr[k] = (sgi + u) / (n - 1); k++;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aT', new THREE.BufferAttribute(tAttr, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uReveal: { value: 0 }, uHiT: { value: -1 }, uDim: { value: 1 }, uTravA: { value: 0 }, uTravB: { value: 0 }, uTravP: { value: 0 }, uTravOn: { value: 0 } },
      vertexShader: PATH_RIBBON_VERTEX, fragmentShader: PATH_RIBBON_FRAGMENT,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 40;
    const revealStart = performance.now();
    const revealMs = Math.min(4200, 1400 + n * 90);
    line.onBeforeRender = () => {
      const now = performance.now();
      mat.uniforms.uTime.value = now / 1000;
      const r = Math.min(1, (now - revealStart) / revealMs);
      mat.uniforms.uReveal.value = 1 - Math.pow(1 - r, 3);
    };
    this.scene.add(line);
    this.line = line;
    this.n = n;

    const wPos = new Float32Array(n * 3), wSize = new Float32Array(n), wT = new Float32Array(n), wIdx = new Float32Array(n);
    let maxH = 1; for (const p of pathNodes) if (p.hoursPlayed > maxH) maxH = p.hoursPlayed;
    pathNodes.forEach((p, i) => {
      wPos.set([p.x, p.y, p.z], i * 3);
      wSize[i] = 9 + 22 * Math.sqrt(p.hoursPlayed / maxH);
      wT[i] = n > 1 ? i / (n - 1) : 0; wIdx[i] = i;
    });
    const wGeo = new THREE.BufferGeometry();
    wGeo.setAttribute('position', new THREE.BufferAttribute(wPos, 3));
    wGeo.setAttribute('aSize', new THREE.BufferAttribute(wSize, 1));
    wGeo.setAttribute('aT', new THREE.BufferAttribute(wT, 1));
    wGeo.setAttribute('aIdx', new THREE.BufferAttribute(wIdx, 1));
    const wMat = new THREE.ShaderMaterial({
      // uReveal / uDim are shared uniform objects with the ribbon so both stay in lockstep
      uniforms: { uReveal: mat.uniforms.uReveal, uHi: { value: -1 }, uActive: { value: -1 }, uPx: { value: this.getPixelRatio() }, uDim: mat.uniforms.uDim },
      vertexShader: PATH_WAYPOINT_VERTEX, fragmentShader: PATH_WAYPOINT_FRAGMENT,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const wPts = new THREE.Points(wGeo, wMat);
    wPts.renderOrder = 41;
    this.scene.add(wPts);
    this.waypoints = wPts;
  }

  setHighlight(idx: number) {
    if (this.waypoints) this.waypoints.material.uniforms.uHi.value = idx;
    const u = this.uniforms;
    if (u) u.uHiT.value = idx >= 0 && this.n > 1 ? idx / (this.n - 1) : -1;
  }

  setActive(idx: number) {
    if (this.waypoints) this.waypoints.material.uniforms.uActive.value = idx;
    const u = this.uniforms;
    if (u) u.uDim.value = idx >= 0 ? 0.6 : 1;
  }

  setTravel(fromIdx: number, toIdx: number) {
    const u = this.uniforms;
    if (!u || this.n < 2 || fromIdx < 0 || toIdx < 0) return;
    u.uTravA.value = fromIdx / (this.n - 1); u.uTravB.value = toIdx / (this.n - 1); u.uTravP.value = 0;
    this.travelOn = true;
  }

  /** Node-exit fade drives the ribbon dim directly. */
  setDim(f: number) { const u = this.uniforms; if (u) u.uDim.value = f; }

  /** Per-frame: the travel head rides the flight progress, then fades after landing. */
  update(flightProgress: number | null, damp: (rate: number) => number) {
    const u = this.uniforms;
    if (!u || !this.travelOn) return;
    if (flightProgress !== null) {
      u.uTravP.value = flightProgress;
      u.uTravOn.value += (1 - u.uTravOn.value) * damp(8);
    } else {
      u.uTravP.value = 1;
      u.uTravOn.value += (0 - u.uTravOn.value) * damp(1.6);
      if (u.uTravOn.value < 0.01) { u.uTravOn.value = 0; this.travelOn = false; }
    }
  }

  /** Prewarm objects (see OrbitLayer.prewarmObjects); materials live as long as the layer. */
  prewarmObjects(): THREE.Object3D[] {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    geo.setAttribute('aT', new THREE.BufferAttribute(new Float32Array(2), 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(2), 1));
    geo.setAttribute('aIdx', new THREE.BufferAttribute(new Float32Array(2), 1));
    const zero = () => ({ value: 0 });
    const ribbon = new THREE.ShaderMaterial({
      uniforms: { uTime: zero(), uReveal: zero(), uHiT: zero(), uDim: zero(), uTravA: zero(), uTravB: zero(), uTravP: zero(), uTravOn: zero() },
      vertexShader: PATH_RIBBON_VERTEX, fragmentShader: PATH_RIBBON_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const way = new THREE.ShaderMaterial({
      uniforms: { uReveal: zero(), uHi: zero(), uActive: zero(), uPx: zero(), uDim: zero() },
      vertexShader: PATH_WAYPOINT_VERTEX, fragmentShader: PATH_WAYPOINT_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.keepAlive.push(geo, ribbon, way);
    return [new THREE.Line(geo, ribbon), new THREE.Points(geo, way)];
  }

  dispose() { this.clear(); for (const k of this.keepAlive) k.dispose(); this.keepAlive = []; }
}
