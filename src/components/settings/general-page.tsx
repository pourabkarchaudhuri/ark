/**
 * Settings → General (1.0.97 B37, design "Redesign · General"): grouped rows with chips, hotkey and
 * warning rows, Roomy/Dense density, the results list when searching, and the first-load skeleton.
 */
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useDevMode } from '@/hooks/useDevMode';
import { useBetaFeatures } from '@/hooks/useBetaFeatures';
import { useAllowAdultContent } from '@/hooks/useAllowAdultContent';
import { isHltbEnabled, setHltbEnabled } from '@/hooks/useHltbTimes';
import {
  getAutoOnHoldEnabled, getAutoStatusTransitionEnabled, setAutoOnHoldEnabled, setAutoStatusTransitionEnabled,
} from '@/lib/auto-status-settings';
import { OVERLAY_CYCLE_HOTKEY_LABEL, OVERLAY_TOGGLE_HOTKEY_LABEL } from '@/overlay/detail-level';
import { YearWrapped } from '@/components/year-wrapped';
import { LibraryDataSection, type ToastInput } from '@/components/settings/library-data-section';
import { GgDealsRow } from '@/components/settings/gg-deals-row';
import { Chip, Icon, ICON, PageHeader, Panel, Row, SwitchRow } from '@/components/settings/ui';
import { PAGE_LABELS, SETTINGS_INDEX, searchSettings, type SettingsPageId } from '@/components/settings/search-index';

export type Density = 'roomy' | 'dense';

export interface PageProps {
  /** Move to another page, optionally to one row (search results, "Change" links). */
  onNavigate: (page: SettingsPageId, settingId?: string) => void;
  /** The row the page was opened at, when it was opened from a link or a search result. */
  focusId?: string | null;
}

interface GeneralPageProps extends PageProps {
  query: string;
  density: Density;
  onToast: (toast: ToastInput) => void;
}

interface GeneralHeaderProps {
  onQuery: (q: string) => void;
  onDensity: (d: Density) => void;
}

function Skeleton() {
  return (
    <Panel id="loading" title="Loading">
      <div aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div className="row" key={i}>
            <div className="grow"><div className="sk" style={{ width: i === 1 ? '45%' : '55%', height: 12 }} /><div className="sk" style={{ width: '75%', height: 8, marginTop: 8 }} /></div>
            <div className="sk" style={{ width: 44, height: 24, borderRadius: 999 }} />
          </div>
        ))}
      </div>
    </Panel>
  );
}

const GeneralBody = memo(function GeneralBody({ query, density, onToast, onNavigate }: GeneralPageProps) {
  const [loaded, setLoaded] = useState(false);
  const [autoLaunch, setAutoLaunch] = useState(true);
  const [overlay, setOverlay] = useState(false);
  const [overlayCycleOk, setOverlayCycleOk] = useState(true);
  const [analytics, setAnalytics] = useState(false);
  const [autoOnHold, setAutoOnHold] = useState(getAutoOnHoldEnabled);
  const [autoPlaying, setAutoPlaying] = useState(getAutoStatusTransitionEnabled);
  const [hltb, setHltb] = useState(isHltbEnabled);
  const [beta, setBeta] = useBetaFeatures();
  const [dev, setDev] = useDevMode();
  const [adult, setAdult] = useAllowAdultContent();
  const [showWrapped, setShowWrapped] = useState(false);

  useEffect(() => {
    let live = true;
    const s = window.settings;
    // The overlay and analytics getters are optional in older preloads: guard each call.
    Promise.all([
      s?.getAutoLaunch().then((v) => live && setAutoLaunch(v)).catch(() => {}),
      s?.getOverlayEnabled?.().then((v) => live && setOverlay(v)).catch(() => {}),
      s?.getOverlayCycleHotkeyRegistered?.().then((v) => live && setOverlayCycleOk(v)).catch(() => {}),
      window.analytics?.getEnabled?.().then((v) => live && setAnalytics(v)).catch(() => {}),
    ]).finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, []);

  /** Optimistic switch backed by a main-process setter; puts the old value back when main refuses. */
  const saveRemote = useCallback(async (next: boolean, set: (v: boolean) => void, save?: (v: boolean) => Promise<{ success: boolean } | undefined | void>) => {
    if (!save) return;
    set(next);
    try {
      const r = await save(next);
      if (r && r.success === false) set(!next);
    } catch { set(!next); }
  }, []);

  const toggles = useMemo<Record<string, { checked: boolean; label: string; onChange: (v: boolean) => void }>>(() => ({
    launch: { checked: autoLaunch, label: 'Launch on startup', onChange: (v) => void saveRemote(v, setAutoLaunch, window.settings?.setAutoLaunch) },
    onhold: { checked: autoOnHold, label: 'Auto On Hold', onChange: (v) => { setAutoOnHoldEnabled(v); setAutoOnHold(v); } },
    autoplay: { checked: autoPlaying, label: 'Auto Playing', onChange: (v) => { setAutoStatusTransitionEnabled(v); setAutoPlaying(v); } },
    overlay: { checked: overlay, label: 'Show the overlay', onChange: (v) => void saveRemote(v, setOverlay, window.settings?.setOverlayEnabled) },
    adult: { checked: adult, label: 'Allow adult content', onChange: setAdult },
    hltb: { checked: hltb, label: 'HowLongToBeat times', onChange: (v) => { setHltbEnabled(v); setHltb(v); } },
    analytics: { checked: analytics, label: 'Usage analytics', onChange: (v) => void saveRemote(v, setAnalytics, window.analytics?.setEnabled) },
    beta: { checked: beta, label: 'Beta features', onChange: setBeta },
    dev: { checked: dev, label: 'Developer mode', onChange: setDev },
  }), [autoLaunch, autoOnHold, autoPlaying, overlay, adult, hltb, analytics, beta, dev, saveRemote, setAdult, setBeta, setDev]);

  if (query.trim()) {
    const results = searchSettings(query);
    return (
      <section className="panel fade" aria-labelledby="h-results">
        <div className="inline" style={{ justifyContent: 'space-between', paddingRight: 'var(--space-4)' }}>
          <h2 id="h-results" className="ph">Results</h2>
          <span aria-live="polite" className="d" style={{ margin: 0 }}>{results.length} across all sections</span>
        </div>
        {results.map((r) => {
          const sw = r.page === 'general' ? toggles[r.id] : undefined;
          return (
            <div className="row" key={r.id}>
              <div className="inline grow" style={{ gap: 'var(--space-3)' }}>
                <Chip tone="accent" tag className="res">{PAGE_LABELS[r.page]}</Chip>
                <div className="grow"><p className="t">{r.label}</p><p className="d">{r.desc}</p></div>
              </div>
              {sw
                ? <button type="button" role="switch" className="sw" aria-checked={sw.checked} aria-label={sw.label} onClick={() => sw.onChange(!sw.checked)}><span /></button>
                : <button type="button" className="btn" onClick={() => onNavigate(r.page, r.id)}>Open<Icon d={ICON.arrow} /></button>}
            </div>
          );
        })}
        {results.length === 0 && (
          <div className="row" style={{ justifyContent: 'flex-start' }}>
            <p className="t" style={{ color: 'var(--color-ink-2)' }}>Nothing matches &ldquo;{query.trim()}&rdquo;. Try &ldquo;key&rdquo;, &ldquo;overlay&rdquo;, &ldquo;backup&rdquo; or &ldquo;rebuild&rdquo;.</p>
          </div>
        )}
      </section>
    );
  }

  if (!loaded) return <Skeleton />;

  const sw = (id: string, desc: ReactNode, extra?: { chip?: ReactNode; extra?: ReactNode }) => {
    const t = toggles[id]!;
    return <SwitchRow settingId={id} label={t.label} desc={desc} checked={t.checked} onChange={t.onChange} chip={extra?.chip} extra={extra?.extra} />;
  };

  return (
    <div className={cn('stack', density === 'dense' && 'dense')} data-density={density}>
      <Panel id="launch" title="Launch and status">
        {sw('launch', 'Starts in the tray when you log in.')}
        {sw('onhold', 'Playing → On Hold after 4 weeks unplayed. You get an Undo, and playing it again moves it back.')}
        {sw('autoplay', 'Want to Play → Playing after a 10-minute session.')}
      </Panel>

      <Panel id="overlay" title="In-game overlay">
        {sw('overlay', 'Corner HUD while a tracked game runs. Best in borderless windowed.', {
          extra: (
            <>
              <p className="d keep" style={{ marginTop: 'var(--space-2)' }}>
                <span className="kbd">{OVERLAY_TOGGLE_HOTKEY_LABEL}</span> show or hide · <span className="kbd">{OVERLAY_CYCLE_HOTKEY_LABEL}</span> cycle detail
              </p>
              {!overlayCycleOk && (
                <p className="warnline"><Icon d={ICON.warn} size={12} />{OVERLAY_CYCLE_HOTKEY_LABEL} is used by another app, so cycling is off.</p>
              )}
            </>
          ),
        })}
      </Panel>

      <Panel id="content" title="Content and prices">
        {sw('adult', 'When off, sexually explicit games are hidden everywhere.')}
        {sw('hltb', 'Sends the game title to howlongtobeat.com. Cached for 30 days.')}
        <GgDealsRow />
      </Panel>

      <Panel id="privacy" title="Privacy">
        {sw('analytics', 'Anonymous app launches, version, platform and which screen is open, never which game. Off by default; turning it off also deletes the anonymous id.')}
      </Panel>

      <Panel id="library" title="Library data">
        <LibraryDataSection onToast={onToast} />
        <Row settingId="wrapped" label="Ark Wrapped" desc="Your year in games: stats, top games, genre mix." control={<button type="button" className="btn" onClick={() => setShowWrapped(true)}>Open<Icon d={ICON.arrow} /></button>} />
      </Panel>

      <Panel id="experimental" title="Experimental">
        {sw('beta', 'AI Chat button and cloud connectors in AI providers.')}
        {sw('dev', 'Data Flow page, status panels and pipeline diagnostics.')}
      </Panel>

      <YearWrapped isOpen={showWrapped} onClose={() => setShowWrapped(false)} />
    </div>
  );
});

/** The page: header with the search box (Ctrl K focuses it from any page) and the density toggle, then the rows. */
export const GeneralPage = memo(function GeneralPage(props: GeneralPageProps & GeneralHeaderProps) {
  const { query, onQuery, density, onDensity } = props;
  return (
    <>
      <PageHeader title="General" lede="How Ark behaves day to day. Changes save as you make them.">
        <div className="inline" style={{ flexWrap: 'wrap' }}>
          <label className="search">
            <Icon d={ICON.search} />
            <span className="vh">Search all settings</span>
            <input id="settings-search" type="search" value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search all settings" />
            <span className="kbd">Ctrl K</span>
          </label>
          <div className="tray" role="group" aria-label="Density">
            <button type="button" aria-pressed={density === 'roomy'} onClick={() => onDensity('roomy')}>Roomy</button>
            <button type="button" aria-pressed={density === 'dense'} onClick={() => onDensity('dense')}>Dense</button>
          </div>
        </div>
      </PageHeader>
      <GeneralBody query={query} density={density} onToast={props.onToast} onNavigate={props.onNavigate} />
    </>
  );
});

/** Ids of the General rows, for the index test. */
export const GENERAL_SETTING_IDS = SETTINGS_INDEX.filter((s) => s.page === 'general').map((s) => s.id);
