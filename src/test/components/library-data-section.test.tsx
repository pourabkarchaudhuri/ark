/**
 * v1.0.97 B16 — Settings → Library Data: import asks before it replaces anything.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const plan = {
  entries: [],
  sessionHistory: [],
  counts: { currentGames: 4, fileGames: 2, currentCustomGames: 1, fileCustomGames: null },
};

vi.mock('@/services/library-store', () => ({
  libraryStore: {
    parseImport: vi.fn(() => ({ success: true, plan })),
    applyImport: vi.fn(() => ({ success: true, count: 2, customCount: 1 })),
    importData: vi.fn(),
    exportData: vi.fn(() => '{}'),
    getSize: vi.fn(() => 4),
    getLastImportSnapshot: vi.fn(() => null),
    restoreLastImportSnapshot: vi.fn(() => ({ success: true, count: 4, customCount: 1 })),
  },
}));

vi.mock('@/services/game-service', () => ({
  gameService: { backfillLibraryMissingCachedMeta: vi.fn(() => Promise.resolve()) },
}));

import { libraryStore } from '@/services/library-store';
import { LibraryDataSection, describeImportPlan } from '@/components/settings/library-data-section';

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'fileDialog', {
    value: { openFile: vi.fn(async () => ({ success: true, content: '{"entries":[]}' })), saveFile: vi.fn() },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window, 'fileDialog', { value: undefined, writable: true, configurable: true });
});

describe('describeImportPlan', () => {
  it('states what is replaced and what is kept, with counts', () => {
    const text = describeImportPlan(plan as never);
    expect(text).toContain('This replaces your library: 4 games now, 2 in the file.');
    expect(text).toContain('your 1 custom game stay');
    expect(text).toContain('Your sessions will be replaced');
    expect(text).toContain('The file has no journey, status history, so yours stay');
  });
});

describe('LibraryDataSection import', () => {
  it('opens a confirm dialog and applies only after confirm', async () => {
    render(<LibraryDataSection />);
    fireEvent.click(screen.getByText('Import Library'));
    await screen.findByText('Replace your library?');
    expect(libraryStore.parseImport).toHaveBeenCalledWith('{"entries":[]}');
    expect(libraryStore.applyImport).not.toHaveBeenCalled();
    expect(libraryStore.importData).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Replace library'));
    await waitFor(() => expect(libraryStore.applyImport).toHaveBeenCalledTimes(1));
    await screen.findByText('Imported 2 games and 1 custom game');
  });

  it('cancel leaves the store untouched', async () => {
    render(<LibraryDataSection />);
    fireEvent.click(screen.getByText('Import Library'));
    await screen.findByText('Replace your library?');
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText('Replace your library?')).toBeNull());
    expect(libraryStore.applyImport).not.toHaveBeenCalled();
    expect(libraryStore.importData).not.toHaveBeenCalled();
  });

  it('the help text no longer claims import merges', () => {
    render(<LibraryDataSection />);
    expect(screen.queryByText(/merges/i)).toBeNull();
    expect(screen.getByText(/Import replaces your library/)).toBeTruthy();
  });
});
