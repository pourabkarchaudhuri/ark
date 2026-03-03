import { useState, useEffect, useCallback, useRef, type FC } from 'react';
import Joyride, { CallBackProps, STATUS, ACTIONS, EVENTS, Step, TooltipRenderProps } from 'react-joyride';
import { Sparkles, ChevronRight, ChevronLeft, X, Rocket, Compass, ScanSearch, Library, Calendar, Route, Radio, Search, Orbit, SlidersHorizontal, Settings, Gamepad2, type LucideProps } from 'lucide-react';

const TOUR_COMPLETED_KEY = 'ark-tour-completed';

const STEP_ICONS: Record<string, FC<LucideProps>> = {
  'Welcome to Ark': Rocket,
  'Navigation Bar': Compass,
  'Browse Games': ScanSearch,
  'Your Library': Library,
  'Oracle Recommendations': Sparkles,
  'Release Calendar': Calendar,
  'Voyage Timeline': Route,
  'Transmissions': Radio,
  'Search': Search,
  'Embedding Space': Orbit,
  'Filters & Sorting': SlidersHorizontal,
  'Settings': Settings,
  'You\'re Ready!': Gamepad2,
};

function TourTooltip({
  continuous,
  index,
  step,
  size,
  backProps,
  closeProps,
  primaryProps,
  skipProps,
  isLastStep,
  tooltipProps,
}: TooltipRenderProps) {
  const progress = ((index + 1) / size) * 100;
  const Icon = STEP_ICONS[step.title as string] || Sparkles;

  return (
    <div
      {...tooltipProps}
      className="no-drag"
      style={{
        maxWidth: 380,
        minWidth: 300,
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <div
        style={{
          background: 'linear-gradient(135deg, rgba(24,24,27,0.97) 0%, rgba(9,9,11,0.98) 100%)',
          backdropFilter: 'blur(24px)',
          border: '1px solid rgba(217,70,239,0.25)',
          borderRadius: 16,
          boxShadow: '0 0 30px rgba(217,70,239,0.15), 0 0 60px rgba(217,70,239,0.05), 0 25px 50px rgba(0,0,0,0.6)',
          overflow: 'hidden',
          position: 'relative' as const,
        }}
      >
        {/* Top gradient accent line */}
        <div
          style={{
            height: 2,
            background: 'linear-gradient(90deg, #d946ef, #a855f7, #6366f1, #22d3ee)',
            opacity: 0.8,
          }}
        />

        {/* Progress bar */}
        <div style={{ height: 2, background: 'rgba(255,255,255,0.05)' }}>
          <div
            style={{
              height: '100%',
              width: `${progress}%`,
              background: 'linear-gradient(90deg, #d946ef, #a855f7)',
              transition: 'width 0.4s ease',
            }}
          />
        </div>

        <div style={{ padding: '20px 22px 16px' }}>
          {/* Header: icon + title + close */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon size={18} color="#ffffff" strokeWidth={1.5} />
              <h3
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 14,
                  fontWeight: 600,
                  color: '#fafafa',
                  letterSpacing: '0.01em',
                  margin: 0,
                }}
              >
                {step.title}
              </h3>
            </div>
            <button
              {...closeProps}
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8,
                width: 28,
                height: 28,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: 'rgba(255,255,255,0.4)',
                transition: 'all 0.2s',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(239,68,68,0.15)';
                e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)';
                e.currentTarget.style.color = '#ef4444';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
                e.currentTarget.style.color = 'rgba(255,255,255,0.4)';
              }}
            >
              <X size={14} />
            </button>
          </div>

          {/* Body */}
          <p
            style={{
              fontSize: 12.5,
              lineHeight: 1.65,
              color: 'rgba(161,161,170,0.9)',
              margin: '0 0 18px',
              fontWeight: 400,
            }}
          >
            {step.content}
          </p>

          {/* Footer: skip + step counter + nav */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            {/* Skip */}
            <button
              {...skipProps}
              style={{
                background: 'none',
                border: 'none',
                color: 'rgba(113,113,122,0.8)',
                fontSize: 11,
                cursor: 'pointer',
                padding: '4px 0',
                fontFamily: "'JetBrains Mono', monospace",
                transition: 'color 0.2s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = '#a1a1aa'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(113,113,122,0.8)'; }}
            >
              Skip tour
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* Step counter */}
              <span
                style={{
                  fontSize: 11,
                  color: 'rgba(161,161,170,0.5)',
                  fontVariantNumeric: 'tabular-nums',
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {index + 1}/{size}
              </span>

              {/* Back */}
              {index > 0 && (
                <button
                  {...backProps}
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8,
                    height: 32,
                    width: 32,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    color: 'rgba(255,255,255,0.5)',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)';
                    e.currentTarget.style.color = '#fff';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
                    e.currentTarget.style.color = 'rgba(255,255,255,0.5)';
                  }}
                >
                  <ChevronLeft size={16} />
                </button>
              )}

              {/* Next / Finish */}
              {continuous && (
                <button
                  {...primaryProps}
                  style={{
                    background: isLastStep
                      ? 'linear-gradient(135deg, #d946ef, #a855f7)'
                      : 'linear-gradient(135deg, #d946ef, #c026d3)',
                    border: 'none',
                    borderRadius: 8,
                    height: 32,
                    padding: '0 14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    cursor: 'pointer',
                    color: '#fff',
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: "'JetBrains Mono', monospace",
                    transition: 'all 0.2s',
                    boxShadow: '0 0 16px rgba(217,70,239,0.3)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.boxShadow = '0 0 24px rgba(217,70,239,0.5)';
                    e.currentTarget.style.transform = 'translateY(-1px)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.boxShadow = '0 0 16px rgba(217,70,239,0.3)';
                    e.currentTarget.style.transform = 'translateY(0)';
                  }}
                >
                  {isLastStep ? (
                    <>
                      <Sparkles size={13} />
                      <span>Finish</span>
                    </>
                  ) : (
                    <>
                      <span>Next</span>
                      <ChevronRight size={14} />
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const tourSteps: Step[] = [
  {
    target: '[data-tour="app-logo"]',
    content: 'Welcome to Ark — your personal game tracking command center. Let\'s take a quick tour of everything you can do here.',
    placement: 'bottom',
    disableBeacon: true,
    title: 'Welcome to Ark',
  },
  {
    target: '[data-tour="view-toggle"]',
    content: 'This is your navigation hub. Switch between different views to browse, track, and analyse your gaming life.',
    placement: 'bottom',
    title: 'Navigation Bar',
  },
  {
    target: '[data-tour="browse-button"]',
    content: 'Browse mode lets you explore trending, top-rated, and upcoming games from a massive catalog. Discover your next obsession here.',
    placement: 'bottom',
    title: 'Browse Games',
  },
  {
    target: '[data-tour="library-button"]',
    content: 'Your personal library. Add games from Browse and track your status — Playing, Backlog, Completed, Dropped — plus priority and progress.',
    placement: 'bottom',
    title: 'Your Library',
  },
  {
    target: '[data-tour="oracle-button"]',
    content: 'The Oracle analyses your library and taste to recommend games you\'ll love. The more you track, the smarter it gets.',
    placement: 'bottom',
    title: 'Oracle Recommendations',
  },
  {
    target: '[data-tour="calendar-button"]',
    content: 'Never miss a launch. The release calendar shows upcoming games on an interactive timeline.',
    placement: 'bottom',
    title: 'Release Calendar',
  },
  {
    target: '[data-tour="journey-button"]',
    content: 'Voyage visualises your gaming history as an interactive timeline — a Gantt chart of sessions, a log of activity, and achievement medals you\'ve earned.',
    placement: 'bottom',
    title: 'Voyage Timeline',
  },
  {
    target: '[data-tour="buzz-button"]',
    content: 'Transmissions brings signals from the Comms Array (Steam + gaming sites). Select a transmission to decode it in the Decode Bay — no need to leave the Ark.',
    placement: 'bottom',
    title: 'Transmissions',
  },
  {
    target: '[data-tour="search-input"]',
    content: 'Search across the entire catalog or within your library. Results appear instantly with suggestions as you type.',
    placement: 'bottom',
    title: 'Search',
  },
  {
    target: '[data-tour="embedding-space"]',
    content: 'Enter Embedding Space for a 3D visualisation of how every game relates to every other based on genre DNA, themes, and player sentiment.',
    placement: 'bottom',
    title: 'Embedding Space',
  },
  {
    target: '[data-tour="filter-trigger"]',
    content: 'Fine-tune any view with powerful filters — sort by rating, release date, or title, and narrow by genre, platform, store, year, and more.',
    placement: 'left',
    title: 'Filters & Sorting',
  },
  {
    target: '[data-tour="settings-button"]',
    content: 'Configure Ark — set up local AI (Ollama), add a Gemini API key, export or import your library, toggle launch-on-startup, and access Year in Review.',
    placement: 'left',
    title: 'Settings',
  },
  {
    target: '[data-tour="app-logo"]',
    content: 'You\'re all set! Click any game card for details, hit the heart to add it to your library, and explore every corner of the Ark. Happy gaming, Commander!',
    placement: 'bottom',
    disableBeacon: true,
    title: 'You\'re Ready!',
  },
];

interface GuidedTourProps {
  run: boolean;
  tourKey: number;
  onFinish: () => void;
}

const OVERLAY_ID = 'ark-tour-overlay';

function removeJoyrideLeftovers() {
  document.querySelectorAll(
    '.react-joyride__overlay, .__floater, [data-react-joyride] > div',
  ).forEach(el => el.remove());
}

export function GuidedTour({ run, tourKey, onFinish }: GuidedTourProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const finishedRef = useRef(false);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const ensureOverlay = useCallback(() => {
    if (overlayRef.current) return;
    let el = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
    if (!el) {
      el = document.createElement('div');
      el.id = OVERLAY_ID;
      Object.assign(el.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '9999',
        background: 'rgba(0, 0, 0, 0.80)',
        pointerEvents: 'none',
        transition: 'opacity 0.3s ease',
        opacity: '1',
      });
      document.body.appendChild(el);
    }
    overlayRef.current = el;
  }, []);

  const removeOverlay = useCallback(() => {
    const el = overlayRef.current ?? document.getElementById(OVERLAY_ID);
    if (el) {
      el.style.opacity = '0';
      setTimeout(() => { try { el.remove(); } catch {} }, 350);
    }
    overlayRef.current = null;
  }, []);

  const finishTour = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    clearTimeout(safetyTimerRef.current);
    localStorage.setItem(TOUR_COMPLETED_KEY, 'true');
    removeOverlay();
    setTimeout(removeJoyrideLeftovers, 100);
    onFinish();
  }, [onFinish, removeOverlay]);

  useEffect(() => {
    if (run) {
      finishedRef.current = false;
      ensureOverlay();
      // Safety net: if the tour gets stuck for 5 minutes, force cleanup
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = setTimeout(() => {
        if (!finishedRef.current) finishTour();
      }, 5 * 60 * 1000);
    }
    return () => clearTimeout(safetyTimerRef.current);
  }, [run, tourKey, ensureOverlay, finishTour]);

  useEffect(() => {
    return () => {
      removeOverlay();
      removeJoyrideLeftovers();
    };
  }, [removeOverlay]);

  const handleCallback = useCallback((data: CallBackProps) => {
    const { status, action, type, index } = data;

    if (
      status === STATUS.FINISHED ||
      status === STATUS.SKIPPED ||
      status === STATUS.ERROR ||
      action === ACTIONS.CLOSE
    ) {
      finishTour();
      return;
    }

    // If the target for the current step can't be found, skip to finish
    if (type === EVENTS.TARGET_NOT_FOUND) {
      // If it's the last step or close to it, just finish
      if (index >= tourSteps.length - 2) {
        finishTour();
      }
    }
  }, [finishTour]);

  if (!run) return null;

  return (
    <Joyride
      key={tourKey}
      steps={tourSteps}
      run
      continuous
      showSkipButton
      showProgress
      disableOverlayClose
      disableScrolling
      tooltipComponent={TourTooltip}
      callback={handleCallback}
      styles={{
        options: {
          zIndex: 10000,
          overlayColor: 'rgba(0, 0, 0, 0)',
        },
        spotlight: {
          borderRadius: 12,
        },
        overlay: {
          backgroundColor: 'transparent',
        },
      }}
      floaterProps={{
        styles: {
          arrow: {
            length: 8,
            spread: 14,
          },
          floater: {
            filter: 'none',
          },
        },
      }}
      locale={{
        back: 'Back',
        close: 'Close',
        last: 'Finish',
        next: 'Next',
        skip: 'Skip tour',
      }}
    />
  );
}

export function useTourState() {
  const [tourRunning, setTourRunning] = useState(false);
  const [tourKey, setTourKey] = useState(0);

  useEffect(() => {
    const completed = localStorage.getItem(TOUR_COMPLETED_KEY);
    if (!completed) {
      const timer = setTimeout(() => setTourRunning(true), 1500);
      return () => clearTimeout(timer);
    }
  }, []);

  const startTour = useCallback(() => {
    setTourKey((k) => k + 1);
    setTourRunning(true);
  }, []);
  const stopTour = useCallback(() => setTourRunning(false), []);

  return { tourRunning, tourKey, startTour, stopTour };
}
