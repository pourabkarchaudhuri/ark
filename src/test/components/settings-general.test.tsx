/**
 * Settings → General (1.0.97 B37): grouped rows, the first-load skeleton, switches that roll back
 * when main refuses, the overlay hotkey rows and warning, search across every page with its
 * no-match state, Roomy/Dense, and every gg.deals key state of the StatesSystem board.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { useState } from 'react';

vi.mock('@/services/library-store', () => ({ libraryStore: { getLastImportSnapshot: vi.fn(() => null) } }));
vi.mock('@/services/game-service', () => ({ gameService: {} }));
vi.mock('@/components/year-wrapped', () => ({ YearWrapped: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div role="dialog" aria-label="Ark Wrapped" /> : null) }));

import { GeneralPage, type Density } from '@/components/settings/general-page';
import { ggDealsService } from '@/services/ggdeals-service';
import { settle } from './settings-fixtures';

const win = window as unknown as { settings?: Record<string, unknown>; analytics?: Record<string, unknown>; ggdeals?: Record<string, unknown> };

function installSettings(over: Record<string, unknown> = {}) {
  const s = {
    getAutoLaunch: vi.fn(async () => true),
    setAutoLaunch: vi.fn(async () => ({ success: true })),
    getOverlayEnabled: vi.fn(async () => false),
    setOverlayEnabled: vi.fn(async () => ({ success: true })),
    getOverlayCycleHotkeyRegistered: vi.fn(async () => true),
    getBetaFeatures: vi.fn(async () => false),
    setBetaFeatures: vi.fn(async () => ({ success: true })),
    ...over,
  };
  win.settings = s;
  return s;
}

function Harness({ onNavigate = vi.fn(), onToast = vi.fn(), initial = '' }: { onNavigate?: (...a: unknown[]) => void; onToast?: (t: unknown) => void; initial?: string }) {
  const [query, setQuery] = useState(initial);
  const [density, setDensity] = useState<Density>('roomy');
  return <GeneralPage query={query} onQuery={setQuery} density={density} onDensity={setDensity} onToast={onToast} onNavigate={onNavigate} />;
}

async function renderLoaded(props: Parameters<typeof Harness>[0] = {}) {
  const view = render(<Harness {...props} />);
  await settle(act);
  return view;
}

beforeEach(() => {
  localStorage.clear();
  installSettings();
  win.analytics = { getEnabled: vi.fn(async () => false), setEnabled: vi.fn(async () => ({ success: true })) };
});
afterEach(() => {
  delete win.settings;
  delete win.analytics;
  delete win.ggdeals;
  ggDealsService.settingsChanged();
});

describe('rows and groups', () => {
  it('shows the design groups with their rows and no dead switches', async () => {
    await renderLoaded();
    for (const g of ['Launch and status', 'In-game overlay', 'Content and prices', 'Privacy', 'Library data', 'Experimental']) {
      expect(screen.getByRole('heading', { name: g })).toBeInTheDocument();
    }
    for (const label of ['Launch on startup', 'Auto On Hold', 'Auto Playing', 'Show the overlay', 'Allow adult content', 'HowLongToBeat times', 'Usage analytics', 'Beta features', 'Developer mode']) {
      expect(screen.getByRole('switch', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Open/ })).toBeInTheDocument();
  });

  it('first load: a skeleton with aria-busy until main has answered', async () => {
    let release: (v: boolean) => void = () => {};
    installSettings({ getAutoLaunch: vi.fn(() => new Promise<boolean>((r) => { release = r; })) });
    render(<Harness />);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole('switch', { name: 'Launch on startup' })).not.toBeInTheDocument();
    await act(async () => { release(true); await Promise.resolve(); });
    await settle(act);
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.getByRole('switch', { name: 'Launch on startup' })).toHaveAttribute('aria-checked', 'true');
  });

  it('Launch on startup rolls back when main reports success:false', async () => {
    const s = installSettings({ setAutoLaunch: vi.fn(async () => ({ success: false, error: 'x' })) });
    await renderLoaded();
    const sw = screen.getByRole('switch', { name: 'Launch on startup' });
    await act(async () => { fireEvent.click(sw); });
    expect(s.setAutoLaunch).toHaveBeenCalledWith(false);
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
  });

  it('the status rules and HowLongToBeat keep their own stored settings', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('switch', { name: 'Auto On Hold' }));
    expect(localStorage.getItem('ark:autoOnHoldTransition')).toBe('false');
    fireEvent.click(screen.getByRole('switch', { name: 'Auto Playing' }));
    expect(localStorage.getItem('ark:autoStatusTransition')).toBe('true');
    expect(screen.getByRole('switch', { name: 'Auto On Hold' })).toHaveAttribute('aria-checked', 'false');
  });

  it('usage analytics is main-backed, off by default, and rolls back on a failed save', async () => {
    win.analytics = { getEnabled: vi.fn(async () => false), setEnabled: vi.fn(async () => ({ success: false })) };
    await renderLoaded();
    const sw = screen.getByRole('switch', { name: 'Usage analytics' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await act(async () => { fireEvent.click(sw); });
    expect(win.analytics!.setEnabled).toHaveBeenCalledWith(true);
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'));
  });

  it('overlay: hotkey row always, a warning only when the cycle hotkey failed to bind', async () => {
    await renderLoaded();
    expect(screen.getByText(/show or hide/)).toBeInTheDocument();
    expect(screen.queryByText(/is used by another app, so cycling is off/)).not.toBeInTheDocument();
    cleanupAndReinstall();
    installSettings({ getOverlayCycleHotkeyRegistered: vi.fn(async () => false) });
    await renderLoaded();
    expect(screen.getByText(/is used by another app, so cycling is off/)).toBeInTheDocument();
  });

  it('Ark Wrapped opens its experience', async () => {
    await renderLoaded();
    expect(screen.queryByRole('dialog', { name: 'Ark Wrapped' })).not.toBeInTheDocument();
    const row = screen.getByText('Ark Wrapped').closest('.row') as HTMLElement;
    fireEvent.click(within(row).getByRole('button'));
    expect(screen.getByRole('dialog', { name: 'Ark Wrapped' })).toBeInTheDocument();
  });
});

function cleanupAndReinstall() {
  document.body.innerHTML = '';
}

describe('search and density', () => {
  it('typing filters across every page, shows the count and live switches for General rows', async () => {
    await renderLoaded({ initial: 'overlay' });
    expect(screen.getByRole('heading', { name: 'Results' })).toBeInTheDocument();
    expect(screen.getByText(/1 across all sections/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Show the overlay' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Launch and status' })).not.toBeInTheDocument();
  });

  it('a result on another page opens it at that row', async () => {
    const onNavigate = vi.fn();
    await renderLoaded({ initial: 'rebuild', onNavigate });
    const row = screen.getByText('Rebuild everything').closest('.row') as HTMLElement;
    expect(within(row).getByText('Game understanding')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: /Open/ }));
    expect(onNavigate).toHaveBeenCalledWith('understanding', 'u-rebuild-all');
  });

  it('a result switch changes the setting like the row does', async () => {
    await renderLoaded({ initial: 'adult' });
    const sw = screen.getByRole('switch', { name: 'Allow adult content' });
    const before = sw.getAttribute('aria-checked');
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).not.toBe(before);
  });

  it('no match says so and suggests words that work', async () => {
    await renderLoaded({ initial: 'warp drive' });
    expect(screen.getByText(/Nothing matches/)).toHaveTextContent('Nothing matches “warp drive”. Try “key”, “overlay”, “backup” or “rebuild”.');
    expect(screen.getByText(/0 across all sections/)).toBeInTheDocument();
  });

  it('clearing the box brings the groups back', async () => {
    await renderLoaded();
    const box = screen.getByRole('searchbox', { name: /Search all settings/ });
    fireEvent.change(box, { target: { value: 'key' } });
    expect(screen.getByRole('heading', { name: 'Results' })).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.getByRole('heading', { name: 'Launch and status' })).toBeInTheDocument();
  });

  it('Roomy and Dense are a pressed pair and Dense marks the groups', async () => {
    await renderLoaded();
    expect(screen.getByRole('button', { name: 'Roomy' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('.dense')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dense' }));
    expect(screen.getByRole('button', { name: 'Dense' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Roomy' })).toHaveAttribute('aria-pressed', 'false');
    expect(document.querySelector('.dense')).not.toBeNull();
  });
});

describe('gg.deals key states', () => {
  function installGg(over: Record<string, unknown> = {}) {
    const g = {
      hasKey: vi.fn(async () => false),
      setKey: vi.fn(async () => ({ success: true })),
      clearKey: vi.fn(async () => ({ success: true })),
      testKey: vi.fn(async () => ({ ok: true })),
      getPrices: vi.fn(async () => ({ prices: {} })),
      ...over,
    };
    win.ggdeals = g;
    return g;
  }
  const ggRow = () => screen.getByText('gg.deals prices').closest('.row') as HTMLElement;

  it('no key: a No key chip and Set up', async () => {
    installGg();
    await renderLoaded();
    expect(within(ggRow()).getByText('No key')).toBeInTheDocument();
    expect(within(ggRow()).getByRole('button', { name: 'Set up' })).toBeInTheDocument();
  });

  it('first load shows a placeholder row until the key state is known', async () => {
    installGg({ hasKey: vi.fn(() => new Promise(() => {})) });
    await renderLoaded();
    expect(document.querySelector('.row[aria-busy="true"]')).not.toBeNull();
  });

  it('saved and working: saving tests the key and shows Connected', async () => {
    const g = installGg();
    await renderLoaded();
    fireEvent.click(within(ggRow()).getByRole('button', { name: 'Set up' }));
    fireEvent.change(screen.getByLabelText('gg.deals API key'), { target: { value: 'ggkey-12345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(g.setKey).toHaveBeenCalledWith('ggkey-12345678'));
    expect(await screen.findByText('Key saved and working.')).toBeInTheDocument();
    expect(within(ggRow()).getByText('Connected')).toBeInTheDocument();
  });

  it('rejected by gg.deals', async () => {
    installGg({ hasKey: vi.fn(async () => true), testKey: vi.fn(async () => ({ ok: false, error: 'invalid-key' })) });
    await renderLoaded();
    fireEvent.click(within(ggRow()).getByRole('button', { name: 'Manage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText(/gg.deals rejected this key/)).toBeInTheDocument();
    expect(within(ggRow()).getByText('Rejected')).toBeInTheDocument();
  });

  it('unreachable', async () => {
    installGg({ hasKey: vi.fn(async () => true), testKey: vi.fn(async () => ({ ok: false, error: 'unavailable' })) });
    await renderLoaded();
    fireEvent.click(within(ggRow()).getByRole('button', { name: 'Manage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText(/could not be reached to check the key/)).toBeInTheDocument();
    expect(within(ggRow()).getByText('Unreachable')).toBeInTheDocument();
  });

  it('tested too recently', async () => {
    installGg({ hasKey: vi.fn(async () => true), testKey: vi.fn(async () => ({ ok: false, error: 'wait' })) });
    await renderLoaded();
    fireEvent.click(within(ggRow()).getByRole('button', { name: 'Manage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText(/wait a few seconds/)).toBeInTheDocument();
    expect(within(ggRow()).getByText('Wait a moment')).toBeInTheDocument();
  });

  it('removing the key hides prices and goes back to No key; region and resellers are stored', async () => {
    const g = installGg({ hasKey: vi.fn(async () => true) });
    await renderLoaded();
    fireEvent.click(within(ggRow()).getByRole('button', { name: 'Manage' }));
    fireEvent.change(screen.getByLabelText('Price region'), { target: { value: 'gb' } });
    expect(localStorage.getItem('ark:ggdealsRegion')).toBe('gb');
    fireEvent.click(screen.getByRole('switch', { name: 'Show key reseller prices' }));
    expect(localStorage.getItem('ark:ggdealsKeyshops')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(g.clearKey).toHaveBeenCalled());
    expect(await screen.findByText('Key removed. Prices are hidden.')).toBeInTheDocument();
    expect(within(ggRow()).getByText('No key')).toBeInTheDocument();
  });

  it('a short key cannot be saved', async () => {
    installGg();
    await renderLoaded();
    fireEvent.click(within(ggRow()).getByRole('button', { name: 'Set up' }));
    fireEvent.change(screen.getByLabelText('gg.deals API key'), { target: { value: 'short' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('without the desktop bridge the row is not shown', async () => {
    await renderLoaded();
    expect(screen.queryByText('gg.deals prices')).not.toBeInTheDocument();
  });
});

describe('gg.deals wait result (1.0.98 F5)', () => {
  it('saving a key right after a test says to wait, not that gg.deals could not be reached', async () => {
    const g = { hasKey: vi.fn(async () => false), setKey: vi.fn(async () => ({ success: true })), clearKey: vi.fn(async () => ({ success: true })), testKey: vi.fn(async () => ({ ok: false, error: 'wait' })), getPrices: vi.fn(async () => ({ prices: {} })) };
    win.ggdeals = g;
    await renderLoaded();
    const row = screen.getByText('gg.deals prices').closest('.row') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Set up' }));
    fireEvent.change(screen.getByLabelText('gg.deals API key'), { target: { value: 'ggkey-12345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Please wait a few seconds, then press Test/)).toBeInTheDocument();
    expect(screen.queryByText(/could not be reached/)).not.toBeInTheDocument();
    expect(within(row).getByText('Wait a moment')).toBeInTheDocument();
  });
});
