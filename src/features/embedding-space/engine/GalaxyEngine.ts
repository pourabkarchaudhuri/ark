/**
 * Embedding Space v2 engine — GLTF-cosmos dolly descent into the embedding
 * galaxy. Camera distance to the origin is the master variable driving the
 * GLTF ↔ embedding crossfade, FOV/exposure breath and the UI zone.
 *
 * Port of the Claude Design handoff (`galaxy-engine-v2.js`); shaders, post
 * chain, flight timelines and thresholds are kept verbatim. High-frequency
 * state (camera, rail marker, FPS, card transforms, path travel) is written
 * straight to the DOM / uniforms from the loop, never through React state.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { gsap } from 'gsap';
import { GENRE_PALETTE, type GraphNode, type NeighborInfo } from '@/services/galaxy-cache';
import { gameGraphStore, type GraphScores } from '@/services/game-graph-store';
import {
  CINEMA_FS, CINEMA_VS, FLOW_LINE_FRAGMENT, FLOW_LINE_VERTEX, FRONTIER_FRAGMENT, FRONTIER_VERTEX,
  HALO_FRAGMENT, HALO_VERTEX, NAMED_STAR_FRAGMENT, NAMED_STAR_VERTEX, NODE_FRAGMENT, NODE_VERTEX,
  SUN_FRAGMENT, SUN_VERTEX,
} from './shaders';
import { STELLAR_CLASS_RGB, communityHueToRGB, hashPhase, stellarClassify } from './stellar';
import { createNebulaTexture, getGlowTexture } from './textures';
import { computeZoomState, nextZone, type Zone } from './zoom';
import { starBrightness, starSize, type PublisherFreqs } from './nodeStyle';
import { CardProjector } from './cards';
import { OrbitLayer } from './layers/orbits';
import { SpaceDressing } from './layers/dressing';
import { PathLayer, type PathPoint } from './layers/path';

// The engine drives GSAP from its own render loop (gsap.updateRoot) so tweens
// and frames stay in lockstep. GSAP is used only by this engine.
gsap.ticker.remove(gsap.updateRoot);

/**
 * Pin GSAP's root clock to now before creating tweens. The root only advances
 * when a frame renders, so after a long frame (shader compile) or a throttled
 * background stretch it is stale; a timeline created then would start in the
 * past and the next frame's catch-up would complete it instantly.
 */
const syncGsapClock = () => gsap.updateRoot(performance.now() / 1000);

const NAMED_STAR_CAPACITY = 50;
const NAMED_STAR_RADIUS = 2.4;
const STAR_COUNT = 12000;
const BG_FRAME_INTERVAL = 500;
const HALO_CAPACITY = 64;
/** PPR-percentile band lit by the frontier aurora: fade in 0.80→0.88, out 0.95→0.985. */
const FRONTIER_BAND: readonly [number, number, number, number] = [0.8, 0.88, 0.95, 0.985];
/** Hard cap on lit frontier points — additive overlap beyond this saturates. */
const FRONTIER_MAX_LIT = 1500;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

type Vec3Tuple = [number, number, number];

interface SunGroup {
  group: THREE.Group;
  surfaceMat: THREE.ShaderMaterial;
  surfaceGeo: THREE.IcosahedronGeometry;
  glowSpriteMat: THREE.SpriteMaterial;
}

interface FlyAnim {
  startCamPos: THREE.Vector3; endCamPos: THREE.Vector3; ctrl: THREE.Vector3;
  startTarget: THREE.Vector3; endTarget: THREE.Vector3;
  p: number; q: number;
  tl: gsap.core.Timeline | null;
  landCbs: Array<() => void>;
}

interface FlowLines { lines: THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial>; mat: THREE.ShaderMaterial }

export interface FlythroughTarget { pos: THREE.Vector3; gameId: string; title: string; subtitle: string }

interface FlythroughState {
  curve: THREE.CatmullRomCurve3; targets: FlythroughTarget[];
  startMs: number; durationMs: number; aborted: boolean; lastSegIdx: number;
}

export interface EngineUiState {
  selectedId: string | null;
  neighborIds: Set<string>;
  focusedNbIds: Set<string>;
  pathIds: Set<string>;
  activeGenres: Set<string>;
  allGenres: string[];
}

function createSunGroup(radius: number): SunGroup {
  const surfaceGeo = new THREE.IcosahedronGeometry(radius, 4);
  const surfaceMat = new THREE.ShaderMaterial({
    vertexShader: SUN_VERTEX, fragmentShader: SUN_FRAGMENT,
    uniforms: {
      u_time: { value: 0 },
      u_color: { value: new THREE.Color(1, 0.7, 1) },
      u_colorBright: { value: new THREE.Color(1, 1, 1) },
    },
  });
  const surfaceMesh = new THREE.Mesh(surfaceGeo, surfaceMat);
  const glowSpriteMat = new THREE.SpriteMaterial({
    map: getGlowTexture(), color: new THREE.Color(1, 0.7, 1),
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const glowSprite = new THREE.Sprite(glowSpriteMat);
  glowSprite.scale.set(radius * 3.4, radius * 3.4, 1);
  glowSpriteMat.opacity = 0.18;
  const group = new THREE.Group();
  group.add(surfaceMesh);
  group.add(glowSprite);
  group.visible = false;
  return { group, surfaceMat, surfaceGeo, glowSpriteMat };
}

function createNodeMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: NODE_VERTEX, fragmentShader: NODE_FRAGMENT,
    uniforms: {
      u_time: { value: 0 },
      u_communityMix: { value: 0 },
      u_prAuroraMix: { value: 0 },
      u_galacticTimeOfDay: { value: 0 },
      u_fade: { value: 0 },
      u_igniteAge: { value: 99 },
      u_keepFade: { value: 1 },
    },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

export class GalaxyEngine {
  readonly container: HTMLElement;
  readonly nodes: GraphNode[];
  readonly nodeMap: Map<string, GraphNode>;
  destroyed = false;

  readonly ui: EngineUiState = {
    selectedId: null, neighborIds: new Set(), focusedNbIds: new Set(), pathIds: new Set(),
    activeGenres: new Set(), allGenres: [],
  };
  autoOrbit = false;
  flyAnim: FlyAnim | null = null;
  probeActive = false;
  readonly keysDown = new Set<string>();
  readonly sunState: {
    selectedPos: THREE.Vector3 | null; selectedColor: Vec3Tuple;
    focusedPos: THREE.Vector3 | null; focusedColor: Vec3Tuple;
  } = { selectedPos: null, selectedColor: [1, 0.7, 1], focusedPos: null, focusedColor: [0.3, 0.95, 0.95] };
  skyboxEnabled = true;

  // DOM targets written every frame (no React re-render)
  fpsEl: HTMLElement | null = null;
  railMarkerEl: HTMLElement | null = null;
  approachWrapEl: HTMLElement | null = null;
  approachEl: HTMLElement | null = null;
  depthEl: HTMLElement | null = null;
  readonly cards = new CardProjector();

  // Bridges to React (low frequency only)
  onZoneChange: ((zone: Zone) => void) | null = null;
  onFlythroughSegment: ((index: number) => void) | null = null;
  onFlythroughEnd: (() => void) | null = null;

  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly scene: THREE.Scene;
  readonly controls: OrbitControls;
  readonly composer: EffectComposer;
  readonly bloomPass: UnrealBloomPass;
  readonly backend: 'WebGL2' | 'WebGL';
  zone: Zone = 'cosmos';
  embedFade = 0;

  private readonly assetBase: string;
  private readonly cinemaPass: ShaderPass;
  private readonly nodeMat = createNodeMaterial();
  private readonly starMat = createNodeMaterial();
  private readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly starField: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly colorAttr: THREE.Float32BufferAttribute;
  private readonly sizeAttr: THREE.Float32BufferAttribute;
  private readonly brightnessAttr: THREE.Float32BufferAttribute;
  private readonly keepAttr: THREE.Float32BufferAttribute;
  private readonly delayAttr: THREE.Float32BufferAttribute;
  private readonly baseSizes: Float32Array;
  private readonly baseBright: Float32Array;
  private readonly baseColors: Float32Array;
  private readonly nodeIndex = new Map<GraphNode, number>();
  private readonly pub: PublisherFreqs;
  private readonly namedStarsMesh: THREE.InstancedMesh<THREE.IcosahedronGeometry, THREE.ShaderMaterial>;
  private readonly frontierPoints: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly haloPts: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly sunSelected: SunGroup;
  private readonly sunFocused: SunGroup;
  private readonly orbits: OrbitLayer;
  private readonly path: PathLayer;
  private readonly dressKey: THREE.DirectionalLight;
  private dressing: SpaceDressing | null = null;
  private prewarmKeep: THREE.Material[] = [];
  private prewarmPromise: Promise<unknown> | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly mouse = new THREE.Vector2();
  private nebTex: THREE.Texture;
  private gltfGroup: THREE.Group | null = null;
  private gltfMats: THREE.Material[] = [];
  private gltfIntroStart = 0;
  private lines: FlowLines | null = null;
  private focusedLines: FlowLines | null = null;
  private focusedLinesOpacity = 0;
  private flyTl: gsap.core.Timeline | null = null;
  private readonly fx = { fov: 0, exposure: 0, mblur: 0, flash: 0 };
  private flythroughState: FlythroughState | null = null;
  private bloomWasEnabled = true;
  private readonly probeVelocity = new THREE.Vector3();
  private nodeFade = 1;
  private nodeFadeTarget: number | undefined;
  private haloStart = 0;
  private frontierBase = 0;
  private namedBase = 0;
  private igniteStart = 0;
  private lastIgniteSel: string | null = null;
  private dollyTarget: number;
  private snapTimer: ReturnType<typeof setTimeout> | null = null;
  private mouseNX = 0; private mouseNY = 0;
  private plxAmt = 0; private plxX = 0; private plxY = 0;
  private cachedRect: DOMRect;
  private cachedCW: number; private cachedCH: number;
  private degraded = false;
  private lowFps = 0;
  private adaptAfter = performance.now() + 8000;
  private lastDepthText = '';
  private lastApproachText: string | null = null;
  private frames = 0;
  private prevTime = performance.now();
  private lastRenderTime = 0;
  private lastT = 0;
  private animFrameId = 0;
  private resizeRaf = 0;
  private readonly observer: ResizeObserver;
  private readonly onWheel: (e: WheelEvent) => void;
  /** GPU reset (e.g. a game grabbing the GPU) empties the baked nebula targets — re-bake them. */
  private readonly onContextRestored = () => {
    if (this.destroyed || !this.dressing) return;
    this.dressing.dispose();
    this.dressing = null;
    this.lazyMountDressing();
  };
  private readonly onPtrMove: (e: PointerEvent) => void;
  private readonly dollyVec = new THREE.Vector3();
  private readonly motPrev = new THREE.Vector3();
  private readonly focusVec = new THREE.Vector3();
  private readonly focusVec2 = new THREE.Vector3();
  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpUp = new THREE.Vector3();

  constructor(container: HTMLElement, nodes: GraphNode[], pub: PublisherFreqs, opts: { assetBase: string }) {
    this.container = container;
    this.nodes = nodes;
    this.pub = pub;
    this.assetBase = opts.assetBase;
    nodes.forEach((nd, i) => this.nodeIndex.set(nd, i));
    this.nodeMap = new Map(nodes.map(nd => [nd.id, nd]));

    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    const pixelRatio = Math.min(window.devicePixelRatio, 1.25);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setSize(w, h);
    renderer.setPixelRatio(pixelRatio);
    renderer.setClearColor(0x020208, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.backend = renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL';

    const camera = new THREE.PerspectiveCamera(52, w / h, 1, 24000);
    camera.position.set(0, 900, 4700); // macro overview of the GLTF cosmos
    this.camera = camera;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x020208, 0.0008);
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    this.scene = scene;

    // Skybox: procedural placeholder immediately, swapped for the real image once it loads
    this.nebTex = createNebulaTexture();
    scene.background = this.nebTex;
    scene.backgroundIntensity = 0.25;
    new THREE.TextureLoader().load(`${this.assetBase}embedding-space/skybox.jpg`, (tex) => {
      if (this.destroyed) { tex.dispose(); return; }
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      scene.background = tex;
      this.nebTex.dispose();
      this.nebTex = tex;
    }, undefined, () => { /* keep the procedural nebula */ });

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.085;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 1.2;
    controls.enableZoom = false; // the wheel drives a damped dolly instead
    controls.minDistance = 50;
    controls.maxDistance = 6500;
    controls.autoRotateSpeed = 0.1;
    // Middle mouse orbits in every state (left too, for trackpads); right pans
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    this.controls = controls;

    // ── Background starfield ──
    const starPositions = new Float32Array(STAR_COUNT * 3);
    const starColors = new Float32Array(STAR_COUNT * 3);
    const starSizes = new Float32Array(STAR_COUNT);
    for (let i = 0; i < STAR_COUNT; i++) {
      starPositions[i * 3] = (Math.random() - 0.5) * 4000;
      starPositions[i * 3 + 1] = (Math.random() - 0.5) * 4000;
      starPositions[i * 3 + 2] = (Math.random() - 0.5) * 4000;
      const warmth = Math.random();
      starColors[i * 3] = 0.3 + warmth * 0.4;
      starColors[i * 3 + 1] = 0.3 + warmth * 0.2;
      starColors[i * 3 + 2] = 0.4 + (1 - warmth) * 0.3;
      starSizes[i] = Math.random() * 1.5 + 0.3;
    }
    const starGeo = new THREE.BufferGeometry();
    const starZeros = new Float32Array(STAR_COUNT);
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
    starGeo.setAttribute('aColor', new THREE.Float32BufferAttribute(starColors, 3));
    starGeo.setAttribute('aSize', new THREE.Float32BufferAttribute(starSizes, 1));
    starGeo.setAttribute('aBrightness', new THREE.Float32BufferAttribute(new Float32Array(STAR_COUNT).fill(0.2), 1));
    starGeo.setAttribute('aCommunityColor', new THREE.Float32BufferAttribute(starColors, 3));
    starGeo.setAttribute('aPRBoost', new THREE.Float32BufferAttribute(starZeros, 1));
    starGeo.setAttribute('aTwinklePhase', new THREE.Float32BufferAttribute(starZeros.slice(), 1));
    starGeo.setAttribute('aPRDelta', new THREE.Float32BufferAttribute(starZeros.slice(), 1));
    starGeo.setAttribute('aKeep', new THREE.Float32BufferAttribute(starZeros.slice(), 1));
    starGeo.setAttribute('aDelay', new THREE.Float32BufferAttribute(starZeros.slice(), 1));
    this.starField = new THREE.Points(starGeo, this.starMat);
    scene.add(this.starField);

    // ── Game nodes ──
    const n = nodes.length;
    const posArr = new Float32Array(n * 3);
    const colArr = new Float32Array(n * 3);
    const sizeArr = new Float32Array(n);
    const brightArr = new Float32Array(n);
    const twinklePhaseArr = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      posArr[i * 3] = nd.x; posArr[i * 3 + 1] = nd.y; posArr[i * 3 + 2] = nd.z;
      const c = GENRE_PALETTE[nd.colorIdx] ?? GENRE_PALETTE[GENRE_PALETTE.length - 1];
      colArr[i * 3] = c[0]; colArr[i * 3 + 1] = c[1]; colArr[i * 3 + 2] = c[2];
      sizeArr[i] = starSize(nd, pub.pubFreq, pub.maxPubLog);
      brightArr[i] = starBrightness(nd);
      twinklePhaseArr[i] = hashPhase(nd.id);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    this.colorAttr = new THREE.Float32BufferAttribute(colArr, 3);
    geo.setAttribute('aColor', this.colorAttr);
    this.sizeAttr = new THREE.Float32BufferAttribute(sizeArr, 1);
    geo.setAttribute('aSize', this.sizeAttr);
    this.brightnessAttr = new THREE.Float32BufferAttribute(brightArr, 1);
    geo.setAttribute('aBrightness', this.brightnessAttr);
    geo.setAttribute('aCommunityColor', new THREE.Float32BufferAttribute(colArr.slice(), 3));
    geo.setAttribute('aPRBoost', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
    geo.setAttribute('aTwinklePhase', new THREE.Float32BufferAttribute(twinklePhaseArr, 1));
    geo.setAttribute('aPRDelta', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
    this.keepAttr = new THREE.Float32BufferAttribute(new Float32Array(n), 1);
    geo.setAttribute('aKeep', this.keepAttr);
    this.delayAttr = new THREE.Float32BufferAttribute(new Float32Array(n), 1);
    geo.setAttribute('aDelay', this.delayAttr);
    this.points = new THREE.Points(geo, this.nodeMat);
    scene.add(this.points);
    this.baseSizes = sizeArr.slice();
    this.baseBright = brightArr.slice();
    this.baseColors = colArr.slice();

    // ── Named stars (top-50 PageRank) ──
    const namedStarGeo = new THREE.IcosahedronGeometry(NAMED_STAR_RADIUS, 2);
    namedStarGeo.setAttribute('aInstColor', new THREE.InstancedBufferAttribute(new Float32Array(NAMED_STAR_CAPACITY * 3), 3));
    namedStarGeo.setAttribute('aInstPhase', new THREE.InstancedBufferAttribute(new Float32Array(NAMED_STAR_CAPACITY), 1));
    const namedStarMat = new THREE.ShaderMaterial({
      vertexShader: NAMED_STAR_VERTEX, fragmentShader: NAMED_STAR_FRAGMENT,
      uniforms: { u_time: { value: 0 }, u_globalIntensity: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.namedStarsMesh = new THREE.InstancedMesh(namedStarGeo, namedStarMat, NAMED_STAR_CAPACITY);
    this.namedStarsMesh.count = 0;
    // Bounding sphere would be computed once at count 0 (empty, at the origin) and never refreshed
    this.namedStarsMesh.frustumCulled = false;
    this.namedStarsMesh.instanceMatrix.usage = THREE.DynamicDrawUsage;
    this.namedStarsMesh.renderOrder = 1;
    scene.add(this.namedStarsMesh);

    // ── Frontier aurora ──
    const frontierGeo = new THREE.BufferGeometry();
    frontierGeo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    const frontierPhaseArr = new Float32Array(n);
    for (let i = 0; i < n; i++) frontierPhaseArr[i] = twinklePhaseArr[i] * 1.7 + 0.13;
    frontierGeo.setAttribute('aIntensity', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
    frontierGeo.setAttribute('aPhase', new THREE.Float32BufferAttribute(frontierPhaseArr, 1));
    this.frontierPoints = new THREE.Points(frontierGeo, new THREE.ShaderMaterial({
      vertexShader: FRONTIER_VERTEX, fragmentShader: FRONTIER_FRAGMENT,
      uniforms: { u_time: { value: 0 }, u_globalIntensity: { value: 0 } },
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    }));
    this.frontierPoints.renderOrder = -10;
    scene.add(this.frontierPoints);

    this.raycaster.params.Points!.threshold = 4;

    // ── Neighbour halos: screen-space dashed rings rotating around each active neighbour ──
    {
      const hg = new THREE.BufferGeometry();
      hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(HALO_CAPACITY * 3), 3));
      hg.setAttribute('aDelay', new THREE.BufferAttribute(new Float32Array(HALO_CAPACITY), 1));
      hg.setAttribute('aDir', new THREE.BufferAttribute(new Float32Array(HALO_CAPACITY), 1));
      hg.setDrawRange(0, 0);
      const haloMat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uAge: { value: 99 }, uPx: { value: renderer.getPixelRatio() }, uOpacity: { value: 1 } },
        vertexShader: HALO_VERTEX, fragmentShader: HALO_FRAGMENT,
        transparent: true, depthTest: false, depthWrite: false, blending: THREE.NormalBlending,
      });
      this.haloPts = new THREE.Points(hg, haloMat);
      this.haloPts.renderOrder = 120;
      this.haloPts.frustumCulled = false;
      scene.add(this.haloPts);
    }

    this.sunSelected = createSunGroup(5);
    this.sunFocused = createSunGroup(4);
    scene.add(this.sunSelected.group);
    scene.add(this.sunFocused.group);

    this.orbits = new OrbitLayer(scene);
    this.path = new PathLayer(scene, () => this.renderer.getPixelRatio());
    this.dressKey = new THREE.DirectionalLight(0xdfe6ff, 0);
    this.dressKey.position.set(0.4, 1, 0.3);
    scene.add(this.dressKey);

    // ── Post: MSAA render target → bloom (half-res) → cinema grade → output ──
    const pr = renderer.getPixelRatio();
    const msaaTarget = new THREE.WebGLRenderTarget(Math.max(1, Math.floor(w * pr)), Math.max(1, Math.floor(h * pr)), {
      samples: renderer.capabilities.isWebGL2 ? 2 : 0, type: THREE.HalfFloatType,
    });
    const composer = new EffectComposer(renderer, msaaTarget);
    composer.addPass(new RenderPass(scene, camera));
    // Final design strength is 0.4 (the prototype's bloomStrength default, applied every render).
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(Math.ceil(w / 2), Math.ceil(h / 2)), 0.4, 0.5, 0.82);
    composer.addPass(this.bloomPass);
    this.cinemaPass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null }, uRes: { value: new THREE.Vector2(w, h) },
        uFocus: { value: new THREE.Vector2(0.5, 0.5) }, uFocusOn: { value: 0 }, uTime: { value: 0 }, uBlur: { value: 0 },
        uMotion: { value: 0 }, uMBlur: { value: 0 }, uFlash: { value: 0 },
      },
      vertexShader: CINEMA_VS,
      fragmentShader: CINEMA_FS,
    });
    composer.addPass(this.cinemaPass);
    composer.addPass(new OutputPass());
    this.composer = composer;

    // ── Smooth wheel dolly + approach magnet ──
    this.dollyTarget = camera.position.distanceTo(controls.target);
    this.onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (this.flythroughState) return;
      if (this.flyAnim) {
        // Land the flight on its target immediately, then let the dolly take over around it
        const fa = this.flyAnim; this.cancelFly();
        this.controls.target.copy(fa.endTarget);
        this.dollyTarget = this.camera.position.distanceTo(this.controls.target);
      }
      const k = Math.exp(Math.max(-100, Math.min(100, e.deltaY)) * 0.0014);
      this.dollyTarget = Math.max(controls.minDistance, Math.min(controls.maxDistance, this.dollyTarget * k));
      if (this.snapTimer) clearTimeout(this.snapTimer);
      this.snapTimer = setTimeout(() => {
        this.snapTimer = null;
        if (this.destroyed || this.flyAnim || this.ui.selectedId) return;
        const originD = this.camera.position.length();
        // Magnetic band: anywhere between "just entered approach" and "about to enter node"
        if (originD > 1600 && originD < 3700 && this.controls.target.length() < 60) this.dollyTarget = 2050;
      }, 220);
    };
    renderer.domElement.addEventListener('wheel', this.onWheel, { passive: false });
    this.onPtrMove = (e: PointerEvent) => {
      const r = this.cachedRect;
      if (!r.width || !r.height) return; // hidden host — avoid NaN parallax
      this.mouseNX = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.mouseNY = ((e.clientY - r.top) / r.height) * 2 - 1;
    };
    window.addEventListener('pointermove', this.onPtrMove);
    renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);

    // ── Resize ──
    this.cachedCW = w; this.cachedCH = h;
    this.cachedRect = renderer.domElement.getBoundingClientRect();
    this.observer = new ResizeObserver(() => {
      if (this.resizeRaf) return;
      this.resizeRaf = requestAnimationFrame(() => {
        this.resizeRaf = 0;
        if (this.destroyed) return;
        const cw = Math.max(1, container.clientWidth), ch = Math.max(1, container.clientHeight);
        this.cachedCW = cw; this.cachedCH = ch;
        renderer.setSize(cw, ch);
        composer.setSize(cw, ch);
        this.bloomPass.setSize(Math.ceil(cw / (this.degraded ? 3 : 2)), Math.ceil(ch / (this.degraded ? 3 : 2)));
        this.cinemaPass.uniforms.uRes.value.set(cw, ch);
        camera.aspect = cw / ch;
        camera.updateProjectionMatrix();
        this.cachedRect = renderer.domElement.getBoundingClientRect();
      });
    });
    this.observer.observe(container);

    this.animate = this.animate.bind(this);
    if (import.meta.env.DEV) (window as unknown as { __esEngine?: GalaxyEngine }).__esEngine = this; // debug handle
    this.animFrameId = requestAnimationFrame(this.animate);
  }

  // ─── Camera flights ────────────────────────────────────────────────────────
  startFly(endTarget: THREE.Vector3, endCamPos: THREE.Vector3, duration = 2500) {
    const startCamPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const hop = startTarget.distanceTo(endTarget);
    // Arc control point: midpoint pulled back along the view axis and lifted, so long
    // hops rise out of the field and settle in, short hops stay nearly straight.
    const mid = new THREE.Vector3().addVectors(startCamPos, endCamPos).multiplyScalar(0.5);
    const back = new THREE.Vector3().subVectors(mid, new THREE.Vector3().addVectors(startTarget, endTarget).multiplyScalar(0.5));
    if (back.lengthSq() < 1e-6) back.set(0, 0, 1);
    // Long hops pull well back (toward Approach altitude) so crossing the galaxy reads as a
    // journey — rise out of the field, travel, dive in — instead of skimming at node height.
    back.normalize().multiplyScalar(Math.min(1500, hop * (hop > 500 ? 0.6 : 0.35)));
    const ctrl = mid.add(back).add(new THREE.Vector3(0, Math.min(420, hop * 0.15), 0));
    // Duration scales with hop length (a far search pick used to take the same 2.8 s as a
    // short hop); explicit long durations (descent, overview) act as a floor.
    const scaled = Math.max(1000, Math.min(5200, 850 + hop * 2.2));
    const ms = duration >= 2400 ? Math.max(duration, scaled) : scaled;
    const D = ms / 1000;
    if (this.flyTl) this.flyTl.kill();
    syncGsapClock();
    const fx = this.fx;
    // A superseded flight's landing callbacks move to this one — dropping them strands
    // whoever was waiting (node-exit fade, Path arrival). Callers guard with their own tokens.
    const carried = this.flyAnim ? this.flyAnim.landCbs.splice(0) : [];
    const fa: FlyAnim = { startCamPos, endCamPos: endCamPos.clone(), ctrl, startTarget, endTarget: endTarget.clone(), p: 0, q: 0, tl: null, landCbs: carried };
    const toStar = endTarget.length() > 1; // flights to a star land with a flash; zone flights don't
    const tl = gsap.timeline({ onComplete: () => { if (this.flyAnim === fa) this.flyAnim = null; this.flyTl = null; } });
    // Control is handed back the moment the camera lands; flash/exposure tails keep playing on fx
    tl.to(fa, { p: 1, duration: D, ease: 'power2.inOut', onComplete: () => { if (this.flyAnim === fa) this.flyAnim = null; this.runLand(fa); } }, 0)
      .to(fa, { q: 1, duration: D * 0.78, ease: 'power2.inOut' }, 0)
      .to(fx, { fov: Math.min(6, hop * 0.01), duration: D * 0.5, ease: 'sine.inOut' }, 0)
      .to(fx, { fov: 0, duration: D * 0.5, ease: 'sine.inOut' }, D * 0.5)
      .to(fx, { exposure: -0.07, duration: D * 0.45, ease: 'sine.in' }, 0)
      .to(fx, { exposure: 0, duration: D * 0.45, ease: 'sine.out' }, D * 0.55)
      .to(fx, { mblur: Math.min(0.6, 0.12 + hop / 900), duration: D * 0.4, ease: 'power2.in' }, D * 0.05)
      .to(fx, { mblur: 0, duration: D * 0.4, ease: 'power2.out' }, D * 0.5);
    if (toStar) {
      tl.to(fx, { flash: 0.6, duration: 0.22, ease: 'power2.out' }, D * 0.9)
        .to(fx, { flash: 0, duration: 1.1, ease: 'power3.out' }, D * 0.9 + 0.16);
    } else if (fx.flash > 0) {
      tl.to(fx, { flash: 0, duration: 0.3, ease: 'power2.out' }, 0); // a killed star landing's flash tail
    }
    fa.tl = tl;
    this.flyTl = tl;
    this.flyAnim = fa;
  }

  flyToNode(node: GraphNode, dist = 100, duration = 1600) {
    const pos = new THREE.Vector3(node.x, node.y, node.z);
    const dir = new THREE.Vector3().subVectors(this.camera.position, pos).normalize();
    this.startFly(pos, pos.clone().add(dir.multiplyScalar(dist)), duration);
  }

  /** Queue a callback for the moment the camera lands (runs now if not flying). */
  whenLanded(cb: () => void) { if (this.flyAnim) this.flyAnim.landCbs.push(cb); else cb(); }

  private runLand(fa: FlyAnim) {
    const cbs = fa.landCbs; fa.landCbs = [];
    for (const cb of cbs) { try { cb(); } catch (e) { console.warn('[Embedding Space] landing callback failed', e); } }
  }

  /** Interrupts travel only; pending landing callbacks run, FX ease back to rest. */
  cancelFly() {
    if (!this.flyAnim) return;
    this.runLand(this.flyAnim);
    if (this.flyTl) { this.flyTl.kill(); this.flyTl = null; }
    this.flyAnim = null;
    syncGsapClock();
    gsap.to(this.fx, { fov: 0, exposure: 0, mblur: 0, flash: 0, duration: 0.5, ease: 'power2.out' });
  }

  get isFlying() { return !!this.flyAnim; }

  /** A flight headed to a star (not a zone flight to the origin) — it may arc out of Node range. */
  get isStarFlight() { return !!this.flyAnim && this.flyAnim.endTarget.length() > 1; }

  // ─── Node exit fade ────────────────────────────────────────────────────────
  beginNodeExit() { this.nodeFadeTarget = 0; }
  endNodeExit() { this.nodeFadeTarget = 1; this.nodeFade = 1; this.applyNodeFade(1); }

  private applyNodeFade(f: number) {
    this.nodeMat.uniforms.u_keepFade.value = f;
    if (this.lines) this.lines.mat.opacity = f;
    if (this.focusedLines) this.focusedLines.mat.opacity = Math.min(this.focusedLinesOpacity, f);
    this.haloPts.material.uniforms.uOpacity.value = (this.zone === 'node' || f < 1 ? 1 : 0) * f;
    this.path.setDim(f);
    for (const g of [this.sunSelected, this.sunFocused]) {
      g.group.scale.setScalar(0.6 + 0.4 * f);
      g.glowSpriteMat.opacity = 0.18 * f;
    }
    this.cards.setHostOpacity(f);
  }

  // ─── Picking ───────────────────────────────────────────────────────────────
  raycastNode(clientX: number, clientY: number): { node: GraphNode; index: number } | null {
    const rect = this.cachedRect;
    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObject(this.points);
    if (hits.length > 0 && hits[0].index !== undefined) return { node: this.nodes[hits[0].index], index: hits[0].index };
    return null;
  }

  projectAllNodes(): Array<{ x: number; y: number; behindCamera: boolean }> {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3();
    const out = new Array<{ x: number; y: number; behindCamera: boolean }>(this.nodes.length);
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      v.set(node.x, node.y, node.z).project(this.camera);
      out[i] = { x: (v.x * 0.5 + 0.5) * rect.width + rect.left, y: (-v.y * 0.5 + 0.5) * rect.height + rect.top, behindCamera: v.z > 1 };
    }
    return out;
  }

  /** Index of the node nearest a world position (camera-relative auto-select). */
  nearestNodeTo(p: THREE.Vector3): GraphNode | null {
    let best: GraphNode | null = null, bestD = Infinity;
    for (const nd of this.nodes) {
      const dx = nd.x - p.x, dy = nd.y - p.y, dz = nd.z - p.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD) { bestD = d2; best = nd; }
    }
    return best;
  }

  // ─── Visual state ──────────────────────────────────────────────────────────
  updateVisuals() {
    const { nodes, colorAttr, sizeAttr, brightnessAttr, baseSizes, baseBright, baseColors } = this;
    const ag = this.ui.activeGenres;
    const al = this.ui.allGenres;
    const selId = this.ui.selectedId;
    const nbIds = this.ui.neighborIds;
    const fnbIds = this.ui.focusedNbIds;
    const pIds = this.ui.pathIds;
    const hasSelection = !!selId;
    const hasFocusedNbs = fnbIds.size > 0;
    const hasPath = pIds.size > 0;
    const filterActive = ag.size > 0 && ag.size < al.length;
    const isDefault = !hasSelection && !hasPath && !filterActive;
    const cArr = colorAttr.array as Float32Array, sArr = sizeAttr.array as Float32Array, bArr = brightnessAttr.array as Float32Array;
    const kArr = this.keepAttr.array as Float32Array;
    kArr.fill(0);
    const dArr = this.delayAttr.array as Float32Array;
    dArr.fill(0);
    const nbRank = new Map<string, number>(); let rk = 0; for (const id of nbIds) nbRank.set(id, rk++);
    if (selId !== this.lastIgniteSel) { this.lastIgniteSel = selId; this.igniteStart = performance.now(); }

    if (isDefault) {
      cArr.set(baseColors); sArr.set(baseSizes); bArr.set(baseBright);
    } else {
      for (let i = 0; i < nodes.length; i++) {
        const nd = nodes[i];
        const isSel = nd.id === selId;
        const isNb = hasSelection && nbIds.has(nd.id);
        const isOnPath = hasPath && pIds.has(nd.id);
        const isFocNb = hasFocusedNbs && fnbIds.has(nd.id);
        let bright: number, size: number;
        let r = baseColors[i * 3], g = baseColors[i * 3 + 1], b = baseColors[i * 3 + 2];
        if (isSel) { bright = 1.25; size = 12; r = r * 0.7 + 0.3; g = g * 0.7 + 0.3; b = b * 0.7 + 0.3; }
        else if (isNb) {
          bright = 1.05; size = Math.max(baseSizes[i], nd.isLibrary ? 7 : 5);
          r = r * 0.85 + 0.15; g = g * 0.85 + 0.15; b = b * 0.85 + 0.15;
        } else if (isFocNb) {
          bright = 1.1; size = Math.max(baseSizes[i], nd.isLibrary ? 6 : 4);
          r = r * 0.9 + 0.05; g = g * 0.9 + 0.05; b = b * 0.9 + 0.05;
        } else if (isOnPath) {
          bright = 1.5; size = Math.max(baseSizes[i], 7);
        } else if (hasSelection || hasPath) {
          bright = baseBright[i] * 0.15;
          size = Math.min(baseSizes[i], nd.isLibrary ? 3 : 1);
        } else if (filterActive && nd.genres.some(gn => ag.has(gn))) {
          bright = Math.min(1.9, baseBright[i] * 1.4 + 0.45);
          size = Math.max(baseSizes[i] * 1.6, nd.isLibrary ? 9 : 5.5);
          r = r * 0.8 + 0.2; g = g * 0.8 + 0.2; b = b * 0.8 + 0.2;
        } else if (filterActive) {
          bright = 0.03; size = 0.6;
          const grey = 0.15;
          r = r * 0.3 + grey * 0.7; g = g * 0.3 + grey * 0.7; b = b * 0.3 + grey * 0.7;
        } else { bright = baseBright[i]; size = baseSizes[i]; }
        const ci = i * 3;
        cArr[ci] = r; cArr[ci + 1] = g; cArr[ci + 2] = b;
        sArr[i] = size; bArr[i] = bright;
        if (isSel || isNb || isOnPath || isFocNb) kArr[i] = 1;
        if (isNb && !isOnPath) dArr[i] = 0.42 + (nbRank.get(nd.id) || 0) * 0.07;
        else if (filterActive && !hasSelection && !hasPath && nd.genres.some(gn => ag.has(gn))) kArr[i] = 1;
      }
    }
    colorAttr.needsUpdate = true; sizeAttr.needsUpdate = true; brightnessAttr.needsUpdate = true;
    this.keepAttr.needsUpdate = true;
    this.delayAttr.needsUpdate = true;
  }

  /** Re-derive a node's base size/brightness after it joins the library. */
  refreshBaseForNode(node: GraphNode) {
    const idx = this.nodeIndex.get(node);
    if (idx === undefined) return;
    this.baseSizes[idx] = starSize(node, this.pub.pubFreq, this.pub.maxPubLog);
    this.baseBright[idx] = starBrightness(node);
  }

  // ─── Connection lines + halos ──────────────────────────────────────────────
  private makeFlowLines(center: { x: number; y: number; z: number }, list: NeighborInfo[], rgb: Vec3Tuple): FlowLines {
    const pos: number[] = [], aT: number[] = [], aD: number[] = [], aI: number[] = [];
    const sorted = list.filter(nb => nb.node).sort((a, b) => a.distance - b.distance);
    const dmin = sorted.length ? sorted[0].distance : 0, dmax = sorted.length ? sorted[sorted.length - 1].distance : 1;
    sorted.forEach((nb, rank) => {
      const nn = nb.node!;
      pos.push(center.x, center.y, center.z, nn.x, nn.y, nn.z);
      aT.push(0, 1);
      const delay = rank * 0.07;
      aD.push(delay, delay);
      const intensity = 1 - 0.6 * (nb.distance - dmin) / ((dmax - dmin) || 1);
      aI.push(intensity, intensity);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aT', new THREE.Float32BufferAttribute(aT, 1));
    geo.setAttribute('aD', new THREE.Float32BufferAttribute(aD, 1));
    geo.setAttribute('aI', new THREE.Float32BufferAttribute(aI, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uAge: { value: 0 }, uTime: { value: 0 }, uOpacity: { value: 1 }, uColor: { value: new THREE.Color(rgb[0], rgb[1], rgb[2]) } },
      vertexShader: FLOW_LINE_VERTEX, fragmentShader: FLOW_LINE_FRAGMENT,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const lines = new THREE.LineSegments(geo, mat);
    const born = performance.now();
    lines.onBeforeRender = () => {
      const now = performance.now();
      mat.uniforms.uAge.value = (now - born) / 1000;
      mat.uniforms.uTime.value = now / 1000;
      mat.uniforms.uOpacity.value = mat.opacity;
    };
    return { lines, mat };
  }

  private disposeFlow(f: FlowLines | null) {
    if (!f) return;
    this.scene.remove(f.lines);
    f.lines.geometry.dispose();
    // compileAsync polls every material it gathered; disposing one mid-prewarm throws inside three
    if (this.prewarmPromise) void this.prewarmPromise.finally(() => f.mat.dispose());
    else f.mat.dispose();
  }

  drawConnections(selNode: GraphNode, neighborList: NeighborInfo[]) {
    this.disposeFlow(this.lines); this.lines = null;
    if (neighborList.length === 0) { this.haloPts.geometry.setDrawRange(0, 0); return; }
    this.setHalos(neighborList);
    if (this.nodeFade < 1 && this.nodeFadeTarget !== 0) this.endNodeExit();
    this.lines = this.makeFlowLines(selNode, neighborList, [0.35, 0.9, 0.95]);
    this.scene.add(this.lines.lines);
  }

  private setHalos(list: NeighborInfo[]) {
    const g = this.haloPts.geometry;
    const pos = g.attributes.position.array as Float32Array;
    const del = g.attributes.aDelay.array as Float32Array;
    const dir = g.attributes.aDir.array as Float32Array;
    const sorted = list.filter(nb => nb.node).sort((a, b) => a.distance - b.distance).slice(0, HALO_CAPACITY);
    sorted.forEach((nb, i) => {
      const nn = nb.node!;
      pos[i * 3] = nn.x; pos[i * 3 + 1] = nn.y; pos[i * 3 + 2] = nn.z;
      del[i] = 0.42 + i * 0.07; // lands with each neighbour's ignition
      dir[i] = i % 2 ? -1 : 1;
    });
    g.setDrawRange(0, sorted.length);
    g.attributes.position.needsUpdate = true; g.attributes.aDelay.needsUpdate = true; g.attributes.aDir.needsUpdate = true;
    this.haloStart = performance.now();
  }

  clearConnections() {
    this.haloPts.geometry.setDrawRange(0, 0);
    this.disposeFlow(this.lines); this.lines = null;
  }

  clearFocusedConnections() {
    this.disposeFlow(this.focusedLines); this.focusedLines = null;
    this.focusedLinesOpacity = 0;
    this.ui.focusedNbIds = new Set();
  }

  drawFocusedConnections(centerNode: GraphNode, nbList: NeighborInfo[]) {
    this.clearFocusedConnections();
    if (nbList.length === 0) return;
    const fl = this.makeFlowLines(centerNode, nbList, [0.66, 0.42, 1.0]);
    fl.mat.opacity = 0;
    this.focusedLines = fl;
    this.scene.add(fl.lines);
    this.focusedLinesOpacity = 0;
    this.ui.focusedNbIds = new Set(nbList.map(nb => nb.id));
    this.updateVisuals();
  }

  // ─── Orbits / Path / Marks ─────────────────────────────────────────────────
  setOrbitRings(neighborList: NeighborInfo[], opts: { preview?: boolean; at?: THREE.Vector3 } = {}) {
    return this.orbits.set(neighborList, opts.at ?? this.sunState.selectedPos, { preview: opts.preview });
  }

  drawPathLines(pathNodes: PathPoint[]) { this.path.draw(pathNodes); }
  clearPathLines() { this.path.clear(); }
  setPathHighlight(idx: number) { this.path.setHighlight(idx); }
  setPathTravel(fromIdx: number, toIdx: number) { this.path.setTravel(fromIdx, toIdx); }
  setPathActive(idx: number) { this.path.setActive(idx); }


  // ─── Graph layers (community colour, PageRank boost, frontier aurora, named stars) ──
  applyGraphLayers() {
    if (this.destroyed || !gameGraphStore.isReady) return;
    const scores = gameGraphStore.getAllScores();
    if (!scores) return;
    const geo = this.points.geometry;
    const communityAttr = geo.getAttribute('aCommunityColor') as THREE.BufferAttribute;
    const prAttr = geo.getAttribute('aPRBoost') as THREE.BufferAttribute;
    const frontierIntensityAttr = this.frontierPoints.geometry.getAttribute('aIntensity') as THREE.BufferAttribute;

    let maxPR = 1e-9, hasPPR = false;
    for (const k of Object.keys(scores)) {
      const gs = scores[k];
      if (gs.pageRank > maxPR) maxPR = gs.pageRank;
      if (gs.personalizedPageRank > 0) hasPPR = true;
    }
    const prCap = maxPR * 0.85;
    const communityArr = communityAttr.array as Float32Array;
    const prArr = prAttr.array as Float32Array;
    const frontierArr = frontierIntensityAttr.array as Float32Array;
    const tmp = new Float32Array(3);
    let matchCount = 0;
    const pprRows: Array<{ i: number; ppr: number }> = [];
    frontierArr.fill(0);
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const gs = scores[node.id];
      if (!gs) continue;
      matchCount++;
      communityHueToRGB(gs.community, tmp, 0);
      communityArr[i * 3] = tmp[0]; communityArr[i * 3 + 1] = tmp[1]; communityArr[i * 3 + 2] = tmp[2];
      prArr[i] = Math.min(1, gs.pageRank / prCap);
      if (!node.isLibrary) pprRows.push({ i, ppr: gs.personalizedPageRank });
    }
    // Frontier = the band just beyond your taste, not "everything you haven't touched".
    // The prototype used `(1 - ppr)^1.8` over mock PPR that had a broad floor; real PPR is
    // concentrated around the library, so that formula lit almost every star at full
    // strength and the additive layer saturated into one giant magenta ball in Approach.
    // Rank by PPR percentile, light a soft band (≈80th–97th percentile) and cap the count.
    if (hasPPR && pprRows.length > 1) {
      pprRows.sort((a, b) => a.ppr - b.ppr);
      const last = pprRows.length - 1;
      const band = (p: number) => smoothstep(FRONTIER_BAND[0], FRONTIER_BAND[1], p) * (1 - smoothstep(FRONTIER_BAND[2], FRONTIER_BAND[3], p));
      const lit: Array<{ i: number; v: number }> = [];
      for (let r = 0; r <= last; r++) {
        const row = pprRows[r];
        if (row.ppr <= 0) continue;
        const v = band(r / last);
        if (v > 0.01) lit.push({ i: row.i, v: v * (0.5 + (this.nodes[row.i].luminance ?? 0.5) * 0.5) });
      }
      lit.sort((a, b) => b.v - a.v);
      for (let k = 0; k < Math.min(FRONTIER_MAX_LIT, lit.length); k++) frontierArr[lit[k].i] = lit[k].v;
    }
    communityAttr.needsUpdate = true;
    prAttr.needsUpdate = true;
    frontierIntensityAttr.needsUpdate = true;

    const coverage = this.nodes.length > 0 ? matchCount / this.nodes.length : 0;
    this.nodeMat.uniforms.u_communityMix.value = 0; // stars keep their genre colour
    this.frontierBase = (coverage >= 0.6 && hasPPR) ? 1.0 : 0;

    this.enrollNamedStars(scores, prCap, coverage);
    this.applyPRAurora();
  }

  private enrollNamedStars(scores: Record<string, GraphScores>, prCap: number, coverage: number) {
    const colorAttr = this.namedStarsMesh.geometry.getAttribute('aInstColor') as THREE.InstancedBufferAttribute;
    const phaseAttr = this.namedStarsMesh.geometry.getAttribute('aInstPhase') as THREE.InstancedBufferAttribute;
    if (coverage < 0.6) { this.namedBase = 0; this.namedStarsMesh.count = 0; return; }
    const communitySizes = new Map<number, number>();
    let maxAuth = 1e-9, maxHub = 1e-9;
    for (const k of Object.keys(scores)) {
      const gs = scores[k];
      if (gs.community >= 0) communitySizes.set(gs.community, (communitySizes.get(gs.community) ?? 0) + 1);
      if (gs.authority > maxAuth) maxAuth = gs.authority;
      if (gs.hub > maxHub) maxHub = gs.hub;
    }
    const authCap = maxAuth * 0.85, hubCap = maxHub * 0.85;
    const candidates: Array<{ node: GraphNode; pr: number; gs: GraphScores }> = [];
    for (const node of this.nodes) {
      const gs = scores[node.id];
      if (!gs || gs.pageRank <= 0) continue;
      candidates.push({ node, pr: gs.pageRank, gs });
    }
    candidates.sort((a, b) => b.pr - a.pr);
    const topN = Math.min(NAMED_STAR_CAPACITY, candidates.length);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < topN; i++) {
      const c = candidates[i];
      const cls = stellarClassify(
        Math.min(1, c.pr / prCap), Math.min(1, c.gs.authority / authCap), Math.min(1, c.gs.hub / hubCap),
        c.node.luminance ?? 0.5, communitySizes.get(c.gs.community) ?? 0,
      );
      dummy.position.set(c.node.x, c.node.y, c.node.z);
      dummy.scale.setScalar(cls === 'Hypergiant' || cls === 'Quasar' ? 1.35 : cls === 'Pulsar' || cls === 'NeutronStar' ? 0.85 : 1.0);
      dummy.updateMatrix();
      this.namedStarsMesh.setMatrixAt(i, dummy.matrix);
      const rgb = STELLAR_CLASS_RGB[cls];
      colorAttr.setXYZ(i, rgb[0], rgb[1], rgb[2]);
      phaseAttr.setX(i, hashPhase(c.node.id));
    }
    this.namedStarsMesh.count = topN;
    this.namedStarsMesh.instanceMatrix.needsUpdate = true;
    colorAttr.needsUpdate = true;
    phaseAttr.needsUpdate = true;
    this.namedBase = 1;
  }

  private applyPRAurora() {
    const prDelta = gameGraphStore.getPRDelta();
    const prDeltaAttr = this.points.geometry.getAttribute('aPRDelta') as THREE.BufferAttribute;
    const buffers = gameGraphStore.getScoreBuffers();
    if (!prDelta || !buffers) { this.nodeMat.uniforms.u_prAuroraMix.value = 0; return; }
    const idToGraphIdx = new Map<string, number>();
    for (let i = 0; i < buffers.nodeIds.length; i++) idToGraphIdx.set(buffers.nodeIds[i], i);
    const prDeltaArr = prDeltaAttr.array as Float32Array;
    let activeCount = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      const gIdx = idToGraphIdx.get(this.nodes[i].id);
      const d = gIdx !== undefined ? prDelta[gIdx] : 0;
      prDeltaArr[i] = d;
      if (d !== 0) activeCount++;
    }
    prDeltaAttr.needsUpdate = true;
    const coverage = this.nodes.length > 0 ? activeCount / this.nodes.length : 0;
    this.nodeMat.uniforms.u_prAuroraMix.value = coverage < 0.6 ? 0 : 0.12;
  }

  // ─── Flythrough (Year Wrapped handoff) ─────────────────────────────────────
  launchFlythrough(targets: FlythroughTarget[]) {
    if (targets.length < 2) return false;
    const controlPoints = targets.map(t => {
      const len = t.pos.length() || 1;
      const out = (len + 35) / len;
      return new THREE.Vector3(t.pos.x * out, t.pos.y * out + 12, t.pos.z * out);
    });
    const curve = new THREE.CatmullRomCurve3(controlPoints, false, 'catmullrom', 0.35);
    this.cancelFly();
    this.bloomWasEnabled = this.bloomPass.enabled !== false;
    this.bloomPass.enabled = false;
    this.controls.enabled = false;
    this.flythroughState = { curve, targets, startMs: performance.now(), durationMs: 60000, aborted: false, lastSegIdx: -1 };
    return true;
  }

  exitFlythrough() {
    if (this.flythroughState) this.flythroughState.aborted = true;
    this.flythroughState = null;
    this.controls.enabled = true;
    if (this.bloomWasEnabled) this.bloomPass.enabled = true;
    this.dollyTarget = this.camera.position.distanceTo(this.controls.target);
  }

  // ─── GLTF cosmos ───────────────────────────────────────────────────────────
  async loadGalaxyModel(): Promise<boolean> {
    try {
      const gltf = await new GLTFLoader().loadAsync(`${this.assetBase}need_some_space/scene.gltf`);
      if (this.destroyed) { gltf.scene.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); }); return false; }
      const model = gltf.scene;
      // Normalise: centre on origin, scale so the cloud radius ≈ 2600 world units
      // (the embedding space, radius ~400, sits buried at its core).
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const scale = 2600 / (sphere.radius || 1);
      const group = new THREE.Group();
      model.position.sub(center);
      group.add(model);
      group.scale.setScalar(scale);
      group.userData.baseScale = scale;
      group.rotation.x = -0.35;
      const mats: THREE.Material[] = [];
      model.traverse(obj => {
        const asPoints = obj as THREE.Points;
        const asMesh = obj as THREE.Mesh;
        if (!asPoints.isPoints && !asMesh.isMesh) return;
        const mat = (asPoints.isPoints ? asPoints.material : asMesh.material) as THREE.Material;
        mat.transparent = true;
        mat.opacity = 1;
        mat.depthWrite = false;
        if (asPoints.isPoints) {
          const pm = mat as THREE.PointsMaterial;
          pm.vertexColors = true;
          pm.size = 8; // world units (point size ignores parent group scale)
          pm.sizeAttenuation = true;
          pm.blending = THREE.NormalBlending;
          pm.map = getGlowTexture(); // soft round sprite instead of raw square points
          pm.alphaMap = null;
        }
        (mat as THREE.Material & { fog?: boolean }).fog = false;
        mat.needsUpdate = true;
        mats.push(mat);
      });
      group.renderOrder = -20;
      this.scene.add(group);
      this.gltfGroup = group;
      this.gltfMats = mats;
      this.gltfIntroStart = performance.now(); // fades in instead of popping
      return true;
    } catch (err) {
      console.warn('[Embedding Space] GLTF cosmos failed to load:', err);
      return false;
    }
  }

  lazyMountDressing() {
    if (this.dressing || this.destroyed) return;
    this.dressing = new SpaceDressing(this.scene, this.renderer, this.dressKey);
    this.prewarmShaders();
  }

  /**
   * Compile programs for layers that start hidden (dressing, nebulae, suns)
   * so the first approach / first selection doesn't hitch on shader compilation.
   * compileAsync gathers materials synchronously, so visibility is restored at once.
   */
  private prewarmShaders() {
    this.adaptAfter = Math.max(this.adaptAfter, performance.now() + 4000); // bake + compile isn't steady-state FPS
    const layers: Array<THREE.Object3D | null | undefined> = [this.dressing?.group, this.sunSelected.group, this.sunFocused.group, this.frontierPoints, this.gltfGroup];
    const hidden = layers.filter((o): o is THREE.Object3D => !!o && !o.visible);
    for (const o of hidden) o.visible = true;
    // Stand-ins for layers created per selection / per path (connections, orbits, the Path).
    // Their materials stay alive with the engine so the reference-counted programs are
    // never released between selections — no recompile hitch on select or hop.
    const flow = this.makeFlowLines({ x: 0, y: 0, z: 0 }, [{ id: '_', distance: 0, node: this.nodes[0] }], [1, 1, 1]);
    this.prewarmKeep.push(flow.mat);
    const temps = new THREE.Group();
    temps.add(flow.lines, ...this.orbits.prewarmObjects(), ...this.path.prewarmObjects());
    this.scene.add(temps);
    // Compile in the same context the composer renders in (its MSAA target: linear, no
    // tone mapping) — program cache keys include both, so a screen compile wouldn't match.
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.composer.renderTarget1);
    try {
      this.prewarmPromise = this.renderer.compileAsync(this.scene, this.camera)
        .catch(() => undefined)
        .finally(() => { this.prewarmPromise = null; });
    } finally {
      this.renderer.setRenderTarget(prevTarget);
      for (const o of hidden) o.visible = false;
      this.scene.remove(temps);
      flow.lines.geometry.dispose();
    }
  }

  // ─── Per-frame ─────────────────────────────────────────────────────────────
  private applyZoomState(now: number) {
    const d = this.camera.position.length();
    const zs = computeZoomState(d);
    let gltfO = zs.gltfOpacity;
    const fade = zs.embedFade;
    this.embedFade = fade;
    const fovF = zs.fov + this.fx.fov;
    if (Math.abs(this.camera.fov - fovF) > 0.02) { this.camera.fov = fovF; this.camera.updateProjectionMatrix(); }
    this.renderer.toneMappingExposure = zs.exposure + this.fx.exposure;
    if (this.railMarkerEl) this.railMarkerEl.style.top = `${zs.railTop}%`;

    const zone = nextZone(d, fade, this.zone);
    if (zone !== this.zone) {
      this.zone = zone;
      this.onZoneChange?.(zone);
    }

    this.nodeMat.uniforms.u_fade.value = fade;
    this.dressing?.update(fade, d, this.camera);
    this.nodeMat.uniforms.u_igniteAge.value = (now - this.igniteStart) / 1000;
    this.starMat.uniforms.u_fade.value = fade;
    // GLTF cosmos: 2.2 s intro fade on first appearance with a slight scale settle
    if (this.gltfGroup) {
      const it = this.gltfIntroStart ? Math.min(1, (now - this.gltfIntroStart) / 2200) : 1;
      const ie = 1 - Math.pow(1 - it, 3);
      gltfO *= ie;
      if (it < 1) this.gltfGroup.scale.setScalar(this.gltfGroup.userData.baseScale * (0.94 + 0.06 * ie));
      else if (this.gltfIntroStart) { this.gltfGroup.scale.setScalar(this.gltfGroup.userData.baseScale); this.gltfIntroStart = 0; }
      const vis = gltfO > 0.012;
      this.gltfGroup.visible = vis;
      if (vis) for (const m of this.gltfMats) m.opacity = gltfO;
    }
    // Fog eases off at macro distance so the cosmos stays readable
    if (this.scene.fog instanceof THREE.FogExp2) this.scene.fog.density = 0.0008 * (0.12 + 0.88 * fade);
    // Skybox rides the crossfade: strongest out in the cosmos, dim inside the field
    this.scene.backgroundIntensity = this.skyboxEnabled ? 0.18 + 0.5 * gltfO : 0.02;
    // Text/opacity writes only on change — these run every frame
    const depthText = `CORE::${Math.round(d)}u`;
    if (this.depthEl && depthText !== this.lastDepthText) { this.depthEl.textContent = depthText; this.lastDepthText = depthText; }
    if (this.approachWrapEl) {
      const show = this.zone === 'approach';
      const approachText = show ? `EMBEDDING SPACE ${Math.round(fade * 100)}%` : '';
      if (approachText !== this.lastApproachText) {
        this.approachWrapEl.style.opacity = show ? '1' : '0';
        if (show && this.approachEl) this.approachEl.textContent = approachText;
        this.lastApproachText = approachText;
      }
    }
  }

  private updateSun(g: SunGroup, pos: THREE.Vector3 | null, c: Vec3Tuple, t: number) {
    if (!pos) { g.group.visible = false; return; }
    g.group.visible = true;
    g.group.position.copy(pos);
    g.surfaceMat.uniforms.u_time.value = t;
    g.surfaceMat.uniforms.u_color.value.setRGB(c[0], c[1], c[2]);
    g.surfaceMat.uniforms.u_colorBright.value.setRGB(Math.min(c[0] + 0.3, 1), Math.min(c[1] + 0.3, 1), Math.min(c[2] + 0.3, 1));
    g.glowSpriteMat.color.setRGB(c[0], c[1], c[2]);
  }

  private adaptQuality(fps: number, now: number) {
    // Startup (GLTF parse, graph layers, nebula bake, shader prewarm) isn't representative
    if (now < this.adaptAfter) { this.lowFps = 0; return; }
    this.lowFps = fps < 42 ? this.lowFps + 1 : 0;
    if (this.lowFps < 4 || this.degraded) return;
    // Sustained low FPS: pixel ratio → 1, MSAA off, bloom to third-res. (No extra
    // lower-quality mode while moving — that was tried and rejected.)
    this.degraded = true;
    this.renderer.setPixelRatio(1);
    const cw = this.cachedCW, ch = this.cachedCH;
    this.renderer.setSize(cw, ch);
    this.composer.renderTarget1.samples = 0; this.composer.renderTarget2.samples = 0;
    this.composer.setPixelRatio(1); this.composer.setSize(cw, ch);
    this.bloomPass.setSize(Math.ceil(cw / 3), Math.ceil(ch / 3));
    this.haloPts.material.uniforms.uPx.value = 1;
    console.info('[Embedding Space] Adaptive quality: reduced resolution for performance');
  }

  /** Dev/test: advance one frame synchronously (rAF is paused in hidden windows). */
  stepFrame() { if (import.meta.env.DEV) this.animate(); }

  private animate() {
    if (this.destroyed) return;
    this.animFrameId = requestAnimationFrame(this.animate);
    const now = performance.now();
    // Background throttle: hidden or unfocused windows (e.g. while the user is in a game)
    // drop to ~2 updates/s with no rendering, so Ark never competes with the game for the GPU.
    if (document.hidden || !document.hasFocus()) {
      if (now - this.lastRenderTime < BG_FRAME_INTERVAL) return;
      this.lastRenderTime = now;
      this.controls.update();
      return;
    } else if (now - this.lastRenderTime > BG_FRAME_INTERVAL) {
      this.prevTime = now;
      this.frames = 0;
    }
    this.lastRenderTime = now;
    this.frames++;
    const elapsed = now - this.prevTime;
    if (elapsed >= 500) {
      const fps = Math.round((this.frames * 1000) / elapsed);
      this.frames = 0;
      this.prevTime = now;
      if (this.fpsEl) this.fpsEl.textContent = `${fps} FPS`;
      this.adaptQuality(fps, now);
    }

    const dt = Math.min(0.05, Math.max(0.001, (now - (this.lastT || now)) / 1000));
    this.lastT = now;
    const damp = (rate: number) => 1 - Math.exp(-rate * dt);
    // Capture the flight before ticking GSAP: the tick that completes it also clears
    // flyAnim, and the camera must still receive that final position.
    const flyBefore = this.flyAnim;
    gsap.updateRoot(now / 1000);
    const fly = this.flyAnim ?? (flyBefore && flyBefore.p >= 1 ? flyBefore : null);
    if (fly) {
      const t = fly.p, it = 1 - t;
      this.camera.position.set(
        it * it * fly.startCamPos.x + 2 * it * t * fly.ctrl.x + t * t * fly.endCamPos.x,
        it * it * fly.startCamPos.y + 2 * it * t * fly.ctrl.y + t * t * fly.endCamPos.y,
        it * it * fly.startCamPos.z + 2 * it * t * fly.ctrl.z + t * t * fly.endCamPos.z,
      );
      this.controls.target.lerpVectors(fly.startTarget, fly.endTarget, fly.q);
    }
    this.controls.autoRotate = this.autoOrbit && !fly;
    if (fly) this.dollyTarget = this.camera.position.distanceTo(this.controls.target);
    else if (!this.flythroughState) {
      const off = this.dollyVec.subVectors(this.camera.position, this.controls.target);
      const cur = off.length();
      if (Math.abs(cur - this.dollyTarget) > 0.05) {
        const next = cur + (this.dollyTarget - cur) * damp(5.5);
        off.multiplyScalar(next / cur);
        this.camera.position.copy(this.controls.target).add(off);
      }
    }
    this.controls.update();
    this.applyZoomState(now);
    this.orbits.update(now, this.zone === 'node', !!this.sunState.selectedPos || !!this.flyAnim);
    this.path.update(this.flyAnim ? this.flyAnim.p : null, damp);
    {
      const hu = this.haloPts.material.uniforms;
      hu.uTime.value = now / 1000;
      hu.uAge.value = (now - this.haloStart) / 1000;
      hu.uOpacity.value = this.zone === 'node' ? 1 : 0;
    }
    if (this.nodeFadeTarget !== undefined && this.nodeFade !== this.nodeFadeTarget) {
      let nf = this.nodeFade + (this.nodeFadeTarget - this.nodeFade) * damp(3.2);
      if (Math.abs(nf - this.nodeFadeTarget) < 0.01) nf = this.nodeFadeTarget;
      this.nodeFade = nf;
      this.applyNodeFade(nf);
    } else if (this.nodeFade < 1) this.applyNodeFade(this.nodeFade);
    {
      // Subtle pointer parallax in node view while the camera is at rest
      const want = this.zone === 'node' && !this.flyAnim && !this.flythroughState ? 1 : 0;
      this.plxAmt += (want - this.plxAmt) * damp(1.6);
      this.plxX += (this.mouseNX - this.plxX) * damp(2.2);
      this.plxY += (this.mouseNY - this.plxY) * damp(2.2);
      if (this.plxAmt > 0.001) {
        this.camera.rotateY(-this.plxX * 0.026 * this.plxAmt);
        this.camera.rotateX(this.plxY * 0.018 * this.plxAmt);
      }
    }
    if (this.gltfGroup && this.gltfGroup.visible) this.gltfGroup.rotation.y += 0.00022;
    if (this.focusedLines && this.focusedLinesOpacity < 1) {
      this.focusedLinesOpacity = Math.min(1, this.focusedLinesOpacity + 0.035);
      this.focusedLines.mat.opacity = Math.min(this.focusedLinesOpacity, this.nodeFade);
    }

    const t = now * 0.001;
    this.nodeMat.uniforms.u_time.value = t;
    const tod = (t % 1800) / 1800;
    this.nodeMat.uniforms.u_galacticTimeOfDay.value = tod;
    this.starMat.uniforms.u_time.value = t;
    this.starMat.uniforms.u_galacticTimeOfDay.value = tod;
    const fu = this.frontierPoints.material.uniforms;
    fu.u_time.value = t;
    fu.u_globalIntensity.value = this.frontierBase * this.embedFade;
    // 30k large soft points = heavy overdraw: skip entirely in node view or when faint
    this.frontierPoints.visible = this.zone !== 'node' && fu.u_globalIntensity.value > 0.03;
    const nu = this.namedStarsMesh.material.uniforms;
    nu.u_time.value = t;
    nu.u_globalIntensity.value = this.namedBase * this.embedFade;

    // Flythrough camera
    const fs = this.flythroughState;
    if (fs) {
      const ft = Math.min(1, (now - fs.startMs) / fs.durationMs);
      const ease = ft < 0.5 ? 2 * ft * ft : 1 - Math.pow(-2 * ft + 2, 2) / 2;
      this.camera.position.copy(fs.curve.getPointAt(ease));
      const lookPoint = fs.curve.getPointAt(Math.min(1, ease + 0.012));
      const seg = ease * (fs.targets.length - 1);
      const segIdx = Math.min(fs.targets.length - 1, Math.floor(seg));
      this.controls.target.lerpVectors(lookPoint, fs.targets[segIdx].pos, 0.55);
      const lowerIdx = Math.min(fs.targets.length - 1, Math.floor(seg + 0.15));
      if (fs.lastSegIdx !== lowerIdx) {
        fs.lastSegIdx = lowerIdx;
        this.onFlythroughSegment?.(lowerIdx);
      }
      if (ft >= 1 && !fs.aborted) {
        fs.aborted = true;
        setTimeout(() => { if (!this.destroyed) this.onFlythroughEnd?.(); }, 800);
      }
    }

    // Probe drift (WASD/QE)
    const vel = this.probeVelocity;
    if (this.probeActive) {
      const keys = this.keysDown;
      const thrust = 4.5;
      const forward = this.camera.getWorldDirection(this.tmpForward);
      const right = this.tmpRight.crossVectors(forward, this.camera.up).normalize();
      const up = this.tmpUp.copy(this.camera.up).normalize();
      if (keys.has('w')) vel.addScaledVector(forward, thrust);
      if (keys.has('s')) vel.addScaledVector(forward, -thrust);
      if (keys.has('a')) vel.addScaledVector(right, -thrust);
      if (keys.has('d')) vel.addScaledVector(right, thrust);
      if (keys.has('q')) vel.addScaledVector(up, -thrust);
      if (keys.has('e')) vel.addScaledVector(up, thrust);
      vel.multiplyScalar(0.92);
      if (Math.abs(vel.x) > 0.01 || Math.abs(vel.y) > 0.01 || Math.abs(vel.z) > 0.01) {
        const p = this.camera.position;
        p.set(Math.max(-2000, Math.min(2000, p.x + vel.x)), Math.max(-2000, Math.min(2000, p.y + vel.y)), Math.max(-2000, Math.min(2000, p.z + vel.z)));
        this.controls.target.add(vel);
        this.dollyTarget = this.camera.position.distanceTo(this.controls.target);
      }
    } else if (vel.lengthSq() > 0) vel.set(0, 0, 0);

    this.updateSun(this.sunSelected, this.sunState.selectedPos, this.sunState.selectedColor, t);
    this.updateSun(this.sunFocused, this.sunState.focusedPos, this.sunState.focusedColor, t);

    {
      const cu = this.cinemaPass.uniforms;
      const sp = this.sunState.selectedPos;
      let on = 0;
      if (sp && this.zone === 'node') {
        const pv = this.focusVec.copy(sp).project(this.camera);
        if (pv.z < 1) { cu.uFocus.value.set(pv.x * 0.5 + 0.5, pv.y * 0.5 + 0.5); on = 1; }
      }
      cu.uFocusOn.value += (on - cu.uFocusOn.value) * damp(2.4);
      cu.uMBlur.value = this.fx.mblur;
      cu.uFlash.value = this.fx.flash;
      if (this.flyAnim && !on) {
        const fv = this.focusVec2.copy(this.flyAnim.endTarget).project(this.camera);
        if (fv.z < 1) cu.uFocus.value.set(fv.x * 0.5 + 0.5, fv.y * 0.5 + 0.5);
      }
      const sinceSel = (now - this.igniteStart) / 1000;
      const pull = on ? 0.35 + 0.55 * Math.sin(Math.PI * Math.min(1, sinceSel / 1.4)) * (sinceSel < 1.4 ? 1 : 0) : 0;
      cu.uBlur.value += (pull - cu.uBlur.value) * damp(3.0);
      // Motion drives the extra chromatic fringe: camera speed, eased
      const speed = this.motPrev.distanceTo(this.camera.position) / Math.max(dt, 0.001);
      this.motPrev.copy(this.camera.position);
      cu.uMotion.value += (Math.min(1, speed / 900) - cu.uMotion.value) * damp(4.0);
      cu.uTime.value = t;
    }
    this.composer.render();
    this.cards.project(this.camera, dt, this.cachedCW, this.cachedCH, this.cachedRect, !!this.flyAnim);
  }

  /** Render a frame synchronously (screenshot capture). */
  render() { this.composer.render(); }

  dispose() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (import.meta.env.DEV) { const w = window as unknown as { __esEngine?: GalaxyEngine }; if (w.__esEngine === this) delete w.__esEngine; }
    this.observer.disconnect();
    cancelAnimationFrame(this.animFrameId);
    if (this.resizeRaf) cancelAnimationFrame(this.resizeRaf);
    if (this.flyTl) this.flyTl.kill();
    if (this.flyAnim) this.flyAnim.landCbs = [];
    this.flyAnim = null;
    gsap.killTweensOf(this.fx);
    if (this.snapTimer) clearTimeout(this.snapTimer);
    this.renderer.domElement.removeEventListener('wheel', this.onWheel);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    window.removeEventListener('pointermove', this.onPtrMove);
    this.controls.dispose();
    // OrbitControls unregisters its keydown interceptor from canvas.getRootNode(); if the
    // canvas was detached first, that isn't `document` and the listener would leak.
    {
      const oc = this.controls as unknown as { _interceptControlDown?: EventListener; _interceptControlUp?: EventListener };
      if (oc._interceptControlDown) document.removeEventListener('keydown', oc._interceptControlDown, { capture: true });
      if (oc._interceptControlUp) document.removeEventListener('keyup', oc._interceptControlUp, { capture: true });
    }
    this.cards.dispose();
    if (this.renderer.domElement.parentNode === this.container) this.container.removeChild(this.renderer.domElement);
    // GPU teardown waits for an in-flight shader prewarm: three's compileAsync keeps polling
    // its materials and would throw if they (or the renderer) were disposed under it.
    if (this.prewarmPromise) {
      const release = () => { clearTimeout(fallback); this.releaseGpu(); };
      const fallback = setTimeout(release, 10_000);
      void this.prewarmPromise.finally(release);
    } else this.releaseGpu();
  }

  private gpuReleased = false;
  private releaseGpu() {
    if (this.gpuReleased) return;
    this.gpuReleased = true;
    this.clearConnections();
    this.clearFocusedConnections();
    this.path.dispose();
    this.orbits.dispose();
    this.dressing?.dispose();
    for (const m of this.prewarmKeep) m.dispose();
    this.scene.remove(this.dressKey);
    for (const g of [this.sunSelected, this.sunFocused]) { g.surfaceGeo.dispose(); g.surfaceMat.dispose(); g.glowSpriteMat.dispose(); }
    this.haloPts.geometry.dispose(); this.haloPts.material.dispose();
    this.points.geometry.dispose(); this.starField.geometry.dispose(); this.frontierPoints.geometry.dispose();
    this.nodeMat.dispose(); this.starMat.dispose(); this.frontierPoints.material.dispose();
    this.namedStarsMesh.geometry.dispose(); this.namedStarsMesh.material.dispose(); this.namedStarsMesh.dispose();
    this.nebTex.dispose();
    if (this.gltfGroup) {
      this.scene.remove(this.gltfGroup);
      for (const m of this.gltfMats) m.dispose();
      this.gltfGroup.traverse(o => { const g = (o as THREE.Mesh).geometry; if (g) g.dispose(); });
      this.gltfGroup = null;
    }
    for (const pass of this.composer.passes) (pass as { dispose?: () => void }).dispose?.();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
