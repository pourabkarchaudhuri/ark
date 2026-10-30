/**
 * Settings > About update control: never offers "Download v<installed>" once an update is
 * downloading/downloaded, and switches to Install after its own download.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AboutUpdateButton, useAboutUpdate } from '@/components/settings/about-update';

const mockUpdater = {
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(),
};

function Harness() {
  const update = useAboutUpdate();
  return (
    <div>
      <AboutUpdateButton update={update} />
      <span data-testid="state">{update.state}</span>
      {update.error && <span data-testid="error">{update.error}</span>}
    </div>
  );
}

describe('About update control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { updater: typeof mockUpdater }).updater = mockUpdater;
  });

  afterEach(() => {
    delete (window as unknown as { updater?: typeof mockUpdater }).updater;
  });

  it('check while an update is already downloaded offers Install for the real new version', async () => {
    mockUpdater.checkForUpdates.mockResolvedValue({
      updateAvailable: true,
      currentVersion: '1.0.96',
      latestVersion: '1.0.97',
      status: 'downloaded',
    });
    render(<Harness />);
    fireEvent.click(screen.getByText('Check for Updates'));
    const install = await screen.findByText('Install & Restart v1.0.97');
    expect(screen.queryByText(/Download v/)).not.toBeInTheDocument();
    fireEvent.click(install);
    expect(mockUpdater.installUpdate).toHaveBeenCalledTimes(1);
  });

  it('check while a download is running shows a disabled Downloading… button', async () => {
    mockUpdater.checkForUpdates.mockResolvedValue({
      updateAvailable: true,
      currentVersion: '1.0.96',
      latestVersion: '1.0.97',
      status: 'downloading',
    });
    render(<Harness />);
    fireEvent.click(screen.getByText('Check for Updates'));
    const btn = await screen.findByText('Downloading…');
    expect(btn.closest('button')).toBeDisabled();
  });

  it('Download → Downloading… → Install & Restart after the download resolves', async () => {
    mockUpdater.checkForUpdates.mockResolvedValue({ updateAvailable: true, currentVersion: '1.0.96', latestVersion: '1.0.97' });
    let finish: (v: unknown) => void = () => undefined;
    mockUpdater.downloadUpdate.mockReturnValue(new Promise((r) => { finish = r; }));
    render(<Harness />);
    fireEvent.click(screen.getByText('Check for Updates'));
    fireEvent.click(await screen.findByText('Download v1.0.97'));
    expect(await screen.findByText('Downloading…')).toBeInTheDocument();
    finish({ success: true, status: 'downloaded' });
    fireEvent.click(await screen.findByText('Install & Restart v1.0.97'));
    expect(mockUpdater.installUpdate).toHaveBeenCalledTimes(1);
  });

  it('a duplicate download request (another download running) stays on Downloading…', async () => {
    mockUpdater.checkForUpdates.mockResolvedValue({ updateAvailable: true, currentVersion: '1.0.96', latestVersion: '1.0.97' });
    mockUpdater.downloadUpdate.mockResolvedValue({ success: true, status: 'downloading' });
    render(<Harness />);
    fireEvent.click(screen.getByText('Check for Updates'));
    fireEvent.click(await screen.findByText('Download v1.0.97'));
    await waitFor(() => expect(mockUpdater.downloadUpdate).toHaveBeenCalled());
    expect(await screen.findByText('Downloading…')).toBeInTheDocument();
    expect(screen.queryByText(/Install & Restart/)).not.toBeInTheDocument();
  });

  it('a failed download shows the hint and the error state', async () => {
    mockUpdater.checkForUpdates.mockResolvedValue({ updateAvailable: true, currentVersion: '1.0.96', latestVersion: '1.0.97' });
    mockUpdater.downloadUpdate.mockResolvedValue({ success: false, error: 'boom', hint: 'Check your connection.' });
    render(<Harness />);
    fireEvent.click(screen.getByText('Check for Updates'));
    fireEvent.click(await screen.findByText('Download v1.0.97'));
    expect(await screen.findByTestId('error')).toHaveTextContent('Check your connection.');
    expect(screen.getByTestId('state')).toHaveTextContent('error');
    expect(screen.getByText('Check for Updates')).toBeInTheDocument();
  });

  it('up to date shows the latest state', async () => {
    mockUpdater.checkForUpdates.mockResolvedValue({ updateAvailable: false, currentVersion: '1.0.97', latestVersion: '1.0.97' });
    render(<Harness />);
    fireEvent.click(screen.getByText('Check for Updates'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('latest'));
  });
});
