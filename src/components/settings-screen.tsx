/**
 * Settings Screen — the redesigned, full-page settings workspace (1.0.97 B37, the user-finalized
 * "Tracker Settings Page" design).
 *
 * Pages (one component each, under src/components/settings/):
 *   General · AI providers · Game understanding · Guide · About
 *
 * The shell owns what crosses pages: the active page, the search box (Ctrl K opens it from any
 * page), the Roomy/Dense density, the toast and the row a link or search result should land on.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { APP_VERSION } from '@/components/changelog-modal';
import type { TourId } from '@/components/guided-tour';
import { GeneralPage, type Density } from '@/components/settings/general-page';
import { AiProvidersPage } from '@/components/settings/ai-providers-page';
import { GameUnderstandingPage } from '@/components/settings/game-understanding-page';
import { GuidePage } from '@/components/settings/guide-page';
import { AboutPage } from '@/components/settings/about-page';
import { Chip, Icon, ICON, Toast, type ToastMessage } from '@/components/settings/ui';
import { PAGE_LABELS, type SettingsPageId } from '@/components/settings/search-index';
import { routeName, useAiRouter } from '@/components/settings/use-ai-router';
import type { ToastInput } from '@/components/settings/library-data-section';
import '@/components/settings/settings.css';

const NAV: ReadonlyArray<{ id: SettingsPageId; icon: string }> = [
  { id: 'general', icon: ICON.general },
  { id: 'providers', icon: ICON.providers },
  { id: 'understanding', icon: ICON.brain },
  { id: 'guide', icon: ICON.guide },
  { id: 'about', icon: ICON.info },
];

const DENSITY_KEY = 'ark-settings-density';
const TOAST_MS = 6000;

function readDensity(): Density {
  try { return localStorage.getItem(DENSITY_KEY) === 'dense' ? 'dense' : 'roomy'; } catch { return 'roomy'; }
}

interface SettingsScreenProps {
  onBack: () => void;
  /** Start a Joyride tour after switching to the correct dashboard view (Browse, Library, etc.). */
  onRunGuidedTour?: (tourId: TourId) => void;
}

export const SettingsScreen = memo(function SettingsScreen({ onBack, onRunGuidedTour }: SettingsScreenProps) {
  const [page, setPage] = useState<SettingsPageId>('general');
  const [query, setQuery] = useState('');
  const [density, setDensityState] = useState<Density>(readDensity);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastSeq = useRef(0);
  const mainRef = useRef<HTMLElement>(null);
  const { state: router } = useAiRouter();

  const chatRoute = routeName(router, 'chat');

  const setDensity = useCallback((d: Density) => {
    setDensityState(d);
    try { localStorage.setItem(DENSITY_KEY, d); } catch { /* storage unavailable: this visit only */ }
  }, []);

  const navigate = useCallback((to: SettingsPageId, settingId?: string) => {
    setPage(to);
    setQuery('');
    setFocusId(settingId ?? null);
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(null);
  }, []);

  const showToast = useCallback((t: ToastInput) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ ...t, id: ++toastSeq.current });
    // A failure stays until it is dismissed or acted on; a success goes away by itself.
    if (t.tone !== 'fault') toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // Ctrl K: search every setting, from any page. Esc clears the search or closes the toast.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPage('general');
        setFocusId(null);
        setTimeout(() => { document.getElementById('settings-search')?.focus(); }, 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Land on the row a link or search result pointed at, else start the page at the top.
  useEffect(() => {
    const t = setTimeout(() => {
      const el = focusId ? document.querySelector<HTMLElement>(`[data-setting-id="${focusId}"]`) : null;
      if (el) el.scrollIntoView?.({ block: 'center', behavior: 'auto' });
      else mainRef.current?.scrollTo?.({ top: 0 });
    }, 0);
    return () => clearTimeout(t);
  }, [page, focusId]);

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (query) { setQuery(''); e.stopPropagation(); }
      else if (toast) dismissToast();
    }
  };

  return (
    <div className="ark-settings" onKeyDown={onSearchKeyDown}>
      <aside className="rail" data-tour="settings-sidebar">
        <button type="button" className="btn q" style={{ justifyContent: 'flex-start' }} onClick={onBack}><Icon d={ICON.back} />Back</button>
        <div>
          <p className="rail-h">Settings</p>
          <nav className="tray v" aria-label="Settings sections">
            {NAV.map((n) => (
              <button
                key={n.id} type="button" aria-current={page === n.id ? 'page' : undefined}
                data-tour={`settings-nav-${n.id}`} onClick={() => navigate(n.id)}
              >
                <Icon d={n.icon} size={16} /><span>{PAGE_LABELS[n.id]}</span>
              </button>
            ))}
          </nav>
        </div>
        <div className="rail-foot">
          {router && (
            <div><span>AI route</span><Chip tone={chatRoute === 'None' ? 'nokey' : 'live'}>{chatRoute}</Chip></div>
          )}
          <div><span>Version</span><span style={{ color: 'var(--color-ink-2)' }}>{APP_VERSION}</span></div>
        </div>
      </aside>

      <main className="main" ref={mainRef} data-tour="settings-content">
        <div className={page === 'providers' ? 'page wide' : 'page'}>
          {page === 'general' && <GeneralPage query={query} onQuery={setQuery} density={density} onDensity={setDensity} onToast={showToast} onNavigate={navigate} />}
          {page === 'providers' && <AiProvidersPage onNavigate={navigate} focusId={focusId} />}
          {page === 'understanding' && <GameUnderstandingPage onNavigate={navigate} focusId={focusId} />}
          {page === 'guide' && <GuidePage onRunGuidedTour={onRunGuidedTour} />}
          {page === 'about' && <AboutPage />}
        </div>
      </main>

      {toast && <Toast key={toast.id} toast={toast} onDismiss={dismissToast} />}
    </div>
  );
});
