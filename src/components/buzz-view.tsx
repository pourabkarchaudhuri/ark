/**
 * Transmissions View — Signal stream + Decode Bay
 *
 * UX: Stream uses FULL WIDTH when idle (no wasted space). When an article is
 * selected, the Decode Bay slides in from the right as an overlay with a
 * resizable split. Focus mode expands the reader to full screen.
 *
 * Scheduled broadcasts live in a collapsible horizontal strip above the
 * stream. Events show live countdown badges, LIVE indicators, and
 * YouTube/Twitch links scraped from event websites.
 */
import { useEffect, useState, useCallback, useRef, useMemo, memo } from 'react';
import {
  Newspaper, RefreshCw, ExternalLink, Clock, X, Loader2, Globe,
  ArrowLeft, ArrowRight, RotateCw,
  Check, Maximize2, Minimize2, ChevronDown, ChevronUp, GripVertical,
  Radio,
} from 'lucide-react';
import { SiYoutube, SiTwitch } from 'react-icons/si';
import { Button } from '@/components/ui/button';
import { fetchAllNews, clearNewsCache, NewsItem } from '@/services/news-service';
import { cn } from '@/lib/utils';
import { AnimateIcon } from '@/components/ui/animate-icon';
import { EncryptedText } from '@/components/ui/encrypted-text';
import type { ResolvedEvent } from '@/data/gaming-events';
import { resolveEvents, refreshStatuses, clearResolvedCache } from '@/services/event-resolver-service';
import { transmissionsHistoryStore } from '@/services/transmissions-history-store';
import { TooltipCard } from '@/components/ui/tooltip-card';
import { MovingBorderButton } from '@/components/ui/moving-border';

// ─── Config ─────────────────────────────────────────────────────────────────

const AUTO_REFRESH_INTERVAL = 5 * 60 * 1000;
const COUNTDOWN_TICK_INTERVAL = 1_000;
const FALLBACK_IMAGE = 'https://cdn.akamai.steamstatic.com/steam/apps/730/header.jpg';
const MIN_STREAM_W = 280;
const MIN_DECODE_W = 360;
const DEFAULT_SPLIT_RATIO = 0.38;

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatRelativeDate(unixSeconds: number): string {
  const now = Date.now() / 1000;
  const diff = now - unixSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatCountdown(unixSeconds: number): string {
  const diff = unixSeconds - Date.now() / 1000;
  if (diff <= 0) return 'Now';
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  const secs = Math.floor(diff % 60);
  const p = (n: number) => String(n).padStart(2, '0');
  if (days > 0) return `${days}D ${p(hours)}H ${p(mins)}M ${p(secs)}S`;
  if (hours > 0) return `${p(hours)}H ${p(mins)}M ${p(secs)}S`;
  return `${p(mins)}M ${p(secs)}S`;
}

function formatEventDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getSourceColor(source: string): string {
  if (source.startsWith('Steam')) return 'bg-blue-500/90 text-white';
  if (source.includes('r/gaming')) return 'bg-orange-500/90 text-white';
  if (source.includes('r/pcgaming')) return 'bg-red-500/90 text-white';
  return 'bg-fuchsia-500/90 text-white';
}

function getSteamFallbackFromId(itemId: string, imageUrl?: string): string | undefined {
  const appIdFromUrl = imageUrl?.match(/\/apps\/(\d+)\//);
  if (appIdFromUrl) {
    const fallback = `https://cdn.akamai.steamstatic.com/steam/apps/${appIdFromUrl[1]}/header.jpg`;
    if (imageUrl !== fallback) return fallback;
    return undefined;
  }
  const appIdFromId = itemId.match(/^steam-(\d+)-/);
  if (appIdFromId) return `https://cdn.akamai.steamstatic.com/steam/apps/${appIdFromId[1]}/header.jpg`;
  return undefined;
}

/** Sort events: live first, then upcoming (soonest first), then unknown, then past */
function sortEvents(events: ResolvedEvent[]): ResolvedEvent[] {
  const order: Record<string, number> = { live: 0, upcoming: 1, unknown: 2, past: 3 };
  return [...events].sort((a, b) => {
    const oa = order[a.status] ?? 2;
    const ob = order[b.status] ?? 2;
    if (oa !== ob) return oa - ob;
    if (a.startDate && b.startDate) return a.startDate - b.startDate;
    if (a.startDate) return -1;
    if (b.startDate) return 1;
    return 0;
  });
}

// ─── useResolvedEvents hook ─────────────────────────────────────────────────

function useResolvedEvents() {
  const [events, setEvents] = useState<ResolvedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    resolveEvents().then((evts) => {
      if (!cancelled) { setEvents(evts); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [refreshKey]);

  // Tick every 60s to keep countdown text + status fresh.
  // Increments `tick` so downstream memo'd components re-render
  // even when no status transition occurs (countdown text changes).
  useEffect(() => {
    if (events.length === 0) return;
    const id = setInterval(() => {
      setEvents((prev) => refreshStatuses(prev));
      setTick((t) => t + 1);
    }, COUNTDOWN_TICK_INTERVAL);
    return () => clearInterval(id);
  }, [events.length]);

  const forceRefresh = useCallback(() => {
    clearResolvedCache();
    window.eventScraper?.clearCache();
    setRefreshKey((k) => k + 1);
  }, []);

  return { events, loading, tick, forceRefresh };
}

// ─── Resizable split hook ───────────────────────────────────────────────────

function useResizableSplit(containerRef: React.RefObject<HTMLDivElement | null>, defaultRatio: number) {
  const [ratio, setRatio] = useState(defaultRatio);
  const [isDragging, setIsDragging] = useState(false);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    setIsDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const total = rect.width;
    const clamped = Math.max(MIN_STREAM_W / total, Math.min(1 - MIN_DECODE_W / total, x / total));
    setRatio(clamped);
  }, [containerRef]);

  const onPointerUp = useCallback(() => { dragging.current = false; setIsDragging(false); }, []);

  return { ratio, isDragging, onPointerDown, onPointerMove, onPointerUp };
}

// ─── Webview Panel (Decode Bay) ─────────────────────────────────────────────

const WebviewPanel = memo(function WebviewPanel({
  url, onClose, relaySources, onSelectRelay, focusMode, onToggleFocus,
}: {
  url: string;
  onClose: () => void;
  relaySources?: { source: string; url: string }[];
  onSelectRelay?: (url: string) => void;
  focusMode?: boolean;
  onToggleFocus?: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const hasNativeWebview = !!window.webviewApi;
  const [isLoading, setIsLoading] = useState(true);
  const [pageTitle, setPageTitle] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!hasNativeWebview) {
      setIsLoading(true);
      setLoadError(null);
      setPageTitle('');
      return;
    }

    const api = window.webviewApi!;
    const el = contentRef.current;
    if (!el) return;

    setLoadError(null);
    setIsLoading(true);
    let cancelled = false;

    const getBounds = () => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    };

    const unsubs = [
      api.onLoading((loading) => { setIsLoading(loading); if (loading) setLoadError(null); }),
      api.onTitle((title) => setPageTitle(title)),
      api.onError((error) => { setIsLoading(false); setLoadError(error); }),
      api.onNavState((state) => { setCanGoBack(state.canGoBack); setCanGoForward(state.canGoForward); }),
    ];

    // Wait for the element to have non-zero dimensions before opening.
    // The parent container may still be mid-transition (flex 0→1) when
    // this effect first fires, yielding zero-sized bounds that the main
    // process rejects silently.
    let openTimer: ReturnType<typeof setTimeout> | null = null;
    let openObserver: ResizeObserver | null = null;

    const tryOpen = async () => {
      if (cancelled) return;
      const b = getBounds();
      if (b.width <= 0 || b.height <= 0) return false;
      const result = await api.open(url, b);
      if (!result?.success && !cancelled) {
        setIsLoading(false);
        setLoadError('Failed to open page viewer');
      }
      return result?.success ?? false;
    };

    const scheduleOpen = () => {
      openObserver = new ResizeObserver(() => {
        const b = getBounds();
        if (b.width > 0 && b.height > 0) {
          openObserver?.disconnect();
          openObserver = null;
          tryOpen();
        }
      });
      openObserver.observe(el);
      // Fallback: if the observer never fires with valid bounds, try after transition
      openTimer = setTimeout(() => { openObserver?.disconnect(); openObserver = null; tryOpen(); }, 400);
    };

    const b = getBounds();
    if (b.width > 0 && b.height > 0) {
      tryOpen();
    } else {
      scheduleOpen();
    }

    let rafId = 0;
    const updateBounds = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        api.resize(getBounds());
      });
    };
    const observer = new ResizeObserver(updateBounds);
    observer.observe(el);
    window.addEventListener('resize', updateBounds);

    const safetyTimer = setTimeout(() => setIsLoading(false), 20000);

    return () => {
      cancelled = true;
      if (openTimer) clearTimeout(openTimer);
      openObserver?.disconnect();
      clearTimeout(safetyTimer);
      cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('resize', updateBounds);
      unsubs.forEach((u) => u());
      api.close();
    };
  }, [url, hasNativeWebview]);

  const handleBack = useCallback(() => {
    if (hasNativeWebview) window.webviewApi?.goBack();
    else iframeRef.current?.contentWindow?.history.back();
  }, [hasNativeWebview]);

  const handleForward = useCallback(() => {
    if (hasNativeWebview) window.webviewApi?.goForward();
    else iframeRef.current?.contentWindow?.history.forward();
  }, [hasNativeWebview]);

  const handleReload = useCallback(() => {
    setLoadError(null);
    setIsLoading(true);
    if (hasNativeWebview) window.webviewApi?.reload();
    else if (iframeRef.current) iframeRef.current.src = url;
  }, [hasNativeWebview, url]);

  const handleOpenExternal = useCallback(() => {
    if (hasNativeWebview) window.webviewApi?.openExternal(url);
    else window.open(url, '_blank');
  }, [hasNativeWebview, url]);

  const handleIframeLoad = useCallback(() => { setIsLoading(false); }, []);
  const handleIframeError = useCallback(() => { setIsLoading(false); setLoadError('Failed to load page — some sites block iframe embedding.'); }, []);

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 rounded-2xl overflow-hidden border border-white/10 bg-black/60 backdrop-blur-sm shadow-2xl shadow-black/40">
      <div className="flex items-center gap-2 px-3 py-2 bg-black/80 border-b border-white/[0.06] flex-shrink-0">
        <div className="flex items-center gap-0.5">
          <button onClick={handleBack} disabled={hasNativeWebview && !canGoBack} className={cn('w-7 h-7 rounded-lg flex items-center justify-center transition-colors', (!hasNativeWebview || canGoBack) ? 'text-white/50 hover:text-white hover:bg-white/10' : 'text-white/15 cursor-not-allowed')} title="Go back">
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
          <button onClick={handleForward} disabled={hasNativeWebview && !canGoForward} className={cn('w-7 h-7 rounded-lg flex items-center justify-center transition-colors', (!hasNativeWebview || canGoForward) ? 'text-white/50 hover:text-white hover:bg-white/10' : 'text-white/15 cursor-not-allowed')} title="Go forward">
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
          <button onClick={handleReload} className="w-7 h-7 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors" title="Reload">
            <AnimateIcon hover="spin"><RotateCw className={cn('w-3.5 h-3.5', isLoading && 'animate-spin')} /></AnimateIcon>
          </button>
        </div>

        <div className="flex-1 min-w-0 flex items-center gap-2 px-3 py-1 rounded-lg bg-white/5 border border-white/[0.06]">
          <Globe className="w-3 h-3 text-white/30 flex-shrink-0" />
          <span className="text-[11px] text-white/50 truncate">{pageTitle || url}</span>
          {isLoading && <Loader2 className="w-3 h-3 text-fuchsia-400 animate-spin flex-shrink-0" />}
        </div>

        <button onClick={handleOpenExternal} className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors" title="Open in browser">
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
        {onToggleFocus && (
          <button onClick={onToggleFocus} className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors" title={focusMode ? 'Exit focus' : 'Focus decode'}>
            {focusMode ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        )}
        <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-red-500/20 transition-colors" title="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      {relaySources && relaySources.length > 1 && onSelectRelay && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 bg-black/60 border-b border-white/[0.06] flex-shrink-0">
          <span className="text-[10px] text-white/40 mr-1">Also carried by:</span>
          {relaySources.map((r) => (
            <button key={r.url} onClick={() => onSelectRelay(r.url)} className="text-[10px] px-2 py-0.5 rounded bg-white/10 text-white/60 hover:text-white hover:bg-white/15 transition-colors">
              {r.source}
            </button>
          ))}
        </div>
      )}

      <div ref={contentRef} className="flex-1 relative" style={{ minHeight: 0 }}>
        {!hasNativeWebview && (
          <iframe
            ref={iframeRef}
            src={url}
            className="absolute inset-0 w-full h-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
            onLoad={handleIframeLoad}
            onError={handleIframeError}
          />
        )}
        {isLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 pointer-events-none">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="w-8 h-8 text-fuchsia-500 animate-spin" />
              <span className="text-xs text-white/40">Decoding transmission...</span>
            </div>
          </div>
        )}
        {loadError && !isLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60">
            <div className="flex flex-col items-center gap-3 text-center px-4">
              <span className="text-sm text-white/50">{loadError}</span>
              <div className="flex gap-2">
                <button onClick={handleReload} className="text-xs text-fuchsia-400 hover:text-fuchsia-300">Try again</button>
                <button onClick={handleOpenExternal} className="text-xs text-white/40 hover:text-white/70">Open in browser</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

// ─── Transmission card ──────────────────────────────────────────────────────

function shortUuid(id: string): string {
  let h = 0x9e3779b9;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) >>> 0;
  return h.toString(16).toUpperCase().padStart(8, '0').slice(0, 8);
}

const TransmissionCard = memo(function TransmissionCard({
  item, isDecoded, isActive, onSelect,
}: {
  item: NewsItem;
  isDecoded: boolean;
  isActive: boolean;
  onSelect: (item: NewsItem) => void;
}) {
  const [imgSrc, setImgSrc] = useState(item.imageUrl || FALLBACK_IMAGE);
  const [imgState, setImgState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const steamFallback = getSteamFallbackFromId(item.id, item.imageUrl);
  const txId = useMemo(() => shortUuid(item.id), [item.id]);
  const srcRef = useRef(item.imageUrl || FALLBACK_IMAGE);

  useEffect(() => {
    const next = item.imageUrl || FALLBACK_IMAGE;
    srcRef.current = next;
    setImgSrc(next);
    setImgState('loading');
  }, [item.id, item.imageUrl]);

  const handleImgError = useCallback(() => {
    const cur = srcRef.current;
    if (steamFallback && cur !== steamFallback && cur !== FALLBACK_IMAGE) {
      srcRef.current = steamFallback;
      setImgSrc(steamFallback);
    } else if (cur !== FALLBACK_IMAGE) {
      srcRef.current = FALLBACK_IMAGE;
      setImgSrc(FALLBACK_IMAGE);
    } else {
      setImgState('failed');
    }
  }, [steamFallback]);

  const handleImgLoad = useCallback(() => setImgState('loaded'), []);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(item)}
      onKeyDown={(e) => e.key === 'Enter' && onSelect(item)}
      className={cn(
        'group flex flex-col rounded-xl border cursor-pointer transition-all text-left overflow-hidden',
        isActive
          ? 'bg-fuchsia-500/10 border-fuchsia-500/30 shadow-lg shadow-fuchsia-500/5 ring-1 ring-fuchsia-500/20'
          : 'bg-black/40 border-white/[0.08] hover:border-white/20 hover:bg-black/60 hover:shadow-lg hover:shadow-black/20',
        isDecoded && !isActive && 'opacity-70',
      )}
    >
      <div className="relative w-full aspect-[16/9] overflow-hidden bg-white/5">
        {imgState === 'failed' && (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-white/[0.04] to-white/[0.01]">
            <Newspaper className="w-8 h-8 text-white/10" />
          </div>
        )}
        <img
          src={imgSrc}
          alt=""
          className={cn(
            'w-full h-full object-cover transition-[transform,opacity] duration-500 group-hover:scale-105',
            imgState === 'loaded' ? 'opacity-100' : 'opacity-0',
          )}
          decoding="async"
          onLoad={handleImgLoad}
          onError={handleImgError}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
        {item.relayCount && item.relayCount > 1 && (
          <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded text-[8px] font-medium bg-black/70 text-white/80 backdrop-blur-sm">{item.relayCount} sources</span>
        )}
        {isDecoded && (
          <div className="absolute top-2 right-2">
            <span className="w-5 h-5 rounded-full bg-black/60 backdrop-blur-sm flex items-center justify-center"><Check className="w-3 h-3 text-white/50" /></span>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2 p-3.5 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium border border-white/20 text-white/70 bg-white/[0.04]">{item.source}</span>
          {item.isFromYourFleet && <span className="px-2 py-0.5 rounded-full text-[10px] font-medium border border-cyan-500/30 text-cyan-300 bg-cyan-500/10">From your fleet</span>}
        </div>
        <h3 className={cn('text-sm font-semibold leading-snug', item.summary ? 'line-clamp-2' : 'line-clamp-[7]')}>
          <EncryptedText
            text={item.title}
            revealDelayMs={15}
            flipDelayMs={20}
            encryptedClassName="text-white/30"
            revealedClassName="text-white"
          />
        </h3>
        {item.summary && (
          <p className="text-xs leading-relaxed line-clamp-5">
            <EncryptedText
              text={item.summary}
              revealDelayMs={9}
              flipDelayMs={18}
              encryptedClassName="text-white/20"
              revealedClassName="text-white/50"
            />
          </p>
        )}
        <div className="flex items-center justify-between text-[10px] text-white/40 mt-auto pt-1">
          <div className="flex items-center gap-1.5">
            <Clock className="w-3 h-3" />
            {formatRelativeDate(item.publishedAt)}
          </div>
          <span className="font-mono text-[9px] tracking-wider select-none">
            <EncryptedText
              text={`// TX::${txId}`}
              revealDelayMs={20}
              flipDelayMs={15}
              encryptedClassName="text-fuchsia-500/20"
              revealedClassName="text-fuchsia-500/50"
            />
          </span>
        </div>
      </div>
    </div>
  );
});

// ─── Event card ─────────────────────────────────────────────────────────────
// Translucent glass cards with celestial body background etchings.
// NASA/public-domain planet & nebula images, overflowing and dimmed.

const CELESTIAL_IMAGES = [
  'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cb/The_Blue_Marble_%28remastered%29.jpg/600px-The_Blue_Marble_%28remastered%29.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/FullMoon2010.jpg/600px-FullMoon2010.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/thumb/0/02/OSIRIS_Mars_true_color.jpg/600px-OSIRIS_Mars_true_color.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Jupiter_New_Horizons.jpg/600px-Jupiter_New_Horizons.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c7/Saturn_during_Equinox.jpg/600px-Saturn_during_Equinox.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/thumb/6/63/Neptune_-_Voyager_2_%2829347980845%29_flatten_crop.jpg/600px-Neptune_-_Voyager_2_%2829347980845%29_flatten_crop.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/Mercury_in_true_color.jpg/600px-Mercury_in_true_color.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e5/Venus-real_color.jpg/600px-Venus-real_color.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Heic0910t.jpg/600px-Heic0910t.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4e/Pleiades_large.jpg/600px-Pleiades_large.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/thumb/0/00/Crab_Nebula.jpg/600px-Crab_Nebula.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b4/The_Sun_by_the_Atmospheric_Imaging_Assembly_of_NASA%27s_Solar_Dynamics_Observatory_-_20100819.jpg/600px-The_Sun_by_the_Atmospheric_Imaging_Assembly_of_NASA%27s_Solar_Dynamics_Observatory_-_20100819.jpg',
];

function seedFromName(name: string): number {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
  return h;
}

function pickCelestial(name: string) {
  const seed = seedFromName(name);
  return {
    src: CELESTIAL_IMAGES[seed % CELESTIAL_IMAGES.length],
    x: (seed % 100) - 50,
    y: ((seed >> 6) % 80) - 40,
    rotate: 0,
    scale: 1.6 + ((seed >> 4) % 5) * 0.2,
  };
}

const EVENT_PALETTE = {
  live:     { text: 'text-white',    sub: 'text-red-200/70',   accent: 'text-red-400',   dot: 'bg-red-400'   },
  upcoming: { text: 'text-white',    sub: 'text-cyan-200/60',  accent: 'text-cyan-400',  dot: 'bg-cyan-400'  },
  past:     { text: 'text-white/50', sub: 'text-white/20',     accent: 'text-white/25',  dot: 'bg-white/20'  },
  unknown:  { text: 'text-white/70', sub: 'text-white/30',     accent: 'text-white/30',  dot: 'bg-white/25'  },
} as const;

const EventCard = memo(function EventCard({
  event, tick: _tick, onLatest, onOpenUrl,
}: {
  event: ResolvedEvent;
  tick: number;
  onLatest: (n: string) => void;
  onOpenUrl: (url: string) => void;
}) {
  const hasYt = event.youtubeUrls.length > 0;
  const hasTwitch = event.twitchUrls.length > 0;
  const isLive = event.status === 'live';
  const isUpcoming = event.status === 'upcoming';
  const isPast = event.status === 'past';
  const palette = EVENT_PALETTE[event.status] ?? EVENT_PALETTE.unknown;

  const nowSec = Date.now() / 1000;
  const isImminent = (isLive) ||
    (isUpcoming && event.startDate != null && (event.startDate - nowSec) <= 86400);

  const handleCardClick = useCallback(() => {
    if (event.url) onOpenUrl(event.url);
  }, [event.url, onOpenUrl]);

  const celestial = useMemo(() => pickCelestial(event.name), [event.name]);

  const card = (
    <div
      role={event.url ? 'button' : undefined}
      tabIndex={event.url ? 0 : undefined}
      onClick={handleCardClick}
      onKeyDown={(e) => e.key === 'Enter' && handleCardClick()}
      className={cn(
        'group relative flex flex-col w-full h-full rounded-[20px] overflow-hidden',
        'transition-transform duration-300',
        !isImminent && 'border border-white/[0.07] hover:border-white/[0.14]',
        'bg-black/15 backdrop-blur-md',
        event.url && 'cursor-pointer',
        !isImminent && event.url && 'hover:scale-[1.02]',
        isPast && 'opacity-50',
      )}
    >
      {/* ── Celestial body etching ── */}
      <img
        src={celestial.src}
        alt=""
        aria-hidden
        className="pointer-events-none absolute inset-0 w-full h-full object-cover"
        style={{
          opacity: 0.08,
          transform: `translate(${celestial.x}px, ${celestial.y}px) rotate(${celestial.rotate}deg) scale(${celestial.scale})`,
          filter: 'brightness(0.7) contrast(1.3)',
          mixBlendMode: 'lighten',
        }}
      />

      {/* ── Content ── */}
      <div className="relative flex flex-col flex-1 px-5 py-5 gap-4">
        {/* Title */}
        <h3 className={cn(
          'text-[15px] font-semibold leading-[1.35] line-clamp-2 min-h-[41px]',
          palette.text,
        )}>
          {event.name}
        </h3>

        {/* Date */}
        {event.startDate ? (
          <span className="text-[20px] font-mono font-bold text-white leading-none">
            {formatEventDate(event.startDate)}
            {event.endDate && ` — ${formatEventDate(event.endDate)}`}
          </span>
        ) : (
          <span className="text-[20px] font-mono font-bold text-white/20 italic leading-none">
            Date TBA
          </span>
        )}

        {/* Countdown ticker — the centrepiece */}
        {isUpcoming && event.startDate && (
          <div className="flex items-baseline gap-2.5">
            <span className={cn('text-[11px] font-mono font-bold select-none', palette.sub)}>
              //
            </span>
            <span className={cn(
              'text-[17px] font-mono font-bold tracking-[0.12em] tabular-nums',
              palette.accent,
            )}>
              {formatCountdown(event.startDate)}
            </span>
          </div>
        )}
        {isLive && (
          <div className="flex items-baseline gap-2.5">
            <span className="text-[11px] font-mono font-bold text-red-500/50 select-none">
              //
            </span>
            <span className="text-[14px] font-mono font-bold tracking-[0.2em] text-red-400 uppercase animate-pulse">
              Broadcasting
            </span>
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />
      </div>

      {/* Edge-to-edge separator + footer */}
      <div className="border-t border-white/[0.06]" />
      <div className="relative flex items-center gap-2 px-5 pb-4 pt-3">
          {hasYt && (
            <TooltipCard content="Watch on YouTube">
              <button
                onClick={(e) => { e.stopPropagation(); onOpenUrl(event.youtubeUrls[0]); }}
                className="w-8 h-8 rounded-full flex items-center justify-center bg-white/[0.04] hover:bg-red-500/20 text-white/30 hover:text-red-400 transition-all duration-200"
              >
                <SiYoutube className="w-4 h-4" />
              </button>
            </TooltipCard>
          )}
          {hasTwitch && (
            <TooltipCard content="Watch on Twitch">
              <button
                onClick={(e) => { e.stopPropagation(); onOpenUrl(event.twitchUrls[0]); }}
                className="w-8 h-8 rounded-full flex items-center justify-center bg-white/[0.04] hover:bg-purple-500/20 text-white/30 hover:text-purple-400 transition-all duration-200"
              >
                <SiTwitch className="w-4 h-4" />
              </button>
            </TooltipCard>
          )}
          <div className="flex-1" />
          <TooltipCard content={`Filter transmissions to "${event.name}" news.`}>
            <button
              onClick={(e) => { e.stopPropagation(); onLatest(event.name); }}
              className="text-[10px] font-medium text-white/25 hover:text-white/50 transition-colors uppercase tracking-widest"
            >
              Latest →
            </button>
          </TooltipCard>
      </div>
    </div>
  );

  if (!isImminent) return <div className="w-[280px] shrink-0">{card}</div>;

  return (
    <MovingBorderButton
      as="div"
      borderRadius="20px"
      duration={4000}
      containerClassName="w-[280px] shrink-0 shadow-[0_0_35px_-8px_rgba(168,85,247,0.3)]"
      borderClassName="from-purple-500 via-fuchsia-500/40 to-transparent"
      className="p-0 !bg-transparent"
    >
      {card}
    </MovingBorderButton>
  );
});

// ─── Scheduled broadcasts strip (collapsible, sorted, with live data) ───────

const BroadcastsStrip = memo(function BroadcastsStrip({
  events, eventsLoading, tick, eventFilter, onEventLatest, onClearFilter, onOpenUrl,
}: {
  events: ResolvedEvent[];
  eventsLoading: boolean;
  tick: number;
  eventFilter: string | null;
  onEventLatest: (name: string) => void;
  onClearFilter: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const { sorted, liveCount, upcomingCount, todayCount } = useMemo(() => {
    let live = 0;
    let upcoming = 0;
    let today = 0;
    const nowSec = Date.now() / 1000;
    const dayStart = Math.floor(nowSec / 86400) * 86400;
    const dayEnd = dayStart + 86400;
    for (const e of events) {
      if (e.status === 'live') { live++; today++; }
      else if (e.status === 'upcoming') upcoming++;
      if (e.startDate && e.startDate < dayEnd && (e.endDate ? e.endDate >= dayStart : e.startDate >= dayStart)) {
        if (e.status !== 'live') today++;
      }
    }
    return { sorted: sortEvents(events), liveCount: live, upcomingCount: upcoming, todayCount: today };
  }, [events]);
  const hasActivity = liveCount > 0 || upcomingCount > 0;
  const [expanded, setExpanded] = useState(hasActivity);

  useEffect(() => {
    if (hasActivity) setExpanded(true);
  }, [hasActivity]);

  return (
    <div className={cn(
      'border-b flex-shrink-0 transition-colors',
      hasActivity ? 'border-white/10 bg-white/[0.02]' : 'border-white/[0.06]',
    )}>
      <button
        onClick={() => setExpanded((e) => !e)}
        className={cn(
          'flex items-center gap-2 w-full px-3 text-left transition-colors',
          hasActivity ? 'py-2.5 hover:bg-white/[0.04]' : 'py-2 hover:bg-white/[0.02]',
        )}
      >
        <Radio className="w-3 h-3 flex-shrink-0 text-white/15" />
        <span className="text-[12px] font-mono font-medium text-white/30 uppercase tracking-[0.2em]">Scheduled Broadcasts</span>
        {liveCount > 0 && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[8px] font-bold bg-red-500 text-white animate-pulse">
            <Radio className="w-2 h-2" />
            {liveCount} LIVE
          </span>
        )}
        {events.length > 0 && (
          <span className="text-[11px] font-mono font-bold text-white/15 tabular-nums">{events.length}</span>
        )}
        {todayCount > 0 && !liveCount && (
          <span className="px-2 py-0.5 rounded-full text-[9px] font-semibold bg-cyan-500/15 text-cyan-400 border border-cyan-500/20">
            Events Today
          </span>
        )}
        {eventFilter && (
          <span className="px-1.5 py-0.5 rounded text-[9px] bg-fuchsia-500/20 text-fuchsia-300 truncate max-w-[120px]">{eventFilter}</span>
        )}
        {eventsLoading && <Loader2 className="w-3 h-3 text-fuchsia-400/50 animate-spin" />}
        <span className="ml-auto text-white/30">{expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3">
          <div className="flex gap-4 overflow-x-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10 pb-2 pt-1">
            {sorted.map((ev) => (
              <EventCard key={ev.id} event={ev} tick={tick} onLatest={onEventLatest} onOpenUrl={onOpenUrl} />
            ))}
          </div>
          {eventFilter && (
            <button onClick={onClearFilter} className="mt-2 text-[10px] text-fuchsia-400 hover:text-fuchsia-300">
              Clear filter: &ldquo;{eventFilter}&rdquo;
            </button>
          )}
        </div>
      )}
    </div>
  );
});

// ─── Stream column ──────────────────────────────────────────────────────────

const StreamColumn = memo(function StreamColumn({
  resolvedEvents, eventsLoading, eventsTick, eventFilter, onEventLatest, onClearFilter, onOpenUrl,
  filteredNews, decodedIds, selectedItemId,
  onSelectItem, onRefresh,
}: {
  resolvedEvents: ResolvedEvent[];
  eventsLoading: boolean;
  eventsTick: number;
  eventFilter: string | null;
  onEventLatest: (name: string) => void;
  onClearFilter: () => void;
  onOpenUrl: (url: string) => void;
  filteredNews: NewsItem[];
  decodedIds: Set<string>;
  selectedItemId: string | null;
  onSelectItem: (item: NewsItem) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 p-2.5 border-b border-white/[0.06] flex-shrink-0">
        <div className="flex-1" />
        <TooltipCard content="Refresh all news feeds and re-scrape event schedules. Clears the cache and fetches the latest transmissions.">
          <button onClick={onRefresh} className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0">
            <AnimateIcon hover="spin"><RefreshCw className="w-3.5 h-3.5" /></AnimateIcon>
          </button>
        </TooltipCard>
      </div>

      {/* Broadcasts */}
      <BroadcastsStrip
        events={resolvedEvents}
        eventsLoading={eventsLoading}
        tick={eventsTick}
        eventFilter={eventFilter}
        onEventLatest={onEventLatest}
        onClearFilter={onClearFilter}
        onOpenUrl={onOpenUrl}
      />

      {/* Section label */}
      <div className="flex items-center gap-2.5 px-4 h-[50px] shrink-0">
        <span className="text-[11px] font-mono font-bold text-white/15 select-none">//</span>
        <span className="text-[12px] font-mono font-medium text-white/30 uppercase tracking-[0.2em]">Transmissions Received</span>
      </div>

      {/* Stream */}
      <div className="flex-1 overflow-y-auto p-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10">
        {filteredNews.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
            <p className="text-xs text-white/40">No transmissions match.</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {filteredNews.map((item) => (
            <TransmissionCard
              key={item.id}
              item={item}
              isDecoded={decodedIds.has(item.id)}
              isActive={item.id === selectedItemId}
              onSelect={onSelectItem}
            />
          ))}
          </div>
        )}
      </div>
    </div>
  );
});

// ─── Main Component ─────────────────────────────────────────────────────────

export const BuzzView = memo(function BuzzView() {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<NewsItem | null>(null);
  const [eventFilter, setEventFilter] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [decodedIds, setDecodedIds] = useState<Set<string>>(() => transmissionsHistoryStore.getDecodedIds());
  const abortedRef = useRef(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const { ratio: splitRatio, isDragging, onPointerDown, onPointerMove, onPointerUp } = useResizableSplit(splitContainerRef, DEFAULT_SPLIT_RATIO);

  const { events: resolvedEvents, loading: eventsLoading, tick: eventsTick, forceRefresh: forceRefreshEvents } = useResolvedEvents();

  const isDecoding = viewUrl !== null;

  // ─── Data fetching ────────────────────────────────────────────

  const loadNews = useCallback(async (force = false) => {
    try {
      if (force) clearNewsCache();
      else setLoading(true);
      setError(null);
      const items = await fetchAllNews(force);
      if (abortedRef.current) return;
      setNews(items);
    } catch (err) {
      if (abortedRef.current) return;
      console.error('[BuzzView] Failed to fetch news:', err);
      setError('Failed to load transmissions. Check the Comms Array and try again.');
    } finally {
      if (!abortedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { abortedRef.current = false; loadNews(); return () => { abortedRef.current = true; }; }, [loadNews]);
  useEffect(() => { const i = setInterval(() => { if (!abortedRef.current) loadNews(true); }, AUTO_REFRESH_INTERVAL); return () => clearInterval(i); }, [loadNews]);

  // Ensure native webview overlay is destroyed when BuzzView unmounts (tab switch)
  useEffect(() => {
    return () => { window.webviewApi?.close(); };
  }, []);

  const handleRefresh = useCallback(() => {
    forceRefreshEvents();
    loadNews(true);
  }, [loadNews, forceRefreshEvents]);

  // ─── Filtered stream ────────────────────────────────────────────

  const filteredNews = useMemo(() => {
    if (!eventFilter) return news;
    const q = eventFilter.toLowerCase();
    return news.filter((item) => item.title.toLowerCase().includes(q) || item.summary.toLowerCase().includes(q));
  }, [news, eventFilter]);

  // ─── Handlers ───────────────────────────────────────────────────

  const handleSelectItem = useCallback((item: NewsItem) => {
    setSelectedItem(item);
    setViewUrl(item.url);
    setFocusMode(false);
    transmissionsHistoryStore.markDecoded(item.id);
    setDecodedIds((prev) => {
      if (prev.has(item.id)) return prev;
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
  }, []);

  const handleCloseDecode = useCallback(() => {
    setViewUrl(null);
    setSelectedItem(null);
    setFocusMode(false);
  }, []);

  const handleSelectRelay = useCallback((url: string) => { setViewUrl(url); }, []);

  const handleOpenUrl = useCallback((url: string) => {
    setSelectedItem(null);
    setViewUrl(url);
    setFocusMode(false);
  }, []);

  const handleEventLatest = useCallback((eventName: string) => {
    setEventFilter((prev) => (prev === eventName ? null : eventName));
  }, []);

  const handleClearFilter = useCallback(() => setEventFilter(null), []);
  const handleToggleFocus = useCallback(() => setFocusMode((f) => !f), []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (focusMode) setFocusMode(false);
        else if (viewUrl) handleCloseDecode();
        else setEventFilter(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [viewUrl, focusMode, handleCloseDecode]);

  // ─── Shared stream props ────────────────────────────────────────

  const streamProps = {
    resolvedEvents,
    eventsLoading,
    eventsTick,
    eventFilter,
    onEventLatest: handleEventLatest,
    onClearFilter: handleClearFilter,
    onOpenUrl: handleOpenUrl,
    filteredNews,
    decodedIds,
    selectedItemId: selectedItem?.id ?? null,
    onSelectItem: handleSelectItem,
    onRefresh: handleRefresh,
  };

  // ─── Loading state ────────────────────────────────────────────

  if (loading && news.length === 0) {
    return (
      <div className="relative w-full overflow-hidden p-1" style={{ height: 'calc(100vh - 180px)' }}>
        <div className="h-full rounded-2xl border border-white/[0.06] bg-black/30 backdrop-blur-sm overflow-hidden flex flex-col">
          {/* Toolbar skeleton */}
          <div className="flex items-center gap-2 p-2.5 border-b border-white/[0.06] flex-shrink-0">
            <div className="flex gap-1.5">
              <div className="w-10 h-6 rounded bg-white/5 animate-pulse" />
              <div className="w-16 h-6 rounded bg-white/5 animate-pulse" />
            </div>
            <div className="ml-auto w-7 h-7 rounded-lg bg-white/5 animate-pulse" />
          </div>
          {/* Broadcasts skeleton */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] flex-shrink-0">
            <div className="w-3 h-3 rounded-full bg-white/5 animate-pulse" />
            <div className="w-32 h-4 rounded bg-white/5 animate-pulse" />
          </div>
          {/* Card grid skeleton */}
          <div className="flex-1 overflow-hidden p-2">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="rounded-xl border border-white/[0.06] bg-black/40 overflow-hidden animate-pulse">
                  <div className="w-full aspect-[16/9] bg-white/5" />
                  <div className="p-3.5 flex flex-col gap-2.5">
                    <div className="w-16 h-5 rounded-full bg-white/5" />
                    <div className="h-4 rounded bg-white/[0.07] w-[85%]" />
                    <div className="space-y-1.5">
                      <div className="h-3 rounded bg-white/[0.04] w-full" />
                      <div className="h-3 rounded bg-white/[0.04] w-[90%]" />
                      <div className="h-3 rounded bg-white/[0.04] w-[70%]" />
                    </div>
                    <div className="flex items-center gap-1.5 mt-1">
                      <div className="w-3 h-3 rounded-full bg-white/5" />
                      <div className="w-12 h-3 rounded bg-white/5" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || news.length === 0) {
    return (
      <div className="relative w-full flex flex-col items-center justify-center text-center" style={{ height: 'calc(100vh - 180px)' }}>
        <div className="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center mb-6 shadow-lg shadow-fuchsia-500/10 backdrop-blur-sm">
          <Newspaper className="w-10 h-10 text-fuchsia-500" />
        </div>
        <h2 className="text-2xl font-bold mb-2 font-['Orbitron']">{error ? 'Comms disrupted' : 'No transmissions yet'}</h2>
        <p className="text-white/60 mb-6 max-w-md">
          {error || 'Signals from the Comms Array will appear here once Steam and RSS feeds are received.'}
        </p>
        <Button onClick={handleRefresh} className="bg-fuchsia-500 hover:bg-fuchsia-600 text-white gap-1.5">
          <AnimateIcon hover="spin"><RefreshCw className="w-4 h-4" /></AnimateIcon>
          Try again
        </Button>
      </div>
    );
  }

  // ─── Unified animated layout ──────────────────────────────────
  // Always render both panels; animate between idle / split / focus
  // via CSS transitions instead of conditional unmount/remount.

  const animate = !isDragging;
  const streamWidth = !isDecoding
    ? '100%'
    : focusMode
      ? '0%'
      : `${splitRatio * 100}%`;

  return (
    <div className="relative w-full overflow-hidden p-1" style={{ height: 'calc(100vh - 180px)' }}>
      <div
        ref={splitContainerRef}
        className="relative flex h-full overflow-hidden"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* Stream panel */}
        <div
          className={cn(
            'flex-shrink-0 overflow-hidden rounded-2xl bg-black/30 backdrop-blur-sm',
            isDecoding && !focusMode && 'border border-white/[0.06]',
            !isDecoding && 'border border-white/[0.06]',
            animate && 'transition-[width,opacity] duration-300 ease-in-out',
          )}
          style={{
            width: streamWidth,
            minWidth: isDecoding && !focusMode ? MIN_STREAM_W : 0,
            opacity: focusMode ? 0 : 1,
          }}
        >
          <StreamColumn {...streamProps} />
        </div>

        {/* Drag handle — only visible in split mode */}
        <div
          className={cn(
            'flex-shrink-0 w-3 flex items-center justify-center cursor-col-resize group z-10',
            animate && 'transition-opacity duration-300 ease-in-out',
            isDecoding && !focusMode ? 'opacity-100' : 'opacity-0 pointer-events-none',
          )}
          onPointerDown={onPointerDown}
        >
          <div className="w-1 h-12 rounded-full bg-white/10 group-hover:bg-fuchsia-500/40 group-active:bg-fuchsia-500/60 transition-colors flex items-center justify-center">
            <GripVertical className="w-3 h-3 text-white/20 group-hover:text-fuchsia-400/60" />
          </div>
        </div>

        {/* Webview panel */}
        <div
          className={cn(
            'min-w-0 flex flex-col',
            animate && 'transition-[flex,opacity,transform] duration-300 ease-in-out',
            isDecoding ? 'flex-1 opacity-100 translate-x-0' : 'flex-[0_0_0%] opacity-0 translate-x-8',
          )}
        >
          {isDecoding && viewUrl && (
            <WebviewPanel
              url={viewUrl}
              onClose={handleCloseDecode}
              relaySources={selectedItem?.relaySources}
              onSelectRelay={handleSelectRelay}
              focusMode={focusMode}
              onToggleFocus={handleToggleFocus}
            />
          )}
        </div>
      </div>
    </div>
  );
});
