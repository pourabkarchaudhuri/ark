/**
 * Audit FindingCard actions: "Open it" goes through the narrow steam:launchGame
 * IPC (steam: is not on the openExternal allowlist) and toasts on failure;
 * "Choose executable" shows a picker rejection and leaves the finding open.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import { FindingCard, type Finding } from '@/components/journey-audit-view';
import { libraryStore } from '@/services/library-store';

vi.mock('@/services/library-store', () => ({
  libraryStore: {
    getEntry: vi.fn(),
    updateEntry: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  },
}));

const launchFinding: Finding = {
  key: 'no-playtime:steam-730',
  ruleId: 'no-playtime',
  area: 'accuracy',
  subjectId: 'steam-730',
  title: 'Counter-Strike 2',
  question: 'No hours stored?',
  detail: '',
  resolution: 'launch',
};

const exeFinding: Finding = {
  key: 'missing-exe:steam-730',
  ruleId: 'missing-exe',
  area: 'completion',
  subjectId: 'steam-730',
  title: 'Counter-Strike 2',
  question: 'No executable path stored?',
  detail: '',
  resolution: 'exe',
};

function renderCard(finding: Finding, onResolve = vi.fn()) {
  render(
    <ToastProvider>
      <FindingCard
        finding={finding}
        rollup={undefined}
        onResolve={onResolve}
        onSnooze={vi.fn()}
        onDismiss={vi.fn()}
      />
    </ToastProvider>,
  );
  return { onResolve };
}

function setWindow(key: 'electron' | 'fileDialog', value: unknown) {
  Object.defineProperty(window, key, { value, writable: true, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  setWindow('electron', undefined);
  setWindow('fileDialog', undefined);
});

describe('FindingCard — Open it', () => {
  it('launches via launchSteamGame with the numeric appId, not openExternal', async () => {
    const launchSteamGame = vi.fn(async () => ({ success: true }));
    const openExternal = vi.fn();
    setWindow('electron', { launchSteamGame, openExternal });
    renderCard(launchFinding);

    fireEvent.click(screen.getByText('Open it'));
    await waitFor(() => expect(launchSteamGame).toHaveBeenCalledWith(730));
    expect(openExternal).not.toHaveBeenCalled();
    expect(screen.queryByText('Steam is not installed or could not be opened')).toBeNull();
  });

  it('shows a toast when the launch fails', async () => {
    setWindow('electron', { launchSteamGame: vi.fn(async () => ({ success: false, error: 'x' })) });
    renderCard(launchFinding);

    fireEvent.click(screen.getByText('Open it'));
    expect(await screen.findByText('Steam is not installed or could not be opened')).toBeTruthy();
  });
});

describe('FindingCard — Choose executable', () => {
  it('shows the picker error and keeps the finding open', async () => {
    const error = "Pick the game's .exe (shortcuts and .bat/.cmd files cannot be tracked)";
    setWindow('fileDialog', { selectExecutable: vi.fn(async () => ({ success: false, error })) });
    const { onResolve } = renderCard(exeFinding);

    fireEvent.click(screen.getByText('Choose executable'));
    expect(await screen.findByText(error)).toBeTruthy();
    expect(onResolve).not.toHaveBeenCalled();
    expect(libraryStore.updateEntry).not.toHaveBeenCalled();
  });

  it('stores the path and resolves on success', async () => {
    setWindow('fileDialog', {
      selectExecutable: vi.fn(async () => ({ success: true, filePath: 'C:\\Games\\cs2.exe' })),
    });
    const { onResolve } = renderCard(exeFinding);

    fireEvent.click(screen.getByText('Choose executable'));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(exeFinding, 'Executable path stored'));
    expect(libraryStore.updateEntry).toHaveBeenCalledWith('steam-730', { executablePath: 'C:\\Games\\cs2.exe' });
  });
});
