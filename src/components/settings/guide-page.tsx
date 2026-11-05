/**
 * Settings → Guide (1.0.97 B37, design "Redesign · Guide"): tours with a completed count and
 * Done / Start / Replay states, plus the features list and "How the AI works" (tours and the old
 * Features tab merged into one page with two tabs).
 */
import { memo, useEffect, useState } from 'react';
import { useDevMode } from '@/hooks/useDevMode';
import { isTourCompleted, type TourId } from '@/components/guided-tour';
import { Chip, Icon, ICON, Meter, PageHeader } from '@/components/settings/ui';

interface TourDef { id: TourId; label: string; desc: string; icon: string; devOnly?: boolean }

export const GUIDE_TOURS: readonly TourDef[] = [
  { id: 'welcome', label: 'Welcome', desc: 'Command strip, Browse and Library, search, filters, settings.', icon: ICON.rocket },
  { id: 'browse', label: 'Browse', desc: 'Categories, search, filters, Embedding Space and the game grid.', icon: ICON.compass },
  { id: 'library', label: 'Library', desc: 'Custom games, status chips, search, filters and the Voyage link.', icon: ICON.library },
  { id: 'journey', label: 'Voyage', desc: "Timeline, Captain's Log, Scenes, Audit and Medals.", icon: ICON.map },
  { id: 'oracle', label: 'Oracle', desc: 'The recommendation engine and your taste profile.', icon: ICON.eye },
  { id: 'ann-graph', label: 'Embedding Space', desc: 'The 3D galaxy map, neighbour search and paths.', icon: ICON.star },
  { id: 'buzz', label: 'Transmissions', desc: 'The news stream, Decode Bay reader and events.', icon: ICON.radio },
  { id: 'calendar', label: 'Upcoming', desc: 'Launches by month, week or day.', icon: ICON.calendar },
  { id: 'settings', label: 'Settings', desc: 'This page: providers, data and preferences.', icon: ICON.general },
  { id: 'data-flow', label: 'Data Flow', desc: 'Live subsystem status diagram.', icon: ICON.zap, devOnly: true },
  { id: 'devlog', label: 'Dev Log', desc: 'Construction journal timeline.', icon: ICON.code, devOnly: true },
];

const FEATURES: ReadonlyArray<{ title: string; desc: string; icon: string }> = [
  { title: 'Every store in one place', desc: 'Steam and Epic side by side, with trending, top sellers, new releases and prices.', icon: ICON.bag },
  { title: 'Your library', desc: "Track what you're playing, finished, paused or want next. Ratings, notes, sessions, backups.", icon: ICON.library },
  { title: 'Recommendations', desc: 'The Oracle learns your taste and gives a reason for each pick.', icon: ICON.eye },
  { title: 'Galaxy map', desc: 'Games that feel alike sit close together. Click a star, hop to its neighbours.', icon: ICON.star },
  { title: 'Gaming news', desc: 'News from 20+ sites in one feed, duplicates removed, readable in Ark.', icon: ICON.radio },
  { title: 'Release calendar', desc: 'Upcoming launches by year, month, week or day.', icon: ICON.calendar },
  { title: 'Medals', desc: 'Milestones for streaks, new genres, collection size and finishes.', icon: ICON.trophy },
  { title: 'Gaming events', desc: '24 big shows with countdowns, a live badge and stream links.', icon: ICON.tv },
];

const FAQ: ReadonlyArray<{ title: string; what: string; icon: string }> = [
  { title: "How does Ark find games I'll like?", what: 'It builds a taste profile from what you play, rate and spend time on, then searches thousands of games for close matches.', icon: ICON.heart },
  { title: 'What is the galaxy map?', what: 'Every game is a star and similar games sit close together. Explore around a game you love to find more like it.', icon: ICON.star },
  { title: 'Is my data private?', what: 'Yes. By default the AI runs on this PC (the built-in local AI) and your library never leaves it. A cloud provider is used only after you add its key, test it and route a role to it in AI providers; then only what that role needs goes to that provider.', icon: ICON.shield },
  { title: 'What does AI Chat do?', what: 'Ask things like "find me a game like Hollow Knight". It searches the catalog and your library, explains its picks, and can add games for you. It uses the chat route set in AI providers.', icon: ICON.message },
  { title: 'How accurate are recommendations?', what: 'They come from a model trained on 41 million player reviews, combined with your own history, and improve as you rate more games.', icon: ICON.trending },
];

function TourRow({ tour, onRun }: { tour: TourDef; onRun: (id: TourId) => void }) {
  const done = isTourCompleted(tour.id);
  return (
    <div className="row">
      <span className="ico" data-done={done}><Icon d={tour.icon} size={16} /></span>
      <div className="grow">
        <div className="inline" style={{ gap: 'var(--space-3)' }}><p className="t">{tour.label}</p>{done && <Chip tone="live">Done</Chip>}{tour.devOnly && <Chip tone="warn">Dev</Chip>}</div>
        <p className="d">{tour.desc}</p>
      </div>
      <button type="button" className="btn" aria-label={`${done ? 'Replay' : 'Start'} ${tour.label} tour`} onClick={() => onRun(tour.id)}>
        <Icon d={done ? ICON.replay : ICON.play} size={12} />{done ? 'Replay' : 'Start'}
      </button>
    </div>
  );
}

type GuideTab = 'tours' | 'manual';

/** The tab a Guide search result lives on; tours exist only when the dashboard can start them. */
function tabFor(focusId: string | null | undefined, canTour: boolean): GuideTab {
  if (focusId === 'g-features' || focusId === 'g-faq') return 'manual';
  if (focusId === 'g-tours') return canTour ? 'tours' : 'manual';
  return canTour ? 'tours' : 'manual';
}

export const GuidePage = memo(function GuidePage({ onRunGuidedTour, focusId }: { onRunGuidedTour?: (tourId: TourId) => void; focusId?: string | null }) {
  const [devMode] = useDevMode();
  const [tab, setTab] = useState<GuideTab>(() => tabFor(focusId, !!onRunGuidedTour));
  useEffect(() => { if (focusId) setTab(tabFor(focusId, !!onRunGuidedTour)); }, [focusId, onRunGuidedTour]);
  const tours = GUIDE_TOURS.filter((t) => !t.devOnly || devMode);
  const doneCount = tours.filter((t) => isTourCompleted(t.id)).length;

  return (
    <>
      <PageHeader title="Guide" lede="Tours of each view, and what Ark can do.">
        <div className="tray" role="tablist" aria-label="Guide sections">
          {onRunGuidedTour && <button type="button" role="tab" aria-selected={tab === 'tours'} onClick={() => setTab('tours')}><Icon d={ICON.compass} />Tours</button>}
          <button type="button" role="tab" aria-selected={tab === 'manual'} onClick={() => setTab('manual')}><Icon d={ICON.layers} />Features</button>
        </div>
      </PageHeader>

      {tab === 'tours' && onRunGuidedTour && (
        <div className="fade stack" role="tabpanel" aria-label="Tours" data-tour="settings-guided-tours" data-setting-id="g-tours" style={{ gap: 'var(--space-4)' }}>
          <div className="inline" style={{ flexWrap: 'wrap', gap: 'var(--space-6)' }}>
            <div style={{ flex: '1 1 240px' }}>
              <div className="inline" style={{ justifyContent: 'space-between', marginBottom: 'var(--space-2)' }}>
                <span className="t">Tours completed</span>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-ink-2)', fontVariantNumeric: 'tabular-nums' }}>{doneCount} of {tours.length}</span>
              </div>
              <Meter pct={tours.length ? (doneCount / tours.length) * 100 : 0} label="Tours completed" />
            </div>
            <p className="d" style={{ margin: 0 }}>Ark opens the right view first. <span className="kbd">Esc</span> leaves a tour.</p>
          </div>
          <div className="card">
            {tours.map((t) => <TourRow key={t.id} tour={t} onRun={onRunGuidedTour} />)}
          </div>
        </div>
      )}

      {tab === 'manual' && (
        <div className="fade stack" role="tabpanel" aria-label="Features" style={{ gap: 'var(--space-10)' }}>
          <section className="stack" style={{ gap: 'var(--space-4)' }} aria-labelledby="h-mods" data-setting-id="g-features">
            <h2 id="h-mods" className="ch">What Ark can do</h2>
            <div className="card">
              {FEATURES.map((f) => (
                <div className="row" key={f.title}>
                  <span className="ico"><Icon d={f.icon} size={16} /></span>
                  <div className="grow"><p className="t">{f.title}</p><p className="d">{f.desc}</p></div>
                </div>
              ))}
            </div>
          </section>
          <section className="stack" style={{ gap: 'var(--space-4)' }} aria-labelledby="h-faq" data-setting-id="g-faq">
            <h2 id="h-faq" className="ch">How the AI works</h2>
            <div className="card">
              {FAQ.map((q) => (
                <details key={q.title}>
                  <summary className="disc"><span className="ico"><Icon d={q.icon} size={16} /></span><span className="t">{q.title}</span><Icon d={ICON.chevron} className="chev" /></summary>
                  <p className="prose fade" style={{ margin: 0, padding: '0 var(--space-5) var(--space-5) 72px' }}>{q.what}</p>
                </details>
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
});
