/**
 * Embedding Space View — Galaxy-map 3D visualization of all game embeddings
 *
 * Renders 60K+ game nodes as glowing particles using THREE.Points (single
 * draw call). WebGPU renderer when available, with automatic WebGL fallback.
 * Galaxy data (PCA positions + metadata) is cached in IDB by galaxy-cache.ts
 * so repeat visits load instantly.
 */

import { useState, useEffect, useCallback, useRef, useMemo, type FC } from 'react';
import { toPng } from 'html-to-image';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Search, Filter, Loader2, Check, RotateCcw, X, Library, ChevronLeft, ChevronRight, Crosshair, Route, Waypoints, Info, Clock, MousePointer, Move, ZoomIn, Plus, Camera } from 'lucide-react';
import type { SteamAppDetails } from '@/types/steam';
import type { EpicCatalogItem, EpicProductReviews } from '@/types/epic';
import { libraryStore } from '@/services/library-store';
import { getStoreFromId } from '@/types/game';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { buildGameImageChain } from '@/lib/utils';
import { getEmbeddingById, embeddingService } from '@/services/embedding-service';
import { annIndex } from '@/services/ann-index';
import { journeyStore } from '@/services/journey-store';
import {
  type GraphNode,
  type NeighborInfo,
  type GalaxyStepReporter,
  GENRE_PALETTE,
  GALAXY_STEP_LABELS,
  loadCachedGalaxyIfFresh,
  buildAndCacheGalaxy,
  getBackgroundBuildPromise,
} from '@/services/galaxy-cache';
import { scoreGame, type SearchIndexEntry } from '@/services/prefetch-store';

/** Image with robust fallback chain — cycles through URLs on error */
const FallbackImg: FC<{
  node: { id: string; title: string; coverUrl?: string };
  className?: string;
  fallbackClassName?: string;
  loading?: 'lazy' | 'eager';
}> = ({ node, className = '', fallbackClassName = '', loading }) => {
  const chain = useRef<string[]>([]);
  const idxRef = useRef(0);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    chain.current = buildGameImageChain(node.id, node.title, node.coverUrl);
    idxRef.current = 0;
    setFailed(false);
    setSrc(chain.current[0] ?? null);
  }, [node.id, node.title, node.coverUrl]);

  const handleError = useCallback(() => {
    idxRef.current++;
    if (idxRef.current < chain.current.length) {
      setSrc(chain.current[idxRef.current]);
    } else {
      setFailed(true);
    }
  }, []);

  if (failed || !src) {
    return <div className={fallbackClassName || `w-full h-full flex items-center justify-center text-white/15 text-xs font-bold`}>NO IMAGE</div>;
  }
  return <img src={src} alt="" className={className} loading={loading} onError={handleError} />;
};

interface LoadingStep {
  label: string;
  status: 'pending' | 'running' | 'done' | 'waiting';
  detail?: string;
}

interface NodeDetailData {
  steam?: SteamAppDetails;
  epic?: { item: EpicCatalogItem; reviews: EpicProductReviews | null };
  stores: ('steam' | 'epic')[];
}

const SteamIcon: FC<{ className?: string }> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658a3.387 3.387 0 0 1 1.912-.59c.064 0 .128.002.19.006l2.861-4.142V8.91a4.528 4.528 0 0 1 4.524-4.524 4.528 4.528 0 0 1 4.524 4.524 4.528 4.528 0 0 1-4.524 4.524h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396a3.406 3.406 0 0 1-3.362-2.898L.309 14.04C1.555 19.63 6.304 24 11.979 24c6.627 0 12-5.373 12-12S18.606 0 11.979 0zM7.54 18.21l-1.473-.61a2.535 2.535 0 0 0 4.568.388 2.546 2.546 0 0 0-.387-2.116 2.545 2.545 0 0 0-1.907-.996l1.526.631a1.874 1.874 0 0 1-1.424 3.465 1.876 1.876 0 0 1-.903-.762zm8.4-5.874a3.02 3.02 0 0 0 3.016-3.016 3.02 3.02 0 0 0-3.016-3.016 3.02 3.02 0 0 0-3.016 3.016 3.02 3.02 0 0 0 3.016 3.016zm-.001-5.277a2.265 2.265 0 0 1 2.262 2.262 2.265 2.265 0 0 1-2.262 2.262 2.265 2.265 0 0 1-2.262-2.262c0-1.248 1.015-2.262 2.262-2.262z"/>
  </svg>
);

const EpicIcon: FC<{ className?: string }> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M3.537 0C2.165 0 1.66.506 1.66 1.879V22.12c0 1.374.504 1.88 1.877 1.88h16.926c1.374 0 1.877-.506 1.877-1.88V1.88C22.34.505 21.837 0 20.463 0H3.537zm6.166 3.985h4.87v1.066h-3.612v3.06h3.248v1.065h-3.248v3.246h3.695V13.5H9.703V3.985zm-5.05.008h1.14l2.218 4.872 2.218-4.872h1.14V13.5h-1.066V6.206l-1.922 4.142h-.74L5.72 6.206V13.5H4.653V3.993z"/>
  </svg>
);

const StoreLogos: FC<{ nodeId: string; className?: string }> = ({ nodeId, className = '' }) => {
  const store = getStoreFromId(nodeId);
  const libEntry = libraryStore.getEntry(nodeId);
  const hasSecondary = !!libEntry?.secondaryGameId;
  const secondaryStore = hasSecondary ? getStoreFromId(libEntry!.secondaryGameId!) : null;

  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      {store === 'steam' && <SteamIcon className="w-3 h-3 text-white/30" />}
      {store === 'epic' && <EpicIcon className="w-3 h-3 text-white/30" />}
      {secondaryStore === 'steam' && <SteamIcon className="w-3 h-3 text-white/20" />}
      {secondaryStore === 'epic' && <EpicIcon className="w-3 h-3 text-white/20" />}
    </span>
  );
};

const DetailPanelContent: FC<{ data: NodeDetailData; nodeId: string }> = ({ data, nodeId }) => {
  const s = data.steam;
  const e = data.epic;
  const epicPrice = e?.item.price?.totalPrice;
  const epicSlug = e?.item.productSlug || e?.item.offerMappings?.[0]?.pageSlug || e?.item.catalogNs?.mappings?.[0]?.pageSlug;
  const steamAppId = nodeId.match(/^steam-(\d+)$/)?.[1]
    ?? libraryStore.getEntry(nodeId)?.secondaryGameId?.match(/^steam-(\d+)$/)?.[1]
    ?? (s ? String(s.steam_appid) : null);

  return (
    <div className="px-3 py-2.5 space-y-2 text-[10px]">
      {s?.metacritic && (
        <div className="flex items-center justify-between">
          <span className="text-white/40">Metacritic</span>
          <a href={s.metacritic.url} target="_blank" rel="noreferrer" className={`font-bold tabular-nums ${
            s.metacritic.score >= 75 ? 'text-emerald-400' : s.metacritic.score >= 50 ? 'text-yellow-400' : 'text-red-400'
          }`}>{s.metacritic.score}</a>
        </div>
      )}
      {(s || e) && (
        <div className="space-y-1.5">
          {s?.price_overview ? (
            <div className="flex items-center justify-between">
              <span className="text-white/40 flex items-center gap-1"><SteamIcon className="w-2.5 h-2.5" /> Price</span>
              <div className="flex items-center gap-1.5">
                {s.price_overview.discount_percent > 0 && (
                  <span className="text-[9px] px-1 py-[1px] rounded bg-emerald-500/20 text-emerald-400 font-bold">-{s.price_overview.discount_percent}%</span>
                )}
                <span className="text-white/80 font-medium">{s.price_overview.final_formatted}</span>
              </div>
            </div>
          ) : s?.is_free ? (
            <div className="flex items-center justify-between">
              <span className="text-white/40 flex items-center gap-1"><SteamIcon className="w-2.5 h-2.5" /> Price</span>
              <span className="text-emerald-400 font-medium">Free to Play</span>
            </div>
          ) : null}
          {epicPrice && epicPrice.discountPrice != null ? (
            <div className="flex items-center justify-between">
              <span className="text-white/40 flex items-center gap-1"><EpicIcon className="w-2.5 h-2.5" /> Price</span>
              <div className="flex items-center gap-1.5">
                {epicPrice.originalPrice != null && epicPrice.originalPrice > epicPrice.discountPrice && epicPrice.originalPrice > 0 && (
                  <span className="text-[9px] px-1 py-[1px] rounded bg-emerald-500/20 text-emerald-400 font-bold">
                    -{Math.round(((epicPrice.originalPrice - epicPrice.discountPrice) / epicPrice.originalPrice) * 100)}%
                  </span>
                )}
                <span className="text-white/80 font-medium">
                  {epicPrice.discountPrice === 0 ? 'Free' : epicPrice.fmtPrice?.discountPrice ?? epicPrice.fmtPrice?.originalPrice ?? 'N/A'}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      )}
      <div className="pt-1 border-t border-white/[0.04] flex items-center gap-1.5">
        {steamAppId && (
          <a
            href={`https://store.steampowered.com/app/${steamAppId}`}
            target="_blank"
            rel="noreferrer"
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-white/[0.03] hover:bg-white/[0.07] text-white/50 hover:text-white/80 transition-colors text-[10px]"
          >
            <SteamIcon className="w-2.5 h-2.5" /> Steam ↗
          </a>
        )}
        {epicSlug && (
          <a
            href={`https://store.epicgames.com/p/${epicSlug}`}
            target="_blank"
            rel="noreferrer"
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-white/[0.03] hover:bg-white/[0.07] text-white/50 hover:text-white/80 transition-colors text-[10px]"
          >
            <EpicIcon className="w-2.5 h-2.5" /> Epic ↗
          </a>
        )}
      </div>
    </div>
  );
};

// ─── GLSL shaders for glow particles (WebGL fallback) ───────────────────────

const NODE_VERTEX = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aBrightness;
  varying vec3 vColor;
  varying float vBrightness;

  void main() {
    vColor = aColor;
    vBrightness = aBrightness;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (400.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const NODE_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vBrightness;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.0, d);
    float glow = exp(-6.0 * d * d);
    float alpha = mix(glow, core, 0.4) * vBrightness;
    vec3 color = mix(vColor, vec3(1.0), core * 0.35);
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

// ─── Sun-like shader for selected/focused nodes ──────────────────────────────
// Adapted from https://sangillee.com/2024-06-29-create-realistic-sun-with-shaders/
// Uses fractal Brownian motion for animated gas-flow surface + Fresnel rim glow.

const SUN_VERTEX = /* glsl */ `
  varying vec3 vPos;
  varying vec3 vViewDir;
  varying vec3 vViewNorm;

  void main() {
    vPos = position;
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewDir = -normalize(mvPos.xyz);
    vViewNorm = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const SUN_FRAGMENT = /* glsl */ `
  uniform float u_time;
  uniform vec3 u_color;
  uniform vec3 u_colorBright;

  varying vec3 vPos;
  varying vec3 vViewDir;
  varying vec3 vViewNorm;

  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 23.112))) * 43758.5453);
  }

  float noise3D(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1,0,0)), u.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), u.x), u.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), u.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), u.x), u.y),
      u.z);
  }

  float fbm(vec3 p) {
    float v = 0.0, a = 0.5;
    float t = u_time * 0.12;
    for (int i = 0; i < 5; i++) {
      v += a * noise3D(p + t);
      p = p * 2.1 + vec3(t * 0.3);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 p = vPos * 3.5;
    vec3 q = vec3(fbm(p), fbm(p + vec3(5.2, 1.3, 2.8)), fbm(p + vec3(2.1, 3.7, 1.4)));
    float n = fbm(p + q * 2.0);

    vec3 col = mix(u_color, u_colorBright, clamp(n * n * 1.5, 0.0, 1.0));
    col = mix(col, u_color * 0.7, clamp(length(q) * 0.5, 0.0, 1.0));

    float rim = 1.0 - max(dot(vViewDir, vViewNorm), 0.0);
    col += u_colorBright * pow(rim, 2.0) * 0.8;

    gl_FragColor = vec4(col * 2.5, 1.0);
  }
`;

let _glowTexture: THREE.Texture | null = null;
function getGlowTexture(): THREE.Texture {
  if (_glowTexture) return _glowTexture;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
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
  _glowTexture = new THREE.CanvasTexture(canvas);
  return _glowTexture;
}

function createSunGroup(radius: number) {
  const surfaceGeo = new THREE.IcosahedronGeometry(radius, 4);
  const surfaceMat = new THREE.ShaderMaterial({
    vertexShader: SUN_VERTEX,
    fragmentShader: SUN_FRAGMENT,
    uniforms: {
      u_time: { value: 0 },
      u_color: { value: new THREE.Color(1, 0.7, 1) },
      u_colorBright: { value: new THREE.Color(1, 1, 1) },
    },
  });
  const surfaceMesh = new THREE.Mesh(surfaceGeo, surfaceMat);

  const glowSpriteMat = new THREE.SpriteMaterial({
    map: getGlowTexture(),
    color: new THREE.Color(1, 0.7, 1),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glowSprite = new THREE.Sprite(glowSpriteMat);
  glowSprite.scale.set(radius * 8, radius * 8, 1);
  glowSpriteMat.opacity = 0.7;

  const group = new THREE.Group();
  group.add(surfaceMesh);
  group.add(glowSprite);
  group.visible = false;
  return { group, surfaceMat, surfaceGeo, glowSpriteMat };
}

// ─── Loading skeleton ───────────────────────────────────────────────────────

const LoadingSkeleton: FC<{ steps: LoadingStep[] }> = ({ steps }) => {
  const allDone = steps.length > 0 && steps.every(s => s.status === 'done');
  const activeIdx = steps.findIndex(s => s.status === 'running' || s.status === 'waiting');
  const pct = allDone ? 100 : steps.length > 0 ? Math.round((steps.filter(s => s.status === 'done').length / steps.length) * 100) : 0;

  const stepBase = (label: string) => {
    const sep = label.indexOf(' — ');
    return sep >= 0 ? label.slice(0, sep) : label;
  };

  return (
    <div className="absolute inset-0 flex items-center justify-center z-30">
      <div className="w-[340px] bg-black/70 backdrop-blur-xl border border-white/[0.06] rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          {!allDone && (
            <div className="relative w-8 h-8 shrink-0">
              <svg className="w-8 h-8 -rotate-90" viewBox="0 0 32 32">
                <circle cx="16" cy="16" r="13" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="2.5" />
                <circle cx="16" cy="16" r="13" fill="none" stroke="url(#loader-grad)" strokeWidth="2.5"
                  strokeLinecap="round" strokeDasharray={`${(pct / 100) * 81.7} 81.7`}
                  className="transition-all duration-500" />
              </svg>
              <svg className="absolute inset-0 w-8 h-8 -rotate-90 animate-spin" style={{ animationDuration: '2s' }} viewBox="0 0 32 32">
                <defs><linearGradient id="loader-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#d946ef" /><stop offset="100%" stopColor="#a855f7" /></linearGradient></defs>
                <circle cx="16" cy="16" r="13" fill="none" stroke="rgba(217,70,239,0.15)" strokeWidth="2"
                  strokeLinecap="round" strokeDasharray="12 69.7" />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold font-mono text-fuchsia-400/80">{pct}%</span>
            </div>
          )}
          {allDone && <Check className="w-5 h-5 text-emerald-400 shrink-0" />}
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-white/60">Initializing Embedding Space</h3>
            {activeIdx >= 0 && <p className="text-[10px] text-fuchsia-400/60 mt-0.5 truncate">{stepBase(steps[activeIdx].label)}</p>}
          </div>
        </div>
        <div className="space-y-2.5">
          {steps.map((step, i) => (
            <div key={i} className="flex items-center gap-2.5">
              <div className="shrink-0 w-4 h-4 flex items-center justify-center">
                {step.status === 'done' ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : step.status === 'waiting' ? (
                  <Clock className="w-3.5 h-3.5 text-white/30" />
                ) : step.status === 'running' ? (
                  <Loader2 className="w-3.5 h-3.5 text-fuchsia-400 animate-spin" />
                ) : (
                  <Loader2 className="w-3.5 h-3.5 text-white/10 animate-spin" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-[11px] leading-tight truncate ${
                  step.status === 'done' ? 'text-white/40'
                  : step.status === 'waiting' ? 'text-white/40'
                  : step.status === 'running' ? 'text-white/80'
                  : 'text-white/20'
                }`}>
                  {stepBase(step.label)}
                </p>
                {step.status === 'running' && (
                  <div className="mt-1 h-0.5 bg-white/[0.04] rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-fuchsia-500/40 to-purple-500/40 rounded-full animate-pulse w-2/3" />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ─── Hero intro text — appears once galaxy finishes loading ──────────────────

const HERO_TEXT = '// Accessing embedding space';

const HeroIntro: FC<{ visible: boolean }> = ({ visible }) => {
  const [charCount, setCharCount] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!visible) { setCharCount(0); return; }
    let i = 0;
    intervalRef.current = setInterval(() => {
      i++;
      setCharCount(i);
      if (i >= HERO_TEXT.length && intervalRef.current) clearInterval(intervalRef.current);
    }, 45);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [visible]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="hero-intro"
          className="absolute inset-0 flex items-center justify-center z-[25] pointer-events-none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, y: -20, filter: 'blur(6px)' }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        >
          <p className="text-2xl md:text-4xl font-mono font-medium tracking-[0.15em] text-white/70">
            {HERO_TEXT.slice(0, charCount)}
            <span className="inline-block w-[2px] h-[1em] bg-white/70 ml-0.5 align-middle animate-pulse" />
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

// ─── Node info panel ────────────────────────────────────────────────────────

// ─── Renderer ────────────────────────────────────────────────────────────────
// Uses WebGLRenderer + GLSL ShaderMaterial — stable across all Chromium builds.
// GPU-accelerated PCA (via navigator.gpu compute shaders) is handled separately
// in galaxy-cache.ts and is unaffected by the renderer choice here.

type RendererBackend = 'WebGL2' | 'WebGL';

interface RendererBundle {
  renderer: THREE.WebGLRenderer;
  backend: RendererBackend;
  nodeMat: THREE.ShaderMaterial;
  starMat: THREE.ShaderMaterial;
}

function createRendererBundle(w: number, h: number): RendererBundle {
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(0x020208, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const backend: RendererBackend = renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL';
  console.log(`[Embedding Space] Renderer: ${backend}`);

  const createMat = () =>
    new THREE.ShaderMaterial({
      vertexShader: NODE_VERTEX,
      fragmentShader: NODE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

  return { renderer, backend, nodeMat: createMat(), starMat: createMat() };
}

// ─── Main component ─────────────────────────────────────────────────────────

export function AnnGraphView({ onBack }: { onBack: () => void }) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const screenshotAreaRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    points: THREE.Points;
    starField: THREE.Points;
    lines: THREE.LineSegments | null;
    linesMat: THREE.LineDashedMaterial | null;
    pathLines: THREE.LineSegments | null;
    pathLinesMat: THREE.LineDashedMaterial | null;
    pathLabels: THREE.Group | null;
    raycaster: THREE.Raycaster;
    mouse: THREE.Vector2;
    nodes: GraphNode[];
    colorAttr: THREE.BufferAttribute;
    sizeAttr: THREE.BufferAttribute;
    brightnessAttr: THREE.BufferAttribute;
    animFrameId: number;
    composer: EffectComposer;
    sunSelected: ReturnType<typeof createSunGroup>;
    sunFocused: ReturnType<typeof createSunGroup>;
  } | null>(null);

  const [loading, setLoading] = useState(true);
  const [heroVisible, setHeroVisible] = useState(false);
  const [loadingSteps, setLoadingSteps] = useState<LoadingStep[]>(
    GALAXY_STEP_LABELS.map(label => ({ label, status: 'pending' as const })),
  );
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [neighbors, setNeighbors] = useState<NeighborInfo[]>([]);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [searchQuery, setSearchQuery] = useState('');
  const [activeGenres, setActiveGenres] = useState<Set<string>>(new Set());
  const [allGenres, setAllGenres] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [nodeCount, setNodeCount] = useState(0);
  const [connectionCount, setConnectionCount] = useState(0);
  const [rendererBackend, setRendererBackend] = useState<RendererBackend | null>(null);
  const neighborK = useRef(10);
  const selectedIdRef = useRef<string | null>(null);
  const neighborIdsRef = useRef<Set<string>>(new Set());
  const loadedNodesRef = useRef<GraphNode[]>([]);
  const nodeSearchIndex = useRef<SearchIndexEntry[]>([]);
  const flyAnimRef = useRef<{
    startCamPos: THREE.Vector3;
    endCamPos: THREE.Vector3;
    startTarget: THREE.Vector3;
    endTarget: THREE.Vector3;
    startTime: number;
    duration: number;
  } | null>(null);
  const neighborCardsRef = useRef<HTMLDivElement>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [suggestionIdx, setSuggestionIdx] = useState(-1);
  const [showLibrary, setShowLibrary] = useState(false);
  const [libSearch, setLibSearch] = useState('');
  const [showNeighbors, setShowNeighbors] = useState(false);
  const [nbSearch, setNbSearch] = useState('');
  const [focusedNbIdx, setFocusedNbIdx] = useState(-1); // -1 = selected node, 0+ = neighbor index
  const [pathActive, setPathActive] = useState(false);
  const [pathOverview, setPathOverview] = useState(false);
  const pathIdsRef = useRef<Set<string>>(new Set());
  const pathNodesRef = useRef<GraphNode[]>([]);
  const [pathIdx, setPathIdx] = useState(-1);
  const pathOverviewCardsRef = useRef<HTMLDivElement>(null);
  const libScrollRef = useRef<HTMLDivElement>(null);
  const fpsRef = useRef<HTMLSpanElement>(null);
  const autoOrbitRef = useRef(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailData, setDetailData] = useState<NodeDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailNodeIdRef = useRef<string | null>(null);
  const [, setLibVersion] = useState(0);

  useEffect(() => {
    return libraryStore.subscribe(() => setLibVersion(v => v + 1));
  }, []);
  const sunStateRef = useRef<{
    selectedPos: THREE.Vector3 | null;
    selectedColor: [number, number, number];
    focusedPos: THREE.Vector3 | null;
    focusedColor: [number, number, number];
  }>({
    selectedPos: null,
    selectedColor: [1, 0.7, 1],
    focusedPos: null,
    focusedColor: [0.3, 0.95, 0.95],
  });

  const startFly = useCallback((endTarget: THREE.Vector3, endCamPos: THREE.Vector3, duration = 2500) => {
    const s = sceneRef.current;
    if (!s) return;
    flyAnimRef.current = {
      startCamPos: s.camera.position.clone(),
      endCamPos: endCamPos.clone(),
      startTarget: s.controls.target.clone(),
      endTarget: endTarget.clone(),
      startTime: performance.now(),
      duration,
    };
  }, []);

  const cancelFly = useCallback(() => { flyAnimRef.current = null; }, []);

  // ─── Build scene ────────────────────────────────────────────────────

  const initScene = useCallback((
    container: HTMLDivElement,
    nodes: GraphNode[],
  ): { cleanup: () => void; backend: RendererBackend } => {
    const w = container.clientWidth;
    const h = container.clientHeight;

    const { renderer, backend, nodeMat, starMat } = createRendererBundle(w, h);
    container.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(60, w / h, 1, 5000);
    camera.position.set(0, 0, 800);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020208);
    scene.fog = new THREE.FogExp2(0x020208, 0.0008);

    let hdrTex: THREE.Texture | null = null;
    new RGBELoader().load('/HDR_hazy_nebulae.hdr', (tex) => {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      scene.background = tex;
      scene.backgroundIntensity = 0.15;
      hdrTex = tex;
    });

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 1.2;
    controls.minDistance = 50;
    controls.maxDistance = 3000;
    controls.autoRotateSpeed = 0.4;

    // ── Star field background ──
    const STAR_COUNT = 12000;
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
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
    starGeo.setAttribute('aColor', new THREE.Float32BufferAttribute(starColors, 3));
    starGeo.setAttribute('aSize', new THREE.Float32BufferAttribute(starSizes, 1));
    starGeo.setAttribute('aBrightness', new THREE.Float32BufferAttribute(new Float32Array(STAR_COUNT).fill(0.2), 1));
    const starField = new THREE.Points(starGeo, starMat);
    scene.add(starField);

    // ── Game nodes ──
    const n = nodes.length;
    const posArr = new Float32Array(n * 3);
    const colArr = new Float32Array(n * 3);
    const sizeArr = new Float32Array(n);
    const brightArr = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      posArr[i * 3] = nd.x;
      posArr[i * 3 + 1] = nd.y;
      posArr[i * 3 + 2] = nd.z;

      const c = GENRE_PALETTE[nd.colorIdx];
      colArr[i * 3] = c[0];
      colArr[i * 3 + 1] = c[1];
      colArr[i * 3 + 2] = c[2];

      sizeArr[i] = nd.isLibrary ? 5.0 + Math.min(nd.hoursPlayed * 0.05, 8.0) : 2.0;
      brightArr[i] = nd.isLibrary ? 1.0 : 0.45;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    const colorAttr = new THREE.Float32BufferAttribute(colArr, 3);
    geo.setAttribute('aColor', colorAttr);
    const sizeAttr = new THREE.Float32BufferAttribute(sizeArr, 1);
    geo.setAttribute('aSize', sizeAttr);
    const brightnessAttr = new THREE.Float32BufferAttribute(brightArr, 1);
    geo.setAttribute('aBrightness', brightnessAttr);

    const points = new THREE.Points(geo, nodeMat);
    scene.add(points);

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points!.threshold = 4;
    const mouse = new THREE.Vector2();

    // ── Sun meshes for selected + focused nodes ──
    const sunSelected = createSunGroup(5);
    const sunFocused = createSunGroup(4);
    scene.add(sunSelected.group);
    scene.add(sunFocused.group);

    // ── Bloom postprocessing ──
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(
      new THREE.Vector2(w, h), 0.4, 0.15, 0.65,
    ));
    composer.addPass(new OutputPass());

    const sRef = {
      renderer, scene, camera, controls, points, starField,
      lines: null as THREE.LineSegments | null,
      linesMat: null as THREE.LineDashedMaterial | null,
      pathLines: null as THREE.LineSegments | null,
      pathLinesMat: null as THREE.LineDashedMaterial | null,
      pathLabels: null as THREE.Group | null,
      raycaster, mouse, nodes,
      colorAttr, sizeAttr, brightnessAttr,
      animFrameId: 0,
      composer, sunSelected, sunFocused,
    };

    // ── Animation loop ──
    const _projVec = new THREE.Vector3();
    let _prevTime = performance.now();
    let _frames = 0;
    function animate() {
      sRef.animFrameId = requestAnimationFrame(animate);

      _frames++;
      const now = performance.now();
      const elapsed = now - _prevTime;
      if (elapsed >= 500) {
        const fps = Math.round((_frames * 1000) / elapsed);
        _frames = 0;
        _prevTime = now;
        if (fpsRef.current) fpsRef.current.textContent = `${fps} FPS`;
      }

      const fly = flyAnimRef.current;
      if (fly) {
        const raw = Math.min((now - fly.startTime) / fly.duration, 1);
        const t = raw < 0.5
          ? 4 * raw * raw * raw
          : 1 - Math.pow(-2 * raw + 2, 3) / 2;
        camera.position.lerpVectors(fly.startCamPos, fly.endCamPos, t);
        controls.target.lerpVectors(fly.startTarget, fly.endTarget, t);
        if (raw >= 1) flyAnimRef.current = null;
      }

      controls.autoRotate = autoOrbitRef.current && !fly;
      controls.update();

      if (sRef.linesMat) (sRef.linesMat as any).dashOffset -= 0.3;
      if (sRef.pathLinesMat) (sRef.pathLinesMat as any).dashOffset -= 0.15;

      // ── Update sun meshes from reactive state ──
      const _sunState = sunStateRef.current;
      const _t = now * 0.001;

      if (_sunState.selectedPos) {
        sRef.sunSelected.group.visible = true;
        sRef.sunSelected.group.position.copy(_sunState.selectedPos);
        sRef.sunSelected.surfaceMat.uniforms.u_time.value = _t;
        const sc = _sunState.selectedColor;
        (sRef.sunSelected.surfaceMat.uniforms.u_color.value as THREE.Color).setRGB(sc[0], sc[1], sc[2]);
        (sRef.sunSelected.surfaceMat.uniforms.u_colorBright.value as THREE.Color).setRGB(
          Math.min(sc[0] + 0.3, 1), Math.min(sc[1] + 0.3, 1), Math.min(sc[2] + 0.3, 1),
        );
        sRef.sunSelected.glowSpriteMat.color.setRGB(sc[0], sc[1], sc[2]);
      } else {
        sRef.sunSelected.group.visible = false;
      }

      if (_sunState.focusedPos) {
        sRef.sunFocused.group.visible = true;
        sRef.sunFocused.group.position.copy(_sunState.focusedPos);
        sRef.sunFocused.surfaceMat.uniforms.u_time.value = _t;
        const fc2 = _sunState.focusedColor;
        (sRef.sunFocused.surfaceMat.uniforms.u_color.value as THREE.Color).setRGB(fc2[0], fc2[1], fc2[2]);
        (sRef.sunFocused.surfaceMat.uniforms.u_colorBright.value as THREE.Color).setRGB(
          Math.min(fc2[0] + 0.3, 1), Math.min(fc2[1] + 0.3, 1), Math.min(fc2[2] + 0.3, 1),
        );
        sRef.sunFocused.glowSpriteMat.color.setRGB(fc2[0], fc2[1], fc2[2]);
      } else {
        sRef.sunFocused.group.visible = false;
      }

      sRef.composer.render();

      const cardsEl = neighborCardsRef.current;
      if (cardsEl && cardsEl.children.length > 0) {
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        for (let ci = 0; ci < cardsEl.children.length; ci++) {
          const card = cardsEl.children[ci] as HTMLElement;
          _projVec.set(
            parseFloat(card.dataset.nx!),
            parseFloat(card.dataset.ny!),
            parseFloat(card.dataset.nz!),
          ).project(camera);
          const sx = (_projVec.x * 0.5 + 0.5) * cw;
          const sy = (-_projVec.y * 0.5 + 0.5) * ch;
          card.style.transform = `translate(${sx}px, ${sy - 48}px) translate(-50%, -100%)`;
          card.style.opacity = _projVec.z > 1 ? '0' : '1';
        }
      }

      const overviewEl = pathOverviewCardsRef.current;
      if (overviewEl && overviewEl.children.length > 0) {
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        for (let ci = 0; ci < overviewEl.children.length; ci++) {
          const card = overviewEl.children[ci] as HTMLElement;
          _projVec.set(
            parseFloat(card.dataset.nx!),
            parseFloat(card.dataset.ny!),
            parseFloat(card.dataset.nz!),
          ).project(camera);
          const sx = (_projVec.x * 0.5 + 0.5) * cw;
          const sy = (-_projVec.y * 0.5 + 0.5) * ch;
          card.style.transform = `translate(${sx}px, ${sy - 48}px) translate(-50%, -100%)`;
          card.style.opacity = _projVec.z > 1 ? '0' : '1';
        }
      }
    }
    animate();

    // ── Resize handler ──
    const observer = new ResizeObserver(() => {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      renderer.setSize(cw, ch);
      composer.setSize(cw, ch);
      camera.aspect = cw / ch;
      camera.updateProjectionMatrix();
    });
    observer.observe(container);

    sceneRef.current = sRef;

    const cleanup = () => {
      observer.disconnect();
      cancelAnimationFrame(sRef.animFrameId);
      composer.dispose();
      renderer.dispose();
      geo.dispose();
      starGeo.dispose();
      nodeMat.dispose();
      starMat.dispose();
      sunSelected.surfaceGeo.dispose();
      sunSelected.surfaceMat.dispose();
      sunSelected.glowSpriteMat.dispose();
      sunFocused.surfaceGeo.dispose();
      sunFocused.surfaceMat.dispose();
      sunFocused.glowSpriteMat.dispose();
      if (hdrTex) hdrTex.dispose();
      if (sRef.lines) {
        sRef.lines.geometry.dispose();
        (sRef.lines.material as THREE.Material).dispose();
      }
      if (sRef.pathLines) {
        sRef.pathLines.geometry.dispose();
        (sRef.pathLines.material as THREE.Material).dispose();
      }
      if (sRef.pathLabels) {
        sRef.pathLabels.traverse(child => {
          if ((child as THREE.Sprite).material) (child as THREE.Sprite).material.dispose();
        });
      }
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      sceneRef.current = null;
    };

    return { cleanup, backend };
  }, []);

  // ─── Data loading (cache-first, then fresh build) ──────────────────

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const RENDER_STEP = 'Rendering galaxy';
    const allLabels = [...GALAXY_STEP_LABELS, RENDER_STEP];
    const RENDER_IDX = GALAXY_STEP_LABELS.length;

    setLoadingSteps(allLabels.map(label => ({ label, status: 'pending' })));

    const onStep: GalaxyStepReporter = (stepIndex, status, detail) => {
      if (cancelled) return;
      setLoadingSteps(prev => prev.map((s, i) => {
        if (i === stepIndex) {
          const label = detail ? `${allLabels[i]} — ${detail}` : allLabels[i];
          return { label, status };
        }
        return s;
      }));
    };

    (async () => {
      try {
      let nodes: GraphNode[];
      let allGenres: string[];

      // Try cache first
      const cached = await loadCachedGalaxyIfFresh();
      if (cached) {
        nodes = cached.nodes;
        allGenres = cached.allGenres;
        GALAXY_STEP_LABELS.forEach((_, i) => onStep(i, 'done', 'cached'));
      } else if (embeddingService.isCatalogRunning) {
        // Catalog embeddings are actively writing to IDB — building the galaxy
        // now would cause a deadlock. Wait for the pipeline to finish first.
        if (!cancelled) {
          setLoadingSteps(allLabels.map(label => ({
            label: `${label} — waiting for Taste DNA`,
            status: 'waiting' as const,
          })));
        }
        await new Promise<void>(resolve => {
          if (!embeddingService.isCatalogRunning) { resolve(); return; }
          const unsub = embeddingService.subscribe(() => {
            if (!embeddingService.isCatalogRunning) { unsub(); resolve(); }
          });
        });
        if (cancelled) return;
        GALAXY_STEP_LABELS.forEach((_, i) => onStep(i, 'running'));
        const result = await buildAndCacheGalaxy(onStep);
        nodes = result.nodes;
        allGenres = result.allGenres;
      } else {
        // If a background build is already in progress, piggyback on it
        const bgPromise = getBackgroundBuildPromise();
        if (bgPromise) {
          GALAXY_STEP_LABELS.forEach((_, i) => onStep(i, 'running', 'background build in progress'));
          const result = await bgPromise;
          nodes = result.nodes;
          allGenres = result.allGenres;
          GALAXY_STEP_LABELS.forEach((_, i) => onStep(i, 'done'));
        } else {
          const result = await buildAndCacheGalaxy(onStep);
          nodes = result.nodes;
          allGenres = result.allGenres;
        }
      }

      if (cancelled) return;
      loadedNodesRef.current = nodes;
      nodeSearchIndex.current = [];
      setNodeCount(nodes.length);
      setAllGenres(allGenres);
      setActiveGenres(new Set());

      if (nodes.length > 0 && canvasRef.current) {
        onStep(RENDER_IDX, 'running');

        // Yield so the loading screen can paint its "Rendering galaxy" state
        // before the heavy synchronous initScene blocks the main thread.
        await new Promise(r => setTimeout(r, 0));
        if (cancelled) return;

        const { cleanup, backend } = initScene(canvasRef.current!, nodes);
        if (cancelled) { cleanup(); return; }
        setRendererBackend(backend);
        (canvasRef.current as any).__cleanup = cleanup;

        // Let WebGL compile shaders and render several frames so the GPU
        // pipeline is warm before we reveal the scene (avoids visible jank).
        await new Promise<void>(resolve => {
          let warmupFrames = 0;
          const tick = () => {
            warmupFrames++;
            if (warmupFrames < 15) requestAnimationFrame(tick);
            else resolve();
          };
          requestAnimationFrame(tick);
        });
        if (cancelled) return;

        onStep(RENDER_IDX, 'done');
      }

      // Yield so the warmup render composites before the big React
      // re-render from setLoading(false) mounts all UI. Use setTimeout
      // (not rAF) — rAF can stall if the Electron GPU process is busy.
      await new Promise(r => setTimeout(r, 0));

      // Critical: no `if (cancelled) return` here — setLoading(false)
      // MUST fire to unstick the loading screen. setState on an unmounted
      // component is a safe no-op in React 18.
      setLoading(false);

      if (!cancelled) {
        // Yield so React commits the DOM and the browser paints before
        // layering the lightweight hero text animation.
        await new Promise(r => setTimeout(r, 0));
        setHeroVisible(true);
        setTimeout(() => setHeroVisible(false), 3000);
      }

      // Build search index during idle time so the typewriter stays smooth.
      let idxPos = 0;
      const IDX_CHUNK = 3000;
      const scheduleIdle = typeof requestIdleCallback === 'function'
        ? (fn: IdleRequestCallback) => requestIdleCallback(fn, { timeout: 3000 })
        : (fn: () => void) => setTimeout(fn, 60);
      const buildChunk = () => {
        if (cancelled) return;
        const end = Math.min(idxPos + IDX_CHUNK, nodes.length);
        const arr = nodeSearchIndex.current;
        for (; idxPos < end; idxPos++) {
          const nd = nodes[idxPos];
          const titleLower = nd.title.toLowerCase();
          arr[idxPos] = {
            titleLower,
            titleNorm: titleLower.replace(/[^a-z0-9\s]/g, ''),
            titleWords: titleLower.split(/\s+/).filter(Boolean),
            devLower: (nd.developer || '').toLowerCase(),
            pubLower: '',
            genresLower: nd.genres.map(g => g.toLowerCase()),
          };
        }
        if (idxPos < nodes.length) scheduleIdle(buildChunk);
      };
      scheduleIdle(buildChunk);

      } catch (err) {
        console.error('[Embedding Space] Loading failed:', err);
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (canvasRef.current && (canvasRef.current as any).__cleanup) {
        (canvasRef.current as any).__cleanup();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Pre-computed search match set (scored once per query change) ────

  const searchMatchIds = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return new Set<string>();

    const nodes = loadedNodesRef.current;
    const idx = nodeSearchIndex.current;
    const ids = new Set<string>();
    for (let i = 0; i < nodes.length; i++) {
      if (idx.length > i && scoreGame(idx[i], tokens, q) > 0) {
        ids.add(nodes[i].id);
      }
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, nodeCount]);

  // ─── Visual update: highlight selection + filter ────────────────────

  const updateVisuals = useCallback(() => {
    const s = sceneRef.current;
    if (!s) return;

    const { nodes, colorAttr, sizeAttr, brightnessAttr } = s;
    const selId = selectedIdRef.current;
    const nbIds = neighborIdsRef.current;
    const pIds = pathIdsRef.current;
    const hasSelection = !!selId;
    const hasPath = pIds.size > 0;
    const hasSearch = searchMatchIds.size > 0;
    const filterActive = activeGenres.size > 0 && activeGenres.size < allGenres.length;

    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      const isSel = nd.id === selId;
      const isNb = hasSelection && nbIds.has(nd.id);
      const isOnPath = hasPath && pIds.has(nd.id);
      const matchesSearch = hasSearch && searchMatchIds.has(nd.id);
      const matchesFilter = !filterActive || nd.genres.some(g => activeGenres.has(g));

      let bright: number;
      let size: number;
      const baseC = GENRE_PALETTE[nd.colorIdx];
      let r = baseC[0], g = baseC[1], b = baseC[2];

      if (isSel) {
        bright = 1.8;
        size = 16;
        r = 1; g = 0.7; b = 1;
      } else if (isNb) {
        bright = 1.4;
        size = nd.isLibrary ? 8 : 6;
        r = 0.3; g = 0.95; b = 0.95;
      } else if (isOnPath) {
        bright = 1.5;
        size = 7 + Math.min(nd.hoursPlayed * 0.06, 10);
      } else if (matchesSearch) {
        bright = 1.3;
        size = nd.isLibrary ? 10 : 6;
      } else if (hasSelection || hasPath) {
        bright = nd.isLibrary ? 0.15 : 0.06;
        size = nd.isLibrary ? 3 : 1;
      } else if (filterActive && matchesFilter) {
        bright = nd.isLibrary ? 1.3 : 0.9;
        size = nd.isLibrary ? 7 : 4;
      } else if (filterActive && !matchesFilter) {
        bright = nd.isLibrary ? 0.35 : 0.12;
        size = nd.isLibrary ? 3 : 1.5;
      } else {
        bright = nd.isLibrary ? 1.0 : 0.45;
        size = nd.isLibrary ? 5 + Math.min(nd.hoursPlayed * 0.05, 8) : 2;
      }

      colorAttr.setXYZ(i, r, g, b);
      sizeAttr.setX(i, size);
      brightnessAttr.setX(i, bright);
    }

    colorAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    brightnessAttr.needsUpdate = true;
  }, [searchMatchIds, activeGenres, allGenres]);

  useEffect(() => { updateVisuals(); }, [updateVisuals]);

  // ─── Connection lines (animated flight-path) ───────────────────────

  const drawConnections = useCallback((selNode: GraphNode, neighborList: NeighborInfo[]) => {
    const s = sceneRef.current;
    if (!s) return;

    if (s.lines) {
      s.scene.remove(s.lines);
      s.lines.geometry.dispose();
      (s.lines.material as THREE.Material).dispose();
      s.lines = null;
      s.linesMat = null;
    }

    if (neighborList.length === 0) return;

    const linePositions: number[] = [];
    const lineColors: number[] = [];
    const lineDistances: number[] = [];

    for (const nb of neighborList) {
      if (!nb.node) continue;
      linePositions.push(selNode.x, selNode.y, selNode.z);
      linePositions.push(nb.node.x, nb.node.y, nb.node.z);
      const intensity = Math.max(0.2, 1 - nb.distance * 2);
      lineColors.push(0.3 * intensity, 0.9 * intensity, 0.9 * intensity);
      lineColors.push(0.3 * intensity * 0.3, 0.9 * intensity * 0.3, 0.9 * intensity * 0.3);
      const dist = Math.sqrt(
        (nb.node.x - selNode.x) ** 2 +
        (nb.node.y - selNode.y) ** 2 +
        (nb.node.z - selNode.z) ** 2,
      );
      lineDistances.push(0, dist);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3));
    geo.setAttribute('lineDistance', new THREE.Float32BufferAttribute(lineDistances, 1));

    const mat = new THREE.LineDashedMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      dashSize: 1,
      gapSize: 4,
      scale: 1,
    });

    const lines = new THREE.LineSegments(geo, mat);
    s.scene.add(lines);
    s.lines = lines;
    s.linesMat = mat;
  }, []);

  // ─── Path helpers ────────────────────────────────────────────────────

  const clearPath = useCallback(() => {
    const s = sceneRef.current;
    if (s) {
      if (s.pathLines) {
        s.scene.remove(s.pathLines);
        s.pathLines.geometry.dispose();
        (s.pathLines.material as THREE.Material).dispose();
        s.pathLines = null;
        s.pathLinesMat = null;
      }
      if (s.pathLabels) {
        s.pathLabels.traverse(child => {
          if ((child as THREE.Sprite).material) (child as THREE.Sprite).material.dispose();
        });
        s.scene.remove(s.pathLabels);
        s.pathLabels = null;
      }
    }
    pathIdsRef.current = new Set();
    pathNodesRef.current = [];
    setPathIdx(-1);
    setPathActive(false);
    setPathOverview(false);
  }, []);

  const makeTextSprite = useCallback((text: string, position: THREE.Vector3, color = '#67e8f9') => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = 512;
    canvas.height = 64;
    ctx.font = '600 28px ui-monospace, monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 32);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.65, depthWrite: false, blending: THREE.AdditiveBlending });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(position);
    sprite.scale.set(80, 10, 1);
    return sprite;
  }, []);

  // ─── Selection logic (shared by canvas click + search) ────────────

  const clearSelection = useCallback(() => {
    selectedIdRef.current = null;
    neighborIdsRef.current = new Set();
    cancelFly();
    sunStateRef.current.selectedPos = null;
    sunStateRef.current.focusedPos = null;
    autoOrbitRef.current = false;
    setSelectedNode(null);
    setNeighbors([]);
    setFocusedNbIdx(-1);
    setConnectionCount(0);
    setShowNeighbors(false);
    setNbSearch('');

    const s = sceneRef.current;
    if (s) {
      if (s.lines) {
        s.scene.remove(s.lines);
        s.lines.geometry.dispose();
        (s.lines.material as THREE.Material).dispose();
        s.lines = null;
      }
      s.linesMat = null;
    }
    updateVisuals();
  }, [updateVisuals, cancelFly]);

  const selectPathNode = useCallback(async (idx: number) => {
    const s = sceneRef.current;
    const pn = pathNodesRef.current;
    if (!s || idx < 0 || idx >= pn.length) return;

    const node = pn[idx];
    setPathIdx(idx);
    selectedIdRef.current = node.id;
    setSelectedNode(node);
    setFocusedNbIdx(-1);
    setDetailOpen(false);
    autoOrbitRef.current = true;

    const starPos = new THREE.Vector3(node.x, node.y, node.z);
    const sunC = GENRE_PALETTE[node.colorIdx];
    sunStateRef.current.selectedPos = starPos.clone();
    sunStateRef.current.selectedColor = [sunC[0], sunC[1], sunC[2]];
    sunStateRef.current.focusedPos = null;

    const isLast = idx === pn.length - 1;

    if (isLast) {
      const vec = await getEmbeddingById(node.id);
      let nbList: NeighborInfo[] = [];
      if (vec && annIndex.isReady) {
        const results = await annIndex.queryWithDistances(vec, neighborK.current + 1);
        const nodeMap = new Map(s.nodes.map(n => [n.id, n]));
        nbList = results
          .filter(r => r.id !== node.id)
          .slice(0, neighborK.current)
          .map(r => ({ id: r.id, distance: r.distance, node: nodeMap.get(r.id) }));
      }
      neighborIdsRef.current = new Set(nbList.map(nb => nb.id));
      setNeighbors(nbList);
      setConnectionCount(nbList.length);
      drawConnections(node, nbList);
    } else {
      const next = pn[idx + 1];
      const dist = Math.sqrt((next.x - node.x) ** 2 + (next.y - node.y) ** 2 + (next.z - node.z) ** 2);
      const nbList: NeighborInfo[] = [{ id: next.id, distance: +(dist / 100).toFixed(4), node: next }];
      neighborIdsRef.current = new Set([next.id]);
      setNeighbors(nbList);
      setConnectionCount(1);
      drawConnections(node, nbList);
    }

    updateVisuals();

    let maxEdgeLen = 0;
    const nbs = isLast ? neighborIdsRef.current : new Set([pn[idx + 1]?.id]);
    for (const nbId of nbs) {
      const nbNode = s.nodes.find(n => n.id === nbId);
      if (!nbNode) continue;
      const dx = nbNode.x - node.x;
      const dy = nbNode.y - node.y;
      const dz = nbNode.z - node.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len > maxEdgeLen) maxEdgeLen = len;
    }
    const zoomDist = Math.max(80, Math.min(maxEdgeLen * 0.65, 350));
    const dir = new THREE.Vector3().subVectors(s.camera.position, starPos).normalize();
    const endCamPos = starPos.clone().add(dir.multiplyScalar(zoomDist));
    startFly(starPos, endCamPos, 2800);
  }, [drawConnections, updateVisuals, startFly]);

  const showThePath = useCallback(async () => {
    const s = sceneRef.current;
    if (!s) return;

    if (pathActive) {
      clearPath();
      clearSelection();
      updateVisuals();
      startFly(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 800), 2200);
      return;
    }

    clearPath();
    clearSelection();
    setSearchQuery('');
    setSearchFocused(false);

    const journeyEntries = journeyStore.getAllEntries()
      .filter(e => e.firstPlayedAt)
      .sort((a, b) => new Date(a.firstPlayedAt!).getTime() - new Date(b.firstPlayedAt!).getTime());

    if (journeyEntries.length < 2) return;

    const nodeMap = new Map(s.nodes.map(n => [n.id, n]));
    const pathNodes: GraphNode[] = [];
    for (const je of journeyEntries) {
      const n = nodeMap.get(je.gameId);
      if (n) pathNodes.push(n);
    }
    if (pathNodes.length < 2) return;

    pathNodesRef.current = pathNodes;
    pathIdsRef.current = new Set(pathNodes.map(n => n.id));
    setPathActive(true);

    const linePositions: number[] = [];
    const lineColors: number[] = [];
    const lineDistances: number[] = [];
    const labelsGroup = new THREE.Group();

    for (let i = 0; i < pathNodes.length - 1; i++) {
      const a = pathNodes[i];
      const b = pathNodes[i + 1];

      linePositions.push(a.x, a.y, a.z);
      linePositions.push(b.x, b.y, b.z);

      const progress = i / (pathNodes.length - 1);
      const r1 = 0.4 + progress * 0.6;
      const g1 = 0.8 - progress * 0.3;
      const b1 = 1.0 - progress * 0.5;
      lineColors.push(r1 * 0.8, g1 * 0.8, b1 * 0.8);
      lineColors.push(r1 * 0.3, g1 * 0.3, b1 * 0.3);

      const segDist = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2);
      lineDistances.push(0, segDist);

      const je = journeyEntries.find(e => e.gameId === a.id);
      const hours = je ? je.hoursPlayed : a.hoursPlayed;
      const mid = new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2 + 4, (a.z + b.z) / 2);
      const label = `${hours.toFixed(0)}h · d=${(segDist / 100).toFixed(2)}`;
      labelsGroup.add(makeTextSprite(label, mid));
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3));
    geo.setAttribute('lineDistance', new THREE.Float32BufferAttribute(lineDistances, 1));

    const mat = new THREE.LineDashedMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      dashSize: 2,
      gapSize: 3,
      scale: 1,
    });

    const pathLineObj = new THREE.LineSegments(geo, mat);
    s.scene.add(pathLineObj);
    s.scene.add(labelsGroup);
    s.pathLines = pathLineObj;
    s.pathLinesMat = mat;
    s.pathLabels = labelsGroup;

    updateVisuals();

    const bbox = new THREE.Box3();
    for (const pn of pathNodes) bbox.expandByPoint(new THREE.Vector3(pn.x, pn.y, pn.z));
    const center = new THREE.Vector3();
    bbox.getCenter(center);
    const bboxSize = new THREE.Vector3();
    bbox.getSize(bboxSize);
    const maxSpan = Math.max(bboxSize.x, bboxSize.y, bboxSize.z);
    const overviewDist = Math.max(maxSpan * 1.1, 300);
    const overviewCamPos = center.clone().add(new THREE.Vector3(0, overviewDist * 0.3, overviewDist));

    setPathOverview(true);
    startFly(center, overviewCamPos, 2400);
  }, [pathActive, clearPath, clearSelection, makeTextSprite, updateVisuals, startFly]);

  const startPathExplore = useCallback(() => {
    setPathOverview(false);
    selectPathNode(0);
  }, [selectPathNode]);

  const [screenshotSaving, setScreenshotSaving] = useState(false);

  const captureScreenshot = useCallback(async () => {
    const area = screenshotAreaRef.current;
    if (!area || screenshotSaving) return;
    setScreenshotSaving(true);
    try {
      const dataUrl = await toPng(area, {
        cacheBust: true,
        pixelRatio: 2,
        filter: (node: HTMLElement) => {
          if (!node.classList) return true;
          if (node.classList.contains('screenshot-exclude')) return false;
          return true;
        },
      });
      const filename = `ark-path-${Date.now()}.png`;

      if (window.fileDialog?.saveImage) {
        await window.fileDialog.saveImage({ dataUrl, defaultName: filename });
      } else {
        const link = document.createElement('a');
        link.download = filename;
        link.href = dataUrl;
        link.click();
      }
    } catch (err) {
      console.error('[Screenshot] Failed to capture:', err);
    }
    setScreenshotSaving(false);
  }, [screenshotSaving]);

  const selectNode = useCallback(async (node: GraphNode, flyTo = false) => {
    const s = sceneRef.current;
    if (!s) return;
    if (pathActive) clearPath();

    selectedIdRef.current = node.id;
    setSelectedNode(node);
    setFocusedNbIdx(-1);
    autoOrbitRef.current = true;

    const starPos = new THREE.Vector3(node.x, node.y, node.z);
    const sunC = GENRE_PALETTE[node.colorIdx];
    sunStateRef.current.selectedPos = starPos.clone();
    sunStateRef.current.selectedColor = [sunC[0], sunC[1], sunC[2]];
    sunStateRef.current.focusedPos = null;

    const vec = await getEmbeddingById(node.id);
    let nbList: NeighborInfo[] = [];

    if (vec && annIndex.isReady) {
      const results = await annIndex.queryWithDistances(vec, neighborK.current + 1);
      const nodeMap = new Map(s.nodes.map(n => [n.id, n]));
      nbList = results
        .filter(r => r.id !== node.id)
        .slice(0, neighborK.current)
        .map(r => ({ id: r.id, distance: r.distance, node: nodeMap.get(r.id) }));
    }

    neighborIdsRef.current = new Set(nbList.map(nb => nb.id));
    setNeighbors(nbList);
    setConnectionCount(nbList.length);
    drawConnections(node, nbList);
    updateVisuals();

    if (flyTo) {
      let maxEdgeLen = 0;
      for (const nb of nbList) {
        if (!nb.node) continue;
        const dx = nb.node.x - node.x;
        const dy = nb.node.y - node.y;
        const dz = nb.node.z - node.z;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len > maxEdgeLen) maxEdgeLen = len;
      }
      const zoomDist = Math.max(80, Math.min(maxEdgeLen * 0.65, 350));
      const dir = new THREE.Vector3()
        .subVectors(s.camera.position, starPos)
        .normalize();
      const endCamPos = starPos.clone().add(dir.multiplyScalar(zoomDist));
      startFly(starPos, endCamPos, 2800);
    }
  }, [drawConnections, updateVisuals, startFly, pathActive, clearPath]);

  // ─── Interaction handlers ──────────────────────────────────────────

  const handleCanvasClick = useCallback(async (e: React.MouseEvent) => {
    const s = sceneRef.current;
    if (!s) return;
    if (!selectedIdRef.current) return;

    const rect = s.renderer.domElement.getBoundingClientRect();
    s.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    s.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    s.raycaster.setFromCamera(s.mouse, s.camera);

    const intersects = s.raycaster.intersectObject(s.points);
    if (intersects.length > 0 && intersects[0].index !== undefined) {
      const node = s.nodes[intersects[0].index];
      const isSelected = selectedIdRef.current === node.id;
      const isNeighbor = neighborIdsRef.current.has(node.id);
      if (!isSelected && !isNeighbor) return;
      if (isSelected) {
        clearSelection();
      } else {
        await selectNode(node, true);
      }
    }
  }, [selectNode, clearSelection]);

  const handleCanvasMove = useCallback((e: React.MouseEvent) => {
    const s = sceneRef.current;
    if (!s) return;
    if (!selectedIdRef.current) {
      if (hoveredNode) setHoveredNode(null);
      return;
    }

    const rect = s.renderer.domElement.getBoundingClientRect();
    s.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    s.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    s.raycaster.setFromCamera(s.mouse, s.camera);

    const intersects = s.raycaster.intersectObject(s.points);
    if (intersects.length > 0 && intersects[0].index !== undefined) {
      const node = s.nodes[intersects[0].index];
      const isSelected = selectedIdRef.current === node.id;
      const isNeighbor = neighborIdsRef.current.has(node.id);
      if (!isSelected && !isNeighbor) {
        setHoveredNode(null);
        s.renderer.domElement.style.cursor = 'default';
        return;
      }
      setHoveredNode(node);
      setTooltipPos({ x: e.clientX - (canvasRef.current?.getBoundingClientRect().left ?? 0), y: e.clientY - (canvasRef.current?.getBoundingClientRect().top ?? 0) });
      s.renderer.domElement.style.cursor = 'pointer';
    } else {
      setHoveredNode(null);
      s.renderer.domElement.style.cursor = 'default';
    }
  }, [hoveredNode]);

  const handleReset = useCallback(() => {
    clearPath();
    clearSelection();
    setSearchQuery('');
    setSearchFocused(false);
    startFly(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 800), 2200);
  }, [clearPath, clearSelection, startFly]);


  const toggleGenre = useCallback((genre: string) => {
    setActiveGenres(prev => {
      const next = new Set(prev);
      if (next.has(genre)) next.delete(genre);
      else next.add(genre);
      return next;
    });
  }, []);

  // ─── Search autocomplete ──────────────────────────────────────────

  const suggestions = useMemo(() => {
    if (searchQuery.length < 2 || loadedNodesRef.current.length === 0) return [];
    const q = searchQuery.toLowerCase().trim();
    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];

    const nodes = loadedNodesRef.current;
    const index = nodeSearchIndex.current;
    const scored: { node: GraphNode; score: number }[] = [];

    for (let i = 0; i < nodes.length; i++) {
      if (!index[i]) continue;
      const nd = nodes[i];
      if (nd.title.startsWith('Unknown Game')) continue;
      const s = scoreGame(index[i], tokens, q);
      if (s > 0) {
        const boost = nd.isLibrary ? 0.5 : 0;
        scored.push({ node: nd, score: s + boost });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 10).map(s => s.node);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, nodeCount]);

  const handleSuggestionSelect = useCallback((node: GraphNode) => {
    setSearchFocused(false);
    setSuggestionIdx(-1);
    selectNode(node, true);
  }, [selectNode]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSuggestionIdx(i => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSuggestionIdx(i => Math.max(i - 1, -1));
    } else if (e.key === 'Enter' && suggestionIdx >= 0 && suggestions[suggestionIdx]) {
      e.preventDefault();
      handleSuggestionSelect(suggestions[suggestionIdx]);
    } else if (e.key === 'Escape') {
      setSearchFocused(false);
      (e.target as HTMLInputElement).blur();
    }
  }, [suggestions, suggestionIdx, handleSuggestionSelect]);

  // ─── Library nodes for side panel ─────────────────────────────────

  const libraryNodes = useMemo(() => {
    const nodes = loadedNodesRef.current.filter(n => n.isLibrary);
    nodes.sort((a, b) => b.hoursPlayed - a.hoursPlayed);
    return nodes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeCount]);

  const filteredLibNodes = useMemo(() => {
    if (!libSearch) return libraryNodes;
    const q = libSearch.toLowerCase();
    return libraryNodes.filter(n => n.title.toLowerCase().includes(q));
  }, [libraryNodes, libSearch]);

  useEffect(() => {
    if (!showLibrary || !selectedNode || !libScrollRef.current) return;
    const container = libScrollRef.current;
    const activeEl = container.querySelector('[data-active="true"]') as HTMLElement | null;
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedNode, showLibrary]);

  // ─── Neighbor cycling (cinematic tour) ─────────────────────────────

  const cycleableNeighbors = useMemo(
    () => neighbors.filter(nb => nb.node && !nb.node.title.startsWith('Unknown Game')),
    [neighbors],
  );

  const flyToNode3D = useCallback((node: GraphNode) => {
    const s = sceneRef.current;
    if (!s) return;
    const pos = new THREE.Vector3(node.x, node.y, node.z);
    const dir = new THREE.Vector3().subVectors(s.camera.position, pos).normalize();
    const endCamPos = pos.clone().add(dir.multiplyScalar(100));
    startFly(pos, endCamPos, 1600);
  }, [startFly]);

  const focusNeighborSun = useCallback((idx: number, node: GraphNode | null) => {
    if (idx === -1 || !node) {
      sunStateRef.current.focusedPos = null;
    } else {
      sunStateRef.current.focusedPos = new THREE.Vector3(node.x, node.y, node.z);
      const fc = GENRE_PALETTE[node.colorIdx];
      sunStateRef.current.focusedColor = [fc[0], fc[1], fc[2]];
    }
    autoOrbitRef.current = true;
  }, []);

  const isLastPathNode = pathActive && pathIdx >= 0 && pathIdx === pathNodesRef.current.length - 1;

  const handleCycleNext = useCallback(() => {
    if (pathActive && pathIdx >= 0 && !isLastPathNode) {
      selectPathNode(pathIdx + 1);
      return;
    }
    if (cycleableNeighbors.length === 0) return;
    setDetailOpen(false);
    const next = focusedNbIdx + 1 >= cycleableNeighbors.length ? -1 : focusedNbIdx + 1;
    setFocusedNbIdx(next);
    if (next === -1 && selectedNode) { flyToNode3D(selectedNode); focusNeighborSun(-1, null); }
    else if (cycleableNeighbors[next]?.node) { flyToNode3D(cycleableNeighbors[next].node!); focusNeighborSun(next, cycleableNeighbors[next].node!); }
  }, [pathActive, pathIdx, isLastPathNode, focusedNbIdx, cycleableNeighbors, selectedNode, flyToNode3D, focusNeighborSun, selectPathNode]);

  const handleCyclePrev = useCallback(() => {
    if (pathActive && pathIdx > 0) {
      if (isLastPathNode && focusedNbIdx >= 0) {
        setDetailOpen(false);
        setFocusedNbIdx(-1);
        focusNeighborSun(-1, null);
        if (selectedNode) flyToNode3D(selectedNode);
        return;
      }
      if (focusedNbIdx === -1) {
        selectPathNode(pathIdx - 1);
        return;
      }
    }
    if (cycleableNeighbors.length === 0) return;
    setDetailOpen(false);
    const prev = focusedNbIdx - 1 < -1 ? cycleableNeighbors.length - 1 : focusedNbIdx - 1;
    setFocusedNbIdx(prev);
    if (prev === -1 && selectedNode) { flyToNode3D(selectedNode); focusNeighborSun(-1, null); }
    else if (cycleableNeighbors[prev]?.node) { flyToNode3D(cycleableNeighbors[prev].node!); focusNeighborSun(prev, cycleableNeighbors[prev].node!); }
  }, [pathActive, pathIdx, isLastPathNode, focusedNbIdx, cycleableNeighbors, selectedNode, flyToNode3D, focusNeighborSun, selectPathNode]);

  const handleCycleHome = useCallback(() => {
    setDetailOpen(false);
    setFocusedNbIdx(-1);
    focusNeighborSun(-1, null);
    if (selectedNode) flyToNode3D(selectedNode);
  }, [selectedNode, flyToNode3D, focusNeighborSun]);

  // ─── Arrow key navigation for cycling nodes ───────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!selectedNode && !pathActive) return;
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleCycleNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleCyclePrev();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedNode, pathActive, handleCycleNext, handleCyclePrev]);

  const toggleDetail = useCallback(async (nodeId: string) => {
    if (detailOpen && detailNodeIdRef.current === nodeId) {
      setDetailOpen(false);
      return;
    }
    detailNodeIdRef.current = nodeId;
    setDetailOpen(true);
    setDetailData(null);
    setDetailLoading(true);

    const store = getStoreFromId(nodeId);
    const libEntry = libraryStore.getEntry(nodeId);
    const meta = libEntry?.cachedMeta;
    const secondaryId = libEntry?.secondaryGameId;
    const secondaryStore = secondaryId ? getStoreFromId(secondaryId) : null;

    const stores: ('steam' | 'epic')[] = [];
    if (store === 'steam' || store === 'epic') stores.push(store);
    if (secondaryStore === 'steam' || secondaryStore === 'epic') {
      if (!stores.includes(secondaryStore)) stores.push(secondaryStore);
    }

    const result: NodeDetailData = { stores };
    const fetches: Promise<void>[] = [];

    const steamAppId = store === 'steam'
      ? Number(nodeId.match(/^steam-(\d+)$/)?.[1])
      : secondaryStore === 'steam'
        ? Number(secondaryId!.match(/^steam-(\d+)$/)?.[1])
        : meta?.steamAppId ?? null;

    if (steamAppId) {
      fetches.push(
        (async () => {
          try {
            const details = await window.steam?.getAppDetails(steamAppId);
            if (details) result.steam = details;
          } catch { /* ignore */ }
        })(),
      );
    }

    const epicNs = store === 'epic'
      ? (meta?.epicNamespace ?? nodeId.replace(/^epic-/, '').split(':')[0])
      : (secondaryStore === 'epic' ? (libraryStore.getEntry(secondaryId!)?.cachedMeta?.epicNamespace) : meta?.epicNamespace);
    const epicOfferId = store === 'epic'
      ? (meta?.epicOfferId ?? nodeId.replace(/^epic-/, '').split(':')[1])
      : (secondaryStore === 'epic' ? libraryStore.getEntry(secondaryId!)?.cachedMeta?.epicOfferId : meta?.epicOfferId);
    const epicSlug = store === 'epic'
      ? meta?.epicSlug
      : (secondaryStore === 'epic' ? libraryStore.getEntry(secondaryId!)?.cachedMeta?.epicSlug : meta?.epicSlug);

    if (epicNs && epicOfferId) {
      fetches.push(
        (async () => {
          try {
            const [item, reviews] = await Promise.all([
              window.epic?.getGameDetails(epicNs, epicOfferId) ?? Promise.resolve(null),
              epicSlug ? (window.epic?.getProductReviews(epicSlug) ?? Promise.resolve(null)) : Promise.resolve(null),
            ]);
            if (item) result.epic = { item, reviews };
          } catch { /* ignore */ }
        })(),
      );
    }

    await Promise.all(fetches);
    if (detailNodeIdRef.current === nodeId) {
      setDetailData(result.steam || result.epic ? result : null);
    }
    setDetailLoading(false);
  }, [detailOpen]);

  const addNodeToLibrary = useCallback((node: GraphNode) => {
    if (libraryStore.isInLibrary(node.id)) return;
    const steamMatch = node.id.match(/^steam-(\d+)$/);
    libraryStore.addToLibrary({
      gameId: node.id,
      steamAppId: steamMatch ? Number(steamMatch[1]) : undefined,
      status: 'Want to Play',
      priority: 'Medium',
      publicReviews: '',
      recommendationSource: 'Embedding Space',
      cachedMeta: {
        title: node.title,
        store: getStoreFromId(node.id) as 'steam' | 'epic',
        coverUrl: node.coverUrl,
        developer: node.developer || undefined,
        genre: node.genres,
      },
    });
    node.isLibrary = true;
  }, []);

  useEffect(() => {
    if (!selectedNode) {
      setDetailOpen(false);
      setDetailData(null);
      detailNodeIdRef.current = null;
    }
  }, [selectedNode]);

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <div className="embedding-space-view h-full flex flex-col bg-[#020208]">
      {/* Header toolbar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06] bg-black/60 backdrop-blur-md shrink-0 z-30">
        <div className="flex items-center gap-3">
          <button onClick={onBack}
            className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-white/40 hover:text-white/70 hover:bg-white/5 rounded-md transition-colors cursor-pointer"
            title="Back to Oracle">
            <ArrowLeft className="w-3.5 h-3.5" />
            Oracle
          </button>
          <div className="w-px h-4 bg-white/[0.06]" />
          <h2 className="text-sm font-medium text-white/70">Embedding Space</h2>
          {!loading && (
            <span className="text-[10px] text-white/30">
              {nodeCount.toLocaleString()} games{connectionCount > 0 ? ` · ${connectionCount} connections` : ''}
              {rendererBackend ? ` · ${rendererBackend}` : ''}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative" title={loading ? 'Galaxy is still loading…' : undefined}>
            <Search className={`absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 z-10 ${loading ? 'text-white/10' : 'text-white/30'}`} />
            <input
              type="text"
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setSuggestionIdx(-1); }}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setTimeout(() => setSearchFocused(false), 200)}
              onKeyDown={handleSearchKeyDown}
              placeholder={loading ? 'Loading galaxy…' : 'Search games...'}
              disabled={loading}
              className={`w-72 pl-7 pr-2 py-1 text-[11px] border rounded-md outline-none transition-colors ${loading ? 'bg-white/[0.02] border-white/[0.03] text-white/20 placeholder:text-white/10 cursor-not-allowed' : 'bg-white/5 border-white/[0.06] text-white/70 placeholder:text-white/20 focus:border-fuchsia-500/30'}`}
            />
            {!loading && searchFocused && suggestions.length > 0 && (
              <div className="absolute top-full left-0 w-72 mt-1 bg-black/95 border border-white/[0.08] rounded-lg backdrop-blur-xl overflow-hidden z-50 max-h-[360px] overflow-y-auto">
                {suggestions.map((node, i) => (
                  <div
                    key={node.id}
                    onMouseDown={() => handleSuggestionSelect(node)}
                    onMouseEnter={() => setSuggestionIdx(i)}
                    className={`flex items-center gap-2.5 px-2.5 py-2 cursor-pointer transition-colors ${
                      i === suggestionIdx ? 'bg-fuchsia-500/15' : 'hover:bg-white/[0.04]'
                    }`}
                  >
                    <div className="w-14 h-7 rounded bg-white/[0.06] overflow-hidden shrink-0">
                      <FallbackImg node={node} className="w-full h-full object-cover" fallbackClassName="w-full h-full flex items-center justify-center text-[7px] text-white/20 font-bold" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] text-white/80 truncate">{node.title}</div>
                      <div className="text-[9px] text-white/25 truncate">{node.genres.slice(0, 3).join(' · ')}</div>
                    </div>
                    {node.isLibrary && (
                      <span className="text-[9px] text-emerald-400/40 shrink-0">★ Library</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button onClick={loading ? undefined : handleReset}
            disabled={loading}
            title={loading ? 'Galaxy is still loading…' : 'Reset selection'}
            className={`px-2 py-1 text-[10px] rounded-md transition-colors ${loading ? 'text-white/10 cursor-not-allowed' : 'text-white/30 hover:text-white/50 hover:bg-white/5 cursor-pointer'}`}>
            <RotateCcw className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* 3D Canvas */}
      <div ref={screenshotAreaRef} className="flex-1 relative overflow-hidden">
        <div
          ref={canvasRef}
          className="absolute inset-0"
          onClick={handleCanvasClick}
          onMouseMove={handleCanvasMove}
        />

        {/* Library side panel — collapsible glass overlay */}
        <AnimatePresence>
          {showLibrary && !loading && (
            <motion.div
              initial={{ opacity: 0, x: -24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
              onClick={e => e.stopPropagation()}
              onMouseMove={e => e.stopPropagation()}
              className="absolute top-3 left-3 bottom-14 w-72 z-30 pointer-events-auto flex flex-col rounded-xl border border-white/[0.08] bg-black/60 backdrop-blur-2xl shadow-2xl shadow-black/40 overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-white/[0.06] shrink-0 bg-white/[0.02]">
                <div className="flex items-center gap-2">
                  <Library className="w-3.5 h-3.5 text-emerald-400/70" />
                  <span className="text-[11px] font-medium text-white/60">My Library</span>
                  <span className="text-[9px] text-white/25 tabular-nums">
                    {filteredLibNodes.length !== libraryNodes.length
                      ? `${filteredLibNodes.length} / ${libraryNodes.length}`
                      : libraryNodes.length}
                  </span>
                </div>
                <button
                  onClick={() => { setShowLibrary(false); setLibSearch(''); }}
                  className="p-1 rounded-md text-white/25 hover:text-white/60 hover:bg-white/5 transition-colors cursor-pointer"
                  title="Collapse panel"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Search within library */}
              <div className="px-3 py-2 border-b border-white/[0.04] shrink-0">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-white/20" />
                  <input
                    type="text"
                    value={libSearch}
                    onChange={e => setLibSearch(e.target.value)}
                    placeholder="Filter library…"
                    className="w-full pl-7 pr-2 py-1.5 text-[11px] bg-white/[0.04] border border-white/[0.06] rounded-md text-white/70 placeholder:text-white/20 outline-none focus:border-emerald-500/30 transition-colors"
                  />
                  {libSearch && (
                    <button
                      onClick={() => setLibSearch('')}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-white/20 hover:text-white/50 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>

              {/* Scrollable game card list */}
              <div ref={libScrollRef} className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide px-2 py-2 space-y-1.5">
                {filteredLibNodes.length === 0 && (
                  <div className="text-[10px] text-white/20 text-center py-8">
                    {libSearch ? 'No matches' : 'No library games found'}
                  </div>
                )}
                {filteredLibNodes.map(node => {
                  const isActive = selectedNode?.id === node.id;
                  return (
                    <button
                      key={node.id}
                      data-active={isActive || undefined}
                      onClick={() => selectNode(node, true)}
                      className={`w-full rounded-lg overflow-hidden text-left transition-all duration-200 cursor-pointer group/card border ${
                        isActive
                          ? 'border-fuchsia-500/30 bg-fuchsia-500/10 ring-1 ring-fuchsia-500/20'
                          : 'border-transparent hover:border-white/[0.08] hover:bg-white/[0.04]'
                      }`}
                    >
                      {/* Cover image */}
                      <div className="relative w-full h-[72px] bg-black/40 overflow-hidden">
                        <FallbackImg
                          node={node}
                          className="w-full h-full object-cover transition-transform duration-500 group-hover/card:scale-105"
                          fallbackClassName="w-full h-full flex items-center justify-center text-white/20 text-sm font-bold"
                          loading="lazy"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent pointer-events-none" />
                        {node.hoursPlayed > 0 && (
                          <span className="absolute bottom-1 right-1.5 text-[8px] text-white/50 font-mono bg-black/50 px-1 py-0.5 rounded backdrop-blur-sm">
                            {node.hoursPlayed.toFixed(1)}h
                          </span>
                        )}
                      </div>
                      {/* Info */}
                      <div className="px-2.5 py-2">
                        <div className="flex items-center gap-1.5">
                          <div className="text-[11px] font-medium text-white/85 truncate leading-tight flex-1 min-w-0">{node.title}</div>
                          <StoreLogos nodeId={node.id} />
                        </div>
                        {node.developer && (
                          <div className="text-[9px] text-white/30 truncate mt-0.5">{node.developer}</div>
                        )}
                        {node.genres.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {node.genres.slice(0, 3).map(g => (
                              <span key={g} className="text-[8px] px-1 py-[1px] rounded bg-white/[0.06] text-white/30">{g}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Collapsed library tab — persistent edge handle */}
        <AnimatePresence>
          {!showLibrary && !loading && libraryNodes.length > 0 && (
            <motion.button
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.2 }}
              onClick={() => setShowLibrary(true)}
              className="absolute top-1/2 -translate-y-1/2 left-0 z-30 pointer-events-auto flex items-center gap-1 pl-1.5 pr-2 py-3 rounded-r-lg border border-l-0 border-white/[0.08] bg-black/50 backdrop-blur-xl text-white/40 hover:text-white/70 hover:bg-black/70 transition-all cursor-pointer group/tab"
              title="Open library panel"
            >
              <ChevronRight className="w-3 h-3 transition-transform group-hover/tab:translate-x-0.5" />
              <span className="text-[9px] font-medium writing-mode-vertical [writing-mode:vertical-lr] tracking-wider uppercase">Library</span>
            </motion.button>
          )}
        </AnimatePresence>

        {loading && <LoadingSkeleton steps={loadingSteps} />}
        <HeroIntro visible={heroVisible} />

        {/* Floating cards at star positions — selected node + neighbors */}
        <div ref={neighborCardsRef} className="absolute inset-0 pointer-events-none z-20">
          {/* Selected node's floating card */}
          {selectedNode && (
            <div
              key={`sel-${selectedNode.id}`}
              data-nx={selectedNode.x}
              data-ny={selectedNode.y}
              data-nz={selectedNode.z}
              className="absolute left-0 top-0"
              style={{ willChange: 'transform', opacity: 0, zIndex: focusedNbIdx === -1 ? 10 : 1 }}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
                className="relative"
              >
                <div className={`rounded-xl overflow-hidden backdrop-blur-xl transition-all duration-300 ${
                  focusedNbIdx === -1
                    ? 'w-[320px] bg-black/90 border border-fuchsia-500/30 shadow-xl shadow-fuchsia-500/15 ring-1 ring-fuchsia-500/10'
                    : 'w-[100px] bg-black/40 border border-white/[0.03] opacity-15'
                }`}>
                  <div className={`w-full bg-black/40 overflow-hidden transition-all duration-300 ${focusedNbIdx === -1 ? 'h-[120px]' : 'h-[20px]'}`}>
                    <FallbackImg node={selectedNode} className="w-full h-full object-cover" />
                  </div>
                  <div className={`transition-all duration-300 ${focusedNbIdx === -1 ? 'px-3.5 py-3' : 'px-1.5 py-1'}`}>
                    <div className={`flex items-center gap-1.5 transition-all duration-300 ${focusedNbIdx === -1 ? '' : ''}`}>
                      <div className={`font-semibold text-white leading-tight flex-1 min-w-0 transition-all duration-300 ${focusedNbIdx === -1 ? 'text-[15px] text-white line-clamp-2 min-h-[2lh]' : 'text-[7px] text-white/20 truncate'}`}>
                        {selectedNode.title}
                      </div>
                      {focusedNbIdx === -1 && <StoreLogos nodeId={selectedNode.id} />}
                    </div>
                    {focusedNbIdx === -1 && (
                      <>
                        <div className="text-[10px] text-white/40 truncate mt-1">{selectedNode.developer || '\u00A0'}</div>
                        {selectedNode.genres.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {selectedNode.genres.slice(0, 4).map(g => (
                              <span key={g} className="text-[8px] px-1.5 py-[1px] rounded bg-fuchsia-500/10 text-fuchsia-400/70 leading-tight">{g}</span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {focusedNbIdx === -1 && (
                  <div className="absolute left-full top-0 bottom-0 ml-2.5 flex flex-col justify-between py-1 select-none" style={{ width: 190 }}>
                    <div className="flex flex-col gap-[3px] font-mono text-[10px] leading-none tracking-wider text-fuchsia-400/30 pointer-events-none">
                      <span className="text-fuchsia-400/20">{pathActive && pathIdx >= 0 ? '// THE PATH' : '// GAME EMBEDDING'}</span>
                      {pathActive && pathIdx >= 0 && (
                        <>
                          <span className="mt-1 text-amber-400/50">STEP::{pathIdx + 1}/{pathNodesRef.current.length}</span>
                          {isLastPathNode && <span className="text-amber-400/40">★ FINAL NODE</span>}
                        </>
                      )}
                      <span className="mt-1">SYS::NODE</span>
                      <span className="text-fuchsia-400/50">{selectedNode.id.slice(0, 12).toUpperCase()}</span>
                      <span className="mt-1">POS</span>
                      <span className="text-fuchsia-400/40">{selectedNode.x.toFixed(1)}</span>
                      <span className="text-fuchsia-400/40">{selectedNode.y.toFixed(1)}</span>
                      <span className="text-fuchsia-400/40">{selectedNode.z.toFixed(1)}</span>
                      <span className="mt-1">LINKS::{connectionCount}</span>
                      {selectedNode.isLibrary && <span className="text-emerald-400/40">LIB::OWNED</span>}
                      {selectedNode.hoursPlayed > 0 && <span className="text-fuchsia-400/40">TIME::{selectedNode.hoursPlayed.toFixed(1)}h</span>}
                      <span className="text-fuchsia-400/20">CLR::{selectedNode.colorIdx.toString(16).toUpperCase().padStart(2, '0')}</span>
                    </div>
                    <div
                      className="flex items-center gap-1 px-1.5 py-1.5 rounded-lg bg-white/[0.04] backdrop-blur-md border border-white/[0.06] pointer-events-auto mt-2"
                      onClick={e => e.stopPropagation()}
                      onMouseMove={e => e.stopPropagation()}
                    >
                      {(cycleableNeighbors.length > 0 || (pathActive && pathNodesRef.current.length > 1)) && (
                        <>
                          <button onClick={handleCyclePrev} className="p-1 rounded text-white/40 hover:text-white/80 hover:bg-white/10 transition-colors cursor-pointer" title={pathActive && !isLastPathNode ? 'Previous game on path' : 'Previous neighbor'}>
                            <ChevronLeft className="w-3 h-3" />
                          </button>
                          {(!pathActive || isLastPathNode) && (
                            <button onClick={handleCycleHome} className={`p-1 rounded transition-colors cursor-pointer ${
                              focusedNbIdx === -1 ? 'text-fuchsia-400/80 bg-fuchsia-500/10' : 'text-white/40 hover:text-white/70 hover:bg-white/10'
                            }`} title="Refocus on selected">
                              <Crosshair className="w-3 h-3" />
                            </button>
                          )}
                          <span className="text-[8px] text-white/30 tabular-nums font-mono flex-1 text-center">
                            {pathActive && pathIdx >= 0
                              ? (isLastPathNode
                                  ? (focusedNbIdx === -1 ? `★ ${pathIdx + 1}/${pathNodesRef.current.length}` : `${focusedNbIdx + 1}/${cycleableNeighbors.length}`)
                                  : `${pathIdx + 1}/${pathNodesRef.current.length}`)
                              : (focusedNbIdx === -1 ? '—' : `${focusedNbIdx + 1}/${cycleableNeighbors.length}`)}
                          </span>
                          <button onClick={handleCycleNext} className="p-1 rounded text-white/40 hover:text-white/80 hover:bg-white/10 transition-colors cursor-pointer" title={pathActive && !isLastPathNode ? 'Next game on path' : 'Next neighbor'}>
                            <ChevronRight className="w-3 h-3" />
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => toggleDetail(selectedNode.id)}
                        className={`p-1 rounded transition-colors cursor-pointer ${
                          detailOpen && detailNodeIdRef.current === selectedNode.id
                            ? 'text-fuchsia-400/80 bg-fuchsia-500/10'
                            : 'text-white/40 hover:text-white/70 hover:bg-white/10'
                        }`}
                        title="Game details"
                      >
                        {detailLoading && detailNodeIdRef.current === selectedNode.id
                          ? <Loader2 className="w-3 h-3 animate-spin" />
                          : <Info className="w-3 h-3" />}
                      </button>
                      {!libraryStore.isInLibrary(selectedNode.id) ? (
                        <button
                          onClick={() => addNodeToLibrary(selectedNode)}
                          className="p-1 rounded text-emerald-400/60 hover:text-emerald-400 hover:bg-emerald-500/15 transition-colors cursor-pointer"
                          title="Add to library"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      ) : (
                        <span className="p-1 text-emerald-400/40" title="In library">
                          <Check className="w-3 h-3" />
                        </span>
                      )}
                    </div>
                  </div>
                )}
                <AnimatePresence>
                  {detailOpen && detailNodeIdRef.current === selectedNode.id && !detailLoading && detailData && focusedNbIdx === -1 && (
                    <motion.div
                      initial={{ opacity: 0, height: 0, marginTop: 0 }}
                      animate={{ opacity: 1, height: 'auto', marginTop: 8 }}
                      exit={{ opacity: 0, height: 0, marginTop: 0 }}
                      transition={{ duration: 0.25, ease: 'easeInOut' }}
                      className="overflow-hidden rounded-lg bg-black/90 backdrop-blur-xl border border-fuchsia-500/20 shadow-xl shadow-fuchsia-500/10 pointer-events-auto w-[320px]"
                      onClick={e => e.stopPropagation()}
                      onMouseMove={e => e.stopPropagation()}
                    >
                      <DetailPanelContent data={detailData} nodeId={selectedNode.id} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            </div>
          )}

          {/* Neighbor floating cards */}
          {selectedNode && cycleableNeighbors.map((nb, i) => {
            const isFocused = focusedNbIdx === i;
            return (
              <div
                key={nb.id}
                data-nx={nb.node!.x}
                data-ny={nb.node!.y}
                data-nz={nb.node!.z}
                className="absolute left-0 top-0"
                style={{ willChange: 'transform', opacity: 0, zIndex: isFocused ? 10 : 1 }}
              >
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15 + i * 0.08, duration: 0.5, ease: 'easeOut' }}
                  className="relative group"
                >
                  <div
                    className={`group/card rounded-xl overflow-hidden backdrop-blur-md transition-all duration-300 cursor-pointer pointer-events-auto ${
                      isFocused
                        ? 'w-[320px] bg-black/90 border border-cyan-500/30 shadow-xl shadow-cyan-500/15 ring-1 ring-cyan-500/10'
                        : 'w-[110px] bg-black/40 border border-white/[0.03] opacity-[0.08] hover:opacity-100 hover:w-[180px] hover:bg-black/80 hover:border-white/[0.08]'
                    }`}
                    onClick={e => { e.stopPropagation(); setFocusedNbIdx(i); flyToNode3D(nb.node!); focusNeighborSun(i, nb.node!); }}
                    onMouseMove={e => e.stopPropagation()}
                  >
                    <div className={`w-full bg-black/40 overflow-hidden transition-all duration-300 ${isFocused ? 'h-[120px]' : 'h-[20px] group-hover/card:h-[60px]'}`}>
                      <FallbackImg node={nb.node!} className="w-full h-full object-cover" />
                    </div>
                    <div className={`transition-all duration-300 ${isFocused ? 'px-3.5 py-3' : 'px-1.5 py-1'}`}>
                      <div className="flex items-center gap-1.5">
                        <div className={`font-semibold leading-tight flex-1 min-w-0 transition-all duration-300 ${isFocused ? 'text-[15px] text-white line-clamp-2 min-h-[2lh]' : 'text-[7px] text-white/30 truncate'}`}>
                          {nb.node!.title}
                        </div>
                        {isFocused && <StoreLogos nodeId={nb.node!.id} />}
                      </div>
                      {isFocused && (
                        <>
                          <div className="text-[10px] text-white/40 truncate mt-1">{nb.node!.developer || '\u00A0'}</div>
                          {nb.node!.genres.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {nb.node!.genres.slice(0, 4).map(g => (
                                <span key={g} className="text-[8px] px-1.5 py-[1px] rounded bg-cyan-500/10 text-cyan-400/70 leading-tight">{g}</span>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  {isFocused && (
                    <div className="absolute left-full top-0 bottom-0 ml-2.5 flex flex-col justify-between py-1 select-none" style={{ width: 190 }}>
                      <div className="flex flex-col gap-[3px] font-mono text-[10px] leading-none tracking-wider text-cyan-400/30 pointer-events-none">
                        <span className="text-cyan-400/20">// GAME EMBEDDING</span>
                        <span className="mt-1">SYS::LINK</span>
                        <span className="text-cyan-400/50">{nb.node!.id.slice(0, 12).toUpperCase()}</span>
                        <span className="mt-1">DIST::FROM_SELECTED</span>
                        <span className="text-cyan-400/50">{nb.distance.toFixed(4)}</span>
                        <span className="mt-1">POS</span>
                        <span className="text-cyan-400/40">{nb.node!.x.toFixed(1)}</span>
                        <span className="text-cyan-400/40">{nb.node!.y.toFixed(1)}</span>
                        <span className="text-cyan-400/40">{nb.node!.z.toFixed(1)}</span>
                        {nb.node!.isLibrary && <span className="text-emerald-400/40 mt-1">LIB::OWNED</span>}
                        {nb.node!.hoursPlayed > 0 && <span className="text-cyan-400/40">TIME::{nb.node!.hoursPlayed.toFixed(1)}h</span>}
                      </div>
                      <div
                        className="flex items-center gap-1 px-1.5 py-1.5 rounded-lg bg-white/[0.04] backdrop-blur-md border border-white/[0.06] pointer-events-auto mt-2"
                        onClick={e => e.stopPropagation()}
                        onMouseMove={e => e.stopPropagation()}
                      >
                        {cycleableNeighbors.length > 0 && (
                          <>
                            <button onClick={handleCyclePrev} className="p-1 rounded text-white/40 hover:text-white/80 hover:bg-white/10 transition-colors cursor-pointer" title="Previous neighbor">
                              <ChevronLeft className="w-3 h-3" />
                            </button>
                            <button onClick={handleCycleHome} className="p-1 rounded text-white/40 hover:text-white/70 hover:bg-white/10 transition-colors cursor-pointer" title="Back to selected star">
                              <Crosshair className="w-3 h-3" />
                            </button>
                            <span className="text-[8px] text-white/30 tabular-nums font-mono flex-1 text-center">
                              {focusedNbIdx + 1}/{cycleableNeighbors.length}
                            </span>
                            <button onClick={handleCycleNext} className="p-1 rounded text-white/40 hover:text-white/80 hover:bg-white/10 transition-colors cursor-pointer" title="Next neighbor">
                              <ChevronRight className="w-3 h-3" />
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => toggleDetail(nb.node!.id)}
                          className={`p-1 rounded transition-colors cursor-pointer ${
                            detailOpen && detailNodeIdRef.current === nb.node!.id
                              ? 'text-cyan-400/80 bg-cyan-500/10'
                              : 'text-white/40 hover:text-white/70 hover:bg-white/10'
                          }`}
                          title="Game details"
                        >
                          {detailLoading && detailNodeIdRef.current === nb.node!.id
                            ? <Loader2 className="w-3 h-3 animate-spin" />
                            : <Info className="w-3 h-3" />}
                        </button>
                        {!libraryStore.isInLibrary(nb.node!.id) ? (
                          <button
                            onClick={() => addNodeToLibrary(nb.node!)}
                            className="p-1 rounded text-emerald-400/60 hover:text-emerald-400 hover:bg-emerald-500/15 transition-colors cursor-pointer"
                            title="Add to library"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        ) : (
                          <span className="p-1 text-emerald-400/40" title="In library">
                            <Check className="w-3 h-3" />
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {!isFocused && (
                    <div className="absolute left-full top-0 ml-1.5 flex flex-col gap-[2px] py-0.5 pointer-events-none select-none font-mono text-[9px] leading-none tracking-wider text-cyan-400/15 transition-colors duration-300 group-hover:text-cyan-400/60">
                      <span>d={nb.distance.toFixed(3)}</span>
                    </div>
                  )}
                  <AnimatePresence>
                    {isFocused && detailOpen && detailNodeIdRef.current === nb.node!.id && !detailLoading && detailData && (
                      <motion.div
                        initial={{ opacity: 0, height: 0, marginTop: 0 }}
                        animate={{ opacity: 1, height: 'auto', marginTop: 8 }}
                        exit={{ opacity: 0, height: 0, marginTop: 0 }}
                        transition={{ duration: 0.25, ease: 'easeInOut' }}
                        className="overflow-hidden rounded-lg bg-black/90 backdrop-blur-xl border border-cyan-500/20 shadow-xl shadow-cyan-500/10 pointer-events-auto w-[320px]"
                        onClick={e => e.stopPropagation()}
                        onMouseMove={e => e.stopPropagation()}
                      >
                        <DetailPanelContent data={detailData} nodeId={nb.node!.id} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              </div>
            );
          })}
        </div>

        {/* Hover tooltip */}
        {hoveredNode && !selectedNode && (
          <div
            className="absolute z-40 pointer-events-none"
            style={{ left: tooltipPos.x + 16, top: tooltipPos.y - 12 }}
          >
            <div className="bg-black/90 border border-white/[0.08] rounded-lg overflow-hidden backdrop-blur-xl max-w-[260px]">
              <FallbackImg node={hoveredNode} className="w-full h-[72px] object-cover" fallbackClassName="w-full h-[72px] bg-black/40 flex items-center justify-center text-white/15 text-xs font-bold" />
              <div className="px-3 py-2">
                <div className="text-[12px] font-semibold text-white/90 truncate">{hoveredNode.title}</div>
                {hoveredNode.developer && <div className="text-[10px] text-white/35 mt-0.5 truncate">{hoveredNode.developer}</div>}
                {hoveredNode.genres.length > 0 && (
                  <div className="text-[9px] text-purple-400/70 mt-1">{hoveredNode.genres.slice(0, 3).join(' · ')}</div>
                )}
                {hoveredNode.hoursPlayed > 0 && (
                  <div className="text-[9px] text-white/25 mt-0.5">{hoveredNode.hoursPlayed.toFixed(1)}h played</div>
                )}
                {hoveredNode.isLibrary && (
                  <div className="text-[8px] text-emerald-400/50 mt-1">★ In Library</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Neighbors right-side panel — collapsible glass overlay */}
        <AnimatePresence>
          {showNeighbors && selectedNode && neighbors.length > 0 && (
            <motion.div
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
              onClick={e => e.stopPropagation()}
              onMouseMove={e => e.stopPropagation()}
              className="absolute top-3 right-3 bottom-14 w-72 z-30 pointer-events-auto flex flex-col rounded-xl border border-white/[0.08] bg-black/60 backdrop-blur-2xl shadow-2xl shadow-black/40 overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-white/[0.06] shrink-0 bg-white/[0.02]">
                <div className="flex items-center gap-2">
                  <Waypoints className="w-3.5 h-3.5 text-cyan-400/70" />
                  <span className="text-[11px] font-medium text-white/60">Neighbors</span>
                  <span className="text-[9px] text-white/25 tabular-nums">{neighbors.filter(nb => nb.node && !nb.node.title.startsWith('Unknown Game')).length}</span>
                </div>
                <button
                  onClick={() => { setShowNeighbors(false); setNbSearch(''); }}
                  className="p-1 rounded-md text-white/25 hover:text-white/60 hover:bg-white/5 transition-colors cursor-pointer"
                  title="Collapse panel"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Search within neighbors */}
              <div className="px-3 py-2 border-b border-white/[0.04] shrink-0">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-white/20" />
                  <input
                    type="text"
                    value={nbSearch}
                    onChange={e => setNbSearch(e.target.value)}
                    placeholder="Filter neighbors…"
                    className="w-full pl-7 pr-2 py-1.5 text-[11px] bg-white/[0.04] border border-white/[0.06] rounded-md text-white/70 placeholder:text-white/20 outline-none focus:border-cyan-500/30 transition-colors"
                  />
                  {nbSearch && (
                    <button
                      onClick={() => setNbSearch('')}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-white/20 hover:text-white/50 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>

              {/* Selected node summary */}
              <div className="px-3.5 py-2.5 border-b border-white/[0.04] shrink-0">
                <div className="flex gap-2.5 items-start">
                  <div className="w-16 h-8 rounded bg-white/[0.06] overflow-hidden shrink-0">
                    <FallbackImg node={selectedNode} className="w-full h-full object-cover" fallbackClassName="w-full h-full flex items-center justify-center text-[7px] text-white/20 font-bold" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium text-white/85 truncate leading-tight">{selectedNode.title}</div>
                    {selectedNode.developer && <div className="text-[9px] text-white/30 truncate mt-0.5">{selectedNode.developer}</div>}
                  </div>
                </div>
              </div>

              {/* Scrollable neighbor list — two-column: name | d */}
              <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide">
                <div className="flex items-center justify-between px-3.5 py-1.5 text-[9px] text-white/25 uppercase tracking-wider border-b border-white/[0.04]">
                  <span>Name</span>
                  <span>Distance</span>
                </div>
                {neighbors
                  .filter(nb => {
                    if (!nb.node) return false;
                    if (nb.node.title.startsWith('Unknown Game')) return false;
                    if (nbSearch) return nb.node.title.toLowerCase().includes(nbSearch.toLowerCase());
                    return true;
                  })
                  .map(nb => {
                    const isFocusedNb = cycleableNeighbors[focusedNbIdx]?.id === nb.id;
                    return (
                      <button
                        key={nb.id}
                        onClick={() => {
                          const idx = cycleableNeighbors.findIndex(cn => cn.id === nb.id);
                          if (idx !== -1 && nb.node) {
                            setFocusedNbIdx(idx);
                            flyToNode3D(nb.node);
                            focusNeighborSun(idx, nb.node);
                          }
                        }}
                        className={`w-full flex items-center justify-between gap-2 px-3.5 py-1.5 text-left transition-colors cursor-pointer ${
                          isFocusedNb
                            ? 'bg-cyan-500/10 text-white/90'
                            : 'text-white/60 hover:bg-white/[0.04] hover:text-white/80'
                        }`}
                      >
                        <span className="text-[11px] truncate min-w-0 flex-1">
                          {nb.node!.isLibrary && <span className="text-emerald-400/60 mr-1">★</span>}
                          {nb.node!.title}
                        </span>
                        <span className={`text-[10px] font-mono tabular-nums shrink-0 ${isFocusedNb ? 'text-cyan-400/70' : 'text-white/30'}`}>
                          {nb.distance.toFixed(4)}
                        </span>
                      </button>
                    );
                  })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Collapsed neighbors tab — persistent edge handle on right */}
        <AnimatePresence>
          {!showNeighbors && selectedNode && neighbors.length > 0 && (
            <motion.button
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 12 }}
              transition={{ duration: 0.2 }}
              onClick={() => setShowNeighbors(true)}
              className="absolute top-1/2 -translate-y-1/2 right-0 z-30 pointer-events-auto flex items-center gap-1 pr-1.5 pl-2 py-3 rounded-l-lg border border-r-0 border-white/[0.08] bg-black/50 backdrop-blur-xl text-white/40 hover:text-white/70 hover:bg-black/70 transition-all cursor-pointer group/nbtab"
              title="Open neighbors panel"
            >
              <span className="text-[9px] font-medium writing-mode-vertical [writing-mode:vertical-lr] tracking-wider uppercase">Neighbors</span>
              <ChevronLeft className="w-3 h-3 transition-transform group-hover/nbtab:-translate-x-0.5" />
            </motion.button>
          )}
        </AnimatePresence>

        {/* Path overview cards — mini cards at each path node during overview mode */}
        <div ref={pathOverviewCardsRef} className="absolute inset-0 pointer-events-none z-20">
          {pathActive && pathOverview && pathNodesRef.current.map((node, idx) => (
            <div
              key={`pov-${node.id}`}
              data-nx={node.x}
              data-ny={node.y}
              data-nz={node.z}
              className="absolute left-0 top-0 group/pov pointer-events-auto cursor-pointer"
              style={{ willChange: 'transform, opacity' }}
              onClick={() => {
                setPathOverview(false);
                selectPathNode(idx);
              }}
            >
              <div className="w-[100px] group-hover/pov:w-[160px] transition-all duration-300 rounded-lg overflow-hidden border border-amber-500/15 group-hover/pov:border-amber-500/40 bg-black/60 group-hover/pov:bg-black/85 backdrop-blur-md opacity-50 group-hover/pov:opacity-100 shadow-lg shadow-black/40">
                <div className="relative w-full aspect-[3/4] overflow-hidden">
                  <FallbackImg
                    node={node}
                    className="w-full h-full object-cover"
                    fallbackClassName="w-full h-full flex items-center justify-center text-white/40 text-xs bg-zinc-900"
                    loading="lazy"
                  />
                  <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-amber-500/80 text-[8px] font-bold text-black leading-none">
                    {idx + 1}
                  </div>
                </div>
                <div className="p-1.5">
                  <p className="text-[9px] group-hover/pov:text-[10px] text-white/60 group-hover/pov:text-white/90 font-medium leading-tight truncate transition-colors duration-300">
                    {node.title}
                  </p>
                  {(() => {
                    const je = journeyStore.getEntry(node.id);
                    const libEntry = libraryStore.getEntry(node.id);
                    const lastPlayed = je?.lastPlayedAt ?? libEntry?.lastPlayedAt;
                    if (!lastPlayed) return null;
                    return (
                      <p className="text-[7px] group-hover/pov:text-[8px] text-white/30 group-hover/pov:text-white/50 font-mono mt-0.5 truncate transition-colors duration-300">
                        {new Date(lastPlayed).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </p>
                    );
                  })()}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Genre filter panel — collapsible glass overlay on the right (Galaxy View only) */}
        <AnimatePresence>
          {showFilters && !loading && !selectedNode && !pathActive && (
            <motion.div
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
              onClick={e => e.stopPropagation()}
              onMouseMove={e => e.stopPropagation()}
              className="absolute top-3 right-3 bottom-32 w-56 z-30 pointer-events-auto flex flex-col rounded-xl border border-white/[0.08] bg-black/60 backdrop-blur-2xl shadow-2xl shadow-black/40 overflow-hidden"
            >
              <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-white/[0.06] shrink-0 bg-white/[0.02]">
                <div className="flex items-center gap-2">
                  <Filter className="w-3.5 h-3.5 text-fuchsia-400/70" />
                  <span className="text-[11px] font-medium text-white/60">Genres</span>
                  {activeGenres.size > 0 && activeGenres.size < allGenres.length && (
                    <span className="text-[9px] text-fuchsia-400/50 tabular-nums">{activeGenres.size}/{allGenres.length}</span>
                  )}
                </div>
                <button
                  onClick={() => setShowFilters(false)}
                  className="p-1 rounded-md text-white/25 hover:text-white/60 hover:bg-white/5 transition-colors cursor-pointer"
                  title="Collapse panel"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex items-center gap-2 px-3.5 py-2 border-b border-white/[0.04] shrink-0">
                <button onClick={() => setActiveGenres(new Set(allGenres))}
                  className={`text-[9px] px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                    activeGenres.size === allGenres.length
                      ? 'bg-fuchsia-500/15 border-fuchsia-500/25 text-fuchsia-400/80'
                      : 'border-white/[0.06] text-white/30 hover:text-white/50'
                  }`}>All</button>
                <button onClick={() => setActiveGenres(new Set())}
                  className={`text-[9px] px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                    activeGenres.size === 0
                      ? 'bg-fuchsia-500/15 border-fuchsia-500/25 text-fuchsia-400/80'
                      : 'border-white/[0.06] text-white/30 hover:text-white/50'
                  }`}>None</button>
              </div>
              <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide px-3 py-2.5">
                <div className="flex flex-wrap gap-1.5">
                  {allGenres.map(genre => (
                    <button key={genre} onClick={() => toggleGenre(genre)}
                      className={`text-[9px] px-2 py-1 rounded-md border transition-colors cursor-pointer ${
                        activeGenres.has(genre)
                          ? 'bg-fuchsia-500/10 border-fuchsia-500/20 text-fuchsia-400/80'
                          : 'bg-transparent border-white/[0.06] text-white/20 hover:text-white/40'
                      }`}>
                      {genre}
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Collapsed genre filter tab — right edge (Galaxy View only) */}
        <AnimatePresence>
          {!showFilters && !loading && !selectedNode && !pathActive && allGenres.length > 0 && (
            <motion.button
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 12 }}
              transition={{ duration: 0.2 }}
              onClick={() => setShowFilters(true)}
              className="absolute top-1/2 -translate-y-1/2 right-0 z-30 pointer-events-auto flex items-center gap-1 pr-1.5 pl-2 py-3 rounded-l-lg border border-r-0 border-white/[0.08] bg-black/50 backdrop-blur-xl text-white/40 hover:text-white/70 hover:bg-black/70 transition-all cursor-pointer group/gtab"
              title="Open genre filter"
            >
              <span className="text-[9px] font-medium writing-mode-vertical [writing-mode:vertical-lr] tracking-wider uppercase">Genres</span>
              {activeGenres.size > 0 && activeGenres.size < allGenres.length && (
                <span className="absolute -top-1 -left-1 w-4 h-4 rounded-full bg-fuchsia-500/80 text-[7px] text-white font-bold flex items-center justify-center">{activeGenres.size}</span>
              )}
              <ChevronLeft className="w-3 h-3 transition-transform group-hover/gtab:-translate-x-0.5" />
            </motion.button>
          )}
        </AnimatePresence>

        {/* Legend */}
        <div className={`absolute bottom-4 flex items-center gap-5 text-[11px] text-white/40 z-20 pointer-events-none transition-all duration-300 ${showLibrary ? 'left-[310px]' : 'left-4'}`}>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: 'radial-gradient(circle, #f0abfc, #a855f7)' }} />
            <span>Selected</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: 'radial-gradient(circle, #67e8f9, #06b6d4)' }} />
            <span>Neighbor</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-white/60" />
            <span>Library</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-white/30" />
            <span>Catalog</span>
          </div>
        </div>

        {/* View mode badge + FPS */}
        {!loading && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 z-20 screenshot-exclude">
            <button
              onClick={showThePath}
              className={`px-3.5 py-1.5 rounded-full border backdrop-blur-xl text-[10px] font-medium tracking-wide transition-all duration-500 cursor-pointer pointer-events-auto flex items-center gap-1.5 ${
                pathActive
                  ? 'border-amber-500/30 bg-amber-500/15 text-amber-300/90 shadow-lg shadow-amber-500/10'
                  : 'border-white/[0.08] bg-white/[0.04] text-white/40 hover:text-white/60 hover:border-white/[0.12]'
              }`}
            >
              <Route className="w-3 h-3" />
              The Path
            </button>
            {pathActive && pathOverview && (
              <>
                <button
                  onClick={startPathExplore}
                  className="px-3.5 py-1.5 rounded-full border border-amber-500/40 bg-amber-500/20 text-amber-200 text-[10px] font-medium tracking-wide transition-all duration-500 cursor-pointer pointer-events-auto flex items-center gap-1.5 shadow-lg shadow-amber-500/15 hover:bg-amber-500/30 hover:border-amber-500/50"
                >
                  <Waypoints className="w-3 h-3" />
                  Explore Path
                </button>
                <button
                  onClick={captureScreenshot}
                  disabled={screenshotSaving}
                  className="px-3 py-1.5 rounded-full border border-white/[0.12] bg-white/[0.06] text-white/50 text-[10px] font-medium tracking-wide transition-all duration-300 cursor-pointer pointer-events-auto flex items-center gap-1.5 hover:text-white/80 hover:border-white/[0.2] hover:bg-white/[0.1] disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Save screenshot to Downloads"
                >
                  <Camera className="w-3 h-3" />
                  {screenshotSaving ? 'Saving...' : 'Screenshot'}
                </button>
              </>
            )}
          </div>
        )}

        {/* View mode label — terminal-style, bottom-left, above legend */}
        <div className={`absolute bottom-14 z-20 pointer-events-none flex flex-col gap-1 screenshot-exclude transition-all duration-300 ${showLibrary ? 'left-[310px]' : 'left-4'}`}>
          <span className="font-mono text-[22px] leading-none tracking-widest text-white/15">
            {selectedNode
              ? (pathActive && pathIdx >= 0
                  ? `// PATH ${pathIdx + 1}/${pathNodesRef.current.length}${isLastPathNode ? ' · FINAL' : ''}`
                  : '// STAR VIEW')
              : pathActive && pathOverview ? '// PATH OVERVIEW' : pathActive ? '// PATH VIEW' : '// GALAXY VIEW'}
          </span>
          <span ref={fpsRef} className="text-[9px] text-white/15 font-mono mt-0.5">-- FPS</span>
        </div>

        {/* Controls hint */}
        <div className="absolute bottom-3 right-4 flex flex-col gap-1.5 z-20 pointer-events-none screenshot-exclude">
          <div className="flex items-center gap-2 text-[10px] text-white/30 font-mono">
            <MousePointer className="w-3 h-3 hint-orbit flex-shrink-0" />
            <span>Left click + drag to orbit</span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-white/30 font-mono">
            <Move className="w-3 h-3 hint-pan flex-shrink-0" />
            <span>Right click + drag to pan</span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-white/30 font-mono">
            <ZoomIn className="w-3 h-3 hint-zoom flex-shrink-0" />
            <span>Scroll wheel to zoom</span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-white/30 font-mono">
            <Crosshair className="w-3 h-3 hint-tap flex-shrink-0" />
            <span>Click a star to inspect</span>
          </div>
          {(selectedNode || pathActive) && (
            <div className="flex items-center gap-2 text-[10px] text-white/30 font-mono">
              <ChevronLeft className="w-3 h-3 flex-shrink-0" />
              <ChevronRight className="w-3 h-3 flex-shrink-0 -ml-1.5" />
              <span>Arrow keys to cycle</span>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
