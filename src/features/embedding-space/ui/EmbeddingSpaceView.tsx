/**
 * Embedding Space v2 — view layer. Rendering only; behaviour lives in
 * EmbeddingSpaceController and the three.js engine. Styling values are the
 * final values from the Claude Design handoff.
 */
import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CANONICAL_GENRE_LABELS, GENRE_PALETTE, type GraphNode } from '@/services/galaxy-cache';
import { libraryStore } from '@/services/library-store';
import { pathLength, toSvgPath } from '@/services/lasso-geometry';
import { EmbeddingSpaceController } from './controller';
import { INITIAL_STATE, type ViewState } from './state';
import { EsImg, primaryImage } from './EsImg';
import { DetailPanel } from './DetailPanel';
import { GalaxyLoader } from './GalaxyLoader';
import './embedding-space.css';

// ─── Shared style tokens ─────────────────────────────────────────────────────
const MONO = "'JetBrains Mono', monospace";
const GLASS_PANEL: CSSProperties = {
  zIndex: 30, pointerEvents: 'auto', display: 'flex', flexDirection: 'column', borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(40px)',
  boxShadow: '0 25px 50px -12px rgba(0,0,0,0.4)', overflow: 'hidden',
};
const PANEL_HEAD: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px',
  borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0, background: 'rgba(255,255,255,0.02)',
};
const PILL: CSSProperties = {
  background: 'rgba(255,255,255,0.04)', backdropFilter: 'blur(12px)', border: '1px solid rgba(232,121,249,0.3)',
  borderRadius: 9999, padding: '4px 12px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.22em', color: 'rgba(240,171,252,0.8)',
};
const TOP_CENTER: CSSProperties = { position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)', pointerEvents: 'none' };
const ICON_BTN: CSSProperties = { padding: 4, borderRadius: 4, color: 'rgba(255,255,255,0.4)', cursor: 'pointer' };
const NO_IMAGE: CSSProperties = { color: 'rgba(255,255,255,0.15)', fontWeight: 700 };
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

// ─── Icons (lucide paths, verbatim from the design) ──────────────────────────
type IconProps = { size?: number; style?: CSSProperties; className?: string; strokeWidth?: number; stroke?: string };
const Svg = ({ size = 12, style, className, strokeWidth = 2, stroke = 'currentColor', children }: IconProps & { children: ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>{children}</svg>
);
const IcLeft = (p: IconProps) => <Svg {...p}><path d="m15 18-6-6 6-6" /></Svg>;
const IcRight = (p: IconProps) => <Svg {...p}><path d="m9 18 6-6-6-6" /></Svg>;
const IcSearch = (p: IconProps) => <Svg {...p}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></Svg>;
const IcX = (p: IconProps) => <Svg {...p}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Svg>;
const IcCrosshair = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="10" /><line x1="22" x2="18" y1="12" y2="12" /><line x1="6" x2="2" y1="12" y2="12" /><line x1="12" x2="12" y1="6" y2="2" /><line x1="12" x2="12" y1="22" y2="18" /></Svg>;
const IcUndo = (p: IconProps) => <Svg {...p}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" /></Svg>;
const IcTraverse = (p: IconProps) => <Svg {...p}><polyline points="15 10 20 15 15 20" /><path d="M4 4v7a4 4 0 0 0 4 4h12" /></Svg>;
const IcInfo = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></Svg>;
const IcSpin = (p: IconProps) => <Svg {...p} style={{ animation: 'es-spin 1s linear infinite', ...p.style }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></Svg>;
const IcPlus = (p: IconProps) => <Svg {...p}><path d="M5 12h14" /><path d="M12 5v14" /></Svg>;
const IcCheck = (p: IconProps) => <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>;
const IcWeb = (p: IconProps) => <Svg {...p}><circle cx="12" cy="4.5" r="2.5" /><path d="m10.2 6.3-3.9 3.9" /><circle cx="4.5" cy="12" r="2.5" /><path d="M7 12h10" /><circle cx="19.5" cy="12" r="2.5" /><path d="m13.8 17.7 3.9-3.9" /><circle cx="12" cy="19.5" r="2.5" /></Svg>;
const IcNbToggle = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="2.5" /><circle cx="4.5" cy="6" r="1.8" /><circle cx="19.5" cy="6" r="1.8" /><circle cx="5" cy="18.5" r="1.8" /><circle cx="19" cy="18" r="1.8" /><path d="M10 11 6 7M14 11l4-4M10.3 13.6 6.3 17.3M13.7 13.6l3.8 3.2" /></Svg>;

function isLib(node: GraphNode) { return node.isLibrary || libraryStore.isInLibrary(node.id); }

export function EmbeddingSpaceView({ onBack, useMock = false }: { onBack: () => void; useMock?: boolean }) {
  const [S, setS] = useState<ViewState>(INITIAL_STATE);
  const ctlRef = useRef<EmbeddingSpaceController | null>(null);
  if (!ctlRef.current) ctlRef.current = new EmbeddingSpaceController(setS, onBack, useMock);
  const ctl = ctlRef.current;
  ctl.onBack = onBack;

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const screenshotAreaRef = useRef<HTMLDivElement>(null);
  const neighborCardsHostRef = useRef<HTMLDivElement>(null);
  const pathOverviewHostRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const fpsRef = useRef<HTMLSpanElement>(null);
  const approachWrapRef = useRef<HTMLDivElement>(null);
  const approachRef = useRef<HTMLSpanElement>(null);
  const depthRef = useRef<HTMLSpanElement>(null);
  const railMarkerRef = useRef<HTMLDivElement>(null);
  const dockLineRef = useRef<HTMLSpanElement>(null);
  const dockBaseRef = useRef<HTMLSpanElement>(null);

  // Layout effect: its cleanup runs while the canvas is still attached, so three.js
  // listeners registered on canvas.getRootNode() (OrbitControls) unregister from document.
  useLayoutEffect(() => {
    ctl.mount({
      root: rootRef.current, canvasHost: canvasHostRef.current, screenshotArea: screenshotAreaRef.current,
      neighborCardsHost: neighborCardsHostRef.current, pathOverviewHost: pathOverviewHostRef.current,
      tooltip: tooltipRef.current, fps: fpsRef.current, approachWrap: approachWrapRef.current, approach: approachRef.current,
      depth: depthRef.current, railMarker: railMarkerRef.current, dockLine: dockLineRef.current, dockBase: dockBaseRef.current,
    });
    return () => ctl.unmount();
  }, [ctl]);

  // ── Derived values ──
  const sel = S.selectedNode;
  const path = S.pathActive && S.pathIdx >= 0;
  const isLast = ctl.isLastPathNode();
  const nbs = useMemo(() => S.neighbors.filter(nb => nb.node && !nb.node.title.startsWith('Unknown Game')), [S.neighbors]);
  const focused = S.focusedNbIdx;
  const inNode = S.viewZone === 'node';
  const pn = ctl.pathStops;

  const libraryNodes = useMemo(
    () => ctl.nodes.filter(n => isLib(n)).sort((a, b) => b.hoursPlayed - a.hoursPlayed),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [S.libVersion, S.nodeCount],
  );
  const filteredLib = useMemo(() => {
    const q = S.libSearch.toLowerCase();
    return q ? libraryNodes.filter(n => n.title.toLowerCase().includes(q)) : libraryNodes;
  }, [libraryNodes, S.libSearch]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const suggestions = useMemo(() => (S.searchFocused && !S.loading ? ctl.computeSuggestions() : []), [S.searchFocused, S.loading, S.searchQuery, S.nodeCount, S.searchIndexed]);

  // Zone-gated chrome: node-navigation UI only exists in Game Node View
  const showNbDock = !!sel && inNode && (!S.pathActive || (S.pathBottom === 'nbs' && S.pathIdx >= 0)) && nbs.length > 1;
  // The strip only yields to the dock when the dock can actually show (else both would vanish)
  const showPathStrip = S.pathActive && pn.length > 1 && inNode && !(S.pathIdx >= 0 && S.pathBottom === 'nbs' && nbs.length > 1);
  const canPickBottom = S.pathActive && S.pathIdx >= 0 && nbs.length > 1;
  const showLibraryPanel = S.showLibrary && !S.loading && inNode;
  const showLibraryTab = !S.showLibrary && !S.loading && libraryNodes.length > 0 && inNode;
  const filterZone = inNode || S.viewZone === 'approach';
  const showFiltersPanel = S.showFilters && !S.loading && !sel && !S.pathActive && filterZone;
  const showFiltersTab = !S.showFilters && !S.loading && !sel && !S.pathActive && S.allGenres.length > 0 && filterZone;
  const showNeighborsPanel = S.showNeighbors && !!sel && S.neighbors.length > 0;
  const showNeighborsTab = !S.showNeighbors && !!sel && S.neighbors.length > 0;
  const hideViewLabel = showPathStrip || showNbDock;
  const showHints = !showNbDock && !showPathStrip;
  const leftOffset = showLibraryPanel ? 310 : 16;

  const viewModeLabel = S.viewZone === 'cosmos' ? '// COSMOS VIEW'
    : S.viewZone === 'approach' ? '// APPROACH'
      : sel
        ? (path ? `// PATH ${S.pathIdx + 1}/${pn.length}${isLast ? ' · FINAL' : ''}` : '// STAR VIEW')
        : S.pathActive && S.pathOverview ? '// PATH OVERVIEW' : S.pathActive ? '// PATH VIEW' : '// GAME NODE VIEW';


  const railStyle = (active: boolean, color: string): CSSProperties => ({
    fontSize: 9, letterSpacing: '0.2em', transition: 'color 0.4s', color: active ? color : 'rgba(255,255,255,0.22)',
    position: 'absolute', transform: 'translateY(-50%)',
  });

  return (
    <div ref={rootRef} className="es-root" style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#020208', color: '#ffffff', overflow: 'hidden', fontSize: '0.9375rem', lineHeight: 1.5 }}>
      {/* ── Header ── */}
      <div data-chrome="1" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)', flexShrink: 0, zIndex: 30, position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button type="button" data-tour="ann-graph-back" onClick={() => ctl.back()} title="Return to the Oracle view — your AI recommendation hub." className="es-hov-ghost" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', fontSize: 11, color: 'rgba(255,255,255,0.4)', borderRadius: 6, cursor: 'pointer' }}>
            <Svg size={14}><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></Svg>
            Oracle
          </button>
          <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.06)' }} />
          <h2 style={{ fontSize: 14, fontWeight: 500, color: 'rgba(255,255,255,0.7)', margin: 0 }}>Embedding Space</h2>
          {!S.loading && (
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {`${S.nodeCount.toLocaleString()} games${S.connectionCount > 0 ? ` · ${S.connectionCount} connections` : ''}`}
              {useMock && (
                <span style={{ marginLeft: 4, padding: '2px 6px', borderRadius: 4, background: 'rgba(245,158,11,0.2)', color: '#fbbf24', fontFamily: MONO, fontSize: 9, fontWeight: 700, border: '1px solid rgba(245,158,11,0.3)' }}>MOCK DATA</span>
              )}
              {S.rendererBackend ? ` · ${S.rendererBackend}` : ''}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ position: 'relative' }} title={S.loading ? 'Galaxy is still loading…' : ''} data-tour="ann-graph-search">
            <IcSearch style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', zIndex: 10, color: S.loading ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.3)' }} />
            <input
              type="text" value={S.searchQuery} disabled={S.loading}
              placeholder={S.loading ? 'Loading galaxy…' : 'Search games...'}
              onChange={e => ctl.set({ searchQuery: e.target.value, suggestionIdx: -1 })}
              onFocus={() => ctl.onSearchFocus()} onBlur={() => ctl.onSearchBlur()} onKeyDown={e => ctl.onSearchKeyDown(e)}
              style={{
                width: 288, padding: '4px 8px 4px 28px', fontSize: 11, border: '1px solid', borderRadius: 6, outline: 'none', transition: 'border-color 0.15s, background 0.15s',
                ...(S.loading
                  ? { background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.03)', color: 'rgba(255,255,255,0.2)', cursor: 'not-allowed' }
                  : { background: 'rgba(255,255,255,0.05)', borderColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.7)' }),
              }}
            />
            {suggestions.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, width: 288, marginTop: 4, background: 'rgba(0,0,0,0.95)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, backdropFilter: 'blur(24px)', overflowY: 'auto', zIndex: 50, maxHeight: 360 }}>
                {suggestions.map((node, i) => (
                  <div key={node.id} onMouseDown={() => ctl.pickSuggestion(node)} onMouseEnter={() => ctl.set({ suggestionIdx: i })}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', cursor: 'pointer', transition: 'background 0.15s', background: i === S.suggestionIdx ? 'rgba(217,70,239,0.15)' : 'transparent' }}>
                    <div style={{ position: 'relative', width: 56, height: 28, borderRadius: 4, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7, color: 'rgba(255,255,255,0.2)', fontWeight: 700 }}>
                      NO IMAGE
                      <EsImg id={node.id} title={node.title} coverUrl={node.coverUrl} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.8)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.title}</div>
                      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.genres.slice(0, 3).join(' · ')}</div>
                    </div>
                    {isLib(node) && <span style={{ fontSize: 9, color: 'rgba(52,211,153,0.4)', flexShrink: 0 }}>★ Library</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <span ref={fpsRef} title="Frames per second" style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', fontFamily: MONO, fontVariantNumeric: 'tabular-nums', padding: '3px 8px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.03)', minWidth: 56, textAlign: 'center' }}>-- FPS</span>
          <button onClick={() => { if (!S.loading) ctl.handleReset(); }} disabled={S.loading}
            title={S.loading ? 'Galaxy is still loading — please wait for the embedding space to finish initializing.' : 'Reset the camera and clear any selected star or active path.'}
            style={{ padding: '4px 8px', borderRadius: 6, transition: 'color 0.15s, background 0.15s', color: S.loading ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.3)', cursor: S.loading ? 'not-allowed' : 'pointer' }}>
            <Svg><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></Svg>
          </button>
        </div>
      </div>

      {/* ── Scene ── */}
      <div ref={screenshotAreaRef} data-tour="ann-graph-canvas" style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div
          ref={canvasHostRef}
          onPointerDown={e => ctl.handleCanvasPointerDown(e)}
          onClick={e => ctl.handleCanvasClick(e)}
          onMouseMove={e => ctl.handleCanvasMove(e)}
          onMouseLeave={() => ctl.handleCanvasLeave()}
          onContextMenu={e => e.preventDefault()}
          style={{ position: 'absolute', inset: 0 }}
        />
        <div ref={approachWrapRef} style={{ ...TOP_CENTER, zIndex: 25, opacity: 0, transition: 'opacity 0.4s' }}>
          <div style={{ ...PILL, fontFamily: MONO }}>Approach · <span ref={approachRef}>EMBEDDING SPACE 0%</span></div>
        </div>

        {/* Depth rail */}
        <div className="screenshot-exclude" style={{ position: 'absolute', left: 44, top: '50%', transform: 'translateY(-50%)', height: 260, zIndex: 22, pointerEvents: 'none', display: 'flex', gap: 12, alignItems: 'stretch', fontFamily: MONO }}>
          <div style={{ position: 'relative', width: 1, background: 'linear-gradient(to bottom, rgba(255,255,255,0.05), rgba(255,255,255,0.18) 30%, rgba(255,255,255,0.18) 70%, rgba(255,255,255,0.05))' }}>
            {[12, 50, 86].map(t => <div key={t} style={{ position: 'absolute', left: -4, top: `${t}%`, width: 9, height: 1, background: 'rgba(255,255,255,0.25)' }} />)}
            <div ref={railMarkerRef} style={{ position: 'absolute', left: -5, top: '0%', width: 11, height: 11, marginTop: -5, borderRadius: 9999, border: '1px solid rgba(240,171,252,0.85)', background: 'rgba(10,4,16,0.9)', boxShadow: '0 0 12px rgba(217,70,239,0.35)' }} />
          </div>
          <div style={{ position: 'relative', width: 90 }}>
            <button className="es-zone-btn" onClick={() => ctl.goToZone('cosmos')} title="Fly out to the cosmos" style={{ ...railStyle(S.viewZone === 'cosmos', 'rgba(255,255,255,0.85)'), top: '12%' }}>COSMOS</button>
            <button className="es-zone-btn" onClick={() => ctl.goToZone('approach')} title="Settle in the approach view" style={{ ...railStyle(S.viewZone === 'approach', 'rgba(240,171,252,0.9)'), top: '50%' }}>APPROACH</button>
            <button className="es-zone-btn" onClick={() => ctl.goToZone('node')} title="Dive into the game node view" style={{ ...railStyle(S.viewZone === 'node', 'rgba(103,232,249,0.9)'), top: '86%' }}>NODE</button>
          </div>
        </div>

        {S.viewZone === 'cosmos' && !S.loading && !S.emptyGalaxy && (
          <div style={{ ...TOP_CENTER, zIndex: 25, animation: 'es-fade-in 0.4s ease both' }}>
            <div style={{ ...PILL, border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.45)' }}>Scroll to dolly in · middle-drag to orbit</div>
          </div>
        )}
        {inNode && !S.loading && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 15, pointerEvents: 'none', background: 'radial-gradient(ellipse at center, transparent 52%, rgba(2,2,8,0.5) 100%)', animation: 'es-fade-in 0.8s ease both' }} />
        )}

        {/* Lasso */}
        {S.lassoActive && (
          <>
            <svg style={{ position: 'absolute', inset: 0, zIndex: 30, pointerEvents: 'auto', cursor: 'crosshair', touchAction: 'none', width: '100%', height: '100%' }}
              onPointerDown={e => ctl.handleLassoDown(e)} onPointerMove={e => ctl.handleLassoMove(e)} onPointerUp={e => ctl.handleLassoUp(e)}>
              {(() => {
                // While drawing, the controller writes `d` straight to this element (no re-render per move)
                const r = S.lassoPath.length >= 2 ? screenshotAreaRef.current?.getBoundingClientRect() : undefined;
                const local = r ? S.lassoPath.map(p => ({ x: p.x - r.left, y: p.y - r.top })) : S.lassoPath;
                return (
                  <path d={local.length >= 2 ? toSvgPath(local, !S.lassoDrawing && pathLength(S.lassoPath) > 60) : ''} fill={S.lassoCapture ? 'rgba(168, 85, 247, 0.08)' : 'rgba(168, 85, 247, 0.04)'}
                    stroke="rgba(217, 70, 239, 0.85)" strokeWidth={1.6} strokeDasharray="5 4" strokeLinecap="round" strokeLinejoin="round" />
                );
              })()}
            </svg>
            <div style={{ ...TOP_CENTER, zIndex: 40 }}><div style={PILL}>Lasso · drag to draw · Esc to exit · L to toggle</div></div>
            {S.lassoCapture && (
              <div style={{ position: 'absolute', bottom: 16, right: 16, zIndex: 40, width: 320, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(24px)', border: '1px solid rgba(232,121,249,0.3)', borderRadius: 12, padding: 16, boxShadow: '0 25px 50px -12px rgba(217,70,239,0.1)', pointerEvents: 'auto' }}>
                <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.18em', color: 'rgba(240,171,252,0.6)', marginBottom: 8 }}>Lasso Capture</div>
                <div style={{ fontSize: 24, fontWeight: 300, color: 'rgba(255,255,255,0.95)', marginBottom: 4 }}>{S.lassoCapture.nodeIds.length.toLocaleString()} stars</div>
                {S.lassoCapture.genres.length > 0 && (
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginBottom: 12 }}>Top genres: {S.lassoCapture.genres.slice(0, 3).map(g => `${g.name} (${g.count})`).join(', ')}</div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => ctl.set({ lassoPath: [], lassoCapture: null })} className="es-hov-clear" style={{ flex: 1, padding: '6px 12px', borderRadius: 6, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', fontSize: 12, color: 'rgba(255,255,255,0.7)', cursor: 'pointer', transition: 'background 0.15s' }}>Clear</button>
                </div>
              </div>
            )}
          </>
        )}

        {/* Year Wrapped flythrough */}
        {S.flythroughActive && (
          <>
            {S.lowerThird && (
              <div key={S.lowerThird.index} style={{ position: 'absolute', left: '50%', bottom: 64, zIndex: 30, pointerEvents: 'none', animation: 'es-rise-in 0.6s cubic-bezier(0.16,1,0.3,1) both', transform: 'translateX(-50%)' }}>
                <div style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '16px 24px', maxWidth: 560, textAlign: 'center', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.7)' }}>
                  <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.24em', color: 'rgba(240,171,252,0.55)', marginBottom: 6 }}>The Voyage · Keyframe {S.lowerThird.index + 1}</div>
                  <div style={{ fontSize: 22, fontWeight: 300, color: 'rgba(255,255,255,0.95)', marginBottom: 4, lineHeight: 1.2 }}>{S.lowerThird.title}</div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>{S.lowerThird.subtitle}</div>
                </div>
              </div>
            )}
            <div style={{ ...TOP_CENTER, zIndex: 30 }}><div style={PILL}>Cinematic · Esc to exit</div></div>
          </>
        )}

        {/* Probe */}
        {S.scannerMode === 'probe' && (
          <>
            <svg style={{ position: 'absolute', left: '50%', top: '50%', pointerEvents: 'none', zIndex: 20, width: 32, height: 32, transform: 'translate(-50%, -50%)' }} viewBox="0 0 32 32">
              <polygon points="16,4 28,28 4,28" fill="rgba(167, 139, 250, 0.18)" stroke="rgba(167, 139, 250, 0.85)" strokeWidth={1.5} />
              <circle cx="16" cy="20" r="2" fill="rgba(167, 139, 250, 0.9)" />
            </svg>
            <div style={{ ...TOP_CENTER, zIndex: 30 }}><div style={PILL}>Probe Mode · WASD to drift · P to exit</div></div>
          </>
        )}

        {/* Library panel */}
        {showLibraryPanel && <LibraryPanel ctl={ctl} rows={filteredLib} total={libraryNodes.length} selId={sel?.id ?? null} libSearch={S.libSearch} />}
        {showLibraryTab && (
          <SideTab side="left" label="Library" title="Open library panel" onClick={() => ctl.set({ showLibrary: true })} />
        )}

        {/* Loader */}
        {S.loading && <GalaxyLoader steps={S.loadingSteps} />}

        {/* No embeddings yet */}
        {S.emptyGalaxy && !S.loading && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 30, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 380, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(24px)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, padding: 20, textAlign: 'center' }}>
              <h3 style={{ fontSize: 14, fontWeight: 500, color: 'rgba(255,255,255,0.7)', margin: '0 0 8px' }}>Embedding Space Requires Ollama</h3>
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', margin: '0 0 16px', lineHeight: 1.6 }}>
                The galaxy map visualizes game embeddings generated by Ollama&apos;s Snowflake Arctic Embed model. Install Ollama and restart the app to unlock this feature.
              </p>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
                <button onClick={() => ctl.back()} style={{ padding: '6px 14px', fontSize: 11, color: 'rgba(255,255,255,0.5)', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, cursor: 'pointer' }}>Go Back</button>
                <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" style={{ padding: '6px 14px', fontSize: 11, color: '#e879f9', background: 'rgba(217,70,239,0.1)', border: '1px solid rgba(217,70,239,0.3)', borderRadius: 8 }}>Download Ollama</a>
              </div>
            </div>
          </div>
        )}

        {/* Floating cards at star positions (positioned every frame by the engine) */}
        <div ref={neighborCardsHostRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 20 }}>
          {sel && (
            <SelectedCard ctl={ctl} S={S} sel={sel} path={path} isLast={isLast} nbCount={nbs.length} />
          )}
          {sel && nbs.map((nb, i) => {
            const node = nb.node!;
            const isFocused = focused === i;
            const inLib = isLib(node);
            const detailLoading = S.detailLoading && S.detailNodeId === node.id;
            const detailActive = S.detailOpen && S.detailNodeId === node.id;
            return (
              <div key={node.id} data-nx={node.x} data-ny={node.y} data-nz={node.z} data-nid={node.id} data-reveal="1" data-focus={isFocused ? '1' : '0'}
                style={{ position: 'absolute', left: 0, top: 0, willChange: 'transform', opacity: 0, zIndex: isFocused ? 10 : 1 }}>
                <div className="es-leader" style={{ position: 'absolute', left: '50%', top: '100%', height: 48, width: 0, borderLeft: '1px dotted rgba(255,255,255,0.32)', pointerEvents: 'none' }} />
                <div className="nb-card-group" style={isFocused
                  ? (S.focusPhase === 'hidden'
                    ? { position: 'relative', opacity: 0, visibility: 'hidden', transform: 'translateY(12px) scale(0.96)', filter: 'blur(3px)', transition: 'none' }
                    : { position: 'relative', opacity: 1, transform: 'none', filter: 'none', transition: 'opacity 0.7s cubic-bezier(0.16,1,0.3,1) 0.05s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.05s, filter 0.7s ease 0.05s' })
                  : { position: 'relative', animation: 'es-card-rise 0.7s cubic-bezier(0.16,1,0.3,1) both', animationDelay: `${(0.45 + i * 0.07).toFixed(2)}s` }}>
                  {isFocused ? (
                    <>
                      <div onClick={e => { e.stopPropagation(); ctl.setFocusedNb(i, true); }} onMouseMove={stop}
                        style={{ borderRadius: 12, overflow: 'hidden', backdropFilter: 'blur(12px)', cursor: 'pointer', pointerEvents: 'auto', width: 320, background: 'rgba(0,0,0,0.9)', border: '1px solid rgba(6,182,212,0.3)', boxShadow: '0 20px 25px -5px rgba(6,182,212,0.15), 0 0 0 1px rgba(6,182,212,0.1)', transition: 'all 0.3s' }}>
                        <div style={{ position: 'relative', width: '100%', height: 120, background: 'rgba(0,0,0,0.4)', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'height 0.3s' }}>
                          <span style={{ ...NO_IMAGE, fontSize: 12 }}>NO IMAGE</span>
                          <EsImg id={node.id} title={node.title} coverUrl={node.coverUrl} fade />
                        </div>
                        <div style={{ padding: '12px 14px' }}>
                          <div style={{ fontWeight: 600, lineHeight: 1.25, fontSize: 15, color: '#ffffff', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: '2.5em', fontFamily: 'Inter, system-ui, sans-serif' }}>{node.title}</div>
                          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 4 }}>{node.developer || ' '}</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                            {node.genres.slice(0, 4).map(g => <span key={g} style={{ fontSize: 8, padding: '1px 6px', borderRadius: 4, background: 'rgba(6,182,212,0.1)', color: 'rgba(34,211,238,0.7)', lineHeight: 1.25 }}>{g}</span>)}
                          </div>
                        </div>
                      </div>
                      <div style={{ width: 320, marginTop: 6, userSelect: 'none' }}>
                        <div onClick={stop} onMouseMove={stop} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: 6, borderRadius: 8, background: 'rgba(255,255,255,0.04)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.06)', pointerEvents: 'auto', marginTop: 8 }}>
                          <button onClick={() => ctl.handleCyclePrev()} title="Previous neighbor" className="es-hov-icon" style={ICON_BTN}><IcLeft /></button>
                          <button onClick={() => ctl.handleCycleHome()} title="Back to selected star" className="es-hov-icon" style={ICON_BTN}><IcCrosshair /></button>
                          <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.3)', fontVariantNumeric: 'tabular-nums', fontFamily: MONO, flex: 1, textAlign: 'center' }}>{`${focused + 1}/${nbs.length}`}</span>
                          <button onClick={() => ctl.handleCycleNext()} title="Next neighbor" className="es-hov-icon" style={ICON_BTN}><IcRight /></button>
                          <button onClick={() => ctl.traverseInto(node)} title="Traverse into — explore this game's own neighbors and see what's similar to it." className="es-hov-amber" style={{ ...ICON_BTN, color: 'rgba(251,191,36,0.6)' }}><IcTraverse /></button>
                          <button onClick={() => void ctl.toggleDetail(node.id)} title="View full details — store info, reviews, screenshots, and description."
                            style={{ ...ICON_BTN, transition: 'color 0.15s, background 0.15s', ...(detailActive ? { color: 'rgba(34,211,238,0.8)', background: 'rgba(6,182,212,0.1)' } : null) }}>
                            {detailLoading ? <IcSpin /> : <IcInfo />}
                          </button>
                          {!inLib ? (
                            <button onClick={() => ctl.addNodeToLibrary(node)} title="Add this game to your personal library to track it." className="es-hov-emerald" style={{ ...ICON_BTN, color: 'rgba(52,211,153,0.6)' }}><IcPlus /></button>
                          ) : (
                            <span title="This game is already in your library." style={{ padding: 4, color: 'rgba(52,211,153,0.4)', display: 'inline-flex' }}><IcCheck /></span>
                          )}
                        </div>
                        {detailActive && <DetailPanel data={S.detailData} loading={S.detailLoading} nodeId={node.id} />}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="nb-mini" onClick={e => { e.stopPropagation(); ctl.setFocusedNb(i, true); }} onMouseMove={stop}
                        style={{ borderRadius: 12, overflow: 'hidden', backdropFilter: 'blur(12px)', transition: 'all 0.3s', cursor: 'pointer', pointerEvents: 'auto' }}>
                        <div className="nb-mini-img" style={{ position: 'relative', width: '100%', background: 'rgba(0,0,0,0.4)', overflow: 'hidden', transition: 'height 0.3s', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <span style={{ ...NO_IMAGE, fontSize: 8, position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)' }}>NO IMAGE</span>
                          <EsImg id={node.id} title={node.title} coverUrl={node.coverUrl} fade />
                        </div>
                        <div style={{ padding: '4px 6px' }}>
                          <div style={{ fontWeight: 600, lineHeight: 1.25, fontSize: 9, color: 'rgba(255,255,255,0.85)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.title}</div>
                        </div>
                      </div>
                      <div className="nb-mini-meta" style={{ position: 'absolute', left: '100%', top: 0, marginLeft: 6, display: 'flex', flexDirection: 'column', gap: 2, padding: '2px 0', pointerEvents: 'none', userSelect: 'none', fontFamily: MONO, fontSize: 9, lineHeight: 1, letterSpacing: '0.05em', transition: 'color 0.3s' }}>
                        <span>d={nb.distance.toFixed(3)}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div ref={tooltipRef} style={{ position: 'absolute', zIndex: 40, pointerEvents: 'none', display: 'none' }}>
          <div style={{ background: 'rgba(0,0,0,0.9)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, overflow: 'hidden', backdropFilter: 'blur(24px)', maxWidth: 260 }}>
            <div style={{ padding: '8px 12px' }}>
              <div data-tip-title="1" style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.9)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} />
              <div data-tip-dev="1" style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} />
              <div data-tip-genre="1" style={{ fontSize: 9, color: 'rgba(192,132,252,0.7)', marginTop: 4 }} />
            </div>
          </div>
        </div>

        {/* Neighbours panel */}
        {showNeighborsPanel && sel && (
          <NeighborsPanel ctl={ctl} S={S} sel={sel} nbs={nbs} />
        )}
        {showNeighborsTab && (
          <SideTab side="right" label="Neighbors" title="Open neighbors panel" onClick={() => ctl.set({ showNeighbors: true })} />
        )}

        {/* Path anchor cards (decluttered against the HUD) */}
        <div ref={pathOverviewHostRef} data-declutter="1" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 20 }}>
          <PathAnchors ctl={ctl} S={S} />
        </div>

        {/* Genre filter panel */}
        {showFiltersPanel && <GenrePanel ctl={ctl} S={S} />}
        {showFiltersTab && (
          <SideTab side="right" label="Genres" title="Open genre filter" onClick={() => ctl.set({ showFilters: true })}
            badge={S.activeGenres.size > 0 && S.activeGenres.size < S.allGenres.length ? S.activeGenres.size : undefined} />
        )}

        {/* Legend */}
        <div style={{ position: 'absolute', bottom: 16, display: inNode ? 'flex' : 'none', alignItems: 'center', gap: 20, fontSize: 11, color: 'rgba(255,255,255,0.4)', zIndex: 20, pointerEvents: 'none', transition: 'all 0.3s', left: leftOffset, opacity: hideViewLabel ? 0 : 1 }}>
          {[
            ['Selected', 10, 'radial-gradient(circle, #f0abfc, #a855f7)'],
            ['Neighbor', 10, 'radial-gradient(circle, #67e8f9, #06b6d4)'],
            ['Library', 8, 'rgba(255,255,255,0.6)'],
            ['Catalog', 6, 'rgba(255,255,255,0.3)'],
          ].map(([label, size, bg]) => (
            <div key={label as string} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: size as number, height: size as number, borderRadius: 9999, background: bg as string }} />
              <span>{label}</span>
            </div>
          ))}
        </div>

        {showNbDock && <NeighborDock ctl={ctl} S={S} nbs={nbs} canPickBottom={canPickBottom} dockBaseRef={dockBaseRef} dockLineRef={dockLineRef} />}
        {showPathStrip && <PathStrip ctl={ctl} S={S} canPickBottom={canPickBottom} />}

        {/* Bottom actions */}
        {!S.loading && inNode && (
          <div className="screenshot-exclude" data-avoid="1" style={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 12, zIndex: 20 }}>
            <button onClick={() => { if (!S.pathDisabledReason || S.pathActive) ctl.showThePath(); }} disabled={!!S.pathDisabledReason && !S.pathActive}
              title={S.pathDisabledReason && !S.pathActive ? S.pathDisabledReason : 'Trace your play history as a connected path through the galaxy.'}
              style={{
                padding: '6px 14px', borderRadius: 9999, border: '1px solid', backdropFilter: 'blur(24px)', fontSize: 10, fontWeight: 500, letterSpacing: '0.025em', transition: 'all 0.5s', pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 6,
                ...(S.pathActive
                  ? { borderColor: 'rgba(59,130,246,0.3)', background: 'rgba(59,130,246,0.15)', color: 'rgba(147,197,253,0.9)', boxShadow: '0 10px 15px -3px rgba(59,130,246,0.1)', cursor: 'pointer' }
                  : S.pathDisabledReason
                    ? { borderColor: 'rgba(255,255,255,0.04)', background: 'rgba(255,255,255,0.02)', color: 'rgba(255,255,255,0.15)', cursor: 'not-allowed' }
                    : { borderColor: 'rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }),
              }}>
              <Svg><circle cx="6" cy="19" r="3" /><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" /><circle cx="18" cy="5" r="3" /></Svg>
              The Path
            </button>
            {S.pathActive && S.pathOverview && (
              <>
                <button onClick={() => ctl.startPathExplore()} className="es-hov-explore" style={{ padding: '6px 14px', borderRadius: 9999, border: '1px solid rgba(59,130,246,0.4)', background: 'rgba(59,130,246,0.2)', color: '#bfdbfe', fontSize: 10, fontWeight: 500, letterSpacing: '0.025em', transition: 'all 0.5s', cursor: 'pointer', pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 6, boxShadow: '0 10px 15px -3px rgba(59,130,246,0.15)' }}>
                  <IcWeb />
                  Explore Path
                </button>
                <button onClick={() => void ctl.captureScreenshot()} disabled={S.screenshotSaving} title="Capture a high-resolution screenshot of the galaxy and save it." className="es-hov-shot" style={{ padding: '6px 12px', borderRadius: 9999, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)', fontSize: 10, fontWeight: 500, letterSpacing: '0.025em', transition: 'all 0.3s', cursor: 'pointer', pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Svg><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /><circle cx="12" cy="13" r="3" /></Svg>
                  {S.screenshotSaving ? 'Saving...' : 'Screenshot'}
                </button>
              </>
            )}
          </div>
        )}

        {/* View label */}
        <div className="screenshot-exclude" style={{ position: 'absolute', bottom: 56, zIndex: 20, pointerEvents: 'none', display: 'flex', flexDirection: 'column', gap: 4, transition: 'all 0.3s', left: leftOffset, opacity: hideViewLabel ? 0 : 1 }}>
          <span style={{ fontFamily: MONO, fontSize: 22, lineHeight: 1, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.15)' }}>{viewModeLabel}</span>
          <span ref={depthRef} style={{ fontSize: 9, color: 'rgba(232,121,249,0.25)', fontFamily: MONO, marginTop: 2, display: 'block' }}>CORE::--</span>
        </div>

        {/* Control hints */}
        {showHints && !S.loading && (
          <div className="screenshot-exclude" style={{ position: 'absolute', bottom: 12, right: 16, display: 'flex', flexDirection: 'column', gap: 6, zIndex: 20, pointerEvents: 'none' }}>
            <Hint anim="hint-orbit 2.4s ease-in-out infinite" text="Middle mouse + drag to orbit"><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z" /><path d="m13 13 6 6" /></Hint>
            <Hint anim="hint-pan 2s ease-in-out infinite" text="Right click + drag to pan"><polyline points="5 9 2 12 5 15" /><polyline points="9 5 12 2 15 5" /><polyline points="15 19 12 22 9 19" /><polyline points="19 9 22 12 19 15" /><line x1="2" x2="22" y1="12" y2="12" /><line x1="12" x2="12" y1="2" y2="22" /></Hint>
            <Hint anim="hint-zoom 2.2s ease-in-out infinite" text="Scroll to dolly between views"><circle cx="11" cy="11" r="8" /><line x1="21" x2="16.65" y1="21" y2="16.65" /><line x1="11" x2="11" y1="8" y2="14" /><line x1="8" x2="14" y1="11" y2="11" /></Hint>
            <Hint anim="hint-tap 2.6s ease-in-out infinite" text="Click a star to inspect"><circle cx="12" cy="12" r="10" /><line x1="22" x2="18" y1="12" y2="12" /><line x1="6" x2="2" y1="12" y2="12" /><line x1="12" x2="12" y1="6" y2="2" /><line x1="12" x2="12" y1="22" y2="18" /></Hint>
            {(!!sel || S.pathActive) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: 'rgba(255,255,255,0.3)', fontFamily: MONO }}>
                <IcLeft style={{ flexShrink: 0 }} />
                <IcRight style={{ flexShrink: 0, marginLeft: -6 }} />
                <span>Arrow keys to cycle</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────
type CtlProps = { ctl: EmbeddingSpaceController; S: ViewState };

/** Memoised: the library can hold thousands of rows and must not re-render on unrelated view state. */
const LibraryPanel = memo(function LibraryPanel({ ctl, rows, total, selId, libSearch }: { ctl: EmbeddingSpaceController; rows: GraphNode[]; total: number; selId: string | null; libSearch: string }) {
  return (
    <div onClick={stop} onMouseMove={stop} style={{ ...GLASS_PANEL, position: 'absolute', top: 12, left: 12, bottom: 56, width: 288, animation: 'es-panel-in-left 0.28s cubic-bezier(0.23,1,0.32,1) both' }}>
      <div style={PANEL_HEAD}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Svg size={14} stroke="rgba(52,211,153,0.7)"><path d="m16 6 4 14" /><path d="M12 6v14" /><path d="M8 8v12" /><path d="M4 4v16" /></Svg>
          <span style={{ fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.6)' }}>My Library</span>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)', fontVariantNumeric: 'tabular-nums' }}>{rows.length !== total ? `${rows.length} / ${total}` : String(total)}</span>
        </div>
        <button onClick={() => ctl.set({ showLibrary: false, libSearch: '' })} title="Collapse panel" className="es-hov-ghost" style={{ padding: 4, borderRadius: 6, color: 'rgba(255,255,255,0.25)', cursor: 'pointer' }}><IcLeft size={14} /></button>
      </div>
      <SearchField value={libSearch} placeholder="Filter library…" focusClass="es-focus-emerald" onChange={v => ctl.set({ libSearch: v })} />
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: 8 }}>
        {rows.length === 0 && (
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', textAlign: 'center', padding: '32px 0' }}>{libSearch ? 'No matches' : 'No library games found'}</div>
        )}
        {rows.map(node => {
          const active = selId === node.id;
          return (
            <button key={node.id} onClick={() => { ctl.traversalStack = []; ctl.set({ traversalDepth: 0 }); ctl.selectNode(node, true); }}
              style={{ display: 'block', width: '100%', borderRadius: 8, overflow: 'hidden', textAlign: 'left', transition: 'all 0.2s', cursor: 'pointer', marginBottom: 6, contentVisibility: 'auto', containIntrinsicSize: 'auto 136px', border: `1px solid ${active ? 'rgba(217,70,239,0.3)' : 'transparent'}`, ...(active ? { background: 'rgba(217,70,239,0.1)', boxShadow: '0 0 0 1px rgba(217,70,239,0.2)' } : null) }}>
              <div style={{ position: 'relative', width: '100%', height: 72, background: 'rgba(0,0,0,0.4)', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: 14, fontWeight: 700 }}>NO IMAGE</span>
                <EsImg id={node.id} title={node.title} coverUrl={node.coverUrl} />
                <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(0,0,0,0.7), transparent 50%)', pointerEvents: 'none' }} />
                {node.hoursPlayed > 0 && (
                  <span style={{ position: 'absolute', bottom: 4, right: 6, fontSize: 8, color: 'rgba(255,255,255,0.5)', fontFamily: MONO, background: 'rgba(0,0,0,0.5)', padding: '2px 4px', borderRadius: 4, backdropFilter: 'blur(4px)' }}>{node.hoursPlayed.toFixed(1)}h</span>
                )}
              </div>
              <div style={{ padding: '8px 10px' }}>
                <div style={{ fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.85)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.25 }}>{node.title}</div>
                {node.developer && <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>{node.developer}</div>}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                  {node.genres.slice(0, 3).map(g => <span key={g} style={{ fontSize: 8, padding: '1px 4px', borderRadius: 4, background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.3)' }}>{g}</span>)}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
});

function Hint({ anim, text, children }: { anim: string; text: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: 'rgba(255,255,255,0.3)', fontFamily: MONO }}>
      <Svg style={{ animation: anim, flexShrink: 0 }}>{children}</Svg>
      <span>{text}</span>
    </div>
  );
}

function SearchField({ value, placeholder, focusClass, onChange }: { value: string; placeholder: string; focusClass: string; onChange: (v: string) => void }) {
  return (
    <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.04)', flexShrink: 0 }}>
      <div style={{ position: 'relative' }}>
        <IcSearch stroke="rgba(255,255,255,0.2)" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)' }} />
        <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className={focusClass}
          style={{ width: '100%', padding: '6px 8px 6px 28px', fontSize: 11, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, color: 'rgba(255,255,255,0.7)', outline: 'none', transition: 'border-color 0.15s' }} />
        {value.length > 0 && (
          <button onClick={() => onChange('')} className="es-hov-ghost" style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', padding: 2, borderRadius: 4, color: 'rgba(255,255,255,0.2)', cursor: 'pointer' }}><IcX /></button>
        )}
      </div>
    </div>
  );
}

function SideTab({ side, label, title, onClick, badge }: { side: 'left' | 'right'; label: string; title: string; onClick: () => void; badge?: number }) {
  const left = side === 'left';
  return (
    <button className={`${left ? 'lib-tab' : 'nb-tab'} es-hov-tab`} onClick={onClick} title={title}
      style={{
        position: 'absolute', top: '50%', transform: 'translateY(-50%)', [left ? 'left' : 'right']: 0, zIndex: 30, pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 4,
        padding: left ? '12px 8px 12px 6px' : '12px 6px 12px 8px', borderRadius: left ? '0 8px 8px 0' : '8px 0 0 8px',
        border: '1px solid rgba(255,255,255,0.08)', [left ? 'borderLeft' : 'borderRight']: 'none', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(24px)',
        color: 'rgba(255,255,255,0.4)', cursor: 'pointer', animation: 'es-fade-in 0.2s ease both',
      }}>
      {left && <IcRight className="lib-tab-ch" />}
      <span style={{ fontSize: 9, fontWeight: 500, writingMode: 'vertical-lr', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{label}</span>
      {badge !== undefined && (
        <span style={{ position: 'absolute', top: -4, left: -4, width: 16, height: 16, borderRadius: 9999, background: 'rgba(217,70,239,0.8)', fontSize: 7, color: '#ffffff', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{badge}</span>
      )}
      {!left && <IcLeft className="nb-tab-ch" />}
    </button>
  );
}

function SelectedCard({ ctl, S, sel, path, isLast, nbCount }: CtlProps & { sel: GraphNode; path: boolean; isLast: boolean; nbCount: number }) {
  const focused = S.focusedNbIdx;
  const expanded = focused === -1;
  const accBorder = path ? 'rgba(59,130,246,0.3)' : 'rgba(217,70,239,0.3)';
  const accShadow = path ? 'rgba(59,130,246,0.15)' : 'rgba(217,70,239,0.15)';
  const accRing = path ? 'rgba(59,130,246,0.1)' : 'rgba(217,70,239,0.1)';
  const ph = S.pathCardPhase;
  // Invisible phases also drop `visibility` so the card's action rows can't take clicks
  const innerStyle: CSSProperties = ph === 'leaving'
    ? { position: 'relative', transformOrigin: '50% 100%', opacity: 0, visibility: 'hidden', transform: 'translateY(-6px) scale(0.97)', filter: 'blur(2px)', transition: 'opacity 0.45s cubic-bezier(0.4,0,0.2,1) 0.15s, transform 0.6s cubic-bezier(0.4,0,0.2,1) 0.15s, filter 0.6s ease 0.15s, visibility 0s linear 0.6s' }
    : ph === 'hidden'
      ? { position: 'relative', transformOrigin: '50% 100%', opacity: 0, visibility: 'hidden', transform: 'translateY(14px) scale(0.95)', filter: 'blur(3px)', transition: 'none' }
      : { position: 'relative', transformOrigin: '50% 100%', opacity: 1, transform: 'none', filter: 'none', transition: 'opacity 0.7s cubic-bezier(0.16,1,0.3,1) 0.08s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.08s, filter 0.7s ease 0.08s' };
  const pn = ctl.pathStops;
  const showCycleControls = nbCount > 0 || (S.pathActive && pn.length > 1);
  const showHomeBtn = !S.pathActive || isLast;
  const cyclePathMode = S.pathActive && !isLast && !S.pathShowNbs;
  const cycleCounter = path && !S.pathShowNbs
    ? (isLast ? (focused === -1 ? `★ ${S.pathIdx + 1}/${pn.length}` : `${focused + 1}/${nbCount}`) : `${S.pathIdx + 1}/${pn.length}`)
    : (focused === -1 ? (S.traversalDepth > 0 ? `↳ D${S.traversalDepth}` : '—') : `${focused + 1}/${nbCount}`);
  const accentText = path ? 'rgba(96,165,250,0.8)' : 'rgba(232,121,249,0.8)';
  const accentBg = path ? 'rgba(59,130,246,0.1)' : 'rgba(217,70,239,0.1)';
  const detailActive = S.detailOpen && S.detailNodeId === sel.id;
  const detailLoading = S.detailLoading && S.detailNodeId === sel.id;
  const inLib = isLib(sel);
  const prev = ctl.traversalStack[ctl.traversalStack.length - 1];
  return (
    <div data-nx={sel.x} data-ny={sel.y} data-nz={sel.z} style={{ position: 'absolute', left: 0, top: 0, willChange: 'transform', opacity: 0, zIndex: expanded ? 10 : 1 }}>
      <div className="es-leader" style={{ position: 'absolute', left: '50%', top: '100%', height: 48, width: 0, borderLeft: '1px dotted rgba(255,255,255,0.32)', pointerEvents: 'none' }} />
      <div style={innerStyle}>
        <div style={expanded
          ? { borderRadius: 12, overflow: 'hidden', backdropFilter: 'blur(24px)', transition: 'all 0.3s', width: 320, background: 'rgba(0,0,0,0.9)', border: `1px solid ${accBorder}`, boxShadow: `0 20px 25px -5px ${accShadow}, 0 0 0 1px ${accRing}` }
          : { borderRadius: 12, overflow: 'hidden', backdropFilter: 'blur(24px)', transition: 'all 0.3s', width: 100, background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.03)', opacity: 0.15 }}>
          <div style={{ position: 'relative', width: '100%', background: 'rgba(0,0,0,0.4)', overflow: 'hidden', transition: 'all 0.3s', height: expanded ? 120 : 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ ...NO_IMAGE, fontSize: 12 }}>NO IMAGE</span>
            <EsImg id={sel.id} title={sel.title} coverUrl={sel.coverUrl} />
          </div>
          <div style={{ transition: 'all 0.3s', padding: expanded ? '12px 14px' : '4px 6px' }}>
            <div style={expanded
              ? { fontWeight: 600, lineHeight: 1.25, transition: 'all 0.3s', fontSize: 15, color: '#ffffff', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: '2.5em', fontFamily: 'Inter, system-ui, sans-serif' }
              : { fontWeight: 600, lineHeight: 1.25, transition: 'all 0.3s', fontSize: 7, color: 'rgba(255,255,255,0.2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sel.title}</div>
            {expanded && (
              <>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 4 }}>{sel.developer || ' '}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                  {sel.genres.slice(0, 4).map(g => (
                    <span key={g} style={{ fontSize: 8, padding: '1px 6px', borderRadius: 4, lineHeight: 1.25, background: path ? 'rgba(59,130,246,0.1)' : 'rgba(217,70,239,0.1)', color: path ? 'rgba(96,165,250,0.7)' : 'rgba(232,121,249,0.7)' }}>{g}</span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        {expanded && (
          <div style={{ width: 320, userSelect: 'none' }}>
            <div onClick={stop} onMouseMove={stop} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: 6, borderRadius: 8, background: 'rgba(6,6,14,0.7)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.06)', pointerEvents: 'auto', marginTop: 6 }}>
              {showCycleControls && (
                <>
                  <button onClick={() => ctl.handleCyclePrev()} title={cyclePathMode ? 'Previous game on path' : 'Previous neighbor'} className="es-hov-icon" style={ICON_BTN}><IcLeft /></button>
                  {showHomeBtn && (
                    <button onClick={() => ctl.handleCycleHome()} title="Refocus on selected" style={{ ...ICON_BTN, transition: 'color 0.15s, background 0.15s', ...(focused === -1 ? { color: accentText, background: accentBg } : null) }}><IcCrosshair /></button>
                  )}
                  <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.3)', fontVariantNumeric: 'tabular-nums', fontFamily: MONO, flex: 1, textAlign: 'center' }}>{cycleCounter}</span>
                  <button onClick={() => ctl.handleCycleNext()} title={cyclePathMode ? 'Next game on path' : 'Next neighbor'} className="es-hov-icon" style={ICON_BTN}><IcRight /></button>
                </>
              )}
              {S.traversalDepth > 0 && (
                <button onClick={() => ctl.traverseBack()} title={`Back to ${prev?.title ?? 'previous node'}`} className="es-hov-amber" style={{ ...ICON_BTN, color: 'rgba(251,191,36,0.6)' }}><IcUndo /></button>
              )}
              {S.pathActive && S.pathIdx >= 0 && !isLast && (
                <button onClick={() => ctl.togglePathNeighbors()} title={S.pathShowNbs ? 'Hide this game’s neighbours (back to the path hop)' : 'Show this game’s similarity neighbours'}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px', borderRadius: 4, cursor: 'pointer', transition: 'color 0.15s, background 0.15s', color: S.pathShowNbs ? 'rgba(103,232,249,0.95)' : 'rgba(255,255,255,0.5)', background: S.pathShowNbs ? 'rgba(6,182,212,0.14)' : 'transparent' }}>
                  <IcNbToggle />
                  <span style={{ fontSize: 9, letterSpacing: '0.08em' }}>NEIGHBORS</span>
                </button>
              )}
              <button onClick={() => void ctl.toggleDetail(sel.id)} title="View full details — store info, reviews, screenshots, and description."
                style={{ ...ICON_BTN, transition: 'color 0.15s, background 0.15s', ...(detailActive ? { color: accentText, background: accentBg } : null) }}>
                {detailLoading ? <IcSpin /> : <IcInfo />}
              </button>
              {!inLib ? (
                <button onClick={() => ctl.addNodeToLibrary(sel)} title="Add this game to your personal library to track it." className="es-hov-emerald" style={{ ...ICON_BTN, color: 'rgba(52,211,153,0.6)' }}><IcPlus /></button>
              ) : (
                <span title="This game is already in your library." style={{ padding: 4, color: 'rgba(52,211,153,0.4)', display: 'inline-flex' }}><IcCheck /></span>
              )}
            </div>
            {detailActive && <DetailPanel data={S.detailData} loading={S.detailLoading} nodeId={sel.id} />}
          </div>
        )}
      </div>
    </div>
  );
}

function NeighborsPanel({ ctl, S, sel, nbs }: CtlProps & { sel: GraphNode; nbs: ViewState['neighbors'] }) {
  const focusedId = nbs[S.focusedNbIdx]?.id;
  const q = S.nbSearch.toLowerCase();
  const rows = S.neighbors
    .filter(nb => nb.node && !nb.node.title.startsWith('Unknown Game') && (!q || nb.node.title.toLowerCase().includes(q)))
    .slice().sort((a, b) => a.distance - b.distance);
  const prev = ctl.traversalStack[ctl.traversalStack.length - 1];
  return (
    <div onClick={stop} onMouseMove={stop} style={{ ...GLASS_PANEL, position: 'absolute', top: 12, right: 12, bottom: 56, width: 288, animation: 'es-panel-in-right 0.28s cubic-bezier(0.23,1,0.32,1) both' }}>
      <div style={PANEL_HEAD}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <IcWeb size={14} stroke="rgba(34,211,238,0.7)" />
          <span style={{ fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.6)' }}>Neighbors</span>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)', fontVariantNumeric: 'tabular-nums' }}>{nbs.length}</span>
        </div>
        <button onClick={() => ctl.set({ showNeighbors: false, nbSearch: '' })} title="Collapse panel" className="es-hov-ghost" style={{ padding: 4, borderRadius: 6, color: 'rgba(255,255,255,0.25)', cursor: 'pointer' }}><IcRight size={14} /></button>
      </div>
      <SearchField value={S.nbSearch} placeholder="Filter neighbors…" focusClass="es-focus-cyan" onChange={v => ctl.set({ nbSearch: v })} />
      {S.neighborStatus && (
        // 3D-nearest stand-ins while the similarity index isn't available — say so plainly
        <div style={{ margin: '8px 12px 0', padding: '8px 10px', borderRadius: 8, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', fontSize: 10, lineHeight: 1.4, color: 'rgba(253,230,138,0.85)' }}>
          {S.neighborStatus === 'ann_rebuilding'
            ? 'Similarity index is still building — showing games that are merely nearby on the map for now.'
            : 'Couldn’t look up true neighbors — showing games that are merely nearby on the map.'}
        </div>
      )}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)', flexShrink: 0 }}>
        {S.traversalDepth > 0 && (
          <button onClick={() => ctl.traverseBack()} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9, color: 'rgba(251,191,36,0.6)', marginBottom: 6, cursor: 'pointer', transition: 'color 0.15s' }}>
            <IcUndo />
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>← {prev?.title ?? 'Back'}</span>
            <span style={{ color: 'rgba(251,191,36,0.3)', fontVariantNumeric: 'tabular-nums', fontFamily: MONO }}>D{S.traversalDepth}</span>
          </button>
        )}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <div style={{ position: 'relative', width: 64, height: 32, borderRadius: 4, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 7, color: 'rgba(255,255,255,0.2)', fontWeight: 700 }}>NO IMAGE</span>
            <EsImg id={sel.id} title={sel.title} coverUrl={sel.coverUrl} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.85)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.25 }}>{sel.title}</div>
            {sel.developer && <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>{sel.developer}</div>}
          </div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px', fontSize: 9, color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <span>Name</span><span>Distance</span>
        </div>
        {rows.map(nb => {
          const idx = nbs.findIndex(cn => cn.id === nb.id);
          const isFocusedNb = focusedId === nb.id;
          return (
            <button key={nb.id} onClick={() => { if (idx !== -1) ctl.setFocusedNb(idx, true); }} className="es-hov-row"
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 14px', textAlign: 'left', transition: 'background 0.15s, color 0.15s', cursor: 'pointer', ...(isFocusedNb ? { background: 'rgba(6,182,212,0.1)', color: 'rgba(255,255,255,0.9)' } : { color: 'rgba(255,255,255,0.6)' }) }}>
              <span style={{ fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: 1, textAlign: 'left' }}>
                {isLib(nb.node!) && <span style={{ color: 'rgba(52,211,153,0.6)', marginRight: 4 }}>★</span>}
                {nb.node!.title}
              </span>
              {isFocusedNb && (
                <span role="button" onClick={ev => { ev.stopPropagation(); ctl.traverseInto(nb.node!); }} title="Traverse into" className="es-hov-amber"
                  style={{ padding: 2, borderRadius: 4, color: 'rgba(251,191,36,0.6)', flexShrink: 0, cursor: 'pointer', display: 'inline-flex' }}><IcTraverse /></span>
              )}
              <span style={{ fontSize: 10, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', flexShrink: 0, color: isFocusedNb ? 'rgba(34,211,238,0.7)' : 'rgba(255,255,255,0.3)' }}>{nb.distance.toFixed(4)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GenrePanel({ ctl, S }: CtlProps) {
  const byCat = ctl.genresByCategory();
  const partial = S.activeGenres.size > 0 && S.activeGenres.size < S.allGenres.length;
  const segBtn = (active: boolean): CSSProperties => ({
    fontSize: 9, padding: '2px 8px', borderRadius: 4, border: '1px solid', transition: 'all 0.15s', cursor: 'pointer',
    ...(active ? { background: 'rgba(217,70,239,0.15)', borderColor: 'rgba(217,70,239,0.25)', color: 'rgba(232,121,249,0.8)' } : { background: 'transparent', borderColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.3)' }),
  });
  return (
    <div onClick={stop} onMouseMove={stop} style={{ ...GLASS_PANEL, position: 'absolute', top: 12, right: 12, bottom: 128, width: 224, animation: 'es-panel-in-right 0.28s cubic-bezier(0.23,1,0.32,1) both' }}>
      <div style={PANEL_HEAD}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Svg size={14} stroke="rgba(232,121,249,0.7)"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></Svg>
          <span style={{ fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.6)' }}>Genres</span>
          {partial && <span style={{ fontSize: 9, color: 'rgba(232,121,249,0.5)', fontVariantNumeric: 'tabular-nums' }}>{`${S.activeGenres.size}/${S.allGenres.length}`}</span>}
        </div>
        <button onClick={() => ctl.set({ showFilters: false })} title="Collapse panel" className="es-hov-ghost" style={{ padding: 4, borderRadius: 6, color: 'rgba(255,255,255,0.25)', cursor: 'pointer' }}><IcRight size={14} /></button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)', flexShrink: 0 }}>
        <button onClick={() => ctl.syncGenres(new Set(S.allGenres))} style={segBtn(S.activeGenres.size === S.allGenres.length && S.allGenres.length > 0)}>All</button>
        <button onClick={() => ctl.syncGenres(new Set())} style={segBtn(S.activeGenres.size === 0)}>None</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <span style={{ fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.25)', fontWeight: 600, marginBottom: 6, display: 'block' }}>Categories</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {CANONICAL_GENRE_LABELS.map((label, idx) => {
              const members = byCat.get(idx) ?? [];
              if (members.length === 0) return null;
              const allActive = members.every(g => S.activeGenres.has(g));
              const someActive = !allActive && members.some(g => S.activeGenres.has(g));
              const [cr, cg, cb] = GENRE_PALETTE[idx];
              const rgb = `${Math.round(cr * 255)}, ${Math.round(cg * 255)}, ${Math.round(cb * 255)}`;
              return (
                <button key={label} onClick={() => ctl.toggleCanonical(idx)} title={`${members.length} genre${members.length !== 1 ? 's' : ''}: ${members.join(', ')}`}
                  style={{ fontSize: 9, padding: '4px 8px', borderRadius: 6, border: '1px solid', transition: 'all 0.15s', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                    ...(allActive ? { borderColor: 'rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.07)' } : someActive ? { borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)' } : { background: 'transparent', borderColor: 'rgba(255,255,255,0.06)' }) }}>
                  <span style={{ width: 8, height: 8, borderRadius: 9999, flexShrink: 0, background: `radial-gradient(circle at 35% 35%, rgba(${rgb}, ${allActive ? 1 : someActive ? 0.7 : 0.4}) 0%, rgba(${rgb}, ${allActive ? 0.5 : someActive ? 0.3 : 0.12}) 100%)`, boxShadow: allActive ? `0 0 4px rgba(${rgb}, 0.4)` : undefined }} />
                  <span style={{ color: allActive ? `rgba(${rgb}, 0.9)` : someActive ? `rgba(${rgb}, 0.55)` : 'rgba(255,255,255,0.25)' }}>{label}</span>
                  <span style={{ fontSize: 7, fontVariantNumeric: 'tabular-nums', color: allActive ? `rgba(${rgb}, 0.5)` : 'rgba(255,255,255,0.15)' }}>{members.length}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <span style={{ fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.25)', fontWeight: 600, marginBottom: 6, display: 'block' }}>All Genres</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {S.allGenres.map(genre => (
              <button key={genre} onClick={() => ctl.toggleGenre(genre)}
                style={{ fontSize: 9, padding: '4px 8px', borderRadius: 6, border: '1px solid', transition: 'all 0.15s', cursor: 'pointer',
                  ...(S.activeGenres.has(genre) ? { background: 'rgba(217,70,239,0.1)', borderColor: 'rgba(217,70,239,0.2)', color: 'rgba(232,121,249,0.8)' } : { background: 'transparent', borderColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.2)' }) }}>
                {genre}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function BottomPick({ ctl, S }: CtlProps) {
  const seg = (active: boolean, on: CSSProperties): CSSProperties => ({
    fontSize: 8, letterSpacing: '0.16em', padding: '3px 7px', borderRadius: 4, cursor: 'pointer', transition: 'background 0.2s, color 0.2s', fontFamily: 'inherit',
    ...(active ? on : { background: 'transparent', color: 'rgba(255,255,255,0.4)' }),
  });
  return (
    <div style={{ flexShrink: 0, display: 'flex', gap: 2, padding: 2, borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.03)' }}>
      <button onClick={() => ctl.set({ pathBottom: 'path' })} title="Show The Path timeline" style={seg(S.pathBottom === 'path', { background: 'rgba(59,130,246,0.22)', color: '#dbeafe' })}>PATH</button>
      <button onClick={() => ctl.set({ pathBottom: 'nbs' })} title="Show this game's neighbours" style={seg(S.pathBottom === 'nbs', { background: 'rgba(6,182,212,0.2)', color: '#cffafe' })}>NEIGHBOURS</button>
    </div>
  );
}

const STEP_BTN: CSSProperties = { flexShrink: 0, width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, color: 'rgba(255,255,255,0.45)', cursor: 'pointer' };
const BOTTOM_SHELL: CSSProperties = {
  position: 'absolute', left: '50%', transform: 'translateX(-50%)', zIndex: 21, pointerEvents: 'auto', borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(4,4,12,0.55)', backdropFilter: 'blur(20px)', display: 'flex', flexDirection: 'column', gap: 8, animation: 'es-fade-in 0.4s ease both',
};

function NeighborDock({ ctl, S, nbs, canPickBottom, dockBaseRef, dockLineRef }: CtlProps & {
  nbs: ViewState['neighbors']; canPickBottom: boolean;
  dockBaseRef: React.RefObject<HTMLSpanElement>; dockLineRef: React.RefObject<HTMLSpanElement>;
}) {
  const focused = S.focusedNbIdx;
  const sel = S.selectedNode;
  const pn = ctl.pathStops;
  // Neighbours arrive in rerank order, not distance order — take the true range.
  let dMin = Infinity, dMax = -Infinity;
  for (const nb of nbs) { dMin = Math.min(dMin, nb.distance); dMax = Math.max(dMax, nb.distance); }
  if (!Number.isFinite(dMin)) { dMin = 0; dMax = 1; }
  const prev = ctl.traversalStack[ctl.traversalStack.length - 1];
  const line = focused >= 0 && nbs[focused]
    ? `${focused + 1}/${nbs.length}  ${nbs[focused].node!.title} · Δ ${nbs[focused].distance.toFixed(3)}`
    : (sel ? `${sel.title} · selected` : '');
  return (
    <div className="screenshot-exclude" data-avoid="1" onClick={stop} onMouseMove={stop}
      style={{ ...BOTTOM_SHELL, bottom: 58, width: 'min(820px, 70vw)', padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontFamily: MONO }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {S.traversalDepth > 0 && (
            <button onClick={() => ctl.traverseBack()} title={`Back to ${prev?.title ?? 'previous node'}`} className="es-hov-amber"
              style={{ flexShrink: 0, fontSize: 9, letterSpacing: '0.12em', color: 'rgba(251,191,36,0.7)', padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(251,191,36,0.25)', cursor: 'pointer' }}>↑ BACK</button>
          )}
          {canPickBottom && <BottomPick ctl={ctl} S={S} />}
          {S.pathActive && pn.length > 1 && S.pathIdx >= 0 && (
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2, padding: '1px 2px', borderRadius: 5, border: '1px solid rgba(147,197,253,0.25)', background: 'rgba(59,130,246,0.08)' }}>
              <button onClick={() => ctl.selectPathNode(Math.max(0, S.pathIdx - 1))} title="Previous game on The Path" className="es-hov-blue" style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, color: 'rgba(147,197,253,0.8)', cursor: 'pointer' }}><IcLeft size={10} strokeWidth={2.4} /></button>
              <span style={{ fontSize: 9, letterSpacing: '0.14em', color: 'rgba(147,197,253,0.85)', whiteSpace: 'nowrap', padding: '0 2px' }}>{`PATH ${S.pathIdx + 1}/${pn.length}`}</span>
              <button onClick={() => ctl.selectPathNode(Math.min(pn.length - 1, S.pathIdx + 1))} title="Next game on The Path" className="es-hov-blue" style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, color: 'rgba(147,197,253,0.8)', cursor: 'pointer' }}><IcRight size={10} strokeWidth={2.4} /></button>
            </div>
          )}
          <span style={{ fontSize: 9, letterSpacing: '0.2em', color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap' }}>// NEIGHBORS · {nbs.length}</span>
          {S.neighborStatus && (
            <span title={S.neighborStatus === 'ann_rebuilding' ? 'The similarity index is still building — showing the nearest stars in 3D instead' : 'No similarity neighbours resolved — showing the nearest stars in 3D instead'}
              style={{ fontSize: 9, letterSpacing: '0.2em', color: 'rgba(251,191,36,0.6)', whiteSpace: 'nowrap' }}>{S.neighborStatus === 'ann_rebuilding' ? '· ANN REBUILDING' : '· SPATIAL'}</span>
          )}
          {S.rerankHint && !S.neighborStatus && (
            <span title={S.rerankHint.title} data-testid="es-rerank-hint"
              style={{
                fontSize: 9, letterSpacing: '0.2em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
                color: S.rerankHint.tone === 'warn' ? 'rgba(251,191,36,0.6)' : S.rerankHint.tone === 'ok' ? 'rgba(110,231,183,0.6)' : 'rgba(255,255,255,0.35)',
              }}>{`· ${S.rerankHint.label.toUpperCase()}`}</span>
          )}
        </div>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.75)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, display: 'inline-grid' }}>
          <span ref={dockBaseRef} style={{ gridArea: '1 / 1', overflow: 'hidden', textOverflow: 'ellipsis' }}>{line}</span>
          <span ref={dockLineRef} style={{ gridArea: '1 / 1', overflow: 'hidden', textOverflow: 'ellipsis', visibility: 'hidden' }} />
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button onClick={() => ctl.handleCyclePrev()} title="Previous neighbor (←)" className="es-hov-step" style={STEP_BTN}><IcLeft /></button>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 4, justifyContent: 'center' }}>
          {nbs.map((nb, i) => {
            const active = i === focused;
            const sim = Math.max(0, Math.min(1, 1 - (nb.distance - dMin) / ((dMax - dMin) || 1)));
            const img = primaryImage(nb.node!.id, nb.node!.title, nb.node!.coverUrl);
            return (
              <button key={nb.id} className="es-dock-thumb" title={nb.node!.title}
                onClick={() => ctl.setFocusedNb(active ? -1 : i, true)} onDoubleClick={() => ctl.traverseInto(nb.node!)}
                onMouseEnter={() => ctl.dockHover(nb, i, nbs.length)} onMouseLeave={() => ctl.dockHover(null)}
                style={{
                  position: 'relative', flex: '0 1 60px', minWidth: 30, aspectRatio: '16 / 9', height: 'auto', borderRadius: 5, overflow: 'hidden', cursor: 'pointer', padding: 0,
                  background: 'linear-gradient(160deg, #173a46, #1d1438)', transition: 'transform 0.25s cubic-bezier(0.16,1,0.3,1), opacity 0.2s, box-shadow 0.2s, border-color 0.2s',
                  border: `1px solid ${active ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.08)'}`, opacity: active ? 1 : focused >= 0 ? 0.3 : 0.5,
                  transform: `translateY(${active ? -4 : 0}px)`, boxShadow: active ? '0 8px 20px -8px rgba(255,255,255,0.35)' : 'none',
                }}>
                <div style={{ position: 'absolute', inset: 0, backgroundSize: 'cover', backgroundPosition: 'center', backgroundImage: img ? `url("${img}")` : 'none' }} />
                <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, background: `rgba(103,232,249,${(0.25 + sim * 0.7).toFixed(2)})`, transformOrigin: 'left', transform: `scaleX(${(0.25 + sim * 0.75).toFixed(2)})` }} />
              </button>
            );
          })}
        </div>
        <button onClick={() => ctl.handleCycleNext()} title="Next neighbor (→)" className="es-hov-step" style={STEP_BTN}><IcRight /></button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 8, color: 'rgba(255,255,255,0.3)', padding: '0 28px' }}>
        <span>CLOSEST</span><span>← → cycle · ↓ traverse · ↑ back · double-click to dive</span><span>FARTHEST</span>
      </div>
    </div>
  );
}

function PathStrip({ ctl, S, canPickBottom }: CtlProps & { canPickBottom: boolean }) {
  const pn = ctl.pathStops;
  let maxH = 1, totalH = 0;
  for (const p of pn) { if (p.hoursPlayed > maxH) maxH = p.hoursPlayed; totalH += p.hoursPlayed; }
  const focusIdx = S.pathHover >= 0 ? S.pathHover : S.pathIdx;
  const setHover = (i: number) => { ctl.set({ pathHover: i }); ctl.engine?.setPathHighlight(i); };
  const step = (dir: -1 | 1) => {
    const n = pn.length; if (!n) return;
    const cur = S.pathIdx;
    ctl.set({ pathOverview: false });
    ctl.selectPathNode(dir < 0 ? (cur <= 0 ? 0 : cur - 1) : (cur < 0 ? 0 : Math.min(n - 1, cur + 1)));
  };
  return (
    <div className="screenshot-exclude" data-avoid="1" onClick={stop} onMouseMove={stop}
      style={{ ...BOTTOM_SHELL, bottom: 58, width: 'min(640px, 52vw)', padding: '10px 14px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, fontFamily: MONO }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {canPickBottom && <BottomPick ctl={ctl} S={S} />}
          <span style={{ fontSize: 9, letterSpacing: '0.2em', color: 'rgba(147,197,253,0.75)', whiteSpace: 'nowrap' }}>// THE PATH · {`${pn.length} GAMES · ${Math.round(totalH).toLocaleString()}H`}</span>
        </div>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
          {focusIdx >= 0 && pn[focusIdx] ? `${focusIdx + 1}/${pn.length}  ${pn[focusIdx].node.title} · ${pn[focusIdx].hoursPlayed.toFixed(0)}h` : 'Hover to preview'}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <button onClick={() => step(-1)} title="Previous game" className="es-hov-step" style={STEP_BTN}><IcLeft /></button>
        <div style={{ flex: 1, minWidth: 0, height: 40, display: 'flex', alignItems: 'flex-end', gap: 2 }}>
          {pn.map((p, i) => {
            const h = 12 + 88 * Math.sqrt(p.hoursPlayed / maxH);
            const t = pn.length > 1 ? i / (pn.length - 1) : 0;
            const c = `rgb(${Math.round(77 + t * 160)}, ${Math.round(133 - t * 5)}, ${Math.round(242 + t * 8)})`;
            const active = i === S.pathIdx, hov = i === S.pathHover;
            return (
              <div key={p.node.id} title={p.node.title} onClick={() => { ctl.set({ pathOverview: false }); ctl.selectPathNode(i); }} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(-1)}
                style={{ flex: '1 1 0', minWidth: 2, maxWidth: 18, height: '100%', display: 'flex', alignItems: 'flex-end', cursor: 'pointer' }}>
                <div style={{ width: '100%', height: `${h}%`, borderRadius: '2px 2px 0 0', transition: 'height 0.3s, opacity 0.2s, background 0.2s', background: active ? '#ffffff' : c, opacity: active || hov ? 1 : S.pathIdx >= 0 ? 0.35 : 0.6, boxShadow: active ? '0 0 10px rgba(255,255,255,0.5)' : 'none' }} />
              </div>
            );
          })}
        </div>
        <button onClick={() => step(1)} title="Next game" className="es-hov-step" style={STEP_BTN}><IcRight /></button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 8, color: 'rgba(255,255,255,0.3)', padding: '0 30px' }}>
        <span>{pn.length ? `${pn[0].playedYear || '—'} · FIRST` : ''}</span><span>{pn.length ? `LATEST · ${pn[pn.length - 1].playedYear || '—'}` : ''}</span>
      </div>
    </div>
  );
}

/** Path anchors: FIRST, LATEST, top-3 by hours (overview only) and the hovered stop. */
function PathAnchors({ ctl, S }: CtlProps) {
  const pn = ctl.pathStops;
  if (!S.pathActive || pn.length === 0) return null;
  const anchorSet = new Set<number>([0, pn.length - 1]);
  if (S.pathOverview) pn.map((p, i) => [p.hoursPlayed, i] as const).sort((a, b) => b[0] - a[0]).slice(0, 3).forEach(([, i]) => anchorSet.add(i));
  if (S.pathHover >= 0) anchorSet.add(S.pathHover);
  if (S.pathIdx >= 0) anchorSet.delete(S.pathIdx);
  if (S.pathGhost) anchorSet.delete(S.pathGhost.idx);
  return (
    <>
      {[...anchorSet].sort((a, b) => a - b).map(idx => {
        const p = pn[idx];
        if (!p) return null;
        const hovered = idx === S.pathHover;
        const isEnd = idx === pn.length - 1, isStart = idx === 0;
        const tag = isStart ? '▶ START' : isEnd ? '◉ END' : `#${idx + 1}`;
        return (
          <div key={p.node.id} data-nx={p.x} data-ny={p.y} data-nz={p.z} data-prio={isEnd ? 50 : isStart ? 40 : p.hoursPlayed / 1000}
            onClick={() => { ctl.set({ pathOverview: false }); ctl.selectPathNode(idx); }}
            onMouseEnter={() => ctl.engine?.setPathHighlight(idx)} onMouseLeave={() => ctl.engine?.setPathHighlight(-1)}
            style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'auto', cursor: 'pointer', willChange: 'transform, opacity', opacity: 0 }}>
            <div className="es-anchor" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px 5px 5px', borderRadius: 8, backdropFilter: 'blur(14px)', transition: 'background 0.2s, border-color 0.2s, transform 0.2s', border: `1px solid ${hovered ? 'rgba(147,197,253,0.45)' : 'rgba(255,255,255,0.08)'}`, background: hovered ? 'rgba(10,14,30,0.85)' : 'rgba(6,6,14,0.6)' }}>
              <div style={{ position: 'relative', width: 30, height: 30, borderRadius: 4, overflow: 'hidden', flexShrink: 0, background: 'linear-gradient(135deg, #1e2a4a, #2a1838)' }}>
                <EsImg id={p.node.id} title={p.node.title} coverUrl={p.node.coverUrl} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 10, fontWeight: 500, color: 'rgba(255,255,255,0.88)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 140, fontFamily: 'Inter, sans-serif' }}>{p.node.title}</span>
                <span style={{ fontSize: 8, letterSpacing: '0.08em', color: isEnd ? 'rgba(240,171,252,0.8)' : 'rgba(147,197,253,0.75)', fontFamily: MONO, whiteSpace: 'nowrap' }}>{`${tag} · ${p.hoursPlayed.toFixed(0)}h · ${p.playedYear || '—'}`}</span>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

export default EmbeddingSpaceView;
