import type { GraphNode, NeighborInfo } from '@/services/galaxy-cache';
import type { LassoPoint } from '@/services/lasso-geometry';
import type { Zone } from '../engine/zoom';
import type { NodeDetailData } from '../data/detail';
import type { RerankHint } from '../data/neighbors';

export type StepStatus = 'pending' | 'running' | 'done' | 'waiting';
export interface LoadingStep {
  label: string;
  base: string;
  status: StepStatus;
  /** Raw detail from the build (counts) — the loader turns it into plain language. */
  detail?: string;
  /** Progress within the step, 0–1, when measurable. */
  fraction?: number;
}

export type ScannerMode = 'observer' | 'probe';
export type CardPhase = 'idle' | 'leaving' | 'hidden' | 'entering';

export interface ViewState {
  loading: boolean;
  loadingSteps: LoadingStep[];
  emptyGalaxy: boolean;
  selectedNode: GraphNode | null;
  neighbors: NeighborInfo[];
  /** Set when neighbours came from the 3D spatial fallback (distances are world units, not cosine). */
  neighborStatus: 'ann_rebuilding' | 'spatial_fallback' | null;
  /** What the Ollama rerank did for the selected star's neighbours (tier + positions moved, or why it was skipped). */
  rerankHint: RerankHint | null;
  focusedNbIdx: number;
  connectionCount: number;
  nodeCount: number;
  rendererBackend: string | null;
  searchQuery: string;
  searchFocused: boolean;
  suggestionIdx: number;
  activeGenres: Set<string>;
  allGenres: string[];
  showFilters: boolean;
  showLibrary: boolean;
  libSearch: string;
  showNeighbors: boolean;
  nbSearch: string;
  pathActive: boolean;
  pathOverview: boolean;
  pathIdx: number;
  pathDisabledReason: string | null;
  detailOpen: boolean;
  detailLoading: boolean;
  detailNodeId: string | null;
  detailData: NodeDetailData | null;
  traversalDepth: number;
  scannerMode: ScannerMode;
  lassoActive: boolean;
  lassoPath: LassoPoint[];
  lassoDrawing: boolean;
  lassoCapture: { nodeIds: string[]; genres: Array<{ name: string; count: number }> } | null;
  flythroughActive: boolean;
  lowerThird: { title: string; subtitle: string; index: number } | null;
  screenshotSaving: boolean;
  libVersion: number;
  /** Bumped when the chunked search index finishes, so open suggestions re-run on the full index. */
  searchIndexed: number;
  viewZone: Zone;
  pathHover: number;
  pathBottom: 'path' | 'nbs';
  pathShowNbs: boolean;
  focusPhase: 'hidden' | 'entering';
  pathCardPhase: CardPhase;
  pathGhost: { node: GraphNode; idx: number } | null;
  pathArriving: boolean;
}

export const INITIAL_STATE: ViewState = {
  loading: true,
  loadingSteps: [],
  emptyGalaxy: false,
  selectedNode: null,
  neighbors: [],
  neighborStatus: null,
  rerankHint: null,
  focusedNbIdx: -1,
  connectionCount: 0,
  nodeCount: 0,
  rendererBackend: null,
  searchQuery: '',
  searchFocused: false,
  suggestionIdx: -1,
  activeGenres: new Set(),
  allGenres: [],
  showFilters: false,
  showLibrary: false,
  libSearch: '',
  showNeighbors: false,
  nbSearch: '',
  pathActive: false,
  pathOverview: false,
  pathIdx: -1,
  pathDisabledReason: null,
  detailOpen: false,
  detailLoading: false,
  detailNodeId: null,
  detailData: null,
  traversalDepth: 0,
  scannerMode: 'observer',
  lassoActive: false,
  lassoPath: [],
  lassoDrawing: false,
  lassoCapture: null,
  flythroughActive: false,
  lowerThird: null,
  screenshotSaving: false,
  libVersion: 0,
  searchIndexed: 0,
  viewZone: 'cosmos',
  pathHover: -1,
  pathBottom: 'path',
  pathShowNbs: false,
  focusPhase: 'entering',
  pathCardPhase: 'idle',
  pathGhost: null,
  pathArriving: false,
};

export type StatePatch = Partial<ViewState> | ((s: ViewState) => Partial<ViewState> | null);
