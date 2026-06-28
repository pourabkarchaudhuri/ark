/**
 * Embedding Space View — Galaxy-map 3D visualization of all game embeddings
 *
 * Renders 60K+ game nodes as glowing particles using THREE.Points (single
 * draw call). WebGPU renderer when available, with automatic WebGL fallback.
 * Galaxy data (PCA positions + metadata) is cached in IDB by galaxy-cache.ts
 * so repeat visits load instantly.
 */

import { useState, useEffect, useCallback, useRef, useMemo, useDeferredValue, startTransition, type FC } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { toPng } from 'html-to-image';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Search, Filter, Loader2, Check, RotateCcw, X, Library, ChevronLeft, ChevronRight, Crosshair, Route, Waypoints, Info, Clock, MousePointer, Move, ZoomIn, Plus, Camera, CornerDownRight, Undo2, AlertTriangle } from 'lucide-react';
import type { SteamAppDetails } from '@/types/steam';
import type { EpicCatalogItem, EpicProductReviews } from '@/types/epic';
import { libraryStore } from '@/services/library-store';
import { getStoreFromId } from '@/types/game';
import { TooltipCard } from '@/components/ui/tooltip-card';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { buildGameImageChain } from '@/lib/utils';
import { getEmbeddingById, embeddingService, extractFranchiseBase } from '@/services/embedding-service';
import { annIndex } from '@/services/ann-index';
import { journeyStore } from '@/services/journey-store';
import {
  type GraphNode,
  type NeighborInfo,
  type GalaxyStepReporter,
  GENRE_PALETTE,
  CANONICAL_GENRE_LABELS,
  GALAXY_STEP_LABELS,
  loadCachedGalaxyIfFresh,
  buildAndCacheGalaxy,
  getBackgroundBuildPromise,
  genreToColorIdx,
  cancelActiveProjectionWorker,
} from '@/services/galaxy-cache';
import { scoreGame, type SearchIndexEntry } from '@/services/prefetch-store';
import { generateMockGalaxy } from '@/services/mock-galaxy';
import { gameGraphStore, type GraphScores } from '@/services/game-graph-store';
import { generateConstellationNames, type ConstellationName } from '@/services/constellation-namer';
import { narratorBus } from '@/services/narrator-bus';
import { scannerSelectionStore, type ScannerMode } from '@/services/scanner-selection-store';
import { userMarksStore, type BannerColor, BANNER_COLORS, BANNER_RGB } from '@/services/user-marks-store';
import { type LassoPoint, pathLength, toSvgPath, findNodesInsidePolygon, simplifyPath } from '@/services/lasso-geometry';
import { TIMESHEAR_WEEKS, buildTimelineMatrix, formatWeekLabel } from '@/services/timeshear-store';
import {
  applyOllamaNeighborRerank,
  NEIGHBOR_HEURISTIC_POOL,
  type NeighborRerankStatus,
} from '@/services/ollama-rerank';

function neighborRerankBadge(status: NeighborRerankStatus): { label: string; title: string } | null {
  if (status === 'applied' || status === 'fallback') return null;
  if (status === 'skipped_settings') return { label: 'Rerank off', title: 'Neighbor rerank is off in Settings' };
  if (status === 'skipped_no_client') return { label: 'Rerank unavailable', title: 'Ollama rerank not available — connect in Settings' };
  if (status === 'empty_results') return { label: 'No rerank scores', title: 'Rerank returned no scores; using heuristic order' };
  if (status === 'error') return { label: 'Rerank failed', title: 'Rerank failed; using heuristic order' };
  return null;
}

// ─── Genre IDF (Inverse Document Frequency) Weights ─────────────────────────
// Approximate frequency of each genre across the gaming ecosystem.
// Lower frequency → higher IDF weight → more discriminating genre match.
const GENRE_FREQ: Record<string, number> = {
  'action': 0.40, 'action-adventure': 0.30, 'adventure': 0.32,
  'casual': 0.20, 'rpg': 0.25, 'shooter': 0.18,
  'strategy': 0.15, 'simulation': 0.12, 'survival': 0.10,
  'fps': 0.12, 'first person': 0.12, 'open world': 0.15,
  'horror': 0.06, 'puzzle': 0.08, 'sports': 0.07,
  'racing': 0.05, 'platformer': 0.06, 'roguelike': 0.04,
  'roguelite': 0.04, 'rogue-lite': 0.04, 'souls-like': 0.02,
  'soulslike': 0.02, 'metroidvania': 0.03, 'visual novel': 0.03,
  'city builder': 0.02, 'tower defense': 0.03, 'fighting': 0.04,
  'rhythm': 0.02, 'mmo': 0.05, 'mmorpg': 0.04,
  'hack and slash': 0.04, 'turn-based': 0.05,
  'real-time strategy': 0.04, 'grand strategy': 0.02,
  'rts': 0.04, 'card game': 0.03, 'stealth': 0.04,
  'exploration': 0.10, 'narration': 0.05, 'comedy': 0.05,
  'space': 0.03, 'party': 0.03, 'indie': 0.35, 'fantasy': 0.15,
  'sandbox': 0.08, 'battle royale': 0.04,
  'crpg': 0.02, 'tactical': 0.04, 'isometric': 0.03,
  'point and click': 0.03, 'walking simulator': 0.02,
  'life sim': 0.02, 'farming': 0.02,
  'management': 0.04, 'building': 0.05, 'crafting': 0.06,
  'co-op': 0.10,
};

function genreIdf(genre: string): number {
  const freq = GENRE_FREQ[genre] ?? 0.10;
  return Math.log2(1 / freq);
}

function idfWeightedJaccard(selGenres: Set<string>, nbGenres: string[]): number {
  const nbSet = new Set(nbGenres);
  let sharedW = 0;
  let unionW = 0;
  const all = new Set([...selGenres, ...nbSet]);
  for (const g of all) {
    const w = genreIdf(g);
    if (selGenres.has(g) && nbSet.has(g)) sharedW += w;
    unionW += w;
  }
  return unionW > 0 ? sharedW / unionW : 0;
}

// ─── Genre Taxonomy: parent-child relationships for partial credit ──────────
const GENRE_PARENT: Record<string, string> = {
  'fps': 'shooter', 'first person': 'shooter', 'third-person shooter': 'shooter',
  'action rpg': 'rpg', 'crpg': 'rpg', 'jrpg': 'rpg', 'mmorpg': 'rpg',
  'roguelite': 'roguelike', 'rogue-lite': 'roguelike',
  'soulslike': 'action', 'souls-like': 'action',
  'hack and slash': 'action', 'beat em up': 'action',
  'stealth': 'action', 'action-adventure': 'action',
  'grand strategy': 'strategy', 'real-time strategy': 'strategy',
  'rts': 'strategy', 'turn-based': 'strategy', 'tactical': 'strategy',
  'tower defense': 'strategy', 'card game': 'strategy',
  'city builder': 'simulation', 'life sim': 'simulation',
  'farming': 'simulation', 'management': 'simulation',
  'battle royale': 'shooter',
  'metroidvania': 'platformer',
  'exploration': 'adventure', 'narration': 'adventure',
  'visual novel': 'adventure', 'point and click': 'adventure',
  'walking simulator': 'adventure',
  'party': 'casual', 'rhythm': 'casual',
};

function genreTaxonomyBonus(selGenres: Set<string>, nbGenres: string[]): number {
  const nbSet = new Set(nbGenres);
  let bonus = 0;
  for (const sg of selGenres) {
    if (nbSet.has(sg)) continue;
    const selParent = GENRE_PARENT[sg];
    for (const ng of nbGenres) {
      if (selGenres.has(ng)) continue;
      const nbParent = GENRE_PARENT[ng];
      if (selParent && selParent === ng) { bonus += 0.015; break; }
      if (nbParent && nbParent === sg) { bonus += 0.015; break; }
      if (selParent && nbParent && selParent === nbParent) { bonus += 0.01; break; }
    }
  }
  return bonus;
}

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

/**
 * Star magnitude — popularity (review count) drives base size; publisher
 * catalog breadth gives a secondary boost so big-publisher titles stand out.
 * Library games get a small bonus so the user's own collection never
 * disappears among the crowd.
 */
function starSize(nd: GraphNode, pubFreq: Map<string, number>, maxPubLog: number): number {
  // Review count → log-scaled 0–1 (caps around ~200K reviews)
  const popNorm = Math.min(Math.log10(Math.max(nd.reviewCount, 1)) / 5.3, 1);
  // Publisher catalog breadth → log-scaled 0–1
  const pf = nd.publisher ? (pubFreq.get(nd.publisher) ?? 1) : 1;
  const pubNorm = maxPubLog > 0 ? Math.log10(pf + 1) / maxPubLog : 0;
  // Blend: 70% popularity, 30% publisher weight
  const combined = popNorm * 0.7 + pubNorm * 0.3;
  const base = 1.2 + combined * 9;
  return nd.isLibrary ? Math.max(base, 4) + Math.min(nd.hoursPlayed * 0.03, 4) : base;
}

/** Cosine distance between two embedding vectors (1 − cos_sim), clamped to [0,2]. */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? Math.max(0, 1 - dot / denom) : 1;
}

/** Publisher frequency map built once when galaxy loads. */
function buildPublisherFreqs(nodes: GraphNode[]): { pubFreq: Map<string, number>; maxPubLog: number } {
  const pubFreq = new Map<string, number>();
  for (const nd of nodes) {
    if (nd.publisher) pubFreq.set(nd.publisher, (pubFreq.get(nd.publisher) ?? 0) + 1);
  }
  let maxFreq = 1;
  for (const v of pubFreq.values()) if (v > maxFreq) maxFreq = v;
  return { pubFreq, maxPubLog: Math.log10(maxFreq + 1) };
}

/** Compute the centroid position of each canonical genre cluster. */
function computeGenreCentroids(nodes: GraphNode[]): Map<number, THREE.Vector3> {
  const sums = new Map<number, { x: number; y: number; z: number; count: number }>();
  for (const nd of nodes) {
    const idx = nd.colorIdx;
    const s = sums.get(idx);
    if (s) { s.x += nd.x; s.y += nd.y; s.z += nd.z; s.count++; }
    else sums.set(idx, { x: nd.x, y: nd.y, z: nd.z, count: 1 });
  }
  const centroids = new Map<number, THREE.Vector3>();
  for (const [idx, s] of sums) {
    if (idx < CANONICAL_GENRE_LABELS.length) {
      centroids.set(idx, new THREE.Vector3(s.x / s.count, s.y / s.count, s.z / s.count));
    }
  }
  return centroids;
}

function createGenreLabelSprite(
  label: string,
  _color: [number, number, number],
  position: THREE.Vector3,
): THREE.Sprite {
  const dpr = 2;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  const fontSize = 20 * dpr;
  const iconSize = fontSize * 0.5;
  const iconGap = 6 * dpr;
  const padX = 14 * dpr;
  const padY = 6 * dpr;
  const borderW = 1 * dpr;

  ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
  const textW = ctx.measureText(label).width;
  const contentW = iconSize * 2 + iconGap + textW;
  const pillW = Math.ceil(contentW + padX * 2);
  const pillH = Math.ceil(fontSize + padY * 2);
  const margin = 4 * dpr;
  canvas.width = pillW + margin * 2;
  canvas.height = pillH + margin * 2;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const rr = pillH / 2;
  const left = cx - pillW / 2;
  const top = cy - pillH / 2;

  // bg-white/[0.04] over simulated dark backdrop-blur
  ctx.fillStyle = 'rgba(6, 6, 14, 0.55)';
  roundRect(ctx, left, top, pillW, pillH, rr);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
  roundRect(ctx, left, top, pillW, pillH, rr);
  ctx.fill();

  // border-white/[0.08]
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = borderW;
  roundRect(ctx, left + borderW / 2, top + borderW / 2, pillW - borderW, pillH - borderW, rr - borderW / 2);
  ctx.stroke();

  // genre dot — radial gradient circle matching the cluster color, with glow
  const r255 = Math.round(_color[0] * 255);
  const g255 = Math.round(_color[1] * 255);
  const b255 = Math.round(_color[2] * 255);
  const dotR = iconSize * 0.55;
  const iconCx = left + padX + iconSize;
  const glow = ctx.createRadialGradient(iconCx, cy, 0, iconCx, cy, dotR * 2.5);
  glow.addColorStop(0, `rgba(${r255}, ${g255}, ${b255}, 0.25)`);
  glow.addColorStop(1, `rgba(${r255}, ${g255}, ${b255}, 0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(iconCx, cy, dotR * 2.5, 0, Math.PI * 2);
  ctx.fill();
  const grad = ctx.createRadialGradient(iconCx - dotR * 0.3, cy - dotR * 0.3, 0, iconCx, cy, dotR);
  grad.addColorStop(0, `rgba(${Math.min(r255 + 80, 255)}, ${Math.min(g255 + 80, 255)}, ${Math.min(b255 + 80, 255)}, 0.95)`);
  grad.addColorStop(1, `rgba(${r255}, ${g255}, ${b255}, 0.7)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(iconCx, cy, dotR, 0, Math.PI * 2);
  ctx.fill();

  // label text — white/40, font-medium, tracking-wide
  ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.40)';
  ctx.fillText(label, iconCx + iconSize + iconGap, cy);

  const tex = new THREE.CanvasTexture(canvas);
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;

  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    sizeAttenuation: true,
  });

  const sprite = new THREE.Sprite(mat);
  sprite.position.copy(position);
  const scale = 28;
  sprite.scale.set(scale * (canvas.width / canvas.height), scale, 1);
  sprite.userData = { baseOpacity: 0.55, highlightOpacity: 1.0 };
  return sprite;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
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
  // Commit #1 — community-color, PageRank-glow, twinkle.
  // Phase 0 fallback: when graph isn't built, these are zeros and the shader degrades to the original.
  attribute vec3 aCommunityColor;
  attribute float aPRBoost;
  attribute float aTwinklePhase;
  // Commit #6 — signed PR delta (-1..1) for PageRank Aurora warm/cold tint
  attribute float aPRDelta;
  uniform float u_time;
  uniform float u_communityMix;
  uniform float u_prAuroraMix;
  uniform float u_galacticTimeOfDay;
  varying vec3 vColor;
  varying float vBrightness;

  void main() {
    // Mix the genre-derived color with the community-derived color.
    vec3 baseColor = mix(aColor, aCommunityColor, u_communityMix);

    // Commit #6 — PageRank Aurora. Warm (yellow→orange→red) where player outranks world; cold (violet→magenta) where world overrates.
    // Strength scales with |aPRDelta| so neutral nodes keep their community color intact.
    vec3 warm = mix(vec3(0.98, 0.85, 0.40), vec3(1.00, 0.45, 0.30), clamp(aPRDelta, 0.0, 1.0));
    vec3 cold = mix(vec3(0.55, 0.30, 0.85), vec3(0.90, 0.30, 0.80), clamp(-aPRDelta, 0.0, 1.0));
    vec3 auroraTint = aPRDelta >= 0.0 ? warm : cold;
    float auroraStrength = abs(aPRDelta) * u_prAuroraMix;
    baseColor = mix(baseColor, auroraTint, auroraStrength);
    // Phase 2 — Living Weather. Subtle slow tint over a galactic 30-min cycle.
    float dayPhase = 0.15 * sin(u_galacticTimeOfDay * 6.2831853);
    baseColor = mix(baseColor, baseColor * vec3(0.92, 0.88, 1.05), abs(dayPhase));
    vColor = baseColor;

    // Twinkle: per-node phase-offset shimmer.
    float twinkle = 0.85 + 0.15 * sin(u_time * 1.4 + aTwinklePhase * 6.2831853);

    // PageRank boosts brightness — central hubs feel like "weight" in the field.
    float prBoostMul = 1.0 + aPRBoost * 0.6;
    vBrightness = aBrightness * twinkle * prBoostMul;

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float prSizeMul = 1.0 + aPRBoost * 0.35;
    gl_PointSize = aSize * prSizeMul * (400.0 / -mv.z);
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

// ─── Named Stars (Commit #2 — Stellar Classification flavor) ──
// Top ~50 PageRank nodes get a low-poly icosahedron with per-instance color + slow pulse.
// One InstancedMesh = one draw call. Far simpler shader than the focused sun (no fbm).
// Class drives flavor copy in the selected-node card, NOT the 60K-point encoding.

export type StellarClass =
  | 'Quasar'           // top PR + high hub  — canonical entry point
  | 'Pulsar'           // top PR + low hub   — cult masterpiece
  | 'Hypergiant'       // top PR + high luminance — universally adored heavy
  | 'NeutronStar'      // high authority + small community — niche-cluster icon
  | 'MDwarf';          // everything else in the top 50

export const STELLAR_CLASS_LABELS: Record<StellarClass, string> = {
  Quasar: 'Q-class Quasar',
  Pulsar: 'P-IV Pulsar',
  Hypergiant: 'O-class Hypergiant',
  NeutronStar: 'N-II Neutron Star',
  MDwarf: 'M-IV Crimson Dwarf',
};

export const STELLAR_CLASS_BLURBS: Record<StellarClass, string> = {
  Quasar: 'Bright across every map. The canonical entry point.',
  Pulsar: 'Burns hot in its own corner of the field. A cult masterpiece.',
  Hypergiant: 'Massive, universally adored. The gravity well its genre orbits.',
  NeutronStar: 'Tight, dense, devoted following. A niche-cluster icon.',
  MDwarf: 'Steady warm light. Notable in this region of the cosmos.',
};

const STELLAR_CLASS_RGB: Record<StellarClass, [number, number, number]> = {
  Quasar:      [0.75, 0.85, 1.00],
  Pulsar:      [0.65, 0.40, 1.00],
  Hypergiant:  [1.00, 0.92, 0.65],
  NeutronStar: [0.55, 0.95, 1.00],
  MDwarf:      [1.00, 0.55, 0.45],
};

const NAMED_STAR_VERTEX = /* glsl */ `
  attribute vec3 aInstColor;
  attribute float aInstPhase;
  uniform float u_time;
  uniform float u_globalIntensity;
  varying vec3 vColor;
  varying float vRim;
  varying float vPulse;

  void main() {
    vColor = aInstColor;
    // Slow pulse per-instance so all 50 stars don't flash together
    vPulse = 0.85 + 0.15 * sin(u_time * 0.7 + aInstPhase * 6.2831853);
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vec3 vn = normalize(normalMatrix * mat3(instanceMatrix) * normal);
    vRim = 1.0 - abs(normalize(-mv.xyz).z * vn.z + normalize(-mv.xyz).x * vn.x + normalize(-mv.xyz).y * vn.y);
    gl_Position = projectionMatrix * mv;
  }
`;

const NAMED_STAR_FRAGMENT = /* glsl */ `
  uniform float u_globalIntensity;
  varying vec3 vColor;
  varying float vRim;
  varying float vPulse;

  void main() {
    // Soft edge glow + emissive core; no expensive noise
    float rimGlow = pow(clamp(vRim, 0.0, 1.0), 1.6);
    vec3 col = mix(vColor * 1.8, vColor + vec3(0.25), rimGlow);
    float a = clamp(0.65 + rimGlow * 0.4, 0.0, 1.0) * vPulse * u_globalIntensity;
    gl_FragColor = vec4(col * a, a);
  }
`;

/**
 * Classify a node's stellar type for flavor copy. Pure function — no side effects.
 * Inputs are pre-normalized (0..1 except community size which is raw count).
 */
export function stellarClassify(
  prNorm: number,
  authNorm: number,
  hubNorm: number,
  luminance: number,
  communitySize: number,
): StellarClass {
  // Pulsar/Quasar/Hypergiant only for the top PageRank tier (above 0.92 normalized)
  if (prNorm >= 0.92) {
    if (luminance >= 0.78) return 'Hypergiant';
    if (hubNorm >= 0.70) return 'Quasar';
    if (hubNorm <= 0.35) return 'Pulsar';
  }
  // Niche-cluster icons: high authority AND small community
  if (authNorm >= 0.75 && communitySize > 0 && communitySize < 80) return 'NeutronStar';
  return 'MDwarf';
}

// ─── Fault Lines (Commit #5) — top 1% edges by sampled Brandes betweenness ──
// Single merged LineSegments draw. Each segment carries its normalized betweenness
// (0..1) as a per-vertex attribute; the vertex shader pulses brightness over u_time.
// Endpoint colors come from each end's community palette so fissures fade between
// territories naturally.

const FISSURE_VERTEX = /* glsl */ `
  attribute float aBetweenness;
  attribute vec3 aFissureColor;
  uniform float u_time;
  uniform float u_globalIntensity;
  varying vec3 vColor;
  varying float vBeat;

  void main() {
    vColor = aFissureColor;
    // Per-edge pulse — betweenness phase-offsets the wave so high-load edges flicker faster.
    float pulse = 0.55 + 0.45 * sin(u_time * 1.8 + aBetweenness * 3.14159);
    vBeat = pulse * u_globalIntensity * (0.45 + aBetweenness * 0.55);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FISSURE_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vBeat;

  void main() {
    if (vBeat < 0.02) discard;
    // Mix toward white at peak intensity — hot core, colored tail
    vec3 col = mix(vColor, vec3(1.0), clamp(vBeat * 0.55, 0.0, 0.6));
    gl_FragColor = vec4(col * vBeat, vBeat);
  }
`;

const FAULT_LINE_TOP_PERCENT = 0.01;
const FAULT_LINE_MAX_COUNT = 6000;

/** Quickselect threshold — returns kth largest in-place without full sort. */
function quickselectThreshold(values: Float32Array, kFromTop: number): number {
  if (values.length === 0 || kFromTop <= 0) return Infinity;
  if (kFromTop >= values.length) return -Infinity;
  // Copy and partial-sort to find the (k-1)th largest. For 600K elements this is ~O(n) average.
  const arr = Array.from(values);
  const k = arr.length - kFromTop; // kth smallest
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const pivot = arr[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (arr[i] < pivot) i++;
      while (arr[j] > pivot) j--;
      if (i <= j) {
        const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        i++; j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return arr[k];
}

// ─── Frontier Aurora — soft cold blobs marking unexplored Personalized-PageRank space ──
// One Points layer, additive blending, large soft sprites. Where many unexplored nodes
// cluster, the overlapping blobs read as cyan-violet "aurora ribbons" without a real
// volumetric solve. Drifts subtly with u_time so the field never reads dead.

const FRONTIER_VERTEX = /* glsl */ `
  attribute float aIntensity;          // 0..1 — frontier-ness (1 - PPR, weighted by mlRecRate)
  attribute float aPhase;              // per-node phase, hash-seeded
  uniform float u_time;
  uniform float u_globalIntensity;     // 0..1 ramp once graph is built
  varying float vIntensity;
  varying float vHue;

  void main() {
    // Slow per-node breath so the aurora pulses like a real sky.
    float breath = 0.82 + 0.18 * sin(u_time * 0.35 + aPhase * 6.2831853);
    vIntensity = aIntensity * u_globalIntensity * breath;

    // Hue drifts cyan → violet → magenta along intensity gradient.
    // Phase tweaks it per-node so adjacent blobs don't all match exactly.
    vHue = clamp(aIntensity + 0.08 * sin(aPhase * 19.0 + u_time * 0.2), 0.0, 1.0);

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Huge soft sprites — radius scales with intensity so frontier regions truly bloom.
    float size = 70.0 + aIntensity * 180.0;
    gl_PointSize = size * (400.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRONTIER_FRAGMENT = /* glsl */ `
  varying float vIntensity;
  varying float vHue;

  void main() {
    if (vIntensity < 0.02) discard;
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;

    // Long, soft falloff so blobs blend into ribbons when overlapping.
    float falloff = exp(-9.0 * d * d);

    // Cyan (low intensity, deepest frontier) → violet → magenta (highest intensity, stretch picks).
    vec3 cyan    = vec3(0.18, 0.55, 0.92);
    vec3 violet  = vec3(0.45, 0.30, 0.90);
    vec3 magenta = vec3(0.90, 0.30, 0.75);
    vec3 col = mix(cyan, violet, smoothstep(0.0, 0.55, vHue));
    col = mix(col, magenta, smoothstep(0.55, 1.0, vHue));

    float a = falloff * vIntensity * 0.42;
    gl_FragColor = vec4(col * a, a);
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

// ─── Monument scaffolding (Commit #4) ──
// Completed games will eventually crystallize into permanent architectural forms by genre.
// This commit ships ONLY the empty InstancedMesh batches + the contract — no visible geometry.
// Five archetypes; capacity 1000 each. count=0 → fully invisible until Phase 2 wires the spawner.

export type GenreArchetype = 'obelisk' | 'ring' | 'crystal' | 'spire' | 'disc';

const ARCHETYPE_LOOKUP: Record<string, GenreArchetype> = {
  // Obelisks for RPGs and narrative-heavy genres
  'rpg': 'obelisk', 'crpg': 'obelisk', 'role-playing': 'obelisk', 'role playing': 'obelisk',
  // Rings for cyclical / loop-based experiences
  'roguelike': 'ring', 'roguelite': 'ring', 'rogue-like': 'ring', 'rogue-lite': 'ring',
  // Crystals for narrative + atmospheric / introspective games
  'visual novel': 'crystal', 'narration': 'crystal', 'walking simulator': 'crystal', 'adventure': 'crystal', 'point and click': 'crystal',
  // Spires for vertical strategy / management
  'strategy': 'spire', 'rts': 'spire', 'real-time strategy': 'spire', 'turn-based': 'spire', 'grand strategy': 'spire', 'tower defense': 'spire', 'city builder': 'spire',
  // Discs for action / racing / fighting
  'action': 'disc', 'action-adventure': 'disc', 'shooter': 'disc', 'fps': 'disc',
  'fighting': 'disc', 'racing': 'disc', 'platformer': 'disc', 'sports': 'disc',
};

export function mapGenreToArchetype(genres: string[]): GenreArchetype {
  for (const g of genres) {
    const arch = ARCHETYPE_LOOKUP[g.toLowerCase()];
    if (arch) return arch;
  }
  return 'crystal'; // safe fallback — visually neutral
}

const MONUMENT_CAPACITY_PER_BATCH = 1000;

interface MonumentBatch {
  archetype: GenreArchetype;
  mesh: THREE.InstancedMesh;
  geo: THREE.BufferGeometry;
  mat: THREE.MeshStandardMaterial;
  /** Next free instance index. Incremented when a game completes. */
  cursor: number;
}

/**
 * Build the empty InstancedMesh batches that future monuments will populate.
 * Standard PBR material (NOT additive) so monuments don't blow out in clusters.
 * Geometry choices are intentionally simple — final aesthetic comes in Phase 2.
 */
function createMonumentBatches(): Map<GenreArchetype, MonumentBatch> {
  const batches = new Map<GenreArchetype, MonumentBatch>();
  // Per-archetype color + emissive intensity. Subtle, self-illuminating; AmbientLight gives
  // them just enough ambient lift so they're readable without DirectionalLight (which would
  // flatten the additive starfield aesthetic).
  const specs: Array<{
    archetype: GenreArchetype;
    geo: () => THREE.BufferGeometry;
    color: number;
    emissive: number;
    emissiveIntensity: number;
  }> = [
    { archetype: 'obelisk', geo: () => new THREE.ConeGeometry(0.6, 4, 4),                color: 0xb38cff, emissive: 0x6e3cff, emissiveIntensity: 0.20 },
    { archetype: 'ring',    geo: () => new THREE.TorusGeometry(1.4, 0.3, 8, 24),         color: 0x6cd9ff, emissive: 0x18b3d9, emissiveIntensity: 0.20 },
    { archetype: 'crystal', geo: () => new THREE.OctahedronGeometry(1.0, 0),             color: 0xff8fd8, emissive: 0xc83cc8, emissiveIntensity: 0.25 },
    { archetype: 'spire',   geo: () => new THREE.CylinderGeometry(0.2, 0.6, 3.5, 6),     color: 0xffd870, emissive: 0xd49a30, emissiveIntensity: 0.18 },
    { archetype: 'disc',    geo: () => new THREE.CylinderGeometry(1.4, 1.4, 0.2, 24),    color: 0xff7060, emissive: 0xc83c2c, emissiveIntensity: 0.22 },
  ];
  for (const spec of specs) {
    const geo = spec.geo();
    const mat = new THREE.MeshStandardMaterial({
      color: spec.color,
      emissive: spec.emissive,
      emissiveIntensity: spec.emissiveIntensity,
      metalness: 0.25,
      roughness: 0.55,
      transparent: false,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, MONUMENT_CAPACITY_PER_BATCH);
    mesh.count = 0;
    mesh.instanceMatrix.usage = THREE.DynamicDrawUsage;
    mesh.renderOrder = 100;
    batches.set(spec.archetype, { archetype: spec.archetype, mesh, geo, mat, cursor: 0 });
  }
  return batches;
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
    <div className="absolute inset-0 flex items-center justify-center">
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

const HeroIntro: FC<{ visible: boolean; onTypingDone?: () => void }> = ({ visible, onTypingDone }) => {
  const textRef = useRef<HTMLSpanElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    if (!visible) { doneRef.current = false; return; }
    const el = textRef.current;
    if (!el) return;
    el.textContent = '';
    doneRef.current = false;
    let i = 0;
    let lastTime = 0;
    let raf = 0;
    const CHAR_MS = 45;
    const tick = (time: number) => {
      if (!lastTime) lastTime = time;
      if (time - lastTime >= CHAR_MS) {
        i++;
        lastTime = time;
        el.textContent = HERO_TEXT.slice(0, i);
        if (i >= HERO_TEXT.length) {
          if (!doneRef.current) { doneRef.current = true; onTypingDone?.(); }
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible, onTypingDone]);

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
            <span ref={textRef} />
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
  frontierMat: THREE.ShaderMaterial;
  namedStarMat: THREE.ShaderMaterial;
}

function createRendererBundle(w: number, h: number): RendererBundle {
  const pixelRatio = Math.min(window.devicePixelRatio, 1.5);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
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
      uniforms: {
        u_time: { value: 0 },
        // 0 = pure genre palette, 1 = pure Louvain community palette. We ramp up
        // to 0.85 when the graph is ready so genre still bleeds through faintly.
        u_communityMix: { value: 0 },
        // Commit #6 — 0 = no PR Aurora; 1 = full warm/cold tint from PR delta
        u_prAuroraMix: { value: 0 },
        // Phase 2 — Living Weather day/night cycle (0..1, ~30min period)
        u_galacticTimeOfDay: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

  const frontierMat = new THREE.ShaderMaterial({
    vertexShader: FRONTIER_VERTEX,
    fragmentShader: FRONTIER_FRAGMENT,
    uniforms: {
      u_time: { value: 0 },
      // Stays 0 until gameGraphStore reports >=60% coverage. Prevents an uncolored
      // first-paint flash before PPR scores arrive.
      u_globalIntensity: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });

  const namedStarMat = new THREE.ShaderMaterial({
    vertexShader: NAMED_STAR_VERTEX,
    fragmentShader: NAMED_STAR_FRAGMENT,
    uniforms: {
      u_time: { value: 0 },
      // Ramps to 1 once graph + classification land. Keeps the layer invisible by default.
      u_globalIntensity: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  return { renderer, backend, nodeMat: createMat(), starMat: createMat(), frontierMat, namedStarMat };
}

const NAMED_STAR_CAPACITY = 50;
const NAMED_STAR_RADIUS = 2.4;

/** Golden-angle HSL → RGB for Louvain community ids. Gives maximally distinct hues even at 100+ communities. */
function communityHueToRGB(communityId: number, out: Float32Array, offset: number): void {
  if (communityId < 0) {
    out[offset] = 0.6; out[offset + 1] = 0.6; out[offset + 2] = 0.62;
    return;
  }
  // 137.5° golden angle for maximally-different adjacent hues
  const h = ((communityId * 137.508) % 360) / 360;
  const s = 0.62;
  const l = 0.58;
  // HSL → RGB
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 1/6) { r = c; g = x; }
  else if (h < 2/6) { r = x; g = c; }
  else if (h < 3/6) { g = c; b = x; }
  else if (h < 4/6) { g = x; b = c; }
  else if (h < 5/6) { r = x; b = c; }
  else { r = c; b = x; }
  out[offset] = r + m;
  out[offset + 1] = g + m;
  out[offset + 2] = b + m;
}

// ─── Main component ─────────────────────────────────────────────────────────

export function AnnGraphView({ onBack, useMock = false }: { onBack: () => void; useMock?: boolean }) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const screenshotAreaRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    points: THREE.Points;
    starField: THREE.Points;
    frontierPoints: THREE.Points;
    namedStarsMesh: THREE.InstancedMesh;
    namedStarMeta: Array<{ gameId: string; stellarClass: StellarClass } | null>;
    /** gameId → stellar class for fast lookup from the UI side panel. */
    stellarClassByGameId: Map<string, StellarClass>;
    /** Empty monument batches scaffolded in Commit #4. Visible geometry lands in Phase 2. */
    monumentBatches: Map<GenreArchetype, MonumentBatch>;
    /** Fault Lines (Commit #5) — null when betweenness not yet computed. */
    faultLines: THREE.LineSegments | null;
    faultLinesMat: THREE.ShaderMaterial | null;
    /** Eccentricity arrow (Commit #6) — null when no PR delta. */
    eccentricityArrow: THREE.ArrowHelper | null;
    /** Constellation labels at Louvain community centroids (Commit #7). */
    constellationLabels: THREE.Group | null;
    /** Banner InstancedMeshes by color (Phase 2). */
    bannerMeshes: Map<BannerColor, THREE.InstancedMesh>;
    /** User-authored constellation line segments (Phase 2). */
    constellationLines: THREE.LineSegments;
    constellationLineMat: THREE.LineBasicMaterial;
    lines: THREE.LineSegments | null;
    linesMat: THREE.LineDashedMaterial | null;
    focusedLines: THREE.LineSegments | null;
    focusedLinesMat: THREE.LineDashedMaterial | null;
    focusedLinesOpacity: number;
    pathLines: THREE.LineSegments | null;
    pathLinesMat: THREE.LineDashedMaterial | null;
    pathLabels: THREE.Group | null;
    genreLabels: THREE.Group | null;
    raycaster: THREE.Raycaster;
    mouse: THREE.Vector2;
    nodes: GraphNode[];
    colorAttr: THREE.BufferAttribute;
    sizeAttr: THREE.BufferAttribute;
    brightnessAttr: THREE.BufferAttribute;
    baseSizes: Float32Array;
    baseBright: Float32Array;
    baseColors: Float32Array;
    nodeMap: Map<string, GraphNode>;
    animFrameId: number;
    composer: EffectComposer;
    sunSelected: ReturnType<typeof createSunGroup>;
    sunFocused: ReturnType<typeof createSunGroup>;
  } | null>(null);

  const [loading, setLoading] = useState(true);
  const [emptyGalaxy, setEmptyGalaxy] = useState(false);
  const [heroVisible, setHeroVisible] = useState(false);
  const [loadingSteps, setLoadingSteps] = useState<LoadingStep[]>(
    GALAXY_STEP_LABELS.map(label => ({ label, status: 'pending' as const })),
  );
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [neighbors, setNeighbors] = useState<NeighborInfo[]>([]);
  // Phase 2 — Cartographer HUD + Probe + Stargazer + Banners + Whisper
  const [streamedLine, setStreamedLine] = useState('');
  const [scannerMode, setScannerMode] = useState<ScannerMode>('observer');
  const [stargazerPath, setStargazerPath] = useState<string[]>([]);
  const [stargazerNamePrompt, setStargazerNamePrompt] = useState(false);
  const [stargazerNameInput, setStargazerNameInput] = useState('');
  const [bannerMenu, setBannerMenu] = useState<{ x: number; y: number; gameId: string } | null>(null);
  const [whisperState, setWhisperState] = useState<{ gameId: string; phrase: string; x: number; y: number; key: number } | null>(null);
  const [codexOpen, setCodexOpen] = useState(false);
  const [codexUnlockedCount, setCodexUnlockedCount] = useState(0);
  // Phase 3.0 — Lasso
  const [lassoActive, setLassoActive] = useState(false);
  const [lassoPath, setLassoPath] = useState<LassoPoint[]>([]);
  const [lassoCapture, setLassoCapture] = useState<{ nodeIds: string[]; genres: { name: string; count: number }[] } | null>(null);
  const [lassoNamePrompt, setLassoNamePrompt] = useState(false);
  const [lassoNameInput, setLassoNameInput] = useState('');
  const lassoDrawingRef = useRef(false);
  // Phase 3.0 — Timeshear
  const [timeshearActive, setTimeshearActive] = useState(false);
  const [timeshearWeek, setTimeshearWeek] = useState(TIMESHEAR_WEEKS - 1);
  const timeshearMatrixRef = useRef<Uint8Array | null>(null);
  const timeshearRafRef = useRef<number>(0);
  // Phase 3.0 — Year Wrapped Flythrough
  const [flythroughActive, setFlythroughActive] = useState(false);
  const [flythroughLowerThird, setFlythroughLowerThird] = useState<{ title: string; subtitle: string; index: number } | null>(null);
  const flythroughStateRef = useRef<{
    curve: THREE.CatmullRomCurve3;
    targets: Array<{ pos: THREE.Vector3; gameId: string; title: string; subtitle: string }>;
    startMs: number;
    durationMs: number;
    bloomWasEnabled: boolean;
    abort: { aborted: boolean };
  } | null>(null);
  const [userMarksVersion, setUserMarksVersion] = useState(0);
  const charStreamAbortRef = useRef<{ aborted: boolean } | null>(null);
  const probeActiveRef = useRef(false);
  const probeVelocityRef = useRef<{ x: number; y: number; z: number }>({ x: 0, y: 0, z: 0 });
  const whisperSeenRef = useRef<Set<string>>(new Set());
  const whisperDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const componentMountedRef = useRef(true);
  const stargazerActiveRef = useRef(false);
  const keysDownRef = useRef<Set<string>>(new Set());
  const probeSvgRef = useRef<SVGSVGElement>(null);
  const hoveredNodeRef2 = useRef<GraphNode | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [activeGenres, setActiveGenres] = useState<Set<string>>(new Set());
  const activeGenresRef = useRef<Set<string>>(activeGenres);
  const [allGenres, setAllGenres] = useState<string[]>([]);
  const allGenresRef = useRef<string[]>(allGenres);
  const [showFilters, setShowFilters] = useState(false);
  const [nodeCount, setNodeCount] = useState(0);
  const [connectionCount, setConnectionCount] = useState(0);
  const [rendererBackend, setRendererBackend] = useState<RendererBackend | null>(null);
  const [projectionMethod, setProjectionMethod] = useState<string | null>(null);
  const neighborK = useRef(GENRE_PALETTE.length - 1);
  const selectedIdRef = useRef<string | null>(null);
  const neighborIdsRef = useRef<Set<string>>(new Set());
  const focusedNbIdsRef = useRef<Set<string>>(new Set());
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
  const [pathDisabledReason, setPathDisabledReason] = useState<string | null>(null);
  const pathIdsRef = useRef<Set<string>>(new Set());
  const pathNodesRef = useRef<GraphNode[]>([]);
  const [pathIdx, setPathIdx] = useState(-1);
  const pathOverviewCardsRef = useRef<HTMLDivElement>(null);
  const pathBuildGenRef = useRef(0);
  const libScrollRef = useRef<HTMLDivElement>(null);
  const fpsRef = useRef<HTMLSpanElement>(null);
  const autoOrbitRef = useRef(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailData, setDetailData] = useState<NodeDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailNodeIdRef = useRef<string | null>(null);
  const pubFreqRef = useRef<{ pubFreq: Map<string, number>; maxPubLog: number }>({ pubFreq: new Map(), maxPubLog: 0 });
  const hoverRafRef = useRef<number>(0);
  const cleanupIdleRef = useRef<(() => void) | null>(null);
  const cachedRectRef = useRef<DOMRect | null>(null);
  const searchBlurRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heroTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [libVersion, setLibVersion] = useState(0);
  const traversalStackRef = useRef<GraphNode[]>([]);
  const [traversalDepth, setTraversalDepth] = useState(0);
  const neighborRerankEnabledRef = useRef(true);
  const [neighborRerankHint, setNeighborRerankHint] = useState<{ label: string; title: string } | null>(null);

  useEffect(() => {
    return libraryStore.subscribe(() => setLibVersion(v => v + 1));
  }, []);

  // Commit #4 — track completion count. No render yet; this is the contract handshake
  // that future monument-spawning code (Phase 2) will read from.
  useEffect(() => {
    const logCompletions = () => {
      const completed = libraryStore.filterByStatus('Completed');
      console.log(`[Monuments] Completed games tracked: ${completed.length}`);
    };
    logCompletions();
    return libraryStore.subscribe(logCompletions);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.settings?.getOllamaSettings) return;
    void window.settings.getOllamaSettings().then((s) => {
      neighborRerankEnabledRef.current = s.neighborRerankEnabled !== false;
    }).catch(() => {});
  }, []);

  // ─── Phase 2 — Witness layer setup ───
  useEffect(() => {
    componentMountedRef.current = true;
    narratorBus.init();
    void userMarksStore.init();
    const unsubMarks = userMarksStore.subscribe(() => setUserMarksVersion((v) => v + 1));
    // Phase 2.1 — load codex unlock count from localStorage
    try {
      const raw = localStorage.getItem('ark.codex.unlocked.v1');
      if (raw) {
        const set = new Set(JSON.parse(raw) as string[]);
        setCodexUnlockedCount(set.size);
      }
    } catch { /* swallow */ }
    return () => {
      componentMountedRef.current = false;
      narratorBus.dispose();
      unsubMarks();
      scannerSelectionStore.cancelAll();
      if (whisperDismissRef.current) {
        clearTimeout(whisperDismissRef.current);
        whisperDismissRef.current = null;
      }
      if (timeshearRafRef.current) {
        cancelAnimationFrame(timeshearRafRef.current);
        timeshearRafRef.current = 0;
      }
      timeshearMatrixRef.current = null;
    };
  }, []);

  // Phase 2.1 — Codex unlock tracker. On selectedNode change, mark that game's codex as unlocked.
  useEffect(() => {
    if (!selectedNode) return;
    try {
      const raw = localStorage.getItem('ark.codex.unlocked.v1');
      const set = new Set<string>(raw ? JSON.parse(raw) as string[] : []);
      if (!set.has(selectedNode.id)) {
        set.add(selectedNode.id);
        localStorage.setItem('ark.codex.unlocked.v1', JSON.stringify(Array.from(set)));
        setCodexUnlockedCount(set.size);
      }
    } catch { /* swallow */ }
  }, [selectedNode?.id]);

  // Phase 3.0 — Year Wrapped Flythrough: builds a CatmullRom camera curve through
  // the supplied keyframe gameIds and animates over 60s. Disables OrbitControls + Bloom.
  const launchFlythrough = useCallback((keyframes: Array<{ gameId: string; title: string; subtitle: string }>) => {
    const sRef = sceneRef.current;
    if (!sRef || keyframes.length < 2) return;
    const targets = keyframes
      .map((k) => {
        const node = sRef.nodeMap.get(k.gameId);
        if (!node) return null;
        return { pos: new THREE.Vector3(node.x, node.y, node.z), gameId: k.gameId, title: k.title, subtitle: k.subtitle };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (targets.length < 2) return;

    // Build a smooth curve through all keyframe positions. Push each control point
    // slightly outward from origin so the camera flies AROUND rather than INTO stars.
    const controlPoints = targets.map((t) => {
      const len = t.pos.length() || 1;
      const out = (len + 35) / len;
      return new THREE.Vector3(t.pos.x * out, t.pos.y * out + 12, t.pos.z * out);
    });
    const curve = new THREE.CatmullRomCurve3(controlPoints, false, 'catmullrom', 0.35);

    // Toggle bloom OFF for perf headroom during flythrough
    let bloomWasEnabled = true;
    for (const pass of sRef.composer.passes) {
      const anyPass = pass as { enabled?: boolean; name?: string };
      if (anyPass.name === 'UnrealBloomPass') {
        bloomWasEnabled = anyPass.enabled !== false;
        anyPass.enabled = false;
      }
    }

    sRef.controls.enabled = false;
    setScannerMode('observer');
    setFlythroughActive(true);
    flythroughStateRef.current = {
      curve,
      targets,
      startMs: performance.now(),
      durationMs: 60_000,
      bloomWasEnabled,
      abort: { aborted: false },
    };
  }, []);

  // Phase 3.0 — Timeshear: build timeline matrix on entry; update brightness on scrub.
  const applyTimeshearWeek = useCallback((week: number) => {
    const sRef = sceneRef.current;
    if (!sRef) return;
    const matrix = timeshearMatrixRef.current;
    if (!matrix) return;
    const w = Math.max(0, Math.min(TIMESHEAR_WEEKS - 1, Math.floor(week)));
    const brightArr = sRef.brightnessAttr.array as Float32Array;
    const colorArr = sRef.colorAttr.array as Float32Array;
    const baseBright = sRef.baseBright;
    const baseColors = sRef.baseColors;
    // Per-state multipliers: 0=ghost, 1=normal, 2=completion tint
    for (let i = 0; i < sRef.nodes.length; i++) {
      const state = matrix[i * TIMESHEAR_WEEKS + w];
      if (state === 0) {
        brightArr[i] = baseBright[i] * 0.06;
        // Keep color but desaturated — leaves base palette intact for reset
        colorArr[i * 3] = baseColors[i * 3] * 0.45;
        colorArr[i * 3 + 1] = baseColors[i * 3 + 1] * 0.45;
        colorArr[i * 3 + 2] = baseColors[i * 3 + 2] * 0.55;
      } else if (state === 2) {
        // Completed — warm gold tint, slight brightness boost
        brightArr[i] = Math.min(1, baseBright[i] * 1.3);
        colorArr[i * 3] = Math.min(1, baseColors[i * 3] * 0.6 + 1.0 * 0.4);
        colorArr[i * 3 + 1] = Math.min(1, baseColors[i * 3 + 1] * 0.6 + 0.78 * 0.4);
        colorArr[i * 3 + 2] = Math.min(1, baseColors[i * 3 + 2] * 0.6 + 0.30 * 0.4);
      } else {
        // Owned, not completed — original brightness + color
        brightArr[i] = baseBright[i];
        colorArr[i * 3] = baseColors[i * 3];
        colorArr[i * 3 + 1] = baseColors[i * 3 + 1];
        colorArr[i * 3 + 2] = baseColors[i * 3 + 2];
      }
    }
    sRef.brightnessAttr.needsUpdate = true;
    sRef.colorAttr.needsUpdate = true;
  }, []);

  const enterTimeshear = useCallback(() => {
    const sRef = sceneRef.current;
    if (!sRef) return;
    const nodeIds = sRef.nodes.map((n) => n.id);
    timeshearMatrixRef.current = buildTimelineMatrix(nodeIds);
    setTimeshearActive(true);
    setTimeshearWeek(TIMESHEAR_WEEKS - 1);
    applyTimeshearWeek(TIMESHEAR_WEEKS - 1);
  }, [applyTimeshearWeek]);

  const exitTimeshear = useCallback(() => {
    const sRef = sceneRef.current;
    if (!sRef) return;
    // Restore base brightness + colors
    sRef.brightnessAttr.array.set(sRef.baseBright);
    sRef.colorAttr.array.set(sRef.baseColors);
    sRef.brightnessAttr.needsUpdate = true;
    sRef.colorAttr.needsUpdate = true;
    timeshearMatrixRef.current = null;
    setTimeshearActive(false);
  }, []);

  const exitFlythrough = useCallback(() => {
    const sRef = sceneRef.current;
    const state = flythroughStateRef.current;
    if (state) state.abort.aborted = true;
    flythroughStateRef.current = null;
    setFlythroughActive(false);
    setFlythroughLowerThird(null);
    if (sRef) {
      sRef.controls.enabled = true;
      if (state?.bloomWasEnabled) {
        for (const pass of sRef.composer.passes) {
          const anyPass = pass as { enabled?: boolean; name?: string };
          if (anyPass.name === 'UnrealBloomPass') anyPass.enabled = true;
        }
      }
    }
  }, []);

  // Phase 3.0 — Check for one-shot flythrough trigger written by Year Wrapped finale.
  useEffect(() => {
    if (!sceneRef.current || loading) return;
    try {
      const raw = localStorage.getItem('ark.flythrough.pending');
      if (!raw) return;
      const payload = JSON.parse(raw) as { keyframes?: Array<{ gameId: string; title: string; subtitle: string }> };
      localStorage.removeItem('ark.flythrough.pending');
      if (payload.keyframes && payload.keyframes.length >= 2) {
        // Small delay so the scene is fully painted before the camera flies
        setTimeout(() => launchFlythrough(payload.keyframes!), 600);
      }
    } catch { /* swallow */ }
  }, [loading, launchFlythrough]);

  // Phase 3.0 — Escape exits flythrough
  useEffect(() => {
    if (!flythroughActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitFlythrough();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flythroughActive, exitFlythrough]);

  // ─── Phase 2 — Rebuild banner InstancedMeshes when userMarksStore mutates ───
  useEffect(() => {
    const sRef = sceneRef.current;
    if (!sRef) return;
    const banners = userMarksStore.banners;
    const byColor = new Map<BannerColor, Array<{ gameId: string; node: GraphNode; plantedAt: string }>>();
    for (const b of banners.values()) {
      const node = sRef.nodeMap.get(b.gameId);
      if (!node) continue;
      if (!byColor.has(b.color)) byColor.set(b.color, []);
      byColor.get(b.color)!.push({ gameId: b.gameId, node, plantedAt: b.plantedAt });
    }
    const dummy = new THREE.Object3D();
    const now = Date.now();
    for (const [color, mesh] of sRef.bannerMeshes) {
      const list = byColor.get(color) ?? [];
      let n = 0;
      let oldestAgeDays = 0;
      for (const { node, plantedAt } of list) {
        if (n >= 1000) break;
        const ageDays = (now - new Date(plantedAt).getTime()) / 86_400_000;
        if (ageDays > oldestAgeDays) oldestAgeDays = ageDays;
        // Position slightly above the node along its normalized radial direction
        const len = Math.sqrt(node.x * node.x + node.y * node.y + node.z * node.z) || 1;
        const offset = 6 / len;
        dummy.position.set(
          node.x + node.x * offset * 0.04 + 0,
          node.y + node.y * offset * 0.04 + 6,
          node.z + node.z * offset * 0.04 + 0,
        );
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
        n++;
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;

      // Phase 2.1 — Bone banner decay. Other colors are permanent; bone tatters as the
      // oldest bone banner ages. Global per-color dim (not per-instance — Phase 3 polish).
      if (color === 'bone') {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        // Decay over 365 days. Floor at 0.18 so they never fully vanish.
        const decay = Math.max(0.18, 1 - Math.min(1, oldestAgeDays / 365) * 0.82);
        mat.emissiveIntensity = 0.25 * decay;
        mat.opacity = decay;
        mat.transparent = decay < 1;
        mat.needsUpdate = true;
      }
    }
  }, [userMarksVersion]);

  // ─── Phase 2 — Rebuild constellation LineSegments when userMarksStore mutates ───
  useEffect(() => {
    const sRef = sceneRef.current;
    if (!sRef) return;
    const constellations = userMarksStore.constellations;
    // Flatten all constellations into a single segment list: for each path of N nodes,
    // emit N-1 segments (each segment = 2 vertices). Plus the in-flight stargazer path.
    const allPaths: string[][] = [];
    for (const c of constellations.values()) allPaths.push(c.nodeIds);
    if (stargazerPath.length >= 2) allPaths.push(stargazerPath);

    let segmentCount = 0;
    for (const path of allPaths) segmentCount += Math.max(0, path.length - 1);

    const positions = new Float32Array(segmentCount * 2 * 3);
    let cursor = 0;
    for (const path of allPaths) {
      for (let i = 0; i < path.length - 1; i++) {
        const a = sRef.nodeMap.get(path[i]);
        const b = sRef.nodeMap.get(path[i + 1]);
        if (!a || !b) continue;
        positions[cursor++] = a.x; positions[cursor++] = a.y; positions[cursor++] = a.z;
        positions[cursor++] = b.x; positions[cursor++] = b.y; positions[cursor++] = b.z;
      }
    }
    sRef.constellationLines.geometry.dispose();
    const newGeo = new THREE.BufferGeometry();
    newGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions.subarray(0, cursor), 3));
    sRef.constellationLines.geometry = newGeo;
  }, [userMarksVersion, stargazerPath]);

  // ─── Phase 2 — Cartographer HUD char-stream on selectedNode change ───
  useEffect(() => {
    if (!selectedNode || scannerMode === 'stargazer') {
      setStreamedLine('');
      return;
    }
    const constellationName = sceneRef.current?.constellationLabels?.children?.find(
      (c) => c.userData.communityId === gameGraphStore.getScores(selectedNode.id)?.community,
    )?.userData.name as string | undefined;
    const stellarClass = sceneRef.current?.stellarClassByGameId.get(selectedNode.id);
    const line = narratorBus.getCartographerLine(selectedNode.id, constellationName, stellarClass);
    setStreamedLine('');
    const abort = { aborted: false };
    charStreamAbortRef.current = abort;
    let i = 0;
    const intervalId = setInterval(() => {
      if (abort.aborted) { clearInterval(intervalId); return; }
      i++;
      setStreamedLine(line.slice(0, i));
      if (i >= line.length) clearInterval(intervalId);
    }, 25);
    return () => {
      abort.aborted = true;
      clearInterval(intervalId);
    };
  }, [selectedNode?.id, scannerMode]);

  // ─── Phase 2 — Keyboard mode toggles (P = Probe, S = Stargazer, L = Lasso, Esc = Observer) ───
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        setScannerMode((m) => m === 'probe' ? 'observer' : 'probe');
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        setScannerMode((m) => m === 'stargazer' ? 'observer' : 'stargazer');
      } else if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        setLassoActive((v) => {
          const next = !v;
          if (next) {
            // Entering lasso — disable orbit + clear prior capture
            setLassoPath([]);
            setLassoCapture(null);
            const sRef = sceneRef.current;
            if (sRef) sRef.controls.enabled = false;
          } else {
            const sRef = sceneRef.current;
            if (sRef) sRef.controls.enabled = true;
          }
          return next;
        });
      } else if (e.key === 'Escape') {
        if (stargazerActiveRef.current && stargazerNamePrompt) return; // let the prompt dismiss naturally
        if (lassoNamePrompt) return;
        if (lassoActive) {
          setLassoActive(false);
          setLassoPath([]);
          setLassoCapture(null);
          const sRef = sceneRef.current;
          if (sRef) sRef.controls.enabled = true;
          return;
        }
        setScannerMode('observer');
        setStargazerPath([]);
        setStargazerNamePrompt(false);
      } else if (e.key === 'Enter' && stargazerActiveRef.current && stargazerPath.length >= 2) {
        e.preventDefault();
        setStargazerNamePrompt(true);
      }
      keysDownRef.current.add(e.key.toLowerCase());
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keysDownRef.current.delete(e.key.toLowerCase());
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [stargazerNamePrompt, stargazerPath.length, lassoActive, lassoNamePrompt]);

  // Phase 3.0 — Lasso close handler. Projects all nodes once, runs P-in-P, captures.
  const closeLasso = useCallback((rawPath: LassoPoint[]) => {
    const sRef = sceneRef.current;
    if (!sRef || rawPath.length < 5) { setLassoPath([]); return; }
    const path = simplifyPath(rawPath, 3);
    setLassoPath(path);
    // Project 60K nodes to screen coords in one pass
    const rect = sRef.renderer.domElement.getBoundingClientRect();
    const projVec = new THREE.Vector3();
    const projected: Array<{ x: number; y: number; behindCamera: boolean }> = [];
    for (const node of sRef.nodes) {
      projVec.set(node.x, node.y, node.z).project(sRef.camera);
      const sx = (projVec.x * 0.5 + 0.5) * rect.width + rect.left;
      const sy = (-projVec.y * 0.5 + 0.5) * rect.height + rect.top;
      projected.push({ x: sx, y: sy, behindCamera: projVec.z > 1 });
    }
    const inside = findNodesInsidePolygon(projected, path);
    const capturedIds: string[] = [];
    const genreCounts = new Map<string, number>();
    for (const i of inside) {
      const n = sRef.nodes[i];
      capturedIds.push(n.id);
      for (const g of n.genres) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
    }
    const topGenres = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));
    setLassoCapture({ nodeIds: capturedIds, genres: topGenres });
  }, []);

  // ─── Phase 2 — sync scannerMode to store + OrbitControls.enabled ───
  useEffect(() => {
    probeActiveRef.current = scannerMode === 'probe';
    stargazerActiveRef.current = scannerMode === 'stargazer';
    scannerSelectionStore.setMode(scannerMode);
    const sRef = sceneRef.current;
    if (sRef) {
      sRef.controls.enabled = scannerMode === 'observer' || scannerMode === 'hover';
    }
    if (scannerMode !== 'stargazer') {
      setStargazerPath([]);
      setStargazerNamePrompt(false);
    }
  }, [scannerMode]);

  // Commit #1 — subscribe to the persisted neighbor graph. When it's ready,
  // paint each node by its Louvain community and boost halo size by PageRank.
  // Re-applies when the graph rebuilds (e.g., after ANN index regeneration).
  useEffect(() => {
    const apply = () => {
      const sRef = sceneRef.current;
      if (!sRef || !gameGraphStore.isReady) return;
      const scores = gameGraphStore.getAllScores();
      if (!scores) return;

      const geo = sRef.points.geometry;
      const communityAttr = geo.getAttribute('aCommunityColor') as THREE.BufferAttribute | undefined;
      const prAttr = geo.getAttribute('aPRBoost') as THREE.BufferAttribute | undefined;
      const frontierGeo = sRef.frontierPoints.geometry;
      const frontierIntensityAttr = frontierGeo.getAttribute('aIntensity') as THREE.BufferAttribute | undefined;
      if (!communityAttr || !prAttr || !frontierIntensityAttr) return;

      // Find max PageRank + max PPR for normalization (soft cap to avoid one outlier flattening everything)
      let maxPR = 1e-9;
      let maxPPR = 1e-9;
      let hasPPR = false;
      for (const k of Object.keys(scores)) {
        const gs = scores[k];
        if (gs.pageRank > maxPR) maxPR = gs.pageRank;
        if (gs.personalizedPageRank > 0) {
          hasPPR = true;
          if (gs.personalizedPageRank > maxPPR) maxPPR = gs.personalizedPageRank;
        }
      }
      const prCap = maxPR * 0.85;
      const pprCap = maxPPR * 0.85;

      const communityArr = communityAttr.array as Float32Array;
      const prArr = prAttr.array as Float32Array;
      const frontierArr = frontierIntensityAttr.array as Float32Array;
      const tmp = new Float32Array(3);
      let matchCount = 0;
      for (let i = 0; i < sRef.nodes.length; i++) {
        const node = sRef.nodes[i];
        const gs = scores[node.id];
        if (!gs) {
          // No graph data for this node — leave neutral so nothing visibly changes for it
          frontierArr[i] = 0;
          continue;
        }
        matchCount++;
        communityHueToRGB(gs.community, tmp, 0);
        communityArr[i * 3] = tmp[0];
        communityArr[i * 3 + 1] = tmp[1];
        communityArr[i * 3 + 2] = tmp[2];
        prArr[i] = Math.min(1, gs.pageRank / prCap);

        // Frontier intensity: (1 - normalized PPR), boosted where the node has strong quality signals
        // (luminance = review-quality aggregate). This makes the deepest aurora hide unexplored gems.
        const pprNorm = hasPPR ? Math.min(1, gs.personalizedPageRank / pprCap) : 0.5;
        const baseFrontier = 1 - pprNorm;
        const stretchBoost = 0.5 + (node.luminance ?? 0.5) * 0.5;
        // Cube the curve so only the deep frontier glows brightly; explored core stays dim.
        frontierArr[i] = Math.pow(baseFrontier, 1.8) * stretchBoost;
      }
      communityAttr.needsUpdate = true;
      prAttr.needsUpdate = true;
      frontierIntensityAttr.needsUpdate = true;

      // Ramp up community tint + aurora visibility once enough nodes have graph data.
      // Keeps the visual fallback graceful while the graph is still building.
      const coverage = sRef.nodes.length > 0 ? matchCount / sRef.nodes.length : 0;
      const mix = coverage >= 0.6 ? 0.85 : 0;
      const mat = sRef.points.material as THREE.ShaderMaterial;
      if (mat.uniforms.u_communityMix) mat.uniforms.u_communityMix.value = mix;
      const fmat = sRef.frontierPoints.material as THREE.ShaderMaterial;
      // Aurora intensity ramps up only when we have PPR (real "you vs not-you" signal).
      // Without PPR, intensity stays at 0 — no aurora glow until library seed lands.
      if (fmat.uniforms.u_globalIntensity) {
        fmat.uniforms.u_globalIntensity.value = (coverage >= 0.6 && hasPPR) ? 1.0 : 0;
      }

      // Commit #2 — Stellar Classification flavor. Top 50 by PageRank become Named Stars.
      enrollNamedStars(sRef, scores, prCap, coverage);

      // Commit #5 — Fault Lines. Top 1% edges by betweenness as glowing fissures.
      buildFaultLines(sRef, scores);

      // Commit #6 — PageRank Aurora delta + eccentricity arrow.
      applyPRAurora(sRef);

      // Commit #7 — Constellation labels at Louvain centroids. Async due to IDB read.
      void buildConstellationLabels(sRef);
    };

    let constellationBuildToken = 0;
    async function buildConstellationLabels(sRef: NonNullable<typeof sceneRef.current>): Promise<void> {
      const token = ++constellationBuildToken;
      const buffers = gameGraphStore.getScoreBuffers();
      if (!buffers) return;
      let names: ConstellationName[] = [];
      try {
        names = await generateConstellationNames(sRef.nodes, buffers.community, buffers.nodeIds, buffers.pageRank);
      } catch (err) {
        console.warn('[Constellations] naming failed:', err);
        return;
      }
      if (token !== constellationBuildToken) return; // newer build in flight
      if (!names.length) return;

      // Dispose any prior constellation labels
      if (sRef.constellationLabels) {
        sRef.scene.remove(sRef.constellationLabels);
        sRef.constellationLabels.traverse((obj) => {
          if (obj instanceof THREE.Sprite) {
            obj.material.map?.dispose();
            obj.material.dispose();
          }
        });
      }

      const group = new THREE.Group();
      group.renderOrder = 999;
      for (const n of names.slice(0, 30)) { // cap label count for readability
        const pos = new THREE.Vector3(n.centroid.x, n.centroid.y, n.centroid.z);
        // Color from community palette so each label visually anchors to its territory
        const rgb = new Float32Array(3);
        communityHueToRGB(n.communityId, rgb, 0);
        const sprite = createGenreLabelSprite(n.name, [rgb[0], rgb[1], rgb[2]], pos);
        sprite.userData.communityId = n.communityId;
        group.add(sprite);
      }
      sRef.scene.add(group);
      sRef.constellationLabels = group;

      // Once constellation labels exist, dispose the static genre labels — they'd compete
      // AND each rebuild would leak ~15 CanvasTextures + materials if we only hid them.
      if (sRef.genreLabels) {
        sRef.scene.remove(sRef.genreLabels);
        sRef.genreLabels.traverse((obj) => {
          if (obj instanceof THREE.Sprite) {
            obj.material.map?.dispose();
            obj.material.dispose();
          }
        });
        sRef.genreLabels = null;
      }
      console.log(`[Constellations] Rendered ${names.length} community labels`);
    }

    function applyPRAurora(
      sRef: NonNullable<typeof sceneRef.current>,
    ): void {
      const prDelta = gameGraphStore.getPRDelta();
      const prDeltaAttr = sRef.points.geometry.getAttribute('aPRDelta') as THREE.BufferAttribute | undefined;
      const prDeltaArr = prDeltaAttr ? (prDeltaAttr.array as Float32Array) : undefined;
      const mat = sRef.points.material as THREE.ShaderMaterial;

      if (!prDelta || !prDeltaArr || !prDeltaAttr) {
        // Graceful fallback — zero everything, hide arrow
        if (prDeltaArr && prDeltaAttr) {
          prDeltaArr.fill(0);
          prDeltaAttr.needsUpdate = true;
        }
        if (mat.uniforms.u_prAuroraMix) mat.uniforms.u_prAuroraMix.value = 0;
        if (sRef.eccentricityArrow) {
          sRef.scene.remove(sRef.eccentricityArrow);
          sRef.eccentricityArrow.dispose();
          sRef.eccentricityArrow = null;
        }
        return;
      }

      // Map prDelta (indexed by graph node order) onto rendered node order
      const buffers = gameGraphStore.getScoreBuffers();
      if (!buffers) return;
      const idToGraphIdx = new Map<string, number>();
      for (let i = 0; i < buffers.nodeIds.length; i++) idToGraphIdx.set(buffers.nodeIds[i], i);

      // Compute eccentricity vector = Σ(prDelta_i × position_i)
      let ex = 0, ey = 0, ez = 0;
      let activeCount = 0;
      for (let i = 0; i < sRef.nodes.length; i++) {
        const gIdx = idToGraphIdx.get(sRef.nodes[i].id);
        const d = gIdx !== undefined ? prDelta[gIdx] : 0;
        prDeltaArr[i] = d;
        if (d !== 0) {
          activeCount++;
          ex += d * sRef.nodes[i].x;
          ey += d * sRef.nodes[i].y;
          ez += d * sRef.nodes[i].z;
        }
      }
      prDeltaAttr.needsUpdate = true;

      const coverage = sRef.nodes.length > 0 ? activeCount / sRef.nodes.length : 0;
      if (coverage < 0.6) {
        if (mat.uniforms.u_prAuroraMix) mat.uniforms.u_prAuroraMix.value = 0;
        if (sRef.eccentricityArrow) {
          sRef.scene.remove(sRef.eccentricityArrow);
          sRef.eccentricityArrow.dispose();
          sRef.eccentricityArrow = null;
        }
        return;
      }

      if (mat.uniforms.u_prAuroraMix) mat.uniforms.u_prAuroraMix.value = 0.55;

      // Eccentricity arrow at origin pointing toward the player's preferred region
      const mag = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (mag < 1e-3) {
        if (sRef.eccentricityArrow) {
          sRef.scene.remove(sRef.eccentricityArrow);
          sRef.eccentricityArrow.dispose();
          sRef.eccentricityArrow = null;
        }
        return;
      }
      const dir = new THREE.Vector3(ex / mag, ey / mag, ez / mag);
      const arrowLen = Math.min(50, mag * 0.5);
      if (sRef.eccentricityArrow) {
        sRef.eccentricityArrow.setDirection(dir);
        sRef.eccentricityArrow.setLength(arrowLen, arrowLen * 0.15, arrowLen * 0.08);
      } else {
        sRef.eccentricityArrow = new THREE.ArrowHelper(
          dir,
          new THREE.Vector3(0, 0, 0),
          arrowLen,
          0xffaa44,
          arrowLen * 0.15,
          arrowLen * 0.08,
        );
        sRef.eccentricityArrow.renderOrder = 50;
        sRef.scene.add(sRef.eccentricityArrow);
      }
    }

    function buildFaultLines(
      sRef: NonNullable<typeof sceneRef.current>,
      scores: Record<string, GraphScores>,
    ): void {
      const eb = gameGraphStore.getEdgeBetweenness();
      const edges = gameGraphStore.getEdges();
      if (!eb || !edges) {
        if (sRef.faultLines) {
          sRef.scene.remove(sRef.faultLines);
          sRef.faultLines.geometry.dispose();
          sRef.faultLines = null;
          sRef.faultLinesMat?.dispose();
          sRef.faultLinesMat = null;
        }
        return;
      }

      // Threshold = top FAULT_LINE_TOP_PERCENT, capped at FAULT_LINE_MAX_COUNT
      const targetCount = Math.min(FAULT_LINE_MAX_COUNT, Math.floor(eb.length * FAULT_LINE_TOP_PERCENT));
      if (targetCount === 0) return;
      const threshold = quickselectThreshold(eb, targetCount);

      // Collect edge indices that survive the threshold (may slightly exceed targetCount due to ties)
      const survivors: number[] = [];
      for (let i = 0; i < eb.length; i++) {
        if (eb[i] >= threshold) survivors.push(i);
        if (survivors.length >= FAULT_LINE_MAX_COUNT) break;
      }
      if (survivors.length === 0) return;

      // Normalize for shader (0..1 across survivors)
      let maxBC = 1e-9;
      for (const idx of survivors) if (eb[idx] > maxBC) maxBC = eb[idx];

      const positions = new Float32Array(survivors.length * 6);
      const colors = new Float32Array(survivors.length * 6);
      const betweenness = new Float32Array(survivors.length * 2);
      const tmp = new Float32Array(3);

      for (let i = 0; i < survivors.length; i++) {
        const eIdx = survivors[i];
        const fromIdx = edges[eIdx * 3];
        const toIdx = edges[eIdx * 3 + 1];
        const fromId = sRef.points.geometry.userData.gameIds?.[fromIdx] as string | undefined;
        const toId = sRef.points.geometry.userData.gameIds?.[toIdx] as string | undefined;
        // Resolve via gameGraphStore nodeIds — same ordering as the edges
        const graphNodeIds = gameGraphStore.state.phase === 'ready' ? gameGraphStore.getScoreBuffers()?.nodeIds : undefined;
        const fromGid = fromId ?? graphNodeIds?.[fromIdx];
        const toGid = toId ?? graphNodeIds?.[toIdx];
        const fromNode = fromGid ? sRef.nodes.find((n) => n.id === fromGid) : undefined;
        const toNode = toGid ? sRef.nodes.find((n) => n.id === toGid) : undefined;
        if (!fromNode || !toNode) {
          // Degenerate fallback — skip but pad zeros
          continue;
        }
        positions[i * 6]     = fromNode.x;
        positions[i * 6 + 1] = fromNode.y;
        positions[i * 6 + 2] = fromNode.z;
        positions[i * 6 + 3] = toNode.x;
        positions[i * 6 + 4] = toNode.y;
        positions[i * 6 + 5] = toNode.z;

        const fromCommunity = scores[fromGid!]?.community ?? -1;
        const toCommunity = scores[toGid!]?.community ?? -1;
        communityHueToRGB(fromCommunity, tmp, 0);
        colors[i * 6]     = tmp[0];
        colors[i * 6 + 1] = tmp[1];
        colors[i * 6 + 2] = tmp[2];
        communityHueToRGB(toCommunity, tmp, 0);
        colors[i * 6 + 3] = tmp[0];
        colors[i * 6 + 4] = tmp[1];
        colors[i * 6 + 5] = tmp[2];

        const bn = eb[eIdx] / maxBC;
        betweenness[i * 2] = bn;
        betweenness[i * 2 + 1] = bn;
      }

      // Dispose any prior fault-lines mesh before swapping in a new one
      if (sRef.faultLines) {
        sRef.scene.remove(sRef.faultLines);
        sRef.faultLines.geometry.dispose();
      }
      const fGeo = new THREE.BufferGeometry();
      fGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      fGeo.setAttribute('aFissureColor', new THREE.Float32BufferAttribute(colors, 3));
      fGeo.setAttribute('aBetweenness', new THREE.Float32BufferAttribute(betweenness, 1));

      // Reuse the material across rebuilds — only swap when first creating
      if (!sRef.faultLinesMat) {
        sRef.faultLinesMat = new THREE.ShaderMaterial({
          vertexShader: FISSURE_VERTEX,
          fragmentShader: FISSURE_FRAGMENT,
          uniforms: {
            u_time: { value: 0 },
            u_globalIntensity: { value: 1.0 },
          },
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          vertexColors: false,
        });
      }
      sRef.faultLines = new THREE.LineSegments(fGeo, sRef.faultLinesMat);
      sRef.faultLines.renderOrder = -5; // above frontier (-10), below points (0)
      sRef.scene.add(sRef.faultLines);
      console.log(`[FaultLines] Rendered ${survivors.length} fissures (top ${(FAULT_LINE_TOP_PERCENT * 100).toFixed(1)}% of ${eb.length} edges)`);
    }

    function enrollNamedStars(
      sRef: NonNullable<typeof sceneRef.current>,
      scores: Record<string, GraphScores>,
      prCap: number,
      coverage: number,
    ): void {
      const colorAttr = sRef.namedStarsMesh.geometry.getAttribute('aInstColor') as THREE.InstancedBufferAttribute;
      const phaseAttr = sRef.namedStarsMesh.geometry.getAttribute('aInstPhase') as THREE.InstancedBufferAttribute;
      const namedStarInstColors = colorAttr.array as Float32Array;
      const namedStarInstPhases = phaseAttr.array as Float32Array;

      // Need at least 60% coverage AND a non-trivial PageRank spread to be meaningful
      if (coverage < 0.6) {
        (sRef.namedStarsMesh.material as THREE.ShaderMaterial).uniforms.u_globalIntensity.value = 0;
        sRef.namedStarsMesh.count = 0;
        return;
      }

      // Pre-compute community sizes for NeutronStar classification
      const communitySizes = new Map<number, number>();
      for (const k of Object.keys(scores)) {
        const cId = scores[k].community;
        if (cId >= 0) communitySizes.set(cId, (communitySizes.get(cId) ?? 0) + 1);
      }

      // Auth/hub normalization caps
      let maxAuth = 1e-9, maxHub = 1e-9;
      for (const k of Object.keys(scores)) {
        const gs = scores[k];
        if (gs.authority > maxAuth) maxAuth = gs.authority;
        if (gs.hub > maxHub) maxHub = gs.hub;
      }
      const authCap = maxAuth * 0.85;
      const hubCap = maxHub * 0.85;

      // Rank candidates by PageRank — only nodes we actually render qualify
      type Candidate = { node: typeof sRef.nodes[number]; pr: number; gs: GraphScores };
      const candidates: Candidate[] = [];
      for (const node of sRef.nodes) {
        const gs = scores[node.id];
        if (!gs || gs.pageRank <= 0) continue;
        candidates.push({ node, pr: gs.pageRank, gs });
      }
      candidates.sort((a, b) => b.pr - a.pr);
      const topN = Math.min(NAMED_STAR_CAPACITY, candidates.length);

      const dummy = new THREE.Object3D();
      sRef.stellarClassByGameId.clear();
      for (let i = 0; i < topN; i++) {
        const c = candidates[i];
        const prNorm = Math.min(1, c.pr / prCap);
        const authNorm = Math.min(1, c.gs.authority / authCap);
        const hubNorm = Math.min(1, c.gs.hub / hubCap);
        const communitySize = communitySizes.get(c.gs.community) ?? 0;
        const cls = stellarClassify(prNorm, authNorm, hubNorm, c.node.luminance ?? 0.5, communitySize);

        dummy.position.set(c.node.x, c.node.y, c.node.z);
        // Slightly larger for Hypergiant/Quasar; smaller for Pulsar/NeutronStar
        const scale = cls === 'Hypergiant' || cls === 'Quasar' ? 1.35
          : cls === 'Pulsar' || cls === 'NeutronStar' ? 0.85
          : 1.0;
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        sRef.namedStarsMesh.setMatrixAt(i, dummy.matrix);

        const rgb = STELLAR_CLASS_RGB[cls];
        namedStarInstColors[i * 3] = rgb[0];
        namedStarInstColors[i * 3 + 1] = rgb[1];
        namedStarInstColors[i * 3 + 2] = rgb[2];
        // Phase: hash from gameId for stability across reloads
        let h = 5381;
        for (let k = 0; k < c.node.id.length; k++) h = ((h << 5) + h + c.node.id.charCodeAt(k)) >>> 0;
        namedStarInstPhases[i] = (h % 1000) / 1000;

        sRef.namedStarMeta[i] = { gameId: c.node.id, stellarClass: cls };
        sRef.stellarClassByGameId.set(c.node.id, cls);
      }
      for (let i = topN; i < NAMED_STAR_CAPACITY; i++) sRef.namedStarMeta[i] = null;

      sRef.namedStarsMesh.count = topN;
      sRef.namedStarsMesh.instanceMatrix.needsUpdate = true;
      colorAttr.needsUpdate = true;
      phaseAttr.needsUpdate = true;
      (sRef.namedStarsMesh.material as THREE.ShaderMaterial).uniforms.u_globalIntensity.value = 1;
    }

    // Try immediate apply (graph may already be built from a prior session)
    apply();
    const unsub = gameGraphStore.subscribe(apply);

    // If the graph hasn't been built yet but ANN is ready, kick off a background build.
    // No library seed here — Galaxy doesn't need PPR for the community tint; Oracle will
    // rebuild with seed when it next computes (and the cache will pick it up).
    if (
      gameGraphStore.state.phase === 'idle'
      && typeof window !== 'undefined'
      && window.ann
    ) {
      (async () => {
        try {
          const status = await window.ann!.status();
          if (status.ready && status.vectorCount > 0) {
            const sig = `ann-${status.vectorCount}`;
            void gameGraphStore.build(sig).catch(() => {});
          }
        } catch { /* ignore */ }
      })();
    }
    return unsub;
  }, []);

  activeGenresRef.current = activeGenres;
  allGenresRef.current = allGenres;

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

    const { renderer, backend, nodeMat, starMat, frontierMat, namedStarMat } = createRendererBundle(w, h);
    container.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(60, w / h, 1, 5000);
    camera.position.set(0, 0, 800);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020208);
    scene.fog = new THREE.FogExp2(0x020208, 0.0008);

    // Commit #8 — Ambient only; DirectionalLight would flatten the additive starfield.
    // Monuments' emissive component carries most of their visual presence.
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));

    let hdrTex: THREE.Texture | null = null;
    let destroyed = false;

    // Load HDR skybox via XHR → Blob URL to bypass the fact that Three.js
    // FileLoader uses fetch(), which doesn't support file:// in Electron.
    const hdrUrl = `${import.meta.env.BASE_URL}HDR_multi_nebulae_2.hdr`;
    const xhr = new XMLHttpRequest();
    xhr.open('GET', hdrUrl, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      if (destroyed) return;
      if ((xhr.status === 200 || xhr.status === 0) && xhr.response) {
        const blobUrl = URL.createObjectURL(new Blob([xhr.response]));
        new RGBELoader().load(blobUrl, (tex) => {
          URL.revokeObjectURL(blobUrl);
          if (destroyed) { tex.dispose(); return; }
          tex.mapping = THREE.EquirectangularReflectionMapping;
          scene.background = tex;
          scene.backgroundIntensity = 0.15;
          hdrTex = tex;
        }, undefined, () => {
          URL.revokeObjectURL(blobUrl);
          console.warn('[Embedding Space] Failed to parse HDR skybox');
        });
      }
    };
    xhr.onerror = () => console.warn('[Embedding Space] Failed to load HDR skybox');
    xhr.send();

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
    // Backdrop stars don't participate in graph metrics — feed zeros so the shared shader compiles.
    const starZeros = new Float32Array(STAR_COUNT);
    starGeo.setAttribute('aCommunityColor', new THREE.Float32BufferAttribute(starColors, 3));
    starGeo.setAttribute('aPRBoost', new THREE.Float32BufferAttribute(starZeros, 1));
    starGeo.setAttribute('aTwinklePhase', new THREE.Float32BufferAttribute(starZeros.slice(), 1));
    starGeo.setAttribute('aPRDelta', new THREE.Float32BufferAttribute(starZeros.slice(), 1));
    const starField = new THREE.Points(starGeo, starMat);
    scene.add(starField);

    // ── Game nodes ──
    const n = nodes.length;
    const posArr = new Float32Array(n * 3);
    const colArr = new Float32Array(n * 3);
    const sizeArr = new Float32Array(n);
    const brightArr = new Float32Array(n);

    const { pubFreq, maxPubLog } = pubFreqRef.current;
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      posArr[i * 3] = nd.x;
      posArr[i * 3 + 1] = nd.y;
      posArr[i * 3 + 2] = nd.z;

      const c = GENRE_PALETTE[nd.colorIdx];
      colArr[i * 3] = c[0];
      colArr[i * 3 + 1] = c[1];
      colArr[i * 3 + 2] = c[2];

      sizeArr[i] = starSize(nd, pubFreq, maxPubLog);
      // Brightness blends review-quality luminance with popularity magnitude
      const popNorm = Math.min(Math.log10(Math.max(nd.reviewCount, 1)) / 5.3, 1);
      const lumBlend = nd.luminance * 0.6 + popNorm * 0.4;
      const bright = 0.08 + lumBlend * 0.92;
      brightArr[i] = nd.isLibrary ? Math.min(1.0, bright + 0.15) : bright;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    const colorAttr = new THREE.Float32BufferAttribute(colArr, 3);
    geo.setAttribute('aColor', colorAttr);
    const sizeAttr = new THREE.Float32BufferAttribute(sizeArr, 1);
    geo.setAttribute('aSize', sizeAttr);
    const brightnessAttr = new THREE.Float32BufferAttribute(brightArr, 1);
    geo.setAttribute('aBrightness', brightnessAttr);

    // Commit #1 attributes — initialized to neutral so shader degrades to pre-Phase-1 look
    // until gameGraphStore.subscribe() fills them with real community/PageRank data.
    const communityColorArr = new Float32Array(n * 3);
    const prBoostArr = new Float32Array(n);
    const twinklePhaseArr = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Start neutral: copy genre color so u_communityMix=0 produces identical output to before.
      communityColorArr[i * 3] = colArr[i * 3];
      communityColorArr[i * 3 + 1] = colArr[i * 3 + 1];
      communityColorArr[i * 3 + 2] = colArr[i * 3 + 2];
      prBoostArr[i] = 0;
      // Phase set once at init from id — same seed across reloads keeps twinkle stable.
      const seed = nodes[i].id;
      let h = 5381;
      for (let k = 0; k < seed.length; k++) h = ((h << 5) + h + seed.charCodeAt(k)) >>> 0;
      twinklePhaseArr[i] = (h % 1000) / 1000;
    }
    const communityColorAttr = new THREE.Float32BufferAttribute(communityColorArr, 3);
    geo.setAttribute('aCommunityColor', communityColorAttr);
    const prBoostAttr = new THREE.Float32BufferAttribute(prBoostArr, 1);
    geo.setAttribute('aPRBoost', prBoostAttr);
    const twinklePhaseAttr = new THREE.Float32BufferAttribute(twinklePhaseArr, 1);
    geo.setAttribute('aTwinklePhase', twinklePhaseAttr);
    // Commit #6 — signed PR delta. Zero until graph + library seed produce real values.
    const prDeltaArr = new Float32Array(n);
    const prDeltaAttr = new THREE.Float32BufferAttribute(prDeltaArr, 1);
    geo.setAttribute('aPRDelta', prDeltaAttr);

    const points = new THREE.Points(geo, nodeMat);
    scene.add(points);

    // ── Phase 2 — Banner InstancedMeshes (one per color) ──
    const BANNER_CAPACITY = 1000;
    const bannerGeo = new THREE.ConeGeometry(0.6, 2.4, 6);
    const bannerMeshes = new Map<BannerColor, THREE.InstancedMesh>();
    for (const color of BANNER_COLORS) {
      const rgb = BANNER_RGB[color];
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(rgb[0], rgb[1], rgb[2]),
        emissive: new THREE.Color(rgb[0] * 0.6, rgb[1] * 0.6, rgb[2] * 0.6),
        emissiveIntensity: 0.25,
        metalness: 0.1,
        roughness: 0.5,
      });
      const mesh = new THREE.InstancedMesh(bannerGeo, mat, BANNER_CAPACITY);
      mesh.count = 0;
      mesh.instanceMatrix.usage = THREE.DynamicDrawUsage;
      mesh.renderOrder = 60;
      scene.add(mesh);
      bannerMeshes.set(color, mesh);
    }

    // ── Phase 2 — User Constellations LineSegments (single draw call) ──
    const constellationLineGeo = new THREE.BufferGeometry();
    constellationLineGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(0), 3));
    const constellationLineMat = new THREE.LineBasicMaterial({
      color: 0x9ce0ff,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    const constellationLines = new THREE.LineSegments(constellationLineGeo, constellationLineMat);
    constellationLines.renderOrder = 5;
    scene.add(constellationLines);

    // ── Monument scaffolding (Commit #4) — empty batches, no visible geometry yet ──
    const monumentBatches = createMonumentBatches();
    for (const batch of monumentBatches.values()) scene.add(batch.mesh);
    console.log(`[Monuments] Initialized ${monumentBatches.size} empty batches (capacity=${MONUMENT_CAPACITY_PER_BATCH} each)`);

    // ── Named Stars layer (Commit #2) ──
    // 50-instance icosahedron, invisible until gameGraphStore enrolls top-PR nodes.
    const namedStarGeo = new THREE.IcosahedronGeometry(NAMED_STAR_RADIUS, 2);
    const namedStarsMesh = new THREE.InstancedMesh(namedStarGeo, namedStarMat, NAMED_STAR_CAPACITY);
    namedStarsMesh.count = 0; // hidden until enrollNamedStars() writes matrices
    const namedStarInstColors = new Float32Array(NAMED_STAR_CAPACITY * 3);
    const namedStarInstPhases = new Float32Array(NAMED_STAR_CAPACITY);
    namedStarGeo.setAttribute('aInstColor', new THREE.InstancedBufferAttribute(namedStarInstColors, 3));
    namedStarGeo.setAttribute('aInstPhase', new THREE.InstancedBufferAttribute(namedStarInstPhases, 1));
    namedStarsMesh.instanceMatrix.usage = THREE.DynamicDrawUsage;
    namedStarsMesh.renderOrder = 1; // sits just above star points; below selected sun (which lives in scene without explicit order)
    scene.add(namedStarsMesh);
    const namedStarMeta: Array<{ gameId: string; stellarClass: StellarClass } | null> = new Array(NAMED_STAR_CAPACITY).fill(null);
    const stellarClassByGameId = new Map<string, StellarClass>();

    // ── Frontier Aurora layer (Commit #3) ──
    // Shares positions with the main star field; intensity attribute is filled from PPR
    // when the graph is ready. Render order < star points so it sits BENEATH them.
    const frontierGeo = new THREE.BufferGeometry();
    frontierGeo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    const frontierIntensityArr = new Float32Array(n);
    // Phase per node — reuse the twinkle phase computation so adjacent stars + aurora
    // breathe at different rates (no synchronized strobing).
    const frontierPhaseArr = new Float32Array(n);
    for (let i = 0; i < n; i++) frontierPhaseArr[i] = twinklePhaseArr[i] * 1.7 + 0.13;
    const frontierIntensityAttr = new THREE.Float32BufferAttribute(frontierIntensityArr, 1);
    frontierGeo.setAttribute('aIntensity', frontierIntensityAttr);
    const frontierPhaseAttr = new THREE.Float32BufferAttribute(frontierPhaseArr, 1);
    frontierGeo.setAttribute('aPhase', frontierPhaseAttr);
    const frontierPoints = new THREE.Points(frontierGeo, frontierMat);
    // Sits visually below the star field. Lower renderOrder = drawn first.
    frontierPoints.renderOrder = -10;
    scene.add(frontierPoints);

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points!.threshold = 4;
    const mouse = new THREE.Vector2();

    // ── Sun meshes for selected + focused nodes ──
    const sunSelected = createSunGroup(5);
    const sunFocused = createSunGroup(4);
    scene.add(sunSelected.group);
    scene.add(sunFocused.group);

    // ── Bloom postprocessing (half-res bloom for quality/perf balance) ──
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(
      new THREE.Vector2(Math.ceil(w / 2), Math.ceil(h / 2)), 0.4, 0.15, 0.65,
    ));
    composer.addPass(new OutputPass());

    // ── Genre cluster labels ──
    const centroids = computeGenreCentroids(nodes);
    const genreLabelsGroup = new THREE.Group();
    genreLabelsGroup.renderOrder = 999;
    for (const [idx, pos] of centroids) {
      if (idx >= CANONICAL_GENRE_LABELS.length) continue;
      const sprite = createGenreLabelSprite(CANONICAL_GENRE_LABELS[idx], GENRE_PALETTE[idx], pos);
      sprite.userData.colorIdx = idx;
      genreLabelsGroup.add(sprite);
    }
    scene.add(genreLabelsGroup);

    const baseSizes = sizeArr.slice();
    const baseBright = brightArr.slice();
    const baseColors = colArr.slice();
    const nodeMap = new Map<string, GraphNode>(nodes.map(nd => [nd.id, nd]));

    const sRef = {
      renderer, scene, camera, controls, points, starField, frontierPoints,
      namedStarsMesh, namedStarMeta, stellarClassByGameId,
      monumentBatches,
      faultLines: null as THREE.LineSegments | null,
      faultLinesMat: null as THREE.ShaderMaterial | null,
      eccentricityArrow: null as THREE.ArrowHelper | null,
      constellationLabels: null as THREE.Group | null,
      bannerMeshes,
      constellationLines,
      constellationLineMat,
      lines: null as THREE.LineSegments | null,
      linesMat: null as THREE.LineDashedMaterial | null,
      focusedLines: null as THREE.LineSegments | null,
      focusedLinesMat: null as THREE.LineDashedMaterial | null,
      focusedLinesOpacity: 0,
      pathLines: null as THREE.LineSegments | null,
      pathLinesMat: null as THREE.LineDashedMaterial | null,
      pathLabels: null as THREE.Group | null,
      genreLabels: genreLabelsGroup as THREE.Group | null,
      raycaster, mouse, nodes,
      colorAttr, sizeAttr, brightnessAttr,
      baseSizes, baseBright, baseColors, nodeMap,
      animFrameId: 0,
      composer, sunSelected, sunFocused,
    };

    // ── Monument backfill + live spawn (Commit #8) ──
    // Source of truth: libraryStore. On mount we backfill Completed games in chunked rAF
    // bursts; afterwards, subscription diffs detect newly-completed games and spawn one matrix
    // each. cursors live on each MonumentBatch — no per-spawn full-rebuild.
    const monumentSeenIds = new Set<string>();
    function spawnMonumentForGame(gameId: string): boolean {
      const node = nodeMap.get(gameId);
      if (!node) return false;
      const archetype = mapGenreToArchetype(node.genres);
      const batch = monumentBatches.get(archetype);
      if (!batch || batch.cursor >= MONUMENT_CAPACITY_PER_BATCH) return false;
      const matrix = new THREE.Matrix4();
      // Slight outward offset along normalized position so monuments don't sit ON the star;
      // 2.5 units (≈ named-star radius) gives breathing room without losing association.
      const len = Math.sqrt(node.x * node.x + node.y * node.y + node.z * node.z) || 1;
      const offset = 2.5 / len;
      matrix.setPosition(
        node.x + node.x * offset * 0.06,
        node.y + node.y * offset * 0.06,
        node.z + node.z * offset * 0.06,
      );
      batch.mesh.setMatrixAt(batch.cursor, matrix);
      batch.cursor++;
      batch.mesh.count = batch.cursor;
      return true;
    }
    function flushMonumentBatchUpdates(): void {
      for (const batch of monumentBatches.values()) {
        if (batch.cursor > 0) batch.mesh.instanceMatrix.needsUpdate = true;
      }
    }

    // Backfill — chunked at 50 per frame
    const completedAtMount = libraryStore.filterByStatus('Completed');
    let backfillIdx = 0;
    const backfillChunkSize = 50;
    function backfillTick(): void {
      const end = Math.min(backfillIdx + backfillChunkSize, completedAtMount.length);
      for (let i = backfillIdx; i < end; i++) {
        const entry = completedAtMount[i];
        if (monumentSeenIds.has(entry.gameId)) continue;
        if (spawnMonumentForGame(entry.gameId)) monumentSeenIds.add(entry.gameId);
      }
      backfillIdx = end;
      flushMonumentBatchUpdates();
      if (backfillIdx < completedAtMount.length) {
        requestAnimationFrame(backfillTick);
      } else {
        console.log(`[Monuments] Backfill complete — ${monumentSeenIds.size}/${completedAtMount.length} placed`);
      }
    }
    if (completedAtMount.length > 0) requestAnimationFrame(backfillTick);

    // Phase 2.1 — Completion event chain. Each new completion fires:
    //   t=0:   supernova billboard at node position (expanding glow)
    //   t=0.5: shockwave ring (one-hop ANN burst — visual only)
    //   t=2:   monument lands (existing Wave B path)
    // EventActors are transient sprites added/removed inline; no new pass, no draw-call budget cost.
    // Track in-flight RAFs so cleanup can cancel them and short-circuit ticks
    const eventRafIds = new Set<number>();
    function spawnSupernova(node: GraphNode): void {
      if (destroyed) return;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const ctx = canvas.getContext('2d')!;
      const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
      grad.addColorStop(0, 'rgba(255, 240, 200, 1)');
      grad.addColorStop(0.3, 'rgba(255, 200, 120, 0.6)');
      grad.addColorStop(1, 'rgba(255, 120, 80, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 256, 256);
      const tex = new THREE.CanvasTexture(canvas);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.position.set(node.x, node.y, node.z);
      sprite.scale.setScalar(10);
      sprite.renderOrder = 90;
      scene.add(sprite);
      const start = performance.now();
      const tick = () => {
        if (destroyed) {
          scene.remove(sprite);
          mat.dispose();
          tex.dispose();
          return;
        }
        const t = (performance.now() - start) / 1800;
        if (t >= 1) {
          scene.remove(sprite);
          mat.dispose();
          tex.dispose();
          return;
        }
        sprite.scale.setScalar(10 + t * 110);
        mat.opacity = Math.max(0, 1 - t);
        const id = requestAnimationFrame(tick);
        eventRafIds.add(id);
      };
      eventRafIds.add(requestAnimationFrame(tick));
    }

    function spawnShockwave(node: GraphNode): void {
      if (destroyed) return;
      const ringGeo = new THREE.RingGeometry(0.9, 1.0, 48);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffd080,
        transparent: true,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(node.x, node.y, node.z);
      ring.renderOrder = 89;
      ring.lookAt(camera.position);
      scene.add(ring);
      const start = performance.now();
      const tick = () => {
        if (destroyed) {
          scene.remove(ring);
          ringGeo.dispose();
          ringMat.dispose();
          return;
        }
        const t = (performance.now() - start) / 1400;
        if (t >= 1) {
          scene.remove(ring);
          ringGeo.dispose();
          ringMat.dispose();
          return;
        }
        const scale = 1 + t * 80;
        ring.scale.setScalar(scale);
        ring.lookAt(camera.position);
        ringMat.opacity = Math.max(0, 0.9 * (1 - t));
        const id = requestAnimationFrame(tick);
        eventRafIds.add(id);
      };
      eventRafIds.add(requestAnimationFrame(tick));
    }

    // Live diff — fires on every libraryStore mutation; only spawns NEW completions.
    const unsubMonumentDiff = libraryStore.subscribe(() => {
      const current = libraryStore.filterByStatus('Completed');
      let dirty = false;
      for (const entry of current) {
        if (monumentSeenIds.has(entry.gameId)) continue;
        const node = nodeMap.get(entry.gameId);
        if (node) {
          // Visual prelude — supernova now, shockwave at t+0.5s, monument lands at t+2s
          spawnSupernova(node);
          setTimeout(() => spawnShockwave(node), 500);
        }
        if (spawnMonumentForGame(entry.gameId)) {
          monumentSeenIds.add(entry.gameId);
          dirty = true;
        }
      }
      if (dirty) flushMonumentBatchUpdates();
    });

    // ── Animation loop ──
    const _projVec = new THREE.Vector3();
    let _prevTime = performance.now();
    let _frames = 0;
    let _lastRenderTime = 0;
    let _cachedCW = container.clientWidth;
    let _cachedCH = container.clientHeight;
    const BG_FRAME_INTERVAL = 500; // ~2 FPS when hidden/unfocused
    function animate() {
      sRef.animFrameId = requestAnimationFrame(animate);

      const now = performance.now();
      if (document.hidden || !document.hasFocus()) {
        if (now - _lastRenderTime < BG_FRAME_INTERVAL) return;
        _lastRenderTime = now;
        controls.update();
        return; // skip ALL GPU work when unfocused/hidden
      } else if (now - _lastRenderTime > BG_FRAME_INTERVAL) {
        _prevTime = now;
        _frames = 0;
      }
      _lastRenderTime = now;
      _frames++;
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

      if (sRef.focusedLinesMat) {
        (sRef.focusedLinesMat as any).dashOffset -= 0.2;
        const target = 1;
        if (sRef.focusedLinesOpacity < target) {
          sRef.focusedLinesOpacity = Math.min(target, sRef.focusedLinesOpacity + 0.035);
          sRef.focusedLinesMat.opacity = sRef.focusedLinesOpacity;
        }
      }

      // ── Update sun meshes from reactive state ──
      const _sunState = sunStateRef.current;
      const _t = now * 0.001;

      // Commit #1 — drive the node shader's u_time so twinkle animates.
      if ((sRef.points.material as THREE.ShaderMaterial).uniforms.u_time) {
        (sRef.points.material as THREE.ShaderMaterial).uniforms.u_time.value = _t;
        // Phase 2 — Living Weather: ~30-min cycle (= 1800s)
        const tod = (_t % 1800) / 1800;
        (sRef.points.material as THREE.ShaderMaterial).uniforms.u_galacticTimeOfDay.value = tod;
        // starField shares the same NODE_VERTEX shader and needs the same uniform updated,
        // otherwise the backdrop misses the day/night tint contract.
        const starMatUniforms = (sRef.starField.material as THREE.ShaderMaterial).uniforms;
        if (starMatUniforms.u_time) starMatUniforms.u_time.value = _t;
        if (starMatUniforms.u_galacticTimeOfDay) starMatUniforms.u_galacticTimeOfDay.value = tod;
      }
      // Drive scanner dwell timers in step with the same heartbeat
      scannerSelectionStore.processDwellTimers(now);
      // Commit #3 — drive the frontier aurora's u_time so the cold ribbons drift.
      if (sRef.frontierPoints) {
        const fmat = sRef.frontierPoints.material as THREE.ShaderMaterial;
        if (fmat.uniforms.u_time) fmat.uniforms.u_time.value = _t;
      }
      // Commit #2 — drive the named-star pulse.
      if (sRef.namedStarsMesh) {
        const nmat = sRef.namedStarsMesh.material as THREE.ShaderMaterial;
        if (nmat.uniforms.u_time) nmat.uniforms.u_time.value = _t;
      }

      // Phase 3.0 — Year Wrapped Flythrough camera animation.
      // Drives camera along a CatmullRomCurve3 through 6-8 keyframe stars over 60s.
      if (flythroughStateRef.current) {
        const fs = flythroughStateRef.current;
        const elapsed = now - fs.startMs;
        const t = Math.min(1, elapsed / fs.durationMs);
        // Ease in/out so the camera doesn't snap at the boundaries
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const point = fs.curve.getPointAt(ease);
        camera.position.copy(point);

        // Aim ahead on the curve — small lookahead for natural camera framing
        const lookT = Math.min(1, ease + 0.012);
        const lookPoint = fs.curve.getPointAt(lookT);
        // Target is between lookahead point and the nearest keyframe star, so the camera
        // glances toward the actual star rather than empty curve space.
        const seg = ease * (fs.targets.length - 1);
        const segIdx = Math.min(fs.targets.length - 1, Math.floor(seg));
        const targetMix = new THREE.Vector3().lerpVectors(lookPoint, fs.targets[segIdx].pos, 0.55);
        controls.target.copy(targetMix);

        // Update lower-third when crossing into a new keyframe segment
        const lowerIdx = Math.min(fs.targets.length - 1, Math.floor(seg + 0.15));
        if (!flythroughLowerThird || flythroughLowerThird.index !== lowerIdx) {
          const k = fs.targets[lowerIdx];
          setFlythroughLowerThird({ title: k.title, subtitle: k.subtitle, index: lowerIdx });
        }

        if (t >= 1 && !fs.abort.aborted) {
          // Auto-exit at the end. setTimeout so the final frame lands first.
          fs.abort.aborted = true;
          setTimeout(() => exitFlythrough(), 800);
        }
      }

      // Phase 2.1 — Probe drift physics. WASD impulse → camera + target offset, damped.
      if (probeActiveRef.current) {
        const keys = keysDownRef.current;
        const thrust = 4.5;
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
        const up = camera.up.clone().normalize();
        const vel = probeVelocityRef.current;
        if (keys.has('w')) { vel.x += forward.x * thrust; vel.y += forward.y * thrust; vel.z += forward.z * thrust; }
        if (keys.has('s')) { vel.x -= forward.x * thrust; vel.y -= forward.y * thrust; vel.z -= forward.z * thrust; }
        if (keys.has('a')) { vel.x -= right.x * thrust; vel.y -= right.y * thrust; vel.z -= right.z * thrust; }
        if (keys.has('d')) { vel.x += right.x * thrust; vel.y += right.y * thrust; vel.z += right.z * thrust; }
        if (keys.has('q')) { vel.x -= up.x * thrust; vel.y -= up.y * thrust; vel.z -= up.z * thrust; }
        if (keys.has('e')) { vel.x += up.x * thrust; vel.y += up.y * thrust; vel.z += up.z * thrust; }
        // Damp + integrate. Clamp position to ±2000 to keep within galaxy.
        vel.x *= 0.92; vel.y *= 0.92; vel.z *= 0.92;
        if (Math.abs(vel.x) > 0.01 || Math.abs(vel.y) > 0.01 || Math.abs(vel.z) > 0.01) {
          camera.position.x = Math.max(-2000, Math.min(2000, camera.position.x + vel.x));
          camera.position.y = Math.max(-2000, Math.min(2000, camera.position.y + vel.y));
          camera.position.z = Math.max(-2000, Math.min(2000, camera.position.z + vel.z));
          controls.target.x += vel.x;
          controls.target.y += vel.y;
          controls.target.z += vel.z;
        }
      } else {
        // Decay any residual velocity when exiting probe
        const vel = probeVelocityRef.current;
        if (vel.x || vel.y || vel.z) { vel.x = vel.y = vel.z = 0; }
      }
      // Commit #5 — drive Fault Lines pulse; dim when neighbor panel active.
      if (sRef.faultLinesMat) {
        sRef.faultLinesMat.uniforms.u_time.value = _t;
        sRef.faultLinesMat.uniforms.u_globalIntensity.value = sRef.lines ? 0.3 : 1.0;
      }

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

      const projectCards = (el: HTMLDivElement | null) => {
        if (!el) return;
        const len = el.children.length;
        if (len === 0) return;
        const cw = _cachedCW;
        const ch = _cachedCH;
        for (let ci = 0; ci < len; ci++) {
          const card = el.children[ci] as HTMLElement;
          let coords = (card as any).__coords as Float64Array | undefined;
          if (!coords) {
            coords = new Float64Array([
              parseFloat(card.dataset.nx!),
              parseFloat(card.dataset.ny!),
              parseFloat(card.dataset.nz!),
            ]);
            (card as any).__coords = coords;
          }
          _projVec.set(coords[0], coords[1], coords[2]).project(camera);
          if (_projVec.z > 1) {
            card.style.opacity = '0';
            continue;
          }
          const sx = (_projVec.x * 0.5 + 0.5) * cw;
          const sy = (-_projVec.y * 0.5 + 0.5) * ch;
          card.style.transform = `translate(${sx}px, ${sy - 48}px) translate(-50%, -100%)`;
          card.style.opacity = '1';
        }
      };
      projectCards(neighborCardsRef.current);
      projectCards(pathOverviewCardsRef.current);
    }
    animate();

    // ── Resize handler (rAF-debounced to avoid storms) ──
    let _resizeRaf = 0;
    const observer = new ResizeObserver(() => {
      if (_resizeRaf) return;
      _resizeRaf = requestAnimationFrame(() => {
        _resizeRaf = 0;
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        _cachedCW = cw;
        _cachedCH = ch;
        renderer.setSize(cw, ch);
        composer.setSize(cw, ch);
        // Re-apply half-res to bloom pass (composer.setSize resets all passes to full-res)
        for (const pass of composer.passes) {
          if (pass instanceof UnrealBloomPass) {
            pass.setSize(Math.ceil(cw / 2), Math.ceil(ch / 2));
          }
        }
        camera.aspect = cw / ch;
        camera.updateProjectionMatrix();
        cachedRectRef.current = renderer.domElement.getBoundingClientRect();
      });
    });
    observer.observe(container);
    cachedRectRef.current = renderer.domElement.getBoundingClientRect();

    sceneRef.current = sRef;

    const cleanup = () => {
      observer.disconnect();
      destroyed = true;
      if (_resizeRaf) cancelAnimationFrame(_resizeRaf);
      cancelAnimationFrame(sRef.animFrameId);
      controls.dispose();
      for (const pass of composer.passes) {
        if (typeof (pass as any).dispose === 'function') (pass as any).dispose();
      }
      composer.dispose();
      renderer.dispose();
      geo.dispose();
      starGeo.dispose();
      frontierGeo.dispose();
      namedStarGeo.dispose();
      nodeMat.dispose();
      starMat.dispose();
      frontierMat.dispose();
      namedStarMat.dispose();
      for (const batch of monumentBatches.values()) {
        batch.geo.dispose();
        batch.mat.dispose();
      }
      if (sRef.faultLines) {
        sRef.faultLines.geometry.dispose();
      }
      if (sRef.faultLinesMat) sRef.faultLinesMat.dispose();
      if (sRef.eccentricityArrow) sRef.eccentricityArrow.dispose();
      if (sRef.constellationLabels) {
        sRef.constellationLabels.traverse((obj) => {
          if (obj instanceof THREE.Sprite) {
            obj.material.map?.dispose();
            obj.material.dispose();
          }
        });
      }
      // Phase 2.1 audit fix — cancel pending event RAFs so they don't tick after dispose
      for (const id of eventRafIds) cancelAnimationFrame(id);
      eventRafIds.clear();
      bannerGeo.dispose();
      for (const m of bannerMeshes.values()) (m.material as THREE.Material).dispose();
      constellationLines.geometry.dispose();
      constellationLineMat.dispose();
      unsubMonumentDiff();
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
      if (sRef.focusedLines) {
        sRef.focusedLines.geometry.dispose();
        (sRef.focusedLines.material as THREE.Material).dispose();
      }
      if (sRef.pathLines) {
        sRef.pathLines.geometry.dispose();
        (sRef.pathLines.material as THREE.Material).dispose();
      }
      if (sRef.pathLabels) {
        sRef.pathLabels.traverse(child => {
          const sp = child as THREE.Sprite;
          if (sp.material) {
            if ((sp.material as THREE.SpriteMaterial).map) (sp.material as THREE.SpriteMaterial).map!.dispose();
            sp.material.dispose();
          }
        });
      }
      if (sRef.genreLabels) {
        sRef.genreLabels.traverse(child => {
          const sp = child as THREE.Sprite;
          if (sp.material) {
            if ((sp.material as THREE.SpriteMaterial).map) (sp.material as THREE.SpriteMaterial).map!.dispose();
            sp.material.dispose();
          }
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
    let catalogUnsub: (() => void) | null = null;
    let catalogTimeout: ReturnType<typeof setTimeout> | null = null;
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
      let projMethod = 'PCA';

      if (useMock) {
        // Fast-path: synthetic data for UI testing — no Ollama/IDB needed
        GALAXY_STEP_LABELS.forEach((_, i) => onStep(i, 'done', 'mock'));
        const mock = generateMockGalaxy();
        nodes = mock.nodes;
        allGenres = mock.allGenres;
        projMethod = 'MOCK';
      } else {
        // Try cache first
        const cached = await loadCachedGalaxyIfFresh();
        if (cached) {
          nodes = cached.nodes;
          allGenres = cached.allGenres;
          projMethod = cached.projectionMethod;
          GALAXY_STEP_LABELS.forEach((_, i) => onStep(i, 'done', 'cached'));
        } else if (embeddingService.isCatalogRunning) {
          if (!cancelled) {
            setLoadingSteps(allLabels.map(label => ({
              label: `${label} — waiting for embedding pipeline`,
              status: 'waiting' as const,
            })));
          }
          // Wait for catalog pipeline with a 3-minute timeout
          await new Promise<void>(resolve => {
            if (!embeddingService.isCatalogRunning) { resolve(); return; }
            catalogTimeout = setTimeout(() => { catalogUnsub?.(); catalogUnsub = null; catalogTimeout = null; resolve(); }, 3 * 60_000);
            const unsub = embeddingService.subscribe(() => {
              if (!embeddingService.isCatalogRunning) { if (catalogTimeout) { clearTimeout(catalogTimeout); catalogTimeout = null; } catalogUnsub = null; unsub(); resolve(); }
            });
            catalogUnsub = unsub;
          });
          if (cancelled) return;
          GALAXY_STEP_LABELS.forEach((_, i) => onStep(i, 'running'));
          const result = await buildAndCacheGalaxy(onStep);
          nodes = result.nodes;
          allGenres = result.allGenres;
          projMethod = result.projectionMethod;
        } else {
          // If a background build is already in progress, piggyback on it
          const bgPromise = getBackgroundBuildPromise();
          if (bgPromise) {
            GALAXY_STEP_LABELS.forEach((_, i) => onStep(i, 'running', 'background build in progress'));
            const result = await bgPromise;
            nodes = result.nodes;
            allGenres = result.allGenres;
            projMethod = result.projectionMethod;
            GALAXY_STEP_LABELS.forEach((_, i) => onStep(i, 'done'));
          } else {
            const result = await buildAndCacheGalaxy(onStep);
            nodes = result.nodes;
            allGenres = result.allGenres;
            projMethod = result.projectionMethod;
          }
        }
      }

      if (cancelled) return;
      setProjectionMethod(projMethod);
      loadedNodesRef.current = nodes;
      pubFreqRef.current = buildPublisherFreqs(nodes);
      nodeSearchIndex.current = [];
      setNodeCount(nodes.length);
      setAllGenres(allGenres);
      setActiveGenres(new Set());

      if (nodes.length === 0) {
        setEmptyGalaxy(true);
      } else if (canvasRef.current) {
        onStep(RENDER_IDX, 'running');

        await new Promise(r => setTimeout(r, 0));
        if (cancelled) return;

        const { cleanup, backend } = initScene(canvasRef.current!, nodes);
        if (cancelled) { cleanup(); return; }
        setRendererBackend(backend);
        (canvasRef.current as any).__cleanup = cleanup;

        await new Promise<void>(resolve => {
          let warmupFrames = 0;
          const tick = () => {
            if (cancelled) { resolve(); return; }
            warmupFrames++;
            if (warmupFrames < 30) requestAnimationFrame(tick);
            else resolve();
          };
          requestAnimationFrame(tick);
        });
        if (cancelled) return;

        onStep(RENDER_IDX, 'done');
      }

      // Start the hero typewriter (only when we have actual galaxy nodes).
      // The hero sits at z-25, below the loader at z-30, so it types
      // behind the fading loader overlay — visible as it fades out.
      if (!cancelled && nodes.length > 0) {
        setHeroVisible(true);
        // Give the typewriter ~600ms to render several characters and let
        // the GPU stabilize frame rate before the heavy UI mount
        // (genre filters, library panel, controls, etc.).
        await new Promise(r => setTimeout(r, 600));
      }

      // Check path availability before we clear loading.
      if (!cancelled && sceneRef.current) {
        if (useMock) {
          const libNodes = loadedNodesRef.current.filter(n => n.isLibrary && n.hoursPlayed > 0);
          setPathDisabledReason(libNodes.length >= 2 ? null : 'Need at least 2 library games for The Path');
        } else {
          const journeyWithDates = journeyStore.getAllEntries().filter(e => e.firstPlayedAt);
          if (journeyWithDates.length < 2) {
            setPathDisabledReason('Play at least 2 games to unlock The Path');
          } else {
            const mapped = journeyWithDates.filter(e => sceneRef.current!.nodeMap.has(e.gameId));
            if (mapped.length < 2) {
              setPathDisabledReason('Need embeddings for at least 2 played games');
            } else {
              setPathDisabledReason(null);
            }
          }
        }
      }

      // Use startTransition so React yields to rAF between render chunks,
      // keeping the typewriter animation smooth during the heavy UI mount.
      startTransition(() => setLoading(false));

      // Build search index during idle time so the typewriter stays smooth.
      let idxPos = 0;
      const IDX_CHUNK = 3000;
      let idleHandle = 0;
      const scheduleIdle = typeof requestIdleCallback === 'function'
        ? (fn: IdleRequestCallback) => { idleHandle = requestIdleCallback(fn, { timeout: 3000 }); }
        : (fn: () => void) => { idleHandle = window.setTimeout(fn, 60) as unknown as number; };
      const cancelIdle = typeof cancelIdleCallback === 'function'
        ? () => cancelIdleCallback(idleHandle)
        : () => clearTimeout(idleHandle);
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
            pubLower: (nd.publisher || '').toLowerCase(),
            genresLower: nd.genres.map(g => g.toLowerCase()),
          };
        }
        if (idxPos < nodes.length) scheduleIdle(buildChunk);
      };
      scheduleIdle(buildChunk);
      cleanupIdleRef.current = cancelIdle;

      } catch (err) {
        console.error('[Embedding Space] Loading failed:', err);
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (catalogTimeout) { clearTimeout(catalogTimeout); catalogTimeout = null; }
      if (catalogUnsub) { catalogUnsub(); catalogUnsub = null; }
      cancelActiveProjectionWorker();
      if (cleanupIdleRef.current) { cleanupIdleRef.current(); cleanupIdleRef.current = null; }
      if (hoverRafRef.current) { cancelAnimationFrame(hoverRafRef.current); hoverRafRef.current = 0; }
      if (heroTimerRef.current) { clearTimeout(heroTimerRef.current); heroTimerRef.current = null; }
      if (searchBlurRef.current) { clearTimeout(searchBlurRef.current); searchBlurRef.current = null; }
      if (canvasRef.current && (canvasRef.current as any).__cleanup) {
        (canvasRef.current as any).__cleanup();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Visual update: highlight selection + filter ────────────────────

  const updateVisuals = useCallback(() => {
    const s = sceneRef.current;
    if (!s) return;

    const ag = activeGenresRef.current;
    const al = allGenresRef.current;
    const { nodes, colorAttr, sizeAttr, brightnessAttr, baseSizes, baseBright, baseColors } = s;
    const selId = selectedIdRef.current;
    const nbIds = neighborIdsRef.current;
    const fnbIds = focusedNbIdsRef.current;
    const pIds = pathIdsRef.current;
    const hasSelection = !!selId;
    const hasFocusedNbs = fnbIds.size > 0;
    const hasPath = pIds.size > 0;
    const filterActive = ag.size > 0 && ag.size < al.length;
    const isDefault = !hasSelection && !hasPath && !filterActive;

    // Fast path: no selection, no path, no filter → restore base values in bulk
    if (isDefault) {
      const cArr = colorAttr.array as Float32Array;
      const sArr = sizeAttr.array as Float32Array;
      const bArr = brightnessAttr.array as Float32Array;
      cArr.set(baseColors);
      sArr.set(baseSizes);
      bArr.set(baseBright);
      colorAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;
      brightnessAttr.needsUpdate = true;
    } else {
      // Slow path: only runs when selection/path/filter is active.
      // Writes directly to typed arrays (avoids per-element setXYZ overhead for 60K+ nodes).
      const cArr = colorAttr.array as Float32Array;
      const sArr = sizeAttr.array as Float32Array;
      const bArr = brightnessAttr.array as Float32Array;

      for (let i = 0; i < nodes.length; i++) {
        const nd = nodes[i];
        const isSel = nd.id === selId;
        const isNb = hasSelection && nbIds.has(nd.id);
        const isOnPath = hasPath && pIds.has(nd.id);

        let bright: number;
        let size: number;
        let r = baseColors[i * 3], g = baseColors[i * 3 + 1], b = baseColors[i * 3 + 2];

        if (isSel) {
          bright = 1.8;
          size = 16;
          r = 1; g = 0.7; b = 1;
        } else if (isNb) {
          bright = 1.4;
          size = Math.max(baseSizes[i], nd.isLibrary ? 8 : 6);
          r = 0.3; g = 0.95; b = 0.95;
        } else if (hasFocusedNbs && fnbIds.has(nd.id)) {
          bright = 1.1;
          size = Math.max(baseSizes[i], nd.isLibrary ? 6 : 4);
          r = 0.65; g = 0.35; b = 1.0;
        } else if (isOnPath) {
          bright = 1.5;
          size = Math.max(baseSizes[i], 7);
        } else if (hasSelection || hasPath) {
          bright = baseBright[i] * 0.15;
          size = Math.min(baseSizes[i], nd.isLibrary ? 3 : 1);
        } else if (filterActive && nd.genres.some(gn => ag.has(gn))) {
          bright = Math.min(1.4, baseBright[i] + 0.3);
          size = Math.max(baseSizes[i], nd.isLibrary ? 7 : 4);
        } else if (filterActive) {
          bright = 0.03;
          size = 0.6;
          const grey = 0.15;
          r = r * 0.3 + grey * 0.7;
          g = g * 0.3 + grey * 0.7;
          b = b * 0.3 + grey * 0.7;
        } else {
          bright = baseBright[i];
          size = baseSizes[i];
        }

        const ci = i * 3;
        cArr[ci] = r; cArr[ci + 1] = g; cArr[ci + 2] = b;
        sArr[i] = size;
        bArr[i] = bright;
      }

      colorAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;
      brightnessAttr.needsUpdate = true;
    }

    // ── Genre label visibility ──
    if (s.genreLabels) {
      const hideLabels = hasSelection || hasPath;
      const activeColorIdxs = new Set<number>();
      if (filterActive) {
        for (const g of ag) activeColorIdxs.add(genreToColorIdx([g]));
      }

      for (const child of s.genreLabels.children) {
        const sprite = child as THREE.Sprite;
        const mat = sprite.material as THREE.SpriteMaterial;
        const cidx = sprite.userData.colorIdx as number;

        if (hideLabels) {
          mat.opacity = 0;
        } else if (filterActive) {
          mat.opacity = activeColorIdxs.has(cidx)
            ? sprite.userData.highlightOpacity
            : 0.02;
        } else {
          mat.opacity = sprite.userData.baseOpacity;
        }
      }
    }
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => updateVisuals());
    return () => cancelAnimationFrame(id);
  }, [activeGenres, allGenres, updateVisuals]);

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
      const intensity = Math.max(0.2, 1 - nb.distance * 1.2);
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

  // ─── Focused-neighbor connection lines (secondary web) ─────────────

  const clearFocusedConnections = useCallback(() => {
    const s = sceneRef.current;
    if (!s) return;
    if (s.focusedLines) {
      s.scene.remove(s.focusedLines);
      s.focusedLines.geometry.dispose();
      (s.focusedLines.material as THREE.Material).dispose();
      s.focusedLines = null;
      s.focusedLinesMat = null;
    }
    s.focusedLinesOpacity = 0;
    focusedNbIdsRef.current = new Set();
  }, []);

  const drawFocusedConnections = useCallback((centerNode: GraphNode, nbList: NeighborInfo[]) => {
    const s = sceneRef.current;
    if (!s) return;
    clearFocusedConnections();
    if (nbList.length === 0) return;

    const linePositions: number[] = [];
    const lineColors: number[] = [];
    const lineDistances: number[] = [];

    for (const nb of nbList) {
      if (!nb.node) continue;
      linePositions.push(centerNode.x, centerNode.y, centerNode.z);
      linePositions.push(nb.node.x, nb.node.y, nb.node.z);
      const intensity = Math.max(0.2, 1 - nb.distance * 1.2);
      lineColors.push(0.65 * intensity, 0.35 * intensity, 1.0 * intensity);
      lineColors.push(0.65 * intensity * 0.3, 0.35 * intensity * 0.3, 1.0 * intensity * 0.3);
      const dist = Math.sqrt(
        (nb.node.x - centerNode.x) ** 2 +
        (nb.node.y - centerNode.y) ** 2 +
        (nb.node.z - centerNode.z) ** 2,
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
      opacity: 0,
    });

    const focusedLineObj = new THREE.LineSegments(geo, mat);
    s.scene.add(focusedLineObj);
    s.focusedLines = focusedLineObj;
    s.focusedLinesMat = mat;
    s.focusedLinesOpacity = 0;

    focusedNbIdsRef.current = new Set(nbList.map(nb => nb.id));
    updateVisuals();
  }, [clearFocusedConnections, updateVisuals]);

  // ─── Path helpers ────────────────────────────────────────────────────

  const clearPath = useCallback(() => {
    pathBuildGenRef.current++;
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
          const sp = child as THREE.Sprite;
          if (sp.material) {
            if ((sp.material as THREE.SpriteMaterial).map) (sp.material as THREE.SpriteMaterial).map!.dispose();
            sp.material.dispose();
          }
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
    tex.generateMipmaps = false;
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
    traversalStackRef.current = [];
    setTraversalDepth(0);

    clearFocusedConnections();

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
  }, [updateVisuals, cancelFly, clearFocusedConnections]);

  const rerankNeighbors = useCallback((
    selectedNode: GraphNode,
    candidates: Array<{ id: string; distance: number }>,
    nodeMap: Map<string, GraphNode>,
    k: number,
  ): NeighborInfo[] => {
    const selGenresLower = new Set(selectedNode.genres.map(g => g.toLowerCase()));
    const selThemesLower = new Set((selectedNode.themes ?? []).map(t => t.toLowerCase()));
    const selColor = selectedNode.colorIdx;
    const selDev = selectedNode.developer?.toLowerCase().trim() ?? '';
    const selPub = selectedNode.publisher?.toLowerCase().trim() ?? '';
    const selFranchise = extractFranchiseBase(selectedNode.title);
    const selHasReviews = selectedNode.reviewCount >= 0;
    const selPopLog = selHasReviews ? Math.log10(Math.max(selectedNode.reviewCount, 1)) : -1;
    const selYear = selectedNode.releaseYear ?? 0;
    const selLum = selectedNode.luminance ?? 0.5;

    const scored = candidates.map(r => {
      const nd = nodeMap.get(r.id);
      if (!nd) return { id: r.id, distance: r.distance, node: nd, adj: r.distance + 0.30 };

      if (nd.title.startsWith('Unknown Game')) {
        return { id: r.id, distance: r.distance, node: nd, adj: r.distance + 0.50 };
      }

      const nbGenresLower = nd.genres.map(g => g.toLowerCase());
      const sameCategory = nd.colorIdx === selColor;

      const nbThemesLower = (nd.themes ?? []).map(t => t.toLowerCase());
      const nbThemeSet = new Set(nbThemesLower);

      let adj = r.distance;

      // ── Popularity: smooth log curve (skip when review data absent, e.g. Epic) ──
      const nbHasReviews = nd.reviewCount >= 0;
      const nbPopLog = nbHasReviews ? Math.log10(Math.max(nd.reviewCount, 1)) : -1;
      if (nbHasReviews && !nd.isLibrary && nd.reviewCount < 500) {
        adj += 0.12 * Math.max(0, 1 - Math.log10(nd.reviewCount + 1) / 2.7);
      }
      if (selPopLog > 2 && nbPopLog > 2 && Math.abs(selPopLog - nbPopLog) < 1.5) {
        adj -= 0.02;
      }

      // ── Genre: IDF-weighted Jaccard with smooth penalty/bonus curve ──
      const idfJ = idfWeightedJaccard(selGenresLower, nbGenresLower);

      if (nbGenresLower.length === 0) {
        adj += 0.10;
      } else if (idfJ === 0) {
        adj += sameCategory ? 0.10 : 0.25;
      } else {
        const mismatchPenalty = 0.22 * (1 - idfJ) * (1 - idfJ) * (sameCategory ? 0.45 : 1.0);
        const overlapBonus = 0.10 * Math.pow(idfJ, 1.5);
        adj += mismatchPenalty - overlapBonus;
      }

      // ── Genre taxonomy: partial credit for related sub-genres ──
      adj -= genreTaxonomyBonus(selGenresLower, nbGenresLower);

      // ── Themes: proportional Jaccard instead of binary thresholds ──
      let themeJaccard = 0;
      if (selThemesLower.size > 0 && nbThemesLower.length > 0) {
        const intersection = nbThemesLower.filter(t => selThemesLower.has(t)).length;
        const union = new Set([...selThemesLower, ...nbThemeSet]).size;
        themeJaccard = union > 0 ? intersection / union : 0;
      }
      adj -= 0.06 * themeJaccard;

      // ── Franchise/series boost (strong — sequels must cluster) ──
      const nbFranchise = extractFranchiseBase(nd.title);
      const isFranchise = selFranchise.length >= 3 && nbFranchise === selFranchise;
      if (isFranchise) adj -= 0.20;

      // ── Developer affinity ──
      const nbDev = nd.developer?.toLowerCase().trim() ?? '';
      const isDev = selDev !== '' && nbDev !== '' && nbDev === selDev;
      if (isDev) adj -= 0.04;

      // ── Publisher affinity (weaker than dev, avoids double-counting) ──
      const nbPub = nd.publisher?.toLowerCase().trim() ?? '';
      const isPub = selPub !== '' && nbPub !== '' && nbPub === selPub && nbPub !== selDev && nbDev !== selPub;
      if (isPub) adj -= 0.02;

      // ── Release era proximity ──
      let eraMatch = false;
      if (selYear > 0 && nd.releaseYear > 0) {
        const yearGap = Math.abs(selYear - nd.releaseYear);
        if (yearGap <= 2) { adj -= 0.03; eraMatch = true; }
        else if (yearGap <= 5) { adj -= 0.01; eraMatch = true; }
        else if (yearGap >= 15) adj += 0.03;
      }

      // ── Luminance (review quality) proximity ──
      const nbLum = nd.luminance ?? 0.5;
      if (selLum > 0 && nbLum > 0) {
        const lumDiff = Math.abs(selLum - nbLum);
        if (lumDiff < 0.15) adj -= 0.015;
        else if (lumDiff > 0.5) adj += 0.02;
      }

      // ── Multi-signal synergy: compound bonus when multiple signals align ──
      let signals = 0;
      if (idfJ >= 0.5) signals++;
      if (themeJaccard >= 0.3) signals++;
      if (eraMatch) signals++;
      if (isFranchise) signals++;
      if (isDev) signals++;
      if (signals >= 3) adj -= 0.02 * (signals - 2);

      return { id: r.id, distance: r.distance, node: nd, adj };
    });

    scored.sort((a, b) => a.adj - b.adj);
    const MAX_DISTANCE = 1.5;
    const out: NeighborInfo[] = [];
    for (const s of scored) {
      if (out.length >= k) break;
      if (s.distance > MAX_DISTANCE) continue;
      if (s.node?.title.startsWith('Unknown Game')) continue;
      out.push({ id: s.id, distance: s.distance, node: s.node });
    }
    return out;
  }, []);

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
      let nbList: NeighborInfo[] = [];
      if (useMock) {
        // Mock: euclidean distance neighbors for the final path node
        const k = neighborK.current;
        const all = loadedNodesRef.current;
        const dists: { id: string; distance: number }[] = [];
        for (const other of all) {
          if (other.id === node.id) continue;
          const dx = other.x - node.x, dy = other.y - node.y, dz = other.z - node.z;
          dists.push({ id: other.id, distance: Math.sqrt(dx * dx + dy * dy + dz * dz) });
        }
        dists.sort((a, b) => a.distance - b.distance);
        nbList = dists.slice(0, k).map(d => ({ id: d.id, distance: d.distance, node: s.nodeMap.get(d.id) }));
      } else {
        const vec = await getEmbeddingById(node.id);
        if (selectedIdRef.current !== node.id) return;
        if (vec && annIndex.isReady) {
          const overFetch = neighborK.current * 8 + 1;
          const results = await annIndex.queryWithDistances(vec, overFetch);
          if (selectedIdRef.current !== node.id) return;
          const filtered = results.filter(r => r.id !== node.id);
          const poolK = Math.min(NEIGHBOR_HEURISTIC_POOL, filtered.length);
          nbList = rerankNeighbors(node, filtered, s.nodeMap, poolK);
          if (selectedIdRef.current !== node.id) return;
          const rrPath = await applyOllamaNeighborRerank(node, nbList, neighborK.current, {
            neighborRerankEnabled: neighborRerankEnabledRef.current,
          });
          nbList = rrPath.neighbors;
          setNeighborRerankHint(neighborRerankBadge(rrPath.status));
          if (selectedIdRef.current !== node.id) return;
        }
      }
      neighborIdsRef.current = new Set(nbList.map(nb => nb.id));
      setNeighbors(nbList);
      setConnectionCount(nbList.length);
      drawConnections(node, nbList);
    } else {
      const next = pn[idx + 1];
      let cosDist = 0;
      if (!useMock) {
        const [vecA, vecB] = await Promise.all([getEmbeddingById(node.id), getEmbeddingById(next.id)]);
        if (selectedIdRef.current !== node.id) return;
        cosDist = vecA && vecB ? cosineDistance(vecA, vecB) : 0;
      } else {
        // Euclidean distance as mock substitute for cosine distance
        const dx = next.x - node.x, dy = next.y - node.y, dz = next.z - node.z;
        cosDist = Math.sqrt(dx * dx + dy * dy + dz * dz) / 100;
      }
      const nbList: NeighborInfo[] = [{ id: next.id, distance: +cosDist.toFixed(4), node: next }];
      neighborIdsRef.current = new Set([next.id]);
      setNeighbors(nbList);
      setConnectionCount(1);
      drawConnections(node, nbList);
    }

    updateVisuals();

    let maxEdgeLen = 0;
    const nbs = isLast ? neighborIdsRef.current : new Set([pn[idx + 1]?.id]);
    for (const nbId of nbs) {
      const nbNode = s.nodeMap.get(nbId);
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
  }, [rerankNeighbors, drawConnections, updateVisuals, startFly, useMock]);

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

    let pathNodes: GraphNode[] = [];
    let pathVecs: (number[] | null)[] = [];

    if (useMock) {
      // Mock mode: sort library nodes by releaseYear to simulate play chronology
      pathNodes = loadedNodesRef.current
        .filter(n => n.isLibrary && n.hoursPlayed > 0)
        .sort((a, b) => a.releaseYear - b.releaseYear);
      pathVecs = pathNodes.map(() => null); // no real embeddings
    } else {
      const journeyEntries = journeyStore.getAllEntries()
        .filter(e => e.firstPlayedAt)
        .sort((a, b) => new Date(a.firstPlayedAt!).getTime() - new Date(b.firstPlayedAt!).getTime());

      if (journeyEntries.length < 2) return;

      for (const je of journeyEntries) {
        const n = s.nodeMap.get(je.gameId);
        if (n) pathNodes.push(n);
      }
    }

    if (pathNodes.length < 2) return;

    pathNodesRef.current = pathNodes;
    pathIdsRef.current = new Set(pathNodes.map(n => n.id));
    setPathActive(true);

    const myPathGen = ++pathBuildGenRef.current;

    if (!useMock) {
      pathVecs = await Promise.all(pathNodes.map(n => getEmbeddingById(n.id)));
      if (pathBuildGenRef.current !== myPathGen) return;
    }

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

      const vecA = pathVecs[i], vecB = pathVecs[i + 1];
      const cosDist = vecA && vecB ? cosineDistance(vecA, vecB) : null;

      const hours = a.hoursPlayed;
      const mid = new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2 + 4, (a.z + b.z) / 2);
      const label = cosDist != null
        ? `${hours.toFixed(0)}h · d=${cosDist.toFixed(3)}`
        : `${hours.toFixed(0)}h`;
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
  }, [pathActive, clearPath, clearSelection, makeTextSprite, updateVisuals, startFly, useMock]);

  const startPathExplore = useCallback(() => {
    setPathOverview(false);
    selectPathNode(0);
  }, [selectPathNode]);

  const [screenshotSaving, setScreenshotSaving] = useState(false);
  const screenshotSavingRef = useRef(false);

  const captureScreenshot = useCallback(async () => {
    const area = screenshotAreaRef.current;
    if (!area || screenshotSavingRef.current) return;
    screenshotSavingRef.current = true;
    setScreenshotSaving(true);
    try {
      const s = sceneRef.current;
      if (s) s.composer.render();

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
    screenshotSavingRef.current = false;
    setScreenshotSaving(false);
  }, []);

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

    let nbList: NeighborInfo[] = [];

    if (useMock) {
      // In mock mode: compute neighbors by 3D euclidean distance
      const k = neighborK.current;
      const all = loadedNodesRef.current;
      if (all.length > 0) {
        const dists: { id: string; distance: number }[] = [];
        for (const other of all) {
          if (other.id === node.id) continue;
          const dx = other.x - node.x;
          const dy = other.y - node.y;
          const dz = other.z - node.z;
          dists.push({ id: other.id, distance: Math.sqrt(dx * dx + dy * dy + dz * dz) });
        }
        dists.sort((a, b) => a.distance - b.distance);
        const top = dists.slice(0, k);
        nbList = top.map(d => ({
          id: d.id,
          distance: d.distance,
          node: s.nodeMap.get(d.id),
        }));
      }
    } else {
      const vec = await getEmbeddingById(node.id);
      if (selectedIdRef.current !== node.id) return;

      if (vec && annIndex.isReady) {
        const overFetch = neighborK.current * 8 + 1;
        const results = await annIndex.queryWithDistances(vec, overFetch);
        if (selectedIdRef.current !== node.id) return;
        const filtered = results.filter(r => r.id !== node.id);
        const poolK = Math.min(NEIGHBOR_HEURISTIC_POOL, filtered.length);
        nbList = rerankNeighbors(node, filtered, s.nodeMap, poolK);
        if (selectedIdRef.current !== node.id) return;
        const rrSel = await applyOllamaNeighborRerank(node, nbList, neighborK.current, {
          neighborRerankEnabled: neighborRerankEnabledRef.current,
        });
        nbList = rrSel.neighbors;
        setNeighborRerankHint(neighborRerankBadge(rrSel.status));
        if (selectedIdRef.current !== node.id) return;
      }
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
  }, [rerankNeighbors, drawConnections, updateVisuals, startFly, pathActive, clearPath, useMock]);

  // ─── Camera fly helper ──────────────────────────────────────────────

  const flyToNode3D = useCallback((node: GraphNode) => {
    const s = sceneRef.current;
    if (!s) return;
    const pos = new THREE.Vector3(node.x, node.y, node.z);
    const dir = new THREE.Vector3().subVectors(s.camera.position, pos).normalize();
    const endCamPos = pos.clone().add(dir.multiplyScalar(100));
    startFly(pos, endCamPos, 1600);
  }, [startFly]);

  // ─── Traversal: dive into neighbor's neighbors ─────────────────────

  const traverseInto = useCallback((node: GraphNode) => {
    if (!selectedNode) return;
    traversalStackRef.current = [...traversalStackRef.current, selectedNode];
    setTraversalDepth(traversalStackRef.current.length);
    setDetailOpen(false);
    flyToNode3D(node);
    selectNode(node, false);
  }, [selectedNode, selectNode, flyToNode3D]);

  const traverseBack = useCallback(() => {
    const stack = traversalStackRef.current;
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1];
    traversalStackRef.current = stack.slice(0, -1);
    setTraversalDepth(traversalStackRef.current.length);
    setDetailOpen(false);
    flyToNode3D(prev);
    selectNode(prev, false);
  }, [selectNode, flyToNode3D]);

  // ─── Interaction handlers ──────────────────────────────────────────

  const handleCanvasClick = useCallback(async (e: React.MouseEvent) => {
    const s = sceneRef.current;
    if (!s) return;

    // Phase 2 — Stargazer mode: click anywhere to append the nearest node to the path.
    if (stargazerActiveRef.current) {
      const rect = cachedRectRef.current ?? s.renderer.domElement.getBoundingClientRect();
      s.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      s.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      s.raycaster.setFromCamera(s.mouse, s.camera);
      const hits = s.raycaster.intersectObject(s.points);
      if (hits.length > 0 && hits[0].index !== undefined) {
        const node = s.nodes[hits[0].index];
        setStargazerPath((p) => (p[p.length - 1] === node.id ? p : [...p, node.id]));
      }
      return;
    }

    if (!selectedIdRef.current) return;

    const rect = cachedRectRef.current ?? s.renderer.domElement.getBoundingClientRect();
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
      } else if (selectedNode) {
        traverseInto(node);
      } else {
        await selectNode(node, true);
      }
    }
  }, [selectNode, clearSelection, selectedNode, traverseInto]);

  const handleCanvasMove = useCallback((e: React.MouseEvent) => {
    const cx = e.clientX;
    const cy = e.clientY;
    if (hoverRafRef.current) return;
    hoverRafRef.current = requestAnimationFrame(() => {
      hoverRafRef.current = 0;
      const s = sceneRef.current;
      if (!s) return;
      const tip = tooltipRef.current;

      // Phase 2.1 — Whisper trigger. Runs regardless of selection state.
      // Raycast once; if hovering a broker node, register dwell timer.
      const rect0 = cachedRectRef.current ?? s.renderer.domElement.getBoundingClientRect();
      const mx = ((cx - rect0.left) / rect0.width) * 2 - 1;
      const my = -((cy - rect0.top) / rect0.height) * 2 + 1;
      s.mouse.set(mx, my);
      s.raycaster.setFromCamera(s.mouse, s.camera);
      const whisperHits = s.raycaster.intersectObject(s.points);
      if (whisperHits.length > 0 && whisperHits[0].index !== undefined) {
        const hoverNode = s.nodes[whisperHits[0].index];
        const brokers = gameGraphStore.getBrokerSet();
        if (brokers.has(hoverNode.id) && !whisperSeenRef.current.has(hoverNode.id)) {
          scannerSelectionStore.registerDwell(hoverNode.id, 1200, (gameId) => {
            if (!componentMountedRef.current) return;
            whisperSeenRef.current.add(gameId);
            void (async () => {
              const phrasesModule = await import('@/data/whisper-phrases.json');
              if (!componentMountedRef.current) return; // bailed out during import
              const bank = (phrasesModule.default as { broker: string[] }).broker;
              let h = 5381;
              for (let i = 0; i < gameId.length; i++) h = ((h << 5) + h + gameId.charCodeAt(i)) >>> 0;
              const phrase = bank[h % bank.length];
              setWhisperState({ gameId, phrase, x: cx + 18, y: cy - 12, key: Date.now() });
              if (whisperDismissRef.current) clearTimeout(whisperDismissRef.current);
              whisperDismissRef.current = setTimeout(() => {
                if (!componentMountedRef.current) return;
                setWhisperState((w) => (w && w.gameId === gameId ? null : w));
                whisperDismissRef.current = null;
              }, 2600);
            })();
          });
        }
      }

      if (!selectedIdRef.current) {
        if (hoveredNodeRef2.current) {
          hoveredNodeRef2.current = null;
          if (tip) tip.style.display = 'none';
        }
        return;
      }

      const rect = cachedRectRef.current ?? s.renderer.domElement.getBoundingClientRect();
      s.mouse.x = ((cx - rect.left) / rect.width) * 2 - 1;
      s.mouse.y = -((cy - rect.top) / rect.height) * 2 + 1;
      s.raycaster.setFromCamera(s.mouse, s.camera);

      const intersects = s.raycaster.intersectObject(s.points);
      if (intersects.length > 0 && intersects[0].index !== undefined) {
        const node = s.nodes[intersects[0].index];
        if (node.id === selectedIdRef.current || neighborIdsRef.current.has(node.id)) {
          hoveredNodeRef2.current = node;
          s.renderer.domElement.style.cursor = 'pointer';
          if (tip) {
            tip.style.display = 'block';
            tip.style.left = `${cx - rect.left + 16}px`;
            tip.style.top = `${cy - rect.top - 12}px`;
            const titleEl = tip.querySelector('[data-tip-title]') as HTMLElement | null;
            const devEl = tip.querySelector('[data-tip-dev]') as HTMLElement | null;
            const genreEl = tip.querySelector('[data-tip-genre]') as HTMLElement | null;
            if (titleEl) titleEl.textContent = node.title;
            if (devEl) { devEl.textContent = node.developer || ''; devEl.style.display = node.developer ? '' : 'none'; }
            if (genreEl) { genreEl.textContent = node.genres.slice(0, 3).join(' · '); genreEl.style.display = node.genres.length ? '' : 'none'; }
          }
          return;
        }
      }
      hoveredNodeRef2.current = null;
      s.renderer.domElement.style.cursor = 'default';
      if (tip) tip.style.display = 'none';
    });
  }, []);

  const handleCanvasLeave = useCallback(() => {
    hoveredNodeRef2.current = null;
    if (tooltipRef.current) tooltipRef.current.style.display = 'none';
    const s = sceneRef.current;
    if (s) s.renderer.domElement.style.cursor = 'default';
  }, []);

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

  // ─── Canonical genre grouping (maps raw genres → palette categories) ──

  const genresByCategory = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const g of allGenres) {
      const idx = genreToColorIdx([g]);
      const list = map.get(idx);
      if (list) list.push(g);
      else map.set(idx, [g]);
    }
    return map;
  }, [allGenres]);

  const toggleCanonical = useCallback((colorIdx: number) => {
    const members = genresByCategory.get(colorIdx) ?? [];
    if (members.length === 0) return;
    setActiveGenres(prev => {
      const next = new Set(prev);
      const allActive = members.every(g => next.has(g));
      if (allActive) members.forEach(g => next.delete(g));
      else members.forEach(g => next.add(g));
      return next;
    });
  }, [genresByCategory]);

  // ─── Search autocomplete ──────────────────────────────────────────

  const suggestions = useMemo(() => {
    if (deferredSearchQuery.length < 2 || loadedNodesRef.current.length === 0) return [];
    const q = deferredSearchQuery.toLowerCase().trim();
    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];

    const nodes = loadedNodesRef.current;
    const index = nodeSearchIndex.current;
    const scored: { node: GraphNode; score: number }[] = [];
    let highQualityHits = 0;

    for (let i = 0; i < nodes.length; i++) {
      if (!index[i]) continue;
      const nd = nodes[i];
      if (nd.title.startsWith('Unknown Game')) continue;
      const s = scoreGame(index[i], tokens, q);
      if (s > 0) {
        const boost = nd.isLibrary ? 0.5 : 0;
        scored.push({ node: nd, score: s + boost });
        if (s >= 60) highQualityHits++;
        if (highQualityHits >= 30) break;
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 10).map(s => s.node);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredSearchQuery, nodeCount]);

  const handleSuggestionSelect = useCallback((node: GraphNode) => {
    setSearchFocused(false);
    setSuggestionIdx(-1);
    traversalStackRef.current = [];
    setTraversalDepth(0);
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
  }, [nodeCount, libVersion]);

  const filteredLibNodes = useMemo(() => {
    if (!libSearch) return libraryNodes;
    const q = libSearch.toLowerCase();
    return libraryNodes.filter(n => n.title.toLowerCase().includes(q));
  }, [libraryNodes, libSearch]);

  // Virtualize the library side-panel list — only the rows actually in view get
  // mounted. Without this, 500+ Steam libraries mount 15K+ DOM nodes on open.
  // Row height: image (72) + padding-y (16) + title (~16) + dev (~10) + genres
  // (~22) + gap (6) ≈ 168. The 6px row gap is folded into estimateSize so each
  // virtual slot reserves space for the gap.
  const LIB_ROW_HEIGHT = 168;
  const libRowVirtualizer = useVirtualizer({
    count: filteredLibNodes.length,
    getScrollElement: () => libScrollRef.current,
    estimateSize: () => LIB_ROW_HEIGHT,
    overscan: 6,
  });

  useEffect(() => {
    if (!showLibrary || !selectedNode || !libScrollRef.current) return;
    const idx = filteredLibNodes.findIndex(n => n.id === selectedNode.id);
    if (idx >= 0) libRowVirtualizer.scrollToIndex(idx, { align: 'auto', behavior: 'smooth' });
  }, [selectedNode, showLibrary, filteredLibNodes, libRowVirtualizer]);

  // ─── Neighbor cycling (cinematic tour) ─────────────────────────────

  const cycleableNeighbors = useMemo(
    () => neighbors.filter(nb => nb.node && !nb.node.title.startsWith('Unknown Game')),
    [neighbors],
  );

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

  const handleHeroTypingDone = useCallback(() => {
    heroTimerRef.current = setTimeout(() => setHeroVisible(false), 1800);
  }, []);

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
      } else if (e.key === 'ArrowDown' && focusedNbIdx >= 0) {
        e.preventDefault();
        const nb = cycleableNeighbors[focusedNbIdx];
        if (nb?.node) traverseInto(nb.node);
      } else if (e.key === 'ArrowUp' && traversalDepth > 0) {
        e.preventDefault();
        traverseBack();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedNode, pathActive, handleCycleNext, handleCyclePrev, focusedNbIdx, cycleableNeighbors, traverseInto, traversalDepth, traverseBack]);

  // ─── Secondary connections for focused neighbor ───────────────────
  useEffect(() => {
    if (focusedNbIdx < 0 || !neighbors[focusedNbIdx]?.node) {
      clearFocusedConnections();
      return;
    }
    const focNode = neighbors[focusedNbIdx].node!;
    let cancelled = false;

    (async () => {
      const s = sceneRef.current;
      if (!s) return;

      const selId = selectedIdRef.current;
      const primaryNbs = neighborIdsRef.current;
      const k = neighborK.current;

      let nbList: NeighborInfo[];

      if (useMock) {
        // Mock mode: compute secondary neighbors by euclidean distance
        const all = loadedNodesRef.current;
        const dists: { id: string; distance: number }[] = [];
        for (const other of all) {
          if (other.id === focNode.id || other.id === selId || primaryNbs.has(other.id)) continue;
          const dx = other.x - focNode.x;
          const dy = other.y - focNode.y;
          const dz = other.z - focNode.z;
          dists.push({ id: other.id, distance: Math.sqrt(dx * dx + dy * dy + dz * dz) });
        }
        dists.sort((a, b) => a.distance - b.distance);
        nbList = dists.slice(0, k).map(d => ({
          id: d.id,
          distance: +d.distance.toFixed(4),
          node: s.nodeMap.get(d.id),
        }));
      } else {
        const vec = await getEmbeddingById(focNode.id);
        if (cancelled || !vec || !annIndex.isReady) return;

        const overFetch = k * 4 + 1;
        const results = await annIndex.queryWithDistances(vec, overFetch);
        if (cancelled) return;

        const filtered = results
          .filter(r => r.id !== focNode.id && r.id !== selId && !primaryNbs.has(r.id) && r.distance <= 1.5);

        const poolK = Math.min(NEIGHBOR_HEURISTIC_POOL, filtered.length);
        nbList = rerankNeighbors(focNode, filtered, s.nodeMap, poolK);
        if (cancelled) return;
        const rrFocus = await applyOllamaNeighborRerank(focNode, nbList, k, {
          neighborRerankEnabled: neighborRerankEnabledRef.current,
        });
        nbList = rrFocus.neighbors;
        const badge = neighborRerankBadge(rrFocus.status);
        if (badge) setNeighborRerankHint(badge);
        if (cancelled) return;
      }

      if (cancelled) return;
      drawFocusedConnections(focNode, nbList.filter(nb => nb.node));
    })();

    return () => { cancelled = true; };
  }, [focusedNbIdx, neighbors, clearFocusedConnections, drawFocusedConnections, useMock, rerankNeighbors]);

  const detailOpenRef = useRef(false);
  detailOpenRef.current = detailOpen;

  const toggleDetail = useCallback(async (nodeId: string) => {
    if (detailOpenRef.current && detailNodeIdRef.current === nodeId) {
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
      setDetailLoading(false);
    }
  }, []);

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
        publisher: node.publisher || undefined,
        genre: node.genres,
      },
    });
    node.isLibrary = true;

    const s = sceneRef.current;
    if (s) {
      const idx = s.nodes.indexOf(node);
      if (idx >= 0) {
        const { pubFreq, maxPubLog } = pubFreqRef.current;
        s.baseSizes[idx] = starSize(node, pubFreq, maxPubLog);
        const popNorm = Math.min(Math.log10(Math.max(node.reviewCount, 1)) / 5.3, 1);
        const lumBlend = node.luminance * 0.6 + popNorm * 0.4;
        s.baseBright[idx] = Math.min(1.0, 0.08 + lumBlend * 0.92 + 0.15);
      }
    }
    updateVisuals();
  }, [updateVisuals]);

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
          <TooltipCard content="Return to the Oracle view — your AI recommendation hub.">
            <button
              type="button"
              data-tour="ann-graph-back"
              onClick={onBack}
              className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-white/40 hover:text-white/70 hover:bg-white/5 rounded-md transition-colors cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Oracle
            </button>
          </TooltipCard>
          <div className="w-px h-4 bg-white/[0.06]" />
          <h2 className="text-sm font-medium text-white/70">Embedding Space</h2>
          {!loading && (
            <span className="text-[10px] text-white/30">
              {nodeCount.toLocaleString()} games{connectionCount > 0 ? ` · ${connectionCount} connections` : ''}
              {projectionMethod === 'MOCK'
                ? <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-mono text-[9px] font-bold border border-amber-500/30">MOCK DATA</span>
                : projectionMethod ? ` · ${projectionMethod}` : ''}
              {rendererBackend ? ` · ${rendererBackend}` : ''}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative" data-tour="ann-graph-search" title={loading ? 'Galaxy is still loading…' : undefined}>
            <Search className={`absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 z-10 ${loading ? 'text-white/10' : 'text-white/30'}`} />
            <input
              type="text"
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setSuggestionIdx(-1); }}
              onFocus={() => { if (searchBlurRef.current) { clearTimeout(searchBlurRef.current); searchBlurRef.current = null; } setSearchFocused(true); }}
              onBlur={() => { searchBlurRef.current = setTimeout(() => { searchBlurRef.current = null; setSearchFocused(false); }, 200); }}
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
          <TooltipCard content={loading ? 'Galaxy is still loading — please wait for the embedding space to finish initializing.' : 'Reset the camera and clear any selected star or active path.'}>
            <button onClick={loading ? undefined : handleReset}
              disabled={loading}
              className={`px-2 py-1 text-[10px] rounded-md transition-colors ${loading ? 'text-white/10 cursor-not-allowed' : 'text-white/30 hover:text-white/50 hover:bg-white/5 cursor-pointer'}`}>
              <RotateCcw className="w-3 h-3" />
            </button>
          </TooltipCard>
        </div>
      </div>

      {/* 3D Canvas */}
      <div ref={screenshotAreaRef} className="flex-1 relative overflow-hidden" data-tour="ann-graph-canvas">
        <div
          ref={canvasRef}
          className="absolute inset-0"
          onClick={handleCanvasClick}
          onMouseMove={handleCanvasMove}
          onMouseLeave={handleCanvasLeave}
          onContextMenu={(e) => {
            // Phase 2 — Banner picker on right-click. Only fires for already-selected/hovered node.
            const tgt = hoveredNodeRef2.current ?? selectedNode;
            if (!tgt) return;
            e.preventDefault();
            setBannerMenu({ x: e.clientX, y: e.clientY, gameId: tgt.id });
          }}
        />

        {/* Phase 2 — Cartographer HUD */}
        {streamedLine && scannerMode !== 'stargazer' && (
          <div className="absolute left-4 bottom-4 z-30 max-w-[420px]">
            <div className="bg-white/[0.04] backdrop-blur-md border border-white/[0.08] rounded-lg px-4 py-3 shadow-2xl shadow-black/40 pointer-events-auto">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[10px] uppercase tracking-[0.18em] text-fuchsia-300/55">CARTOGRAPHER</div>
                {selectedNode && (
                  <button
                    onClick={() => setCodexOpen(true)}
                    className="text-[9px] uppercase tracking-[0.15em] text-cyan-300/60 hover:text-cyan-300 transition-colors"
                  >
                    Open Codex ▸
                  </button>
                )}
              </div>
              <div className="text-[13px] text-white/85 font-light leading-snug">
                {streamedLine}
                <span className="inline-block w-[6px] h-[12px] ml-0.5 align-middle bg-fuchsia-300/70 animate-pulse" />
              </div>
            </div>
          </div>
        )}

        {/* Phase 3.0 — Lasso draw + HUD overlay */}
        {lassoActive && (
          <>
            <svg
              className="absolute inset-0 z-30 pointer-events-auto cursor-crosshair"
              style={{ touchAction: 'none' }}
              onPointerDown={(e) => {
                lassoDrawingRef.current = true;
                setLassoCapture(null);
                setLassoPath([{ x: e.clientX, y: e.clientY }]);
                (e.target as SVGSVGElement).setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!lassoDrawingRef.current) return;
                setLassoPath((p) => [...p, { x: e.clientX, y: e.clientY }]);
              }}
              onPointerUp={(e) => {
                if (!lassoDrawingRef.current) return;
                lassoDrawingRef.current = false;
                (e.target as SVGSVGElement).releasePointerCapture(e.pointerId);
                closeLasso(lassoPath);
              }}
            >
              {lassoPath.length >= 2 && (
                <path
                  d={toSvgPath(lassoPath, !lassoDrawingRef.current && pathLength(lassoPath) > 60)}
                  fill={lassoCapture ? 'rgba(168, 85, 247, 0.08)' : 'rgba(168, 85, 247, 0.04)'}
                  stroke="rgba(217, 70, 239, 0.85)"
                  strokeWidth={1.6}
                  strokeDasharray="5 4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 pointer-events-none">
              <div className="bg-white/[0.04] backdrop-blur-md border border-fuchsia-400/30 rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-fuchsia-300/80">
                Lasso · drag to draw · Esc to exit · L to toggle
              </div>
            </div>
            {lassoCapture && (
              <div className="absolute bottom-4 right-4 z-40 w-80 bg-black/85 backdrop-blur-xl border border-fuchsia-400/30 rounded-xl p-4 shadow-2xl shadow-fuchsia-500/10 pointer-events-auto">
                <div className="text-[10px] uppercase tracking-[0.18em] text-fuchsia-300/60 mb-2">Lasso Capture</div>
                <div className="text-2xl font-light text-white/95 mb-1">{lassoCapture.nodeIds.length.toLocaleString()} stars</div>
                {lassoCapture.genres.length > 0 && (
                  <div className="text-[11px] text-white/55 mb-3">
                    Top genres: {lassoCapture.genres.slice(0, 3).map((g) => `${g.name} (${g.count})`).join(', ')}
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => setLassoNamePrompt(true)}
                    disabled={lassoCapture.nodeIds.length < 2}
                    className="flex-1 px-3 py-1.5 rounded-md bg-fuchsia-500/25 hover:bg-fuchsia-500/40 border border-fuchsia-400/30 text-[12px] text-white/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    Save as Constellation
                  </button>
                  <button
                    onClick={() => { setLassoPath([]); setLassoCapture(null); }}
                    className="px-3 py-1.5 rounded-md bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-[12px] text-white/70 transition-colors"
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}
            {lassoNamePrompt && lassoCapture && (
              <>
                <div className="fixed inset-0 z-50 bg-black/40" onClick={() => setLassoNamePrompt(false)} />
                <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-black/95 backdrop-blur-2xl border border-fuchsia-400/30 rounded-xl p-5 w-80 shadow-2xl">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-fuchsia-300/70 mb-2">Name this constellation</div>
                  <input
                    autoFocus
                    value={lassoNameInput}
                    onChange={(e) => setLassoNameInput(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === 'Enter' && lassoNameInput.trim()) {
                        const ok = await userMarksStore.addConstellation(lassoNameInput, lassoCapture.nodeIds);
                        if (!ok) console.warn('[Lasso] constellation cap reached');
                        setLassoNamePrompt(false);
                        setLassoNameInput('');
                        setLassoPath([]);
                        setLassoCapture(null);
                        setLassoActive(false);
                        const sRef = sceneRef.current;
                        if (sRef) sRef.controls.enabled = true;
                      } else if (e.key === 'Escape') {
                        setLassoNamePrompt(false);
                      }
                    }}
                    placeholder="The..."
                    className="w-full bg-white/[0.04] border border-white/[0.1] rounded-md px-3 py-2 text-sm text-white/90 placeholder-white/30 focus:outline-none focus:border-fuchsia-400/40"
                  />
                  <div className="text-[10px] text-white/30 mt-2">{lassoCapture.nodeIds.length} stars · Enter to save · Esc to dismiss</div>
                </div>
              </>
            )}
          </>
        )}

        {/* Phase 3.0 — Timeshear scrubber */}
        {timeshearActive && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 w-[min(640px,80vw)] pointer-events-auto">
            <div className="bg-black/70 backdrop-blur-xl border border-cyan-400/25 rounded-xl p-3 shadow-2xl shadow-cyan-500/10">
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10px] uppercase tracking-[0.18em] text-cyan-300/65">
                  Timeshear · {formatWeekLabel(timeshearWeek)}
                </div>
                <button
                  onClick={exitTimeshear}
                  className="text-[10px] uppercase tracking-[0.15em] text-white/40 hover:text-white/80 transition-colors"
                >
                  Return to now ✕
                </button>
              </div>
              <input
                type="range"
                min={0}
                max={TIMESHEAR_WEEKS - 1}
                step={1}
                value={timeshearWeek}
                onChange={(e) => {
                  const w = Number(e.target.value);
                  setTimeshearWeek(w);
                  if (timeshearRafRef.current) cancelAnimationFrame(timeshearRafRef.current);
                  timeshearRafRef.current = requestAnimationFrame(() => {
                    timeshearRafRef.current = 0;
                    applyTimeshearWeek(w);
                  });
                }}
                className="w-full accent-cyan-400"
              />
              <div className="flex justify-between text-[9px] text-white/30 mt-1">
                <span>1 year ago</span>
                <span>6 months ago</span>
                <span>now</span>
              </div>
            </div>
          </div>
        )}

        {/* Phase 3.0 — Timeshear launch button (only when graph + library are loaded) */}
        {!timeshearActive && !flythroughActive && !lassoActive && selectedNode === null && !loading && (
          <button
            onClick={enterTimeshear}
            className="absolute bottom-4 right-4 z-20 bg-white/[0.04] hover:bg-white/[0.08] backdrop-blur-md border border-cyan-400/25 rounded-full px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] text-cyan-300/70 hover:text-cyan-200 transition-colors"
            title="Scrub the past year of your library"
          >
            ◴ Timeshear
          </button>
        )}

        {/* Phase 3.0 — Year Wrapped Flythrough lower-thirds + exit hint */}
        {flythroughActive && (
          <>
            {flythroughLowerThird && (
              <motion.div
                key={flythroughLowerThird.index}
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -24 }}
                transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                className="absolute left-1/2 bottom-16 -translate-x-1/2 z-30 pointer-events-none"
              >
                <div className="bg-black/55 backdrop-blur-md border border-white/[0.08] rounded-lg px-6 py-4 max-w-[560px] text-center shadow-2xl shadow-black/70">
                  <div className="text-[10px] uppercase tracking-[0.24em] text-fuchsia-300/55 mb-1.5">
                    The Voyage · Keyframe {flythroughLowerThird.index + 1}
                  </div>
                  <div className="text-[22px] font-light text-white/95 mb-1 leading-tight">
                    {flythroughLowerThird.title}
                  </div>
                  <div className="text-[11px] text-white/55">
                    {flythroughLowerThird.subtitle}
                  </div>
                </div>
              </motion.div>
            )}
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
              <div className="bg-white/[0.04] backdrop-blur-md border border-fuchsia-400/30 rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-fuchsia-300/80">
                Cinematic · Esc to exit
              </div>
            </div>
          </>
        )}

        {/* Phase 2.1 — Codex 2-page spread */}
        {codexOpen && selectedNode && (() => {
          const buffers = gameGraphStore.getScoreBuffers();
          const communityName = sceneRef.current?.constellationLabels?.children?.find(
            (c) => c.userData.communityId === gameGraphStore.getScores(selectedNode.id)?.community,
          )?.userData.name as string | undefined;
          const stellarClass = sceneRef.current?.stellarClassByGameId.get(selectedNode.id);
          const spread = narratorBus.getCuratorSpread(selectedNode.id, communityName, stellarClass);
          const total = buffers?.nodeIds.length ?? 0;
          return (
            <>
              <div
                className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm"
                onClick={() => setCodexOpen(false)}
              />
              <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[820px] max-w-[92vw] h-[480px] max-h-[88vh] grid grid-cols-2 gap-0 rounded-lg overflow-hidden shadow-[0_30px_120px_-20px_rgba(0,0,0,0.95)]"
                style={{ filter: 'sepia(0.35) contrast(1.05)' }}
              >
                {/* Left page — classification */}
                <div className="bg-[#1a1410] border-r border-[#3d2f25] p-8 flex flex-col">
                  <div className="text-[10px] uppercase tracking-[0.22em] text-amber-200/40 mb-3">
                    Codex Entry · {codexUnlockedCount} / {total.toLocaleString()} charted
                  </div>
                  <div className="text-[24px] font-serif text-amber-100/85 mb-1 leading-tight">
                    {selectedNode.title}
                  </div>
                  {stellarClass && (
                    <div className="text-[11px] uppercase tracking-[0.18em] text-amber-200/60 mb-4">
                      {stellarClass}
                    </div>
                  )}
                  <div className="text-[13px] italic font-serif text-amber-50/65 leading-relaxed flex-1">
                    {spread.left}
                  </div>
                  <div className="text-[9px] uppercase tracking-[0.18em] text-amber-200/30 mt-4">
                    — Curator’s Field Journal —
                  </div>
                </div>
                {/* Right page — narrative observation */}
                <div className="bg-[#15100d] p-8 flex flex-col">
                  {selectedNode.coverUrl && (
                    <div className="w-full h-32 rounded overflow-hidden mb-3 border border-[#3d2f25]" style={{ filter: 'sepia(0.6) contrast(1.05) brightness(0.85)' }}>
                      <FallbackImg node={selectedNode} className="w-full h-full object-cover" />
                    </div>
                  )}
                  <div className="text-[13px] font-serif text-amber-50/75 leading-relaxed flex-1">
                    {spread.right}
                  </div>
                  <div className="flex items-center justify-between mt-4">
                    <div className="text-[10px] text-amber-200/35">
                      {communityName ?? 'Unmapped Reach'}
                    </div>
                    <button
                      onClick={() => setCodexOpen(false)}
                      className="text-[10px] uppercase tracking-[0.18em] text-amber-200/50 hover:text-amber-100 transition-colors"
                    >
                      Close ✕
                    </button>
                  </div>
                </div>
              </div>
            </>
          );
        })()}

        {/* Phase 2 — Probe mode SVG overlay */}
        {scannerMode === 'probe' && (
          <>
            <svg
              ref={probeSvgRef}
              className="absolute left-1/2 top-1/2 pointer-events-none z-20"
              style={{ width: 32, height: 32, transform: 'translate(-50%, -50%)' }}
              viewBox="0 0 32 32"
            >
              <polygon points="16,4 28,28 4,28" fill="rgba(167, 139, 250, 0.18)" stroke="rgba(167, 139, 250, 0.85)" strokeWidth="1.5" />
              <circle cx="16" cy="20" r="2" fill="rgba(167, 139, 250, 0.9)" />
            </svg>
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
              <div className="bg-white/[0.04] backdrop-blur-md border border-fuchsia-400/30 rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-fuchsia-300/80">
                Probe Mode · WASD to drift · P to exit
              </div>
            </div>
          </>
        )}

        {/* Phase 2 — Stargazer mode indicator */}
        {scannerMode === 'stargazer' && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
            <div className="bg-white/[0.04] backdrop-blur-md border border-cyan-400/30 rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-cyan-300/80">
              Stargazer · {stargazerPath.length} stars · Enter to name · Esc to cancel
            </div>
          </div>
        )}

        {/* Phase 2 — Whisper drift (on broker hover) */}
        {whisperState && (
          <div
            key={whisperState.key}
            className="absolute z-30 pointer-events-none italic text-white/55 text-[12px] font-light"
            style={{
              left: whisperState.x,
              top: whisperState.y,
              animation: 'whisper-drift 2500ms ease-out forwards',
            }}
          >
            {whisperState.phrase}
          </div>
        )}

        {/* Phase 2 — Banner picker context menu */}
        {bannerMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setBannerMenu(null)} />
            <div
              className="absolute z-50 bg-black/85 backdrop-blur-xl border border-white/[0.08] rounded-lg p-2 shadow-2xl shadow-black/60"
              style={{ left: bannerMenu.x, top: bannerMenu.y }}
            >
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/40 px-2 py-1">Plant Banner</div>
              <div className="flex gap-1.5 px-1.5 pb-1.5 pt-0.5">
                {BANNER_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => {
                      userMarksStore.setBanner(bannerMenu.gameId, c);
                      setBannerMenu(null);
                    }}
                    className="w-7 h-7 rounded-full border border-white/15 hover:scale-110 transition-transform"
                    style={{ background: `rgb(${BANNER_RGB[c][0] * 255}, ${BANNER_RGB[c][1] * 255}, ${BANNER_RGB[c][2] * 255})` }}
                    title={c}
                  />
                ))}
                <button
                  onClick={() => {
                    userMarksStore.removeBanner(bannerMenu.gameId);
                    setBannerMenu(null);
                  }}
                  className="w-7 h-7 rounded-full border border-white/15 bg-black hover:scale-110 transition-transform flex items-center justify-center text-white/40"
                  title="Remove banner"
                >
                  ✕
                </button>
              </div>
            </div>
          </>
        )}

        {/* Phase 2 — Stargazer name prompt */}
        {stargazerNamePrompt && (
          <>
            <div className="fixed inset-0 z-40 bg-black/40" onClick={() => setStargazerNamePrompt(false)} />
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-black/90 backdrop-blur-2xl border border-cyan-400/30 rounded-xl p-5 w-80 shadow-2xl">
              <div className="text-[10px] uppercase tracking-[0.18em] text-cyan-300/70 mb-2">Name this constellation</div>
              <input
                autoFocus
                value={stargazerNameInput}
                onChange={(e) => setStargazerNameInput(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && stargazerNameInput.trim()) {
                    const ok = await userMarksStore.addConstellation(stargazerNameInput, stargazerPath);
                    if (!ok) console.warn('[Stargazer] constellation cap reached');
                    setStargazerNamePrompt(false);
                    setStargazerNameInput('');
                    setStargazerPath([]);
                    setScannerMode('observer');
                  } else if (e.key === 'Escape') {
                    setStargazerNamePrompt(false);
                  }
                }}
                placeholder="The..."
                className="w-full bg-white/[0.04] border border-white/[0.1] rounded-md px-3 py-2 text-sm text-white/90 placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
              />
              <div className="text-[10px] text-white/30 mt-2">{stargazerPath.length} stars connected · Enter to save · Esc to discard</div>
            </div>
          </>
        )}

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

              {/* Scrollable game card list — virtualized so only the visible
                  rows render even when the library has 500+ games. */}
              <div ref={libScrollRef} className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide px-2 py-2">
                {filteredLibNodes.length === 0 && (
                  <div className="text-[10px] text-white/20 text-center py-8">
                    {libSearch ? 'No matches' : 'No library games found'}
                  </div>
                )}
                {filteredLibNodes.length > 0 && (
                  <div
                    style={{
                      height: `${libRowVirtualizer.getTotalSize()}px`,
                      position: 'relative',
                    }}
                  >
                    {libRowVirtualizer.getVirtualItems().map(virtualRow => {
                      const node = filteredLibNodes[virtualRow.index];
                      const isActive = selectedNode?.id === node.id;
                      return (
                        <button
                          key={node.id}
                          data-active={isActive || undefined}
                          onClick={() => { traversalStackRef.current = []; setTraversalDepth(0); selectNode(node, true); }}
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: `${virtualRow.size}px`,
                            transform: `translateY(${virtualRow.start}px)`,
                            paddingBottom: '6px', // preserves the previous space-y-1.5 visual gap
                          }}
                          className={`rounded-lg overflow-hidden text-left transition-all duration-200 cursor-pointer group/card border ${
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
                )}
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

        <AnimatePresence>
          {loading && (
            <motion.div
              key="galaxy-loader"
              initial={{ opacity: 1 }}
              exit={{ opacity: 0, pointerEvents: 'none' as any }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
              className="absolute inset-0 z-30"
            >
              <LoadingSkeleton steps={loadingSteps} />
            </motion.div>
          )}
        </AnimatePresence>

        {emptyGalaxy && !loading && (
          <div className="absolute inset-0 flex items-center justify-center z-30 bg-black/80">
            <div className="text-center max-w-md px-6">
              <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-fuchsia-500/10 border border-fuchsia-500/20 flex items-center justify-center">
                <Waypoints className="w-8 h-8 text-fuchsia-400/60" />
              </div>
              <h3 className="text-lg font-semibold text-white/80 mb-2">Embedding Space Requires Ollama</h3>
              <p className="text-sm text-white/40 mb-5 leading-relaxed">
                The galaxy map visualizes game embeddings generated by Ollama's Snowflake Arctic Embed model.
                Install Ollama and restart the app to unlock this feature.
              </p>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={onBack}
                  className="px-4 py-2 text-xs font-medium text-white/50 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10 transition-colors"
                >
                  Go Back
                </button>
                <a
                  href="https://ollama.com/download"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 text-xs font-medium text-fuchsia-400 bg-fuchsia-500/10 border border-fuchsia-500/30 rounded-lg hover:bg-fuchsia-500/20 transition-colors"
                >
                  Download Ollama
                </a>
              </div>
            </div>
          </div>
        )}

        <HeroIntro visible={heroVisible} onTypingDone={handleHeroTypingDone} />

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
                    ? pathActive && pathIdx >= 0
                      ? 'w-[320px] bg-black/90 border border-blue-500/30 shadow-xl shadow-blue-500/15 ring-1 ring-blue-500/10'
                      : 'w-[320px] bg-black/90 border border-fuchsia-500/30 shadow-xl shadow-fuchsia-500/15 ring-1 ring-fuchsia-500/10'
                    : 'w-[100px] bg-black/40 border border-white/[0.03] opacity-15'
                }`}>
                  <div className={`w-full bg-black/40 overflow-hidden transition-all duration-300 ${focusedNbIdx === -1 ? 'h-[120px]' : 'h-[20px]'}`}>
                    <FallbackImg node={selectedNode} className="w-full h-full object-cover" />
                  </div>
                  <div className={`transition-all duration-300 ${focusedNbIdx === -1 ? 'px-3.5 py-3' : 'px-1.5 py-1'}`}>
                    <div className={`flex items-center gap-1.5 transition-all duration-300 ${focusedNbIdx === -1 ? '' : ''}`}>
                      <div
                        className={`font-semibold text-white leading-tight flex-1 min-w-0 transition-all duration-300 ${focusedNbIdx === -1 ? 'text-[15px] text-white line-clamp-2' : 'text-[7px] text-white/20 truncate'}`}
                        style={focusedNbIdx === -1 ? { minHeight: '2lh' } : undefined}
                      >
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
                              <span key={g} className={`text-[8px] px-1.5 py-[1px] rounded leading-tight ${pathActive && pathIdx >= 0 ? 'bg-blue-500/10 text-blue-400/70' : 'bg-fuchsia-500/10 text-fuchsia-400/70'}`}>{g}</span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {focusedNbIdx === -1 && (
                  <div className="absolute left-full top-0 bottom-0 ml-2.5 flex flex-col justify-between py-1 select-none" style={{ width: 190 }}>
                    <div className={`flex flex-col gap-[3px] font-mono text-[10px] leading-none tracking-wider pointer-events-none ${pathActive && pathIdx >= 0 ? 'text-blue-400/30' : 'text-fuchsia-400/30'}`}>
                      <span className={pathActive && pathIdx >= 0 ? 'text-blue-400/20' : 'text-fuchsia-400/20'}>{pathActive && pathIdx >= 0 ? '// THE PATH' : '// GAME EMBEDDING'}</span>
                      {pathActive && pathIdx >= 0 && (
                        <>
                          <span className="mt-1 text-blue-400/50">STEP::{pathIdx + 1}/{pathNodesRef.current.length}</span>
                          {isLastPathNode && <span className="text-blue-400/40">★ FINAL NODE</span>}
                        </>
                      )}
                      <span className="mt-1">SYS::NODE</span>
                      <span className={pathActive && pathIdx >= 0 ? 'text-blue-400/50' : 'text-fuchsia-400/50'}>{selectedNode.id.slice(0, 12).toUpperCase()}</span>
                      <span className="mt-1">POS</span>
                      <span className={pathActive && pathIdx >= 0 ? 'text-blue-400/40' : 'text-fuchsia-400/40'}>{selectedNode.x.toFixed(1)}</span>
                      <span className={pathActive && pathIdx >= 0 ? 'text-blue-400/40' : 'text-fuchsia-400/40'}>{selectedNode.y.toFixed(1)}</span>
                      <span className={pathActive && pathIdx >= 0 ? 'text-blue-400/40' : 'text-fuchsia-400/40'}>{selectedNode.z.toFixed(1)}</span>
                      <span className="mt-1">LINKS::{connectionCount}</span>
                      {traversalDepth > 0 && <span className="mt-1 text-amber-400/50">DEPTH::{traversalDepth}</span>}
                      {selectedNode.isLibrary && <span className="text-emerald-400/40">LIB::OWNED</span>}
                      {selectedNode.hoursPlayed > 0 && <span className={pathActive && pathIdx >= 0 ? 'text-blue-400/40' : 'text-fuchsia-400/40'}>TIME::{selectedNode.hoursPlayed.toFixed(1)}h</span>}
                      <span className={pathActive && pathIdx >= 0 ? 'text-blue-400/20' : 'text-fuchsia-400/20'}>CLR::{selectedNode.colorIdx.toString(16).toUpperCase().padStart(2, '0')}</span>
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
                              focusedNbIdx === -1
                                ? pathActive ? 'text-blue-400/80 bg-blue-500/10' : 'text-fuchsia-400/80 bg-fuchsia-500/10'
                                : 'text-white/40 hover:text-white/70 hover:bg-white/10'
                            }`} title="Refocus on selected">
                              <Crosshair className="w-3 h-3" />
                            </button>
                          )}
                          <span className="text-[8px] text-white/30 tabular-nums font-mono flex-1 text-center">
                            {pathActive && pathIdx >= 0
                              ? (isLastPathNode
                                  ? (focusedNbIdx === -1 ? `★ ${pathIdx + 1}/${pathNodesRef.current.length}` : `${focusedNbIdx + 1}/${cycleableNeighbors.length}`)
                                  : `${pathIdx + 1}/${pathNodesRef.current.length}`)
                              : (focusedNbIdx === -1
                                  ? (traversalDepth > 0 ? `↳ D${traversalDepth}` : '—')
                                  : `${focusedNbIdx + 1}/${cycleableNeighbors.length}`)}
                          </span>
                          <button onClick={handleCycleNext} className="p-1 rounded text-white/40 hover:text-white/80 hover:bg-white/10 transition-colors cursor-pointer" title={pathActive && !isLastPathNode ? 'Next game on path' : 'Next neighbor'}>
                            <ChevronRight className="w-3 h-3" />
                          </button>
                        </>
                      )}
                      {traversalDepth > 0 && (
                        <button
                          onClick={traverseBack}
                          className="p-1 rounded text-amber-400/60 hover:text-amber-400 hover:bg-amber-500/15 transition-colors cursor-pointer"
                          title={`Back to ${traversalStackRef.current[traversalStackRef.current.length - 1]?.title ?? 'previous node'}`}
                        >
                          <Undo2 className="w-3 h-3" />
                        </button>
                      )}
                      <TooltipCard content="View full details — store info, reviews, screenshots, and description.">
                        <button
                          onClick={() => toggleDetail(selectedNode.id)}
                          className={`p-1 rounded transition-colors cursor-pointer ${
                            detailOpen && detailNodeIdRef.current === selectedNode.id
                              ? pathActive ? 'text-blue-400/80 bg-blue-500/10' : 'text-fuchsia-400/80 bg-fuchsia-500/10'
                              : 'text-white/40 hover:text-white/70 hover:bg-white/10'
                          }`}
                        >
                          {detailLoading && detailNodeIdRef.current === selectedNode.id
                            ? <Loader2 className="w-3 h-3 animate-spin" />
                            : <Info className="w-3 h-3" />}
                        </button>
                      </TooltipCard>
                      {!libraryStore.isInLibrary(selectedNode.id) ? (
                        <TooltipCard content="Add this game to your personal library to track it.">
                          <button
                            onClick={() => addNodeToLibrary(selectedNode)}
                            className="p-1 rounded text-emerald-400/60 hover:text-emerald-400 hover:bg-emerald-500/15 transition-colors cursor-pointer"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </TooltipCard>
                      ) : (
                        <TooltipCard content="This game is already in your library.">
                          <span className="p-1 text-emerald-400/40">
                            <Check className="w-3 h-3" />
                          </span>
                        </TooltipCard>
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
                      className={`overflow-hidden rounded-lg bg-black/90 backdrop-blur-xl pointer-events-auto w-[320px] ${pathActive && pathIdx >= 0 ? 'border border-blue-500/20 shadow-xl shadow-blue-500/10' : 'border border-fuchsia-500/20 shadow-xl shadow-fuchsia-500/10'}`}
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
                        <div
                          className={`font-semibold leading-tight flex-1 min-w-0 transition-all duration-300 ${isFocused ? 'text-[15px] text-white line-clamp-2' : 'text-[7px] text-white/30 truncate'}`}
                          style={isFocused ? { minHeight: '2lh' } : undefined}
                        >
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
                        <TooltipCard content="Traverse into — explore this game's own neighbors and see what's similar to it.">
                          <button
                            onClick={() => traverseInto(nb.node!)}
                            className="p-1 rounded text-amber-400/60 hover:text-amber-400 hover:bg-amber-500/15 transition-colors cursor-pointer"
                          >
                            <CornerDownRight className="w-3 h-3" />
                          </button>
                        </TooltipCard>
                        <TooltipCard content="View full details — store info, reviews, screenshots, and description.">
                          <button
                            onClick={() => toggleDetail(nb.node!.id)}
                            className={`p-1 rounded transition-colors cursor-pointer ${
                              detailOpen && detailNodeIdRef.current === nb.node!.id
                                ? 'text-cyan-400/80 bg-cyan-500/10'
                                : 'text-white/40 hover:text-white/70 hover:bg-white/10'
                            }`}
                          >
                            {detailLoading && detailNodeIdRef.current === nb.node!.id
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : <Info className="w-3 h-3" />}
                          </button>
                        </TooltipCard>
                        {!libraryStore.isInLibrary(nb.node!.id) ? (
                          <TooltipCard content="Add this game to your personal library to track it.">
                            <button
                              onClick={() => addNodeToLibrary(nb.node!)}
                              className="p-1 rounded text-emerald-400/60 hover:text-emerald-400 hover:bg-emerald-500/15 transition-colors cursor-pointer"
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                          </TooltipCard>
                        ) : (
                          <TooltipCard content="This game is already in your library.">
                            <span className="p-1 text-emerald-400/40">
                              <Check className="w-3 h-3" />
                            </span>
                          </TooltipCard>
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

        {/* Hover tooltip — positioned via ref, no React re-renders */}
        <div
          ref={tooltipRef}
          className="absolute z-40 pointer-events-none"
          style={{ display: 'none' }}
        >
          <div className="bg-black/90 border border-white/[0.08] rounded-lg overflow-hidden backdrop-blur-xl max-w-[260px]">
            <div className="px-3 py-2">
              <div data-tip-title className="text-[12px] font-semibold text-white/90 truncate" />
              <div data-tip-dev className="text-[10px] text-white/35 mt-0.5 truncate" />
              <div data-tip-genre className="text-[9px] text-purple-400/70 mt-1" />
            </div>
          </div>
        </div>

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
                  <span className="text-[9px] text-white/25 tabular-nums">{cycleableNeighbors.length}</span>
                  {neighborRerankHint && (
                    <span
                      className="flex items-center gap-1 text-[8px] text-amber-400/70 bg-amber-400/[0.08] border border-amber-400/15 rounded px-1.5 py-0.5"
                      title={neighborRerankHint.title}
                    >
                      <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                      {neighborRerankHint.label}
                    </span>
                  )}
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
                {traversalDepth > 0 && (
                  <button
                    onClick={traverseBack}
                    className="flex items-center gap-1.5 text-[9px] text-amber-400/60 hover:text-amber-400 transition-colors mb-1.5 cursor-pointer"
                  >
                    <Undo2 className="w-3 h-3" />
                    <span className="truncate">← {traversalStackRef.current[traversalStackRef.current.length - 1]?.title ?? 'Back'}</span>
                    <span className="text-amber-400/30 tabular-nums font-mono">D{traversalDepth}</span>
                  </button>
                )}
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
                  .slice()
                  .sort((a, b) => a.distance - b.distance)
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
                        {isFocusedNb && (
                          <span
                            role="button"
                            onClick={ev => { ev.stopPropagation(); traverseInto(nb.node!); }}
                            className="p-0.5 rounded text-amber-400/60 hover:text-amber-400 hover:bg-amber-500/15 transition-colors shrink-0 cursor-pointer"
                            title="Traverse into"
                          >
                            <CornerDownRight className="w-3 h-3" />
                          </span>
                        )}
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
              <div className="w-[115px] group-hover/pov:w-[184px] transition-all duration-300 rounded-lg overflow-hidden border border-blue-500/15 group-hover/pov:border-blue-500/40 bg-black/60 group-hover/pov:bg-black/85 backdrop-blur-md opacity-50 group-hover/pov:opacity-100 shadow-lg shadow-black/40">
                <div className="relative w-full aspect-[4/3] overflow-hidden">
                  <FallbackImg
                    node={node}
                    className="w-full h-full object-cover"
                    fallbackClassName="w-full h-full flex items-center justify-center text-white/40 text-xs bg-zinc-900"
                    loading="lazy"
                  />
                  <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-blue-500/80 text-[8px] font-bold text-black leading-none">
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
              <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide px-3 py-2.5 space-y-3">
                {/* Canonical genre categories */}
                <div>
                  <span className="text-[8px] uppercase tracking-widest text-white/25 font-semibold mb-1.5 block">Categories</span>
                  <div className="flex flex-wrap gap-1.5">
                    {CANONICAL_GENRE_LABELS.map((label, idx) => {
                      const members = genresByCategory.get(idx) ?? [];
                      if (members.length === 0) return null;
                      const allActive = members.every(g => activeGenres.has(g));
                      const someActive = !allActive && members.some(g => activeGenres.has(g));
                      const [cr, cg, cb] = GENRE_PALETTE[idx];
                      const rgb = `${Math.round(cr * 255)}, ${Math.round(cg * 255)}, ${Math.round(cb * 255)}`;
                      return (
                        <button
                          key={idx}
                          onClick={() => toggleCanonical(idx)}
                          className={`text-[9px] px-2 py-1 rounded-md border transition-colors cursor-pointer flex items-center gap-1.5 ${
                            allActive
                              ? 'border-white/15 bg-white/[0.07]'
                              : someActive
                                ? 'border-white/10 bg-white/[0.03]'
                                : 'bg-transparent border-white/[0.06] hover:border-white/10'
                          }`}
                          title={`${members.length} genre${members.length !== 1 ? 's' : ''}: ${members.join(', ')}`}
                        >
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{
                              background: `radial-gradient(circle at 35% 35%, rgba(${rgb}, ${allActive ? 1 : someActive ? 0.7 : 0.4}) 0%, rgba(${rgb}, ${allActive ? 0.5 : someActive ? 0.3 : 0.12}) 100%)`,
                              boxShadow: allActive ? `0 0 4px rgba(${rgb}, 0.4)` : undefined,
                            }}
                          />
                          <span style={{ color: allActive ? `rgba(${rgb}, 0.9)` : someActive ? `rgba(${rgb}, 0.55)` : 'rgba(255,255,255,0.25)' }}>
                            {label}
                          </span>
                          <span className="text-[7px] tabular-nums" style={{ color: allActive ? `rgba(${rgb}, 0.5)` : 'rgba(255,255,255,0.15)' }}>
                            {members.length}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Raw genre tags */}
                <div>
                  <span className="text-[8px] uppercase tracking-widest text-white/25 font-semibold mb-1.5 block">All Genres</span>
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
              onClick={pathDisabledReason && !pathActive ? undefined : showThePath}
              disabled={!!pathDisabledReason && !pathActive}
              title={pathDisabledReason && !pathActive ? pathDisabledReason : undefined}
              className={`px-3.5 py-1.5 rounded-full border backdrop-blur-xl text-[10px] font-medium tracking-wide transition-all duration-500 pointer-events-auto flex items-center gap-1.5 ${
                pathActive
                  ? 'border-blue-500/30 bg-blue-500/15 text-blue-300/90 shadow-lg shadow-blue-500/10 cursor-pointer'
                  : pathDisabledReason
                    ? 'border-white/[0.04] bg-white/[0.02] text-white/15 cursor-not-allowed'
                    : 'border-white/[0.08] bg-white/[0.04] text-white/40 hover:text-white/60 hover:border-white/[0.12] cursor-pointer'
              }`}
            >
              <Route className="w-3 h-3" />
              The Path
            </button>
            {pathActive && pathOverview && (
              <>
                <button
                  onClick={startPathExplore}
                  className="px-3.5 py-1.5 rounded-full border border-blue-500/40 bg-blue-500/20 text-blue-200 text-[10px] font-medium tracking-wide transition-all duration-500 cursor-pointer pointer-events-auto flex items-center gap-1.5 shadow-lg shadow-blue-500/15 hover:bg-blue-500/30 hover:border-blue-500/50"
                >
                  <Waypoints className="w-3 h-3" />
                  Explore Path
                </button>
                <TooltipCard content="Capture a high-resolution screenshot of the galaxy and save it to your Downloads folder." containerClassName="pointer-events-auto">
                  <button
                    onClick={captureScreenshot}
                    disabled={screenshotSaving}
                    className="px-3 py-1.5 rounded-full border border-white/[0.12] bg-white/[0.06] text-white/50 text-[10px] font-medium tracking-wide transition-all duration-300 cursor-pointer flex items-center gap-1.5 hover:text-white/80 hover:border-white/[0.2] hover:bg-white/[0.1] disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Camera className="w-3 h-3" />
                    {screenshotSaving ? 'Saving...' : 'Screenshot'}
                  </button>
                </TooltipCard>
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
