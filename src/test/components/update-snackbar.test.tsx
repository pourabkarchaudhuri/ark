import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { UpdateSnackbar } from '@/components/update-snackbar';

// Mock the window.updater API
const mockUpdater = {
  checkForUpdates: vi.fn().mockResolvedValue({ updateAvailable: false }),
  downloadUpdate: vi.fn().mockResolvedValue(undefined),
  installUpdate: vi.fn().mockResolvedValue(undefined),
  getVersion: vi.fn().mockResolvedValue('1.0.0'),
  onChecking: vi.fn(),
  onUpdateAvailable: vi.fn(),
  onUpdateNotAvailable: vi.fn(),
  onDownloadProgress: vi.fn(),
  onUpdateDownloaded: vi.fn(),
  onError: vi.fn(),
  onAutoDownload: vi.fn(),
  removeAllListeners: vi.fn(),
};

describe('UpdateSnackbar', () => {
  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();
    
    // Set up the mock updater
    (window as unknown as { updater: typeof mockUpdater }).updater = mockUpdater;
  });

  afterEach(() => {
    // Clean up
    delete (window as unknown as { updater?: typeof mockUpdater }).updater;
  });

  it('does not render when no update is available', () => {
    render(<UpdateSnackbar />);
    
    // Should not show any update UI initially
    expect(screen.queryByText('Update Available')).not.toBeInTheDocument();
  });

  it('registers event listeners on mount', () => {
    render(<UpdateSnackbar />);
    
    expect(mockUpdater.onChecking).toHaveBeenCalled();
    expect(mockUpdater.onUpdateAvailable).toHaveBeenCalled();
    expect(mockUpdater.onUpdateNotAvailable).toHaveBeenCalled();
    expect(mockUpdater.onDownloadProgress).toHaveBeenCalled();
    expect(mockUpdater.onUpdateDownloaded).toHaveBeenCalled();
    expect(mockUpdater.onError).toHaveBeenCalled();
  });

  it('removes event listeners on unmount', () => {
    const { unmount } = render(<UpdateSnackbar />);
    
    unmount();
    
    expect(mockUpdater.removeAllListeners).toHaveBeenCalled();
  });

  it('shows update available notification when update is found', async () => {
    render(<UpdateSnackbar />);
    
    // Simulate update available event
    const onUpdateAvailableCallback = mockUpdater.onUpdateAvailable.mock.calls[0][0];
    await act(async () => {
      onUpdateAvailableCallback({ version: '2.0.0', releaseDate: '2026-01-30' });
    });
    
    expect(screen.getByText('Update Available')).toBeInTheDocument();
    expect(screen.getByText(/Version 2.0.0 is available/)).toBeInTheDocument();
    expect(screen.getByText('Download Now')).toBeInTheDocument();
    expect(screen.getByText('Later')).toBeInTheDocument();
  });

  it('starts download when Download Now is clicked', async () => {
    mockUpdater.downloadUpdate.mockResolvedValue({ success: true });
    
    render(<UpdateSnackbar />);
    
    // Simulate update available
    const onUpdateAvailableCallback = mockUpdater.onUpdateAvailable.mock.calls[0][0];
    await act(async () => {
      onUpdateAvailableCallback({ version: '2.0.0' });
    });
    
    expect(screen.getByText('Download Now')).toBeInTheDocument();
    
    // Click download
    await act(async () => {
      fireEvent.click(screen.getByText('Download Now'));
    });
    
    expect(mockUpdater.downloadUpdate).toHaveBeenCalled();
  });

  it('dismisses notification when Later is clicked', async () => {
    render(<UpdateSnackbar />);
    
    // Simulate update available
    const onUpdateAvailableCallback = mockUpdater.onUpdateAvailable.mock.calls[0][0];
    await act(async () => {
      onUpdateAvailableCallback({ version: '2.0.0' });
    });
    
    expect(screen.getByText('Update Available')).toBeInTheDocument();
    
    // Click Later
    await act(async () => {
      fireEvent.click(screen.getByText('Later'));
    });
    
    expect(screen.queryByText('Update Available')).not.toBeInTheDocument();
  });

  it('shows download progress', async () => {
    render(<UpdateSnackbar />);
    
    // Simulate update available first
    const onUpdateAvailableCallback = mockUpdater.onUpdateAvailable.mock.calls[0][0];
    await act(async () => {
      onUpdateAvailableCallback({ version: '2.0.0' });
    });
    
    // Simulate download progress
    const onDownloadProgressCallback = mockUpdater.onDownloadProgress.mock.calls[0][0];
    await act(async () => {
      onDownloadProgressCallback({
        percent: 50,
        bytesPerSecond: 1024 * 1024,
        transferred: 50 * 1024 * 1024,
        total: 100 * 1024 * 1024,
      });
    });
    
    expect(screen.getByText('Downloading Update')).toBeInTheDocument();
    expect(screen.getByText(/Downloading... 50%/)).toBeInTheDocument();
  });

  it('shows ready to install state after download', async () => {
    render(<UpdateSnackbar />);
    
    // Simulate update downloaded
    const onUpdateDownloadedCallback = mockUpdater.onUpdateDownloaded.mock.calls[0][0];
    await act(async () => {
      onUpdateDownloadedCallback({ version: '2.0.0' });
    });
    
    expect(screen.getByText('Ready to Install')).toBeInTheDocument();
    expect(screen.getByText(/Version 2.0.0 is ready/)).toBeInTheDocument();
    expect(screen.getByText('Install Now')).toBeInTheDocument();
  });

  it('calls installUpdate when Install Now is clicked', async () => {
    render(<UpdateSnackbar />);
    
    // Simulate update downloaded
    const onUpdateDownloadedCallback = mockUpdater.onUpdateDownloaded.mock.calls[0][0];
    await act(async () => {
      onUpdateDownloadedCallback({ version: '2.0.0' });
    });
    
    expect(screen.getByText('Install Now')).toBeInTheDocument();
    
    // Click install
    await act(async () => {
      fireEvent.click(screen.getByText('Install Now'));
    });
    
    expect(mockUpdater.installUpdate).toHaveBeenCalled();
  });

  it('shows error state on update error', async () => {
    render(<UpdateSnackbar />);
    
    // Simulate error
    const onErrorCallback = mockUpdater.onError.mock.calls[0][0];
    await act(async () => {
      onErrorCallback({ message: 'Network error' });
    });
    
    expect(screen.getByText('Update Error')).toBeInTheDocument();
    expect(screen.getByText('Network error')).toBeInTheDocument();
  });

  it('shows the error code and hint sent by the main process', async () => {
    render(<UpdateSnackbar />);
    const onErrorCallback = mockUpdater.onError.mock.calls[0][0];
    await act(async () => {
      onErrorCallback({ message: 'net::ERR_CONNECTION_RESET', code: 'ERR_CONNECTION_RESET', kind: 'network-reset', hint: 'The connection was cut mid-download.' });
    });
    expect(screen.getByText('ERR_CONNECTION_RESET')).toBeInTheDocument();
    expect(screen.getByText('The connection was cut mid-download.')).toBeInTheDocument();
    expect(screen.getByText('Copy link')).toBeInTheDocument();
  });

  it('a failed download shows that attempt\'s error, not a stale one from before', async () => {
    mockUpdater.downloadUpdate.mockResolvedValue({ success: false, error: 'second failure', kind: 'network-timeout', hint: 'The download timed out.' });
    render(<UpdateSnackbar />);
    const onErrorCallback = mockUpdater.onError.mock.calls[0][0];
    await act(async () => {
      onErrorCallback({ message: 'first failure' });
    });
    const onUpdateAvailableCallback = mockUpdater.onUpdateAvailable.mock.calls[0][0];
    await act(async () => {
      onUpdateAvailableCallback({ version: '2.0.0' });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Download Now'));
    });
    expect(screen.getByText('second failure')).toBeInTheDocument();
    expect(screen.queryByText('first failure')).not.toBeInTheDocument();
    expect(screen.getByText('The download timed out.')).toBeInTheDocument();
  });

  it('offers the alternate download and reports a verified installer', async () => {
    const fallbackDownload = vi.fn().mockResolvedValue({ success: true, launched: true });
    (window as unknown as { updater: Record<string, unknown> }).updater = { ...mockUpdater, fallbackDownload };
    render(<UpdateSnackbar />);
    const onErrorCallback = mockUpdater.onError.mock.calls[0][0];
    await act(async () => {
      onErrorCallback({ message: 'reset', kind: 'network-reset' });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Try alternate download'));
    });
    expect(fallbackDownload).toHaveBeenCalled();
    expect(screen.getByText(/downloaded and verified/)).toBeInTheDocument();
  });

  it('hides the alternate download when the network is blocking it', async () => {
    (window as unknown as { updater: Record<string, unknown> }).updater = { ...mockUpdater, fallbackDownload: vi.fn() };
    render(<UpdateSnackbar />);
    const onErrorCallback = mockUpdater.onError.mock.calls[0][0];
    await act(async () => {
      onErrorCallback({ message: 'blocked', kind: 'blocked-by-client' });
    });
    expect(screen.queryByText('Try alternate download')).not.toBeInTheDocument();
    expect(screen.getByText('Download from GitHub')).toBeInTheDocument();
  });

  it('a check that could not reach GitHub is reported, not shown as "up to date"', async () => {
    mockUpdater.checkForUpdates.mockResolvedValueOnce({ updateAvailable: false, currentVersion: '1', latestVersion: '1', error: 'x', hint: 'Could not reach github.com.' });
    render(<UpdateSnackbar />);
    await waitFor(() => expect(screen.getByText("Couldn't reach GitHub")).toBeInTheDocument());
    expect(screen.getByText('Could not reach github.com.')).toBeInTheDocument();
  });

  it('does not render when updater API is not available', () => {
    // Remove the updater
    delete (window as unknown as { updater?: typeof mockUpdater }).updater;
    
    const { container } = render(<UpdateSnackbar />);
    
    expect(container.firstChild).toBeNull();
  });
});
