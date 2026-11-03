/**
 * Settings → About (1.0.97 B37, design "Redesign · About" and the update states): version with the
 * 1.0.84+ updater, "In this build" from the changelog data, the team, the libraries and their
 * installed versions (read at build time) and the terms.
 */
import { memo } from 'react';
import { APP_VERSION, getLatestChangelog } from '@/components/changelog-modal';
import { useAboutUpdate, type UpdateCheckState } from '@/components/settings/about-update';
import { BUILT_WITH_PACKAGES, formatBuiltWithVersion } from '@/lib/built-with-packages';
import { Chip, ExtLink, Icon, ICON, PageHeader, Row, Spinner, type Tone, openExternal } from '@/components/settings/ui';

export const RELEASES_URL = 'https://github.com/pourabkarchaudhuri/ark/releases/latest';

const TEAM = [
  { name: 'Pourab Karchaudhuri', role: 'Lead developer', what: 'architecture, ML pipeline, galaxy map' },
  { name: 'Sanket Aley', role: 'Developer', what: 'core features, testing, store integrations' },
];

const STATE_CHIP: Record<UpdateCheckState, { tone: Tone; msg: (latest: string | null) => string }> = {
  idle: { tone: 'off', msg: () => 'Not checked this session' },
  checking: { tone: 'off', msg: () => 'Checking for updates…' },
  latest: { tone: 'live', msg: () => 'You’re on the latest build' },
  available: { tone: 'accent', msg: (v) => `Ark ${v ?? 'next'} is ready` },
  downloading: { tone: 'info', msg: () => 'Downloading the update…' },
  ready: { tone: 'live', msg: (v) => `Ark ${v ?? 'next'} is downloaded` },
  error: { tone: 'fault', msg: () => 'Couldn’t reach GitHub.' },
};

export const AboutPage = memo(function AboutPage() {
  const update = useAboutUpdate();
  const notes = getLatestChangelog();
  const hasUpdater = typeof window !== 'undefined' && !!window.updater;
  const chip = STATE_CHIP[update.state];
  const versions = typeof __BUILT_WITH__ !== 'undefined' ? __BUILT_WITH__ : undefined;

  return (
    <>
      <PageHeader title="About" lede="Ark · Game tracker and recommendations." />

      <div className="stack">
        <section className="panel" aria-labelledby="h-ver" data-setting-id="a-version">
          <h2 id="h-ver" className="ph">Version</h2>
          <div className="row">
            <div>
              <p className="t">Ark {APP_VERSION}</p>
              <p aria-live="polite" className="d"><Chip tone={chip.tone}>{chip.msg(update.latestVersion)}</Chip></p>
            </div>
            {hasUpdater && (update.state === 'available' || update.state === 'ready' ? (
              <button type="button" className="btn p" onClick={update.state === 'ready' ? update.install : () => void update.download()}>
                <Icon d={update.state === 'ready' ? ICON.replay : ICON.download} />
                {update.state === 'ready' ? `Install & Restart v${update.latestVersion}` : `Download v${update.latestVersion}`}
              </button>
            ) : update.state === 'downloading' ? (
              <button type="button" className="btn p" disabled><Spinner />Downloading</button>
            ) : (
              <button type="button" className="btn" onClick={() => void update.check()} disabled={update.state === 'checking'}>
                {update.state === 'checking' ? <Spinner /> : <Icon d={ICON.refresh} />}
                {update.state === 'checking' ? 'Checking' : update.state === 'idle' || update.state === 'error' ? 'Check for updates' : 'Check again'}
              </button>
            ))}
          </div>
          {update.state === 'error' && (
            <div className="row" data-tone="fault" role="alert" style={{ display: 'block' }}>
              <p className="t" style={{ color: 'var(--tone)' }}>{update.error ?? 'Couldn’t reach GitHub.'}</p>
              <p className="d">
                Download the latest installer from{' '}
                <a href={RELEASES_URL} onClick={(e) => { e.preventDefault(); openExternal(RELEASES_URL); }}>GitHub releases</a>. Your data is kept.
              </p>
            </div>
          )}
          {notes && (
            <div style={{ padding: 'var(--space-4) var(--space-5) var(--space-5)', borderTop: '1px solid var(--color-rule)' }}>
              <p className="t" style={{ marginBottom: 'var(--space-2)' }}>In this build</p>
              <ul className="prose" style={{ paddingLeft: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                {notes.changes.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}
        </section>

        <section className="panel" aria-labelledby="h-team" data-setting-id="a-team">
          <h2 id="h-team" className="ph">Team</h2>
          {TEAM.map((m) => (
            <Row key={m.name} label={m.name} desc={`${m.role} · ${m.what}`} />
          ))}
        </section>

        <section className="panel" aria-labelledby="h-cred" data-setting-id="a-built-with">
          <h2 id="h-cred" className="ph">Built with</h2>
          <ul style={{ margin: 0, padding: '0 0 var(--space-3)', listStyle: 'none', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))' }}>
            {BUILT_WITH_PACKAGES.map((p) => (
              <li className="row" key={p.name} style={{ borderTop: 0, paddingTop: 'var(--space-2)', paddingBottom: 'var(--space-2)', minHeight: 0 }}>
                <ExtLink href={p.url}>{p.name}</ExtLink>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-ink-3)', fontVariantNumeric: 'tabular-nums' }}>{formatBuiltWithVersion(versions, p.pkg)}</span>
              </li>
            ))}
          </ul>
          <p className="d" style={{ margin: 0, padding: '0 var(--space-5) var(--space-5)' }}>Installed versions in this build.</p>
        </section>

        <section className="panel" aria-labelledby="h-terms" data-setting-id="a-terms">
          <h2 id="h-terms" className="ph">Terms</h2>
          <details>
            <summary className="disc" style={{ padding: 'var(--space-4) var(--space-5)', fontSize: 'var(--text-md)', fontWeight: 500 }}>Terms of use and data handling<Icon d={ICON.chevron} className="chev" /></summary>
            <div className="prose fade" style={{ padding: '0 var(--space-5) var(--space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <p><strong style={{ color: 'var(--color-ink)' }}>Personal use.</strong> Ark is for personal, non-commercial use. It is not affiliated with Valve, Epic Games, Google, Microsoft or Anthropic.</p>
              <p><strong style={{ color: 'var(--color-ink)' }}>Your data.</strong> Library data, play history and preferences stay on this PC. Ark contacts game stores and services (Steam, Epic, HowLongToBeat and others) to fetch game information, which sends the titles or ids being looked up. Usage analytics is off unless you turn it on; when on, app launches and the screen in use (never which game) go to Google Analytics with an anonymous id. If you route an AI role to a cloud provider, the text for that role goes to that provider under its terms.</p>
              <p><strong style={{ color: 'var(--color-ink)' }}>Store data.</strong> Steam, Epic and IGDB metadata is used under their API terms. News comes from public RSS feeds and links back to the publishers.</p>
              <p><strong style={{ color: 'var(--color-ink)' }}>AI.</strong> Recommendations and chat answers are generated and can be wrong. The recommendation model is trained on aggregated, anonymized public review data.</p>
              <p><strong style={{ color: 'var(--color-ink)' }}>No warranty.</strong> Provided as is, and the developers are not liable for damages from using it. Each library above keeps its own license.</p>
            </div>
          </details>
        </section>
      </div>
    </>
  );
});
