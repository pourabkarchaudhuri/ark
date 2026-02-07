/**
 * Tests for useInstalledGames hook
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useInstalledGames, checkGameInstalled } from '@/hooks/useInstalledGames';

// Mock the window.installedGames API
const mockInstalledGamesAPI = {
  getInstalled: vi.fn(),
  getInstalledAppIds: vi.fn(),
  clearCache: vi.fn(),
};

describe('useInstalledGames', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Setup the mock API
    (window as any).installedGames = mockInstalledGamesAPI;
  });

  afterEach(() => {
    delete (window as any).installedGames;
  });

  it('returns empty set when not in Electron environment', async () => {
    delete (window as any).installedGames;
    
    const { result } = renderHook(() => useInstalledGames());
    
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    
    expect(result.current.installedAppIds.size).toBe(0);
    expect(result.current.installedGames).toEqual([]);
    expect(result.current.error).toBe(null);
  });

  it('fetches installed games on mount', async () => {
    const mockAppIds = [730, 570, 440];
    const mockGames = [
      { appId: 730, name: 'Counter-Strike 2', installPath: 'C:\\Steam\\steamapps\\common\\Counter-Strike 2', platform: 'steam' },
      { appId: 570, name: 'Dota 2', installPath: 'C:\\Steam\\steamapps\\common\\dota 2 beta', platform: 'steam' },
      { appId: 440, name: 'Team Fortress 2', installPath: 'C:\\Steam\\steamapps\\common\\Team Fortress 2', platform: 'steam' },
    ];
    
    mockInstalledGamesAPI.getInstalledAppIds.mockResolvedValue(mockAppIds);
    mockInstalledGamesAPI.getInstalled.mockResolvedValue(mockGames);
    
    const { result } = renderHook(() => useInstalledGames());
    
    expect(result.current.loading).toBe(true);
    
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    
    expect(result.current.installedAppIds.size).toBe(3);
    expect(result.current.installedAppIds.has(730)).toBe(true);
    expect(result.current.installedAppIds.has(570)).toBe(true);
    expect(result.current.installedAppIds.has(440)).toBe(true);
    expect(result.current.installedGames).toEqual(mockGames);
  });

  it('isInstalled returns correct value', async () => {
    const mockAppIds = [730, 570];
    mockInstalledGamesAPI.getInstalledAppIds.mockResolvedValue(mockAppIds);
    mockInstalledGamesAPI.getInstalled.mockResolvedValue([]);
    
    const { result } = renderHook(() => useInstalledGames());
    
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    
    expect(result.current.isInstalled(730)).toBe(true);
    expect(result.current.isInstalled(570)).toBe(true);
    expect(result.current.isInstalled(999)).toBe(false);
  });

  it('handles API errors gracefully', async () => {
    mockInstalledGamesAPI.getInstalledAppIds.mockRejectedValue(new Error('Scan failed'));
    
    const { result } = renderHook(() => useInstalledGames());
    
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    
    expect(result.current.error).toBe('Scan failed');
    expect(result.current.installedAppIds.size).toBe(0);
  });

  it('refresh function forces a new scan', async () => {
    const mockAppIds = [730];
    mockInstalledGamesAPI.getInstalledAppIds.mockResolvedValue(mockAppIds);
    mockInstalledGamesAPI.getInstalled.mockResolvedValue([]);
    
    const { result } = renderHook(() => useInstalledGames());
    
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    
    // Clear mocks and setup new return values
    mockInstalledGamesAPI.getInstalledAppIds.mockClear();
    mockInstalledGamesAPI.getInstalledAppIds.mockResolvedValue([730, 570, 440]);
    mockInstalledGamesAPI.getInstalled.mockResolvedValue([]);
    
    // Call refresh
    await act(async () => {
      await result.current.refresh();
    });
    
    // Should have called with forceRefresh = true
    expect(mockInstalledGamesAPI.getInstalled).toHaveBeenCalledWith(true);
    expect(result.current.installedAppIds.size).toBe(3);
  });
});

describe('checkGameInstalled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).installedGames = mockInstalledGamesAPI;
  });

  afterEach(() => {
    delete (window as any).installedGames;
  });

  it('returns true for installed game', async () => {
    mockInstalledGamesAPI.getInstalledAppIds.mockResolvedValue([730, 570]);
    
    const result = await checkGameInstalled(730);
    
    expect(result).toBe(true);
  });

  it('returns false for non-installed game', async () => {
    mockInstalledGamesAPI.getInstalledAppIds.mockResolvedValue([730, 570]);
    
    const result = await checkGameInstalled(999);
    
    expect(result).toBe(false);
  });

  it('returns false when not in Electron', async () => {
    delete (window as any).installedGames;
    
    const result = await checkGameInstalled(730);
    
    expect(result).toBe(false);
  });

  it('returns false on API error', async () => {
    mockInstalledGamesAPI.getInstalledAppIds.mockRejectedValue(new Error('Failed'));
    
    const result = await checkGameInstalled(730);
    
    expect(result).toBe(false);
  });
});
