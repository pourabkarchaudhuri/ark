/**
 * Embedding Space v2 controller — the behaviour layer of the view (port of the
 * handoff prototype's `class Component`). React owns rendering; this class
 * owns the engine, data, timers and every interaction. UI state goes through
 * a synchronous get/set pair so handlers never read stale state.
 */
import type React from 'react';
import * as THREE from 'three';
import { toPng } from 'html-to-image';
import {
  GALAXY_STEP_LABELS, GENRE_PALETTE, genreToColorIdx, loadCachedGalaxyIfFresh, buildAndCacheGalaxy,
  getBackgroundBuildPromise, cancelActiveProjectionWorker,
  type GalaxyStepReporter, type GraphNode, type NeighborInfo,
} from '@/services/galaxy-cache';
import { embeddingService, getEmbeddingById } from '@/services/embedding-service';
import { libraryStore } from '@/services/library-store';
import { journeyStore } from '@/services/journey-store';
import { gameGraphStore } from '@/services/game-graph-store';
import { getStoreFromId } from '@/types/game';
import { scoreGame, normalizeSearchText, type SearchIndexEntry } from '@/services/game-search-scoring';
import { findNodesInsidePolygon, simplifyPath, toSvgPath, type LassoPoint } from '@/services/lasso-geometry';
import { GalaxyEngine, type FlythroughTarget } from '../engine/GalaxyEngine';
import { APPROACH_REST, COSMOS_CAM, NODE_REST, type Zone } from '../engine/zoom';
import { buildPublisherFreqs } from '../engine/nodeStyle';
import { NEIGHBOR_K, cosineDistance, fetchNeighbors, spatialNeighbors } from '../data/neighbors';
import { buildMockPath, buildPath, type PathStop } from '../data/path';
import { fetchNodeDetail } from '../data/detail';
import { INITIAL_STATE, type StatePatch, type ViewState, type ScannerMode } from './state';

export interface ControllerRefs {
  canvasHost: HTMLDivElement | null;
  screenshotArea: HTMLDivElement | null;
  root: HTMLDivElement | null;
  neighborCardsHost: HTMLDivElement | null;
  pathOverviewHost: HTMLDivElement | null;
  tooltip: HTMLDivElement | null;
  fps: HTMLSpanElement | null;
  approachWrap: HTMLDivElement | null;
  approach: HTMLSpanElement | null;
  depth: HTMLSpanElement | null;
  railMarker: HTMLDivElement | null;
  dockLine: HTMLSpanElement | null;
  dockBase: HTMLSpanElement | null;
}

const RENDER_STEP = 'Rendering galaxy';
const CLICK_DRAG_PX = 5;
/** How long a flight waits for neighbours to frame them before flying on a default distance. */
const NEIGHBOR_FRAME_WAIT_MS = 250;
const DEFAULT_ZOOM_DIST = 200;

const resolveWithin = <T,>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>(r => setTimeout(() => r(undefined), ms))]);

function zoomDistFor(node: GraphNode, nbList: NeighborInfo[] | undefined | null): number {
  if (!nbList || nbList.length === 0) return DEFAULT_ZOOM_DIST;
  let maxEdgeLen = 0;
  for (const nb of nbList) {
    if (!nb.node) continue;
    const dx = nb.node.x - node.x, dy = nb.node.y - node.y, dz = nb.node.z - node.z;
    maxEdgeLen = Math.max(maxEdgeLen, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return Math.max(80, Math.min(maxEdgeLen * 0.65, 350));
}

export class EmbeddingSpaceController {
  engine: GalaxyEngine | null = null;
  nodes: GraphNode[] = [];
  nodeMap = new Map<string, GraphNode>();
  pathStops: PathStop[] = [];
  traversalStack: GraphNode[] = [];
  refs: ControllerRefs | null = null;

  private mounted = false;
  private loadGen = 0;
  private state: ViewState = INITIAL_STATE;
  private searchIndex: SearchIndexEntry[] = [];
  private suggestCacheQ: string | null = null;
  private suggestCacheRows: GraphNode[] = [];
  private voyageTargets: FlythroughTarget[] = [];
  private neighborRerankEnabled = true;
  private exitingNode = false;
  private exitTok = 0;
  private selectTok = 0;
  private focusTok = 0;
  private pathHopToken = 0;
  private detailTok = 0;
  private hoverRaf = 0;
  private hoveredNode: GraphNode | null = null;
  private hotEl: HTMLElement | null = null;
  private lassoDrawing = false;
  private lassoPts: LassoPoint[] = [];
  private lassoRect: DOMRect | null = null;
  private pointerDown: { x: number; y: number } | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private searchBlurTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanups: Array<() => void> = [];

  constructor(private commit: (s: ViewState) => void, public onBack: () => void, private useMock: boolean) {}

  get S(): ViewState { return this.state; }

  set(patch: StatePatch) {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    if (!p) return;
    this.state = { ...this.state, ...p };
    if (this.mounted) this.commit(this.state);
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => { this.timers.delete(t); if (this.mounted) fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────
  mount(refs: ControllerRefs) {
    this.refs = refs;
    if (import.meta.env.DEV) (window as unknown as { __esCtl?: EmbeddingSpaceController }).__esCtl = this; // debug handle
    this.mounted = true;
    const wake = () => {
      const root = this.refs?.root;
      if (root && root.dataset.esIdle === '1') root.dataset.esIdle = '0';
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (this.mounted && !this.state.loading && this.refs?.root) this.refs.root.dataset.esIdle = '1';
      }, 4000);
    };
    for (const ev of ['pointermove', 'pointerdown', 'wheel', 'keydown'] as const) window.addEventListener(ev, wake, { passive: true });
    wake();
    const onKeyDown = (e: KeyboardEvent) => this.handleKeyDown(e);
    const onKeyUp = (e: KeyboardEvent) => { this.engine?.keysDown.delete(e.key.toLowerCase()); };
    const onBlur = () => { this.engine?.keysDown.clear(); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    this.cleanups.push(() => {
      for (const ev of ['pointermove', 'pointerdown', 'wheel', 'keydown'] as const) window.removeEventListener(ev, wake);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    });
    this.cleanups.push(libraryStore.subscribe(() => this.set(s => ({ libVersion: s.libVersion + 1 }))));
    if (typeof window !== 'undefined' && window.settings?.getOllamaSettings) {
      void window.settings.getOllamaSettings().then(s => { this.neighborRerankEnabled = s.neighborRerankEnabled !== false; }).catch(() => {});
    }
    void this.load();
  }

  unmount() {
    this.mounted = false;
    for (const c of this.cleanups) c();
    this.cleanups = [];
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.searchBlurTimer) clearTimeout(this.searchBlurTimer);
    if (this.hoverRaf) cancelAnimationFrame(this.hoverRaf);
    cancelActiveProjectionWorker();
    this.engine?.dispose();
    this.engine = null;
    this.loadGen++;
    this.selectTok++; this.focusTok++; this.pathHopToken++; this.detailTok++;
  }

  // ─── Loading ───────────────────────────────────────────────────────────────
  private setStep(i: number, status: ViewState['loadingSteps'][number]['status'], detail?: string) {
    this.set(s => ({
      loadingSteps: s.loadingSteps.map((st, idx) => idx === i
        ? { label: detail ? `${st.base} — ${detail}` : st.base, base: st.base, status }
        : st),
    }));
  }

  private async loadNodes(alive: () => boolean): Promise<{ nodes: GraphNode[]; allGenres: string[] } | null> {
    const onStep: GalaxyStepReporter = (i, status, detail) => { if (alive()) this.setStep(i, status, detail); };
    const markAll = (status: 'running' | 'done' | 'waiting', detail?: string) => GALAXY_STEP_LABELS.forEach((_, i) => onStep(i, status, detail));
    if (this.useMock) {
      const { generateMockGalaxy } = await import('@/services/mock-galaxy');
      markAll('done', 'mock');
      return generateMockGalaxy();
    }
    const cached = await loadCachedGalaxyIfFresh();
    if (cached) { markAll('done', 'cached'); return cached; }
    if (embeddingService.isCatalogRunning) {
      markAll('waiting', 'waiting for embedding pipeline');
      await new Promise<void>(resolve => {
        if (!embeddingService.isCatalogRunning) { resolve(); return; }
        let unsub: (() => void) | null = null;
        const timeout = setTimeout(() => { unsub?.(); resolve(); }, 3 * 60_000);
        unsub = embeddingService.subscribe(() => {
          if (!embeddingService.isCatalogRunning) { clearTimeout(timeout); unsub?.(); resolve(); }
        });
        this.cleanups.push(() => { clearTimeout(timeout); unsub?.(); resolve(); });
      });
      if (!alive()) return null;
      markAll('running');
      return buildAndCacheGalaxy(onStep);
    }
    const bg = getBackgroundBuildPromise();
    if (bg) {
      markAll('running', 'background build in progress');
      const result = await bg;
      markAll('done');
      return result;
    }
    return buildAndCacheGalaxy(onStep);
  }

  private async load() {
    const gen = ++this.loadGen;
    const alive = () => this.mounted && gen === this.loadGen;
    try {
      const labels = [...GALAXY_STEP_LABELS, RENDER_STEP];
      const renderIdx = GALAXY_STEP_LABELS.length;
      this.set({ loadingSteps: labels.map(l => ({ label: l, base: l, status: 'pending' as const })) });
      const data = await this.loadNodes(alive);
      if (!alive() || !data) return;
      this.nodes = data.nodes;
      this.nodeMap = new Map(this.nodes.map(n => [n.id, n]));
      this.set({ nodeCount: this.nodes.length, allGenres: data.allGenres, activeGenres: new Set() });
      if (this.nodes.length === 0) { this.set({ emptyGalaxy: true, loading: false }); return; }

      this.setStep(renderIdx, 'running');
      await new Promise(r => setTimeout(r, 0));
      const host = this.refs?.canvasHost;
      if (!alive() || !host) return;
      const engine = new GalaxyEngine(host, this.nodes, buildPublisherFreqs(this.nodes), { assetBase: import.meta.env.BASE_URL });
      this.engine = engine;
      engine.ui.allGenres = data.allGenres;
      engine.fpsEl = this.refs!.fps;
      engine.cards.containers = [this.refs!.neighborCardsHost, this.refs!.pathOverviewHost];
      engine.onFlythroughSegment = (idx) => {
        const k = this.voyageTargets[idx];
        if (k) this.set({ lowerThird: { title: k.title, subtitle: k.subtitle, index: idx } });
      };
      engine.onFlythroughEnd = () => this.exitFlythrough();
      engine.onZoneChange = (zone) => this.handleZoneChange(zone);
      engine.approachWrapEl = this.refs!.approachWrap;
      engine.approachEl = this.refs!.approach;
      engine.railMarkerEl = this.refs!.railMarker;
      this.set({ rendererBackend: engine.backend });
      this.setStep(renderIdx, 'running', 'loading galaxy model...');
      await engine.loadGalaxyModel();
      if (!alive()) return;
      this.setStep(renderIdx, 'running');
      await new Promise<void>(resolve => {
        let done = false, warmup = 0;
        const finish = () => { if (!done) { done = true; resolve(); } };
        const tick = () => { warmup++; if (warmup < 3) requestAnimationFrame(tick); else finish(); };
        requestAnimationFrame(tick);
        setTimeout(finish, 1200); // rAF stalls in hidden windows — don't hang the loader
      });
      if (!alive()) return;
      this.setStep(renderIdx, 'done');
      engine.depthEl = this.refs!.depth;

      // Graph layers + dressing mount in idle slices after first paint
      const idle = (fn: () => void) => {
        if (typeof window.requestIdleCallback === 'function') {
          const h = window.requestIdleCallback(fn, { timeout: 600 });
          this.cleanups.push(() => window.cancelIdleCallback(h));
        } else this.later(fn, 60);
      };
      idle(() => {
        if (!alive() || !this.engine) return;
        this.engine.applyGraphLayers();
        this.cleanups.push(gameGraphStore.subscribe(() => this.engine?.applyGraphLayers()));
        this.ensureGraphBuilt();
        idle(() => { if (this.mounted) this.engine?.lazyMountDressing(); });
      });

      const pb = this.useMock ? buildMockPath(this.nodes) : buildPath(journeyStore.getAllEntries(), this.nodeMap);
      this.set({ pathDisabledReason: pb.disabledReason, loading: false });

      // Search index — chunked so the main thread stays smooth
      let idxPos = 0;
      const buildChunk = () => {
        const end = Math.min(idxPos + 5000, this.nodes.length);
        for (; idxPos < end; idxPos++) {
          const nd = this.nodes[idxPos];
          const titleLower = nd.title.toLowerCase();
          this.searchIndex[idxPos] = {
            titleLower,
            titleNorm: normalizeSearchText(nd.title),
            titleWords: titleLower.split(/\s+/).filter(Boolean),
            devLower: (nd.developer || '').toLowerCase(),
            pubLower: (nd.publisher || '').toLowerCase(),
            genresLower: nd.genres.map(g => g.toLowerCase()),
          };
        }
        this.suggestCacheQ = null;
        if (idxPos < this.nodes.length) this.later(buildChunk, 30);
        else this.set(s => ({ searchIndexed: s.searchIndexed + 1 }));
      };
      this.later(buildChunk, 100);

      // One-shot flythrough trigger from Year Wrapped
      try {
        const raw = localStorage.getItem('ark.flythrough.pending');
        if (raw) {
          localStorage.removeItem('ark.flythrough.pending');
          const payload = JSON.parse(raw) as { keyframes?: Array<{ gameId: string; title: string; subtitle: string }> };
          if (payload.keyframes && payload.keyframes.length >= 2) {
            const kf = payload.keyframes;
            this.later(() => this.launchFlythroughKeyframes(kf), 600);
          }
        }
      } catch { /* malformed handoff — ignore */ }
    } catch (err) {
      console.error('[Embedding Space] Loading failed:', err);
      if (alive()) this.set({ loading: false });
    }
  }

  /** Kick off a background graph build if nothing has built one yet (community tint, named stars). */
  private ensureGraphBuilt() {
    if (this.useMock || gameGraphStore.state.phase !== 'idle' || !window.ann) return;
    void (async () => {
      try {
        const status = await window.ann!.status();
        if (status.ready && status.vectorCount > 0) void gameGraphStore.build(`ann-${status.vectorCount}`).catch(() => {});
      } catch { /* ANN unavailable */ }
    })();
  }

  // ─── Neighbours ────────────────────────────────────────────────────────────
  /**
   * Primary queries (the selected star) report their source in `neighborStatus`.
   * Secondary queries (a focused neighbour's own web) skip the Ollama cross-encoder —
   * stepping through neighbours would otherwise queue reranks ahead of the next real selection.
   */
  private neighborsFor(node: GraphNode, isStale: () => boolean, exclude?: Set<string>, secondary = false) {
    return fetchNeighbors(node, {
      nodes: this.nodes, nodeMap: this.nodeMap, useMock: this.useMock,
      neighborRerankEnabled: this.neighborRerankEnabled && !secondary, exclude, isStale,
    }, NEIGHBOR_K).then(r => {
      if (r && !secondary && !isStale()) this.set({ neighborStatus: r.statusChip });
      return r?.neighbors ?? null;
    }).catch((err) => {
      console.warn('[Embedding Space] neighbour query failed, using spatial fallback:', err);
      if (isStale()) return null;
      if (!secondary) this.set({ neighborStatus: 'spatial_fallback' });
      return spatialNeighbors(node, this.nodes, NEIGHBOR_K, exclude);
    });
  }

  /** Cancels a pending zone pull-back's fade-out (a new selection or flight supersedes it). */
  private abortNodeExit() {
    if (!this.exitingNode) return;
    this.exitingNode = false;
    this.exitTok++;
    this.engine?.endNodeExit();
  }

  /** The single next-hop link shown at a Path stop when neighbours are hidden. */
  private async nextHopList(node: GraphNode, next: GraphNode): Promise<NeighborInfo[]> {
    let dist: number;
    if (this.useMock) {
      const dx = next.x - node.x, dy = next.y - node.y, dz = next.z - node.z;
      dist = Math.sqrt(dx * dx + dy * dy + dz * dz) / 100;
    } else {
      const [a, b] = await Promise.all([getEmbeddingById(node.id), getEmbeddingById(next.id)]);
      dist = a && b ? cosineDistance(a, b) : 0;
    }
    return [{ id: next.id, distance: +dist.toFixed(4), node: next }];
  }

  // ─── Selection ─────────────────────────────────────────────────────────────
  selectNode(node: GraphNode, flyTo: boolean) {
    const eng = this.engine;
    if (!eng) return;
    this.abortNodeExit();
    if (this.state.pathActive) this.clearPath();
    const tok = ++this.selectTok;
    this.focusTok++;
    eng.ui.selectedId = node.id;
    eng.autoOrbit = true;
    const sunC = GENRE_PALETTE[node.colorIdx] ?? GENRE_PALETTE[GENRE_PALETTE.length - 1];
    eng.sunState.selectedPos = new THREE.Vector3(node.x, node.y, node.z);
    eng.sunState.selectedColor = [sunC[0], sunC[1], sunC[2]];
    eng.sunState.focusedPos = null;
    eng.ui.neighborIds = new Set();
    eng.clearFocusedConnections();
    eng.clearConnections();
    eng.setOrbitRings([]);
    eng.updateVisuals();
    this.set({ selectedNode: node, neighbors: [], focusedNbIdx: -1, connectionCount: 0, detailOpen: false, detailNodeId: null });
    const isStale = () => tok !== this.selectTok || this.engine?.ui.selectedId !== node.id;
    const nbPromise = this.neighborsFor(node, isStale);
    void nbPromise.then(nbList => {
      if (!nbList || isStale() || !this.engine) return;
      this.engine.ui.neighborIds = new Set(nbList.map(nb => nb.id));
      this.set({ neighbors: nbList, connectionCount: nbList.length });
      this.engine.drawConnections(node, nbList);
      this.engine.setOrbitRings(nbList);
      this.engine.updateVisuals();
    });
    if (flyTo) {
      void resolveWithin(nbPromise, NEIGHBOR_FRAME_WAIT_MS).then(nbList => {
        if (isStale() || !this.engine) return;
        const starPos = new THREE.Vector3(node.x, node.y, node.z);
        const dir = new THREE.Vector3().subVectors(this.engine.camera.position, starPos).normalize();
        this.engine.startFly(starPos, starPos.clone().add(dir.multiplyScalar(zoomDistFor(node, nbList))), 2800);
      });
    }
  }

  clearSelection() {
    const eng = this.engine;
    this.traversalStack = [];
    // pathHopToken too: cancelFly below runs landing callbacks, and a pending Path
    // arrival must not re-select the stop we're deselecting.
    this.selectTok++; this.focusTok++; this.pathHopToken++;
    this.set({
      selectedNode: null, neighbors: [], neighborStatus: null, focusedNbIdx: -1, connectionCount: 0,
      showNeighbors: false, nbSearch: '', traversalDepth: 0, detailOpen: false, detailNodeId: null,
    });
    if (!eng) return;
    eng.ui.selectedId = null;
    eng.ui.neighborIds = new Set();
    eng.cancelFly();
    eng.sunState.selectedPos = null;
    eng.sunState.focusedPos = null;
    eng.autoOrbit = false;
    eng.clearFocusedConnections();
    eng.clearConnections();
    eng.updateVisuals();
  }

  cycleable(): NeighborInfo[] {
    return this.state.neighbors.filter(nb => nb.node && !nb.node.title.startsWith('Unknown Game'));
  }

  isLastPathNode(): boolean {
    return this.state.pathActive && this.state.pathIdx >= 0 && this.state.pathIdx === this.pathStops.length - 1;
  }

  setFocusedNb(i: number, fly: boolean) {
    const eng = this.engine;
    if (!eng) return;
    const nbs = this.cycleable();
    this.abortNodeExit();
    this.set({ focusedNbIdx: i, detailOpen: false, detailNodeId: null });
    const tok = ++this.focusTok;
    if (i === -1 || !nbs[i]?.node) {
      eng.sunState.focusedPos = null;
      eng.clearFocusedConnections();
      eng.updateVisuals();
      if (this.state.selectedNode && fly) eng.flyToNode(this.state.selectedNode);
      eng.autoOrbit = true;
      return;
    }
    const node = nbs[i].node!;
    if (fly) {
      eng.flyToNode(node);
      // The big card stays on the selected star until the camera arrives (no side-load-then-pop)
      this.set({ focusPhase: 'hidden' });
      eng.whenLanded(() => {
        if (!this.mounted || tok !== this.focusTok) return;
        requestAnimationFrame(() => { if (this.mounted && tok === this.focusTok) this.set({ focusPhase: 'entering' }); });
      });
    } else this.set({ focusPhase: 'entering' });
    eng.sunState.focusedPos = new THREE.Vector3(node.x, node.y, node.z);
    const fc = GENRE_PALETTE[node.colorIdx] ?? GENRE_PALETTE[GENRE_PALETTE.length - 1];
    eng.sunState.focusedColor = [fc[0], fc[1], fc[2]];
    eng.autoOrbit = true;
    eng.clearFocusedConnections();
    // Secondary web — this neighbour's own neighbours
    const exclude = new Set<string>([node.id, ...this.state.neighbors.map(nb => nb.id)]);
    if (this.state.selectedNode) exclude.add(this.state.selectedNode.id);
    void this.neighborsFor(node, () => tok !== this.focusTok, exclude, true).then(secondary => {
      if (!secondary || tok !== this.focusTok || !this.engine) return;
      this.engine.drawFocusedConnections(node, secondary.filter(nb => !!nb.node));
    });
  }

  traverseInto(node: GraphNode) {
    if (!this.state.selectedNode || !this.engine) return;
    this.traversalStack = [...this.traversalStack, this.state.selectedNode];
    this.set({ traversalDepth: this.traversalStack.length, detailOpen: false });
    this.engine.flyToNode(node);
    this.selectNode(node, false);
  }

  traverseBack() {
    if (this.traversalStack.length === 0 || !this.engine) return;
    const prev = this.traversalStack[this.traversalStack.length - 1];
    this.traversalStack = this.traversalStack.slice(0, -1);
    this.set({ traversalDepth: this.traversalStack.length, detailOpen: false });
    this.engine.flyToNode(prev);
    this.selectNode(prev, false);
  }

  handleCycleNext() {
    const { pathActive, pathIdx, focusedNbIdx, pathShowNbs } = this.state;
    if (pathActive && pathIdx >= 0 && !this.isLastPathNode() && !pathShowNbs) { this.selectPathNode(pathIdx + 1); return; }
    const nbs = this.cycleable();
    if (nbs.length === 0) return;
    this.setFocusedNb(focusedNbIdx + 1 >= nbs.length ? -1 : focusedNbIdx + 1, true);
  }

  handleCyclePrev() {
    const { pathActive, pathIdx, focusedNbIdx, pathShowNbs } = this.state;
    if (pathActive && pathIdx > 0 && !pathShowNbs) {
      if (this.isLastPathNode() && focusedNbIdx >= 0) { this.setFocusedNb(-1, true); return; }
      if (focusedNbIdx === -1) { this.selectPathNode(pathIdx - 1); return; }
    }
    const nbs = this.cycleable();
    if (nbs.length === 0) return;
    this.setFocusedNb(focusedNbIdx - 1 < -1 ? nbs.length - 1 : focusedNbIdx - 1, true);
  }

  handleCycleHome() { this.setFocusedNb(-1, true); }

  async toggleDetail(nodeId: string) {
    if (this.state.detailOpen && this.state.detailNodeId === nodeId) { this.set({ detailOpen: false }); return; }
    const tok = ++this.detailTok;
    this.set({ detailOpen: true, detailNodeId: nodeId, detailLoading: true, detailData: null });
    if (this.useMock) { this.later(() => { if (tok === this.detailTok) this.set({ detailLoading: false }); }, 500); return; }
    const data = await fetchNodeDetail(nodeId).catch(() => null);
    if (!this.mounted || tok !== this.detailTok) return;
    this.set({ detailLoading: false, detailData: data });
  }

  addNodeToLibrary(node: GraphNode) {
    if (libraryStore.isInLibrary(node.id)) return;
    const steamMatch = node.id.match(/^steam-(\d+)$/);
    const store = getStoreFromId(node.id);
    libraryStore.addToLibrary({
      gameId: node.id,
      steamAppId: steamMatch ? Number(steamMatch[1]) : undefined,
      status: 'Want to Play',
      priority: 'Medium',
      publicReviews: '',
      recommendationSource: 'Embedding Space',
      cachedMeta: {
        title: node.title,
        store: store === 'steam' || store === 'epic' ? store : undefined,
        coverUrl: node.coverUrl,
        developer: node.developer || undefined,
        publisher: node.publisher || undefined,
        genre: node.genres,
      },
    });
    node.isLibrary = true;
    this.engine?.refreshBaseForNode(node);
    this.engine?.updateVisuals();
  }

  // ─── The Path ──────────────────────────────────────────────────────────────
  clearPath() {
    this.engine?.clearPathLines();
    this.pathStops = [];
    this.pathHopToken++;
    this.focusTok++;
    if (this.engine) this.engine.ui.pathIds = new Set();
    this.set({ pathActive: false, pathOverview: false, pathIdx: -1, pathHover: -1, pathGhost: null, pathArriving: false, pathCardPhase: 'idle', pathShowNbs: false, pathBottom: 'path' });
  }

  showThePath() {
    const eng = this.engine;
    if (!eng) return;
    if (this.state.pathActive) {
      // Exiting The Path returns to Approach; path + selection fade with the pull-back
      // and goToZone clears them on landing.
      this.goToZone('approach');
      return;
    }
    this.abortNodeExit();
    this.clearPath();
    this.clearSelection();
    this.set({ searchQuery: '', searchFocused: false });
    const pb = this.useMock ? buildMockPath(this.nodes) : buildPath(journeyStore.getAllEntries(), this.nodeMap);
    if (pb.stops.length < 2) { this.set({ pathDisabledReason: pb.disabledReason }); return; }
    this.pathStops = pb.stops;
    eng.ui.pathIds = new Set(pb.stops.map(s => s.node.id));
    this.set({ pathActive: true, pathShowNbs: true, pathDisabledReason: null });
    eng.drawPathLines(pb.stops);
    eng.setPathActive(-1);
    eng.updateVisuals();
    const bbox = new THREE.Box3();
    for (const s of pb.stops) bbox.expandByPoint(new THREE.Vector3(s.x, s.y, s.z));
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());
    const overviewDist = Math.max(Math.max(size.x, size.y, size.z) * 1.1, 300);
    this.set({ pathOverview: true });
    eng.startFly(center, center.clone().add(new THREE.Vector3(0, overviewDist * 0.3, overviewDist)), 2400);
  }

  startPathExplore() {
    this.set({ pathOverview: false });
    this.selectPathNode(0);
  }

  selectPathNode(idx: number) {
    const eng = this.engine;
    const pn = this.pathStops;
    if (!eng || idx < 0 || idx >= pn.length) return;
    this.abortNodeExit();
    const stop = pn[idx];
    const node = stop.node;
    const starPos = new THREE.Vector3(node.x, node.y, node.z);
    const sunC = GENRE_PALETTE[node.colorIdx] ?? GENRE_PALETTE[GENRE_PALETTE.length - 1];
    const isLast = idx === pn.length - 1;
    const token = ++this.pathHopToken;
    const isStale = () => token !== this.pathHopToken || !this.state.pathActive;
    const nbPromise: Promise<NeighborInfo[] | null> = (isLast || this.state.pathShowNbs)
      ? this.neighborsFor(node, isStale)
      : this.nextHopList(node, pn[idx + 1].node).catch(() => null);
    let resolved: NeighborInfo[] | null | undefined; // undefined while the query is in flight
    void nbPromise.then(l => { resolved = l; });
    const applyLinks = (list: NeighborInfo[]) => {
      const e = this.engine!;
      e.ui.neighborIds = new Set(list.map(nb => nb.id));
      e.drawConnections(node, list);
      e.setOrbitRings(list);
      e.updateVisuals();
      this.set({ neighbors: list, connectionCount: list.length, focusedNbIdx: -1 });
    };
    // Everything at the current star stays up during the flight; the swap happens on landing.
    // Arrival never waits on the neighbour query (ANN + rerank can take seconds): the card and
    // star swap at once and the links follow when the query resolves.
    const applyArrival = () => {
      if (!this.mounted || isStale() || !this.engine) return;
      const e = this.engine;
      e.ui.selectedId = node.id;
      e.autoOrbit = true;
      e.sunState.selectedPos = starPos.clone();
      e.sunState.selectedColor = [sunC[0], sunC[1], sunC[2]];
      e.sunState.focusedPos = null;
      e.clearFocusedConnections();
      e.setPathActive(idx);
      this.selectTok++; // invalidate any free-roam selection still resolving
      this.focusTok++;  // and any secondary web still resolving for the previous stop
      this.set({ pathCardPhase: 'hidden', selectedNode: node, focusedNbIdx: -1, detailOpen: false });
      applyLinks(resolved ?? []);
      if (resolved === undefined) {
        void nbPromise.then(list => { if (list && this.mounted && !isStale() && this.engine) applyLinks(list); });
      }
      // two frames so the hidden pose commits before the entrance transition runs
      requestAnimationFrame(() => requestAnimationFrame(() => { if (this.mounted && token === this.pathHopToken) this.set({ pathCardPhase: 'entering' }); }));
    };
    const hopping = !!this.state.selectedNode && this.state.selectedNode.id !== node.id;
    const fromIdx = hopping ? pn.findIndex(s => s.node.id === this.state.selectedNode!.id) : -1;
    this.set({ pathIdx: idx, pathGhost: null, pathCardPhase: hopping ? 'leaving' : 'idle' });
    if (!hopping) applyArrival();
    void resolveWithin(nbPromise, NEIGHBOR_FRAME_WAIT_MS).then(early => {
      if (isStale() || !this.engine) return;
      const e = this.engine;
      const dir = new THREE.Vector3().subVectors(e.camera.position, starPos).normalize();
      e.startFly(starPos, starPos.clone().add(dir.multiplyScalar(zoomDistFor(node, early ?? null))), 2800);
      if (!hopping) return;
      if (fromIdx >= 0) e.setPathTravel(fromIdx, idx);
      // The destination's orbit system fades in during the flight; the departing one stays until arrival
      void nbPromise.then(list => { if (list && !isStale() && this.engine?.isFlying) this.engine.setOrbitRings(list, { preview: true, at: starPos }); });
      e.whenLanded(applyArrival);
    });
  }

  /** NEIGHBORS toggle at a Path stop: full similarity web ↔ just the next-hop line. */
  togglePathNeighbors() {
    const pn = this.pathStops, idx = this.state.pathIdx;
    // Mid-hop the arrival will draw the stop's links; a toggle now would be overwritten on landing.
    if (!this.engine || idx < 0 || !pn[idx] || this.engine.isFlying || this.state.selectedNode?.id !== pn[idx].node.id) return;
    const on = !this.state.pathShowNbs;
    const node = pn[idx].node;
    const tok = ++this.selectTok;
    this.focusTok++;
    const isStale = () => tok !== this.selectTok || !this.state.pathActive || this.state.pathIdx !== idx;
    // Turning neighbours off leaves one next-hop link — the dock can't show, so fall back to the strip
    this.set(s => ({ pathShowNbs: on, pathBottom: on ? s.pathBottom : 'path' }));
    const listP: Promise<NeighborInfo[] | null> = (on || idx === pn.length - 1)
      ? this.neighborsFor(node, isStale)
      : this.nextHopList(node, pn[idx + 1].node).catch(() => null);
    void listP.then(list => {
      const eng = this.engine;
      if (!list || isStale() || !eng) return;
      eng.sunState.focusedPos = null;
      eng.clearFocusedConnections();
      eng.ui.neighborIds = new Set(list.map(nb => nb.id));
      eng.drawConnections(node, list);
      eng.setOrbitRings(list);
      eng.updateVisuals();
      this.set({ neighbors: list, connectionCount: list.length, focusedNbIdx: -1 });
    });
  }

  // ─── Zones ─────────────────────────────────────────────────────────────────
  handleReset() {
    this.clearPath();
    this.clearSelection();
    this.set({ searchQuery: '', searchFocused: false });
    // Reset returns all the way out to the GLTF cosmos overview
    this.engine?.startFly(new THREE.Vector3(0, 0, 0), new THREE.Vector3(...COSMOS_CAM), 2600);
  }

  handleZoneChange(zone: Zone) {
    if (!this.mounted) return;
    const prev = this.state.viewZone;
    this.set({ viewZone: zone });
    if (zone === 'node') {
      if (!this.state.selectedNode && !this.state.pathActive && !this.state.loading && !this.state.flythroughActive) this.autoSelectNearest();
    } else if (prev === 'node' && !this.exitingNode) {
      // Only leaving Node clears node state — a fly-in from the Cosmos (e.g. a search
      // pick) crosses Approach on its way down and must keep its selection.
      if (this.state.pathActive) this.clearPath();
      if (this.state.selectedNode) this.clearSelection();
    }
  }

  goToZone(zone: Zone) {
    const eng = this.engine;
    if (!eng || this.state.loading) return;
    // Leaving node view: node assets fade out with the pull-back and are cleared once the camera lands
    const hasNodeStuff = zone !== 'node' && (this.state.pathActive || !!this.state.selectedNode);
    if (hasNodeStuff) { this.exitingNode = true; eng.beginNodeExit(); } else this.abortNodeExit();
    const xt = ++this.exitTok; // a later zone flight or selection supersedes this exit
    // Keep the current viewing direction; move along it to each state's resting distance
    const dir = eng.camera.position.clone().sub(eng.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.2, 1);
    dir.normalize();
    const origin = new THREE.Vector3(0, 0, 0);
    if (zone === 'cosmos') eng.startFly(origin, new THREE.Vector3(...COSMOS_CAM), 2800);
    else if (zone === 'approach') eng.startFly(origin, dir.multiplyScalar(APPROACH_REST), 2400);
    else eng.startFly(origin, dir.multiplyScalar(NODE_REST), 2400);
    if (hasNodeStuff) {
      eng.whenLanded(() => {
        if (xt !== this.exitTok) return;
        this.exitingNode = false;
        if (!this.mounted) return;
        if (this.state.pathActive) this.clearPath();
        if (this.state.selectedNode) this.clearSelection();
        this.engine?.endNodeExit();
      });
    }
  }

  /** Entering node with nothing selected picks the star nearest the camera. */
  autoSelectNearest() {
    const eng = this.engine;
    if (!eng) return;
    const best = eng.nearestNodeTo(eng.camera.position);
    if (!best) return;
    this.selectNode(best, false);
    eng.flyToNode(best, 170, 1900); // gentle docking flight as the node interface comes online
  }

  // ─── Genre filters ─────────────────────────────────────────────────────────
  syncGenres(next: Set<string>) {
    this.set({ activeGenres: next });
    if (this.engine) {
      this.engine.ui.activeGenres = next;
      requestAnimationFrame(() => this.engine?.updateVisuals());
    }
  }

  toggleGenre(genre: string) {
    const next = new Set(this.state.activeGenres);
    if (next.has(genre)) next.delete(genre); else next.add(genre);
    this.syncGenres(next);
  }

  toggleCanonical(colorIdx: number) {
    const members = this.genresByCategory().get(colorIdx) ?? [];
    if (members.length === 0) return;
    const next = new Set(this.state.activeGenres);
    if (members.every(g => next.has(g))) members.forEach(g => next.delete(g));
    else members.forEach(g => next.add(g));
    this.syncGenres(next);
  }

  genresByCategory(): Map<number, string[]> {
    const map = new Map<number, string[]>();
    for (const g of this.state.allGenres) {
      const idx = genreToColorIdx([g]);
      const list = map.get(idx);
      if (list) list.push(g); else map.set(idx, [g]);
    }
    return map;
  }

  // ─── Canvas interaction ────────────────────────────────────────────────────
  handleCanvasPointerDown(e: React.PointerEvent) { this.pointerDown = { x: e.clientX, y: e.clientY }; }

  private wasDrag(e: { clientX: number; clientY: number }): boolean {
    const d = this.pointerDown;
    return !!d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_DRAG_PX;
  }

  handleCanvasClick(e: React.MouseEvent) {
    const eng = this.engine;
    if (!eng || this.wasDrag(e) || !eng.ui.selectedId) return; // an orbit drag is not a click
    const hit = eng.raycastNode(e.clientX, e.clientY);
    if (!hit) return;
    const node = hit.node;
    const isSelected = eng.ui.selectedId === node.id;
    const isNeighbor = eng.ui.neighborIds.has(node.id);
    if (!isSelected && !isNeighbor) return;
    if (isSelected) this.clearSelection();
    else if (this.state.selectedNode) this.traverseInto(node);
    else this.selectNode(node, true);
  }

  handleCanvasMove(e: React.MouseEvent) {
    const cx = e.clientX, cy = e.clientY;
    if (this.hoverRaf) return;
    this.hoverRaf = requestAnimationFrame(() => {
      this.hoverRaf = 0;
      const eng = this.engine;
      const tip = this.refs?.tooltip;
      if (!eng) return;
      if (!eng.ui.selectedId) {
        if (this.hoveredNode) { this.hoveredNode = null; if (tip) tip.style.display = 'none'; }
        return;
      }
      const hit = eng.raycastNode(cx, cy);
      const rect = eng.renderer.domElement.getBoundingClientRect();
      if (hit && (hit.node.id === eng.ui.selectedId || eng.ui.neighborIds.has(hit.node.id))) {
        const node = hit.node;
        this.hoveredNode = node;
        eng.renderer.domElement.style.cursor = 'pointer';
        if (tip) {
          tip.style.display = 'block';
          tip.style.left = `${cx - rect.left + 16}px`;
          tip.style.top = `${cy - rect.top - 12}px`;
          const titleEl = tip.querySelector<HTMLElement>('[data-tip-title]');
          const devEl = tip.querySelector<HTMLElement>('[data-tip-dev]');
          const genreEl = tip.querySelector<HTMLElement>('[data-tip-genre]');
          if (titleEl) titleEl.textContent = node.title;
          if (devEl) { devEl.textContent = node.developer || ''; devEl.style.display = node.developer ? '' : 'none'; }
          if (genreEl) { genreEl.textContent = node.genres.slice(0, 3).join(' · '); genreEl.style.display = node.genres.length ? '' : 'none'; }
        }
        return;
      }
      this.hoveredNode = null;
      eng.renderer.domElement.style.cursor = 'default';
      if (tip) tip.style.display = 'none';
    });
  }

  handleCanvasLeave() {
    this.hoveredNode = null;
    if (this.refs?.tooltip) this.refs.tooltip.style.display = 'none';
    if (this.engine) this.engine.renderer.domElement.style.cursor = 'default';
  }

  // ─── Keyboard ──────────────────────────────────────────────────────────────
  handleKeyDown(e: KeyboardEvent) {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave app / OS shortcuts alone
    this.engine?.keysDown.add(e.key.toLowerCase());
    if (this.state.loading) return;
    if (this.state.flythroughActive) { if (e.key === 'Escape') this.exitFlythrough(); return; }
    // Probe mode owns WASD/QE; only P / Esc leave it
    const probe = this.state.scannerMode === 'probe';
    if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      this.setScannerMode(probe ? 'observer' : 'probe');
    } else if ((e.key === 'l' || e.key === 'L') && !probe) {
      e.preventDefault();
      this.setLassoActive(!this.state.lassoActive);
    } else if (e.key === 'Escape') {
      if (this.state.lassoActive) { this.setLassoActive(false); return; }
      this.setScannerMode('observer');
    } else if (e.key === 'ArrowRight' && (this.state.selectedNode || this.state.pathActive)) {
      e.preventDefault(); this.handleCycleNext();
    } else if (e.key === 'ArrowLeft' && (this.state.selectedNode || this.state.pathActive)) {
      e.preventDefault(); this.handleCyclePrev();
    } else if (e.key === 'ArrowDown' && this.state.focusedNbIdx >= 0) {
      e.preventDefault();
      const nb = this.cycleable()[this.state.focusedNbIdx];
      if (nb?.node) this.traverseInto(nb.node);
    } else if (e.key === 'ArrowUp' && this.state.traversalDepth > 0) {
      e.preventDefault(); this.traverseBack();
    }
  }

  setScannerMode(mode: ScannerMode) {
    this.set({ scannerMode: mode });
    const eng = this.engine;
    if (!eng) return;
    eng.probeActive = mode === 'probe';
    eng.controls.enabled = mode === 'observer' && !this.state.lassoActive;
  }

  // ─── Lasso ─────────────────────────────────────────────────────────────────
  setLassoActive(on: boolean) {
    // A stroke interrupted by Esc / L never gets its pointer-up (the SVG unmounts)
    this.lassoDrawing = false;
    this.lassoPts = [];
    this.set({ lassoActive: on, lassoPath: [], lassoCapture: null, lassoDrawing: false });
    if (this.engine) this.engine.controls.enabled = !on && this.state.scannerMode === 'observer';
  }

  // The stroke is drawn straight into the SVG path while the pointer moves; React only
  // sees the closed, simplified polygon.
  handleLassoDown(e: React.PointerEvent<SVGSVGElement>) {
    this.lassoDrawing = true;
    this.lassoPts = [{ x: e.clientX, y: e.clientY }];
    this.lassoRect = e.currentTarget.getBoundingClientRect();
    this.set({ lassoCapture: null, lassoPath: [], lassoDrawing: true });
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  handleLassoMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!this.lassoDrawing) return;
    this.lassoPts.push({ x: e.clientX, y: e.clientY });
    const r = this.lassoRect;
    const el = e.currentTarget.querySelector('path');
    if (el && r) el.setAttribute('d', toSvgPath(this.lassoPts.map(p => ({ x: p.x - r.left, y: p.y - r.top })), false));
  }

  handleLassoUp(e: React.PointerEvent<SVGSVGElement>) {
    if (!this.lassoDrawing) return;
    this.lassoDrawing = false;
    const el = e.currentTarget.querySelector('path');
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const pts = this.lassoPts;
    this.lassoPts = [];
    this.set({ lassoDrawing: false });
    this.closeLasso(pts);
    // A too-short stroke leaves React's `d` unchanged (''), so clear what we drew directly
    if (el && this.state.lassoPath.length === 0) el.setAttribute('d', '');
  }

  private closeLasso(rawPath: ViewState['lassoPath']) {
    const eng = this.engine;
    if (!eng || rawPath.length < 5) { this.set({ lassoPath: [] }); return; }
    const path = simplifyPath(rawPath, 3);
    this.set({ lassoPath: path });
    const inside = findNodesInsidePolygon(eng.projectAllNodes(), path);
    const nodeIds: string[] = [];
    const genreCounts = new Map<string, number>();
    for (const i of inside) {
      const n = eng.nodes[i];
      nodeIds.push(n.id);
      for (const g of n.genres) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
    }
    const genres = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));
    this.set({ lassoCapture: { nodeIds, genres } });
  }

  // ─── Flythrough (Year Wrapped handoff) ─────────────────────────────────────
  launchFlythroughKeyframes(keyframes: Array<{ gameId: string; title: string; subtitle: string }>) {
    const eng = this.engine;
    if (!eng || keyframes.length < 2) return;
    const targets = keyframes
      .map(k => {
        const node = eng.nodeMap.get(k.gameId);
        return node ? { pos: new THREE.Vector3(node.x, node.y, node.z), gameId: k.gameId, title: k.title, subtitle: k.subtitle } : null;
      })
      .filter((t): t is FlythroughTarget => !!t);
    if (targets.length < 2) return;
    this.voyageTargets = targets;
    this.setScannerMode('observer');
    if (eng.launchFlythrough(targets)) this.set({ flythroughActive: true, lowerThird: null });
  }

  exitFlythrough() {
    this.engine?.exitFlythrough();
    this.set({ flythroughActive: false, lowerThird: null });
  }

  // ─── Screenshot ────────────────────────────────────────────────────────────
  async captureScreenshot() {
    const area = this.refs?.screenshotArea;
    if (!area || this.state.screenshotSaving) return;
    this.set({ screenshotSaving: true });
    const filename = `ark-path-${Date.now()}.png`;
    let dataUrl: string | null = null;
    try {
      // The WebGL buffer isn't preserved between frames (perf), so snapshot it right
      // after a render and stand an <img> in for the canvas during the DOM capture.
      let frameImg: HTMLImageElement | null = null;
      const cv = this.engine?.renderer.domElement;
      if (this.engine && cv?.parentElement) {
        this.engine.render();
        frameImg = document.createElement('img');
        frameImg.src = cv.toDataURL('image/png');
        frameImg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
        cv.parentElement.appendChild(frameImg);
        cv.style.visibility = 'hidden';
        await frameImg.decode().catch(() => {});
      }
      try {
        dataUrl = await toPng(area, {
          cacheBust: true, pixelRatio: 2,
          filter: (node: HTMLElement) => !(node.classList && node.classList.contains('screenshot-exclude')),
        });
      } finally {
        frameImg?.remove();
        if (cv) cv.style.visibility = '';
      }
    } catch (err) {
      console.error('[Screenshot] Failed to capture:', err);
      try { if (this.engine) { this.engine.render(); dataUrl = this.engine.renderer.domElement.toDataURL('image/png'); } } catch { /* give up */ }
    }
    if (dataUrl) {
      try {
        if (window.fileDialog?.saveImage) await window.fileDialog.saveImage({ dataUrl, defaultName: filename });
        else { const link = document.createElement('a'); link.download = filename; link.href = dataUrl; link.click(); }
      } catch (err) { console.error('[Screenshot] Save failed:', err); }
    }
    this.set({ screenshotSaving: false });
  }

  // ─── Search ────────────────────────────────────────────────────────────────
  computeSuggestions(): GraphNode[] {
    const q = this.state.searchQuery.toLowerCase().trim();
    if (q.length < 2 || this.nodes.length === 0) return [];
    if (this.suggestCacheQ === q) return this.suggestCacheRows;
    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];
    const scored: Array<{ node: GraphNode; score: number }> = [];
    let highQualityHits = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      const entry = this.searchIndex[i];
      if (!entry) continue;
      const nd = this.nodes[i];
      if (nd.title.startsWith('Unknown Game')) continue;
      const s = scoreGame(entry, tokens, q);
      if (s > 0) {
        scored.push({ node: nd, score: s + (nd.isLibrary ? 0.5 : 0) });
        if (s >= 60 && ++highQualityHits >= 30) break;
      }
    }
    scored.sort((a, b) => b.score - a.score);
    this.suggestCacheQ = q;
    this.suggestCacheRows = scored.slice(0, 10).map(s => s.node);
    return this.suggestCacheRows;
  }

  pickSuggestion(node: GraphNode) {
    this.traversalStack = [];
    this.set({ searchFocused: false, suggestionIdx: -1, traversalDepth: 0 });
    this.selectNode(node, true);
  }

  onSearchFocus() {
    if (this.searchBlurTimer) { clearTimeout(this.searchBlurTimer); this.searchBlurTimer = null; }
    this.set({ searchFocused: true });
  }

  onSearchBlur() {
    this.searchBlurTimer = setTimeout(() => { this.searchBlurTimer = null; if (this.mounted) this.set({ searchFocused: false }); }, 200);
  }

  onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const sugg = this.computeSuggestions();
    if (e.key === 'Escape') { this.set({ searchFocused: false }); e.currentTarget.blur(); return; }
    if (sugg.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); this.set(s => ({ suggestionIdx: Math.min(s.suggestionIdx + 1, sugg.length - 1) })); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.set(s => ({ suggestionIdx: Math.max(s.suggestionIdx - 1, -1) })); }
    else if (e.key === 'Enter') {
      const pick = sugg[Math.max(0, this.state.suggestionIdx)];
      if (pick) { e.preventDefault(); this.pickSuggestion(pick); }
    }
  }

  // ─── Dock hover (direct DOM — no re-render) ────────────────────────────────
  dockHover(nb: NeighborInfo | null, i = 0, n = 0) {
    const host = this.refs?.neighborCardsHost, line = this.refs?.dockLine, base = this.refs?.dockBase;
    if (this.hotEl) { this.hotEl.classList.remove('is-hot'); this.hotEl = null; }
    const show = (on: boolean) => { if (line) line.style.visibility = on ? 'visible' : 'hidden'; if (base) base.style.visibility = on ? 'hidden' : 'visible'; };
    if (!nb || !nb.node) { show(false); return; }
    show(true);
    const el = host?.querySelector<HTMLElement>(`[data-nid="${CSS.escape(nb.id)}"] .nb-mini`);
    if (el) { el.classList.add('is-hot'); this.hotEl = el; }
    if (line) line.textContent = `${i + 1}/${n}  ${nb.node.title} · Δ ${nb.distance.toFixed(3)}`;
  }

  back() { this.onBack(); }
}
