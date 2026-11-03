/**
 * Settings → Guide and About (1.0.97 B37): tours with a completed count and Done / Start / Replay,
 * the merged features list and "How the AI works" (copy updated for the built-in AI and the router),
 * and About's version and update states, "In this build" from the changelog data, the team, the
 * libraries with their build-time versions, and the terms.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';

import { GuidePage, GUIDE_TOURS } from '@/components/settings/guide-page';
import { AboutPage, RELEASES_URL } from '@/components/settings/about-page';
import { APP_VERSION, getLatestChangelog } from '@/components/changelog-modal';
import { tourStorageKey } from '@/components/guided-tour';
import { BUILT_WITH_PACKAGES, formatBuiltWithVersion } from '@/lib/built-with-packages';
import { readBuiltWithVersions } from '../../../config/built-with';

describe('Guide: tours', () => {
  beforeEach(() => localStorage.clear());

  it('lists the tours with a count of the completed ones and a Start or Replay button each', () => {
    localStorage.setItem(tourStorageKey('welcome'), 'true');
    const run = vi.fn();
    render(<GuidePage onRunGuidedTour={run} />);
    const total = GUIDE_TOURS.filter((t) => !t.devOnly).length;
    expect(screen.getByText(`1 of ${total}`)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Tours completed' })).toHaveAttribute('aria-valuenow', '11');
    const welcome = screen.getByText('Welcome').closest('.row') as HTMLElement;
    expect(within(welcome).getByText('Done')).toBeInTheDocument();
    fireEvent.click(within(welcome).getByRole('button', { name: 'Replay Welcome tour' }));
    expect(run).toHaveBeenCalledWith('welcome');
    fireEvent.click(screen.getByRole('button', { name: 'Start Browse tour' }));
    expect(run).toHaveBeenCalledWith('browse');
  });

  it('dev-only tours appear only in developer mode', () => {
    render(<GuidePage onRunGuidedTour={vi.fn()} />);
    expect(screen.queryByText('Data Flow')).not.toBeInTheDocument();
    localStorage.setItem('ark-developer-mode', '1');
    render(<GuidePage onRunGuidedTour={vi.fn()} />);
    expect(screen.getAllByText('Data Flow').length).toBeGreaterThan(0);
  });

  it('the settings tour is part of the list and the tour list is the tab panel the tour targets', () => {
    render(<GuidePage onRunGuidedTour={vi.fn()} />);
    expect(screen.getByText('Settings', { selector: 'p' })).toBeInTheDocument();
    expect(document.querySelector('[data-tour="settings-guided-tours"]')).not.toBeNull();
  });
});

describe('Guide: features and how the AI works', () => {
  it('Features merges the old Features tab: what Ark can do, and an FAQ with updated privacy copy', () => {
    render(<GuidePage onRunGuidedTour={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /Features/ }));
    expect(screen.getByRole('heading', { name: 'What Ark can do' })).toBeInTheDocument();
    expect(screen.getByText('Galaxy map')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'How the AI works' })).toBeInTheDocument();
    const privacy = screen.getByText('Is my data private?').closest('details') as HTMLElement;
    const text = privacy.textContent ?? '';
    expect(text).toContain('built-in local AI');
    expect(text).toContain('AI providers');
    expect(text).not.toMatch(/Ollama/);
    expect(screen.getByText('What does AI Chat do?').closest('details')!.textContent).toContain('chat route');
  });

  it('without a tour launcher only the features page is offered', () => {
    render(<GuidePage />);
    expect(screen.queryByRole('tab', { name: /Tours/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What Ark can do' })).toBeInTheDocument();
  });
});

describe('About', () => {
  const updater = { checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), installUpdate: vi.fn() };
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { updater?: unknown }).updater = updater;
  });
  afterEach(() => {
    delete (window as unknown as { updater?: unknown }).updater;
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('shows the running version and "not checked yet", then the latest-build state after a check', async () => {
    updater.checkForUpdates.mockResolvedValue({ updateAvailable: false, currentVersion: APP_VERSION, latestVersion: APP_VERSION });
    render(<AboutPage />);
    expect(screen.getByText(`Ark ${APP_VERSION}`)).toBeInTheDocument();
    expect(screen.getByText('Not checked this session')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('You’re on the latest build')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });

  it('checking shows a busy button, and an update offers Download then Install', async () => {
    let finish: (v: unknown) => void = () => {};
    updater.checkForUpdates.mockReturnValue(new Promise((r) => { finish = r; }));
    render(<AboutPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(screen.getByText('Checking for updates…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Checking' })).toBeDisabled();
    finish({ updateAvailable: true, currentVersion: APP_VERSION, latestVersion: '9.9.9' });
    expect(await screen.findByText('Ark 9.9.9 is ready')).toBeInTheDocument();
    updater.downloadUpdate.mockResolvedValue({ success: true });
    fireEvent.click(screen.getByRole('button', { name: 'Download v9.9.9' }));
    const install = await screen.findByRole('button', { name: 'Install & Restart v9.9.9' });
    fireEvent.click(install);
    expect(updater.installUpdate).toHaveBeenCalledTimes(1);
  });

  it('a failed check says it could not reach GitHub and links to the releases page', async () => {
    updater.checkForUpdates.mockResolvedValue({ error: 'offline', updateAvailable: false, currentVersion: APP_VERSION, latestVersion: '' });
    const open = vi.fn();
    (window as unknown as { electron?: unknown }).electron = { openExternal: open };
    render(<AboutPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Download the latest installer from/)).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('link', { name: 'GitHub releases' }));
    expect(open).toHaveBeenCalledWith(RELEASES_URL);
  });

  it('In this build comes from the changelog data, not from text in the page', () => {
    render(<AboutPage />);
    const notes = getLatestChangelog();
    expect(notes).not.toBeNull();
    const section = screen.getByText('In this build').parentElement as HTMLElement;
    for (const change of notes!.changes) expect(within(section).getByText(change)).toBeInTheDocument();
  });

  it('lists the team, every library with its installed version, and the terms', () => {
    render(<AboutPage />);
    expect(screen.getByText('Pourab Karchaudhuri')).toBeInTheDocument();
    expect(screen.getByText('Sanket Aley')).toBeInTheDocument();
    const built = screen.getByRole('heading', { name: 'Built with' }).closest('section') as HTMLElement;
    for (const p of BUILT_WITH_PACKAGES) expect(within(built).getByText(p.name)).toBeInTheDocument();
    expect(within(built).getAllByText(/^v\d+\.\d+\.\d+/, { selector: 'span' }).length).toBeGreaterThan(10);
    fireEvent.click(screen.getByText('Terms of use and data handling'));
    expect(screen.getByText(/Personal use\./)).toBeInTheDocument();
    expect(screen.getByText(/route an AI role to a cloud provider/)).toBeInTheDocument();
  });

  it('without an updater the version is shown without a check button', () => {
    delete (window as unknown as { updater?: unknown }).updater;
    render(<AboutPage />);
    expect(screen.queryByRole('button', { name: /Check/ })).not.toBeInTheDocument();
    expect(screen.getByText(`Ark ${APP_VERSION}`)).toBeInTheDocument();
  });
});

describe('build-time library versions', () => {
  it('the versions come from node_modules and the manifests, never from typed text', () => {
    const versions = readBuiltWithVersions(process.cwd());
    expect(versions.react).toMatch(/^\d+\.\d+\.\d+/);
    expect(versions.electron).toMatch(/^\d+\.\d+\.\d+/);
    expect(versions.litellm).toMatch(/^\d+\.\d+\.\d+/);
    expect(versions['llama.cpp']).toMatch(/^b\d+/);
    expect(versions['@react-three/fiber']).toMatch(/^\d+\./);
    for (const p of BUILT_WITH_PACKAGES) expect(versions[p.pkg], p.pkg).toBeTruthy();
  });

  it('formats a version with v, leaves a build tag alone, and shows nothing for an unknown one', () => {
    expect(formatBuiltWithVersion({ react: '18.3.1' }, 'react')).toBe('v18.3.1');
    expect(formatBuiltWithVersion({ 'llama.cpp': 'b11780' }, 'llama.cpp')).toBe('b11780');
    expect(formatBuiltWithVersion({}, 'react')).toBe('');
    expect(formatBuiltWithVersion(undefined, 'react')).toBe('');
  });

  it('the page reads the version the build injected', async () => {
    render(<AboutPage />);
    await waitFor(() => expect(within(screen.getByRole('heading', { name: 'Built with' }).closest('section') as HTMLElement).getByText(`v${__BUILT_WITH__.react}`)).toBeInTheDocument());
  });
});
