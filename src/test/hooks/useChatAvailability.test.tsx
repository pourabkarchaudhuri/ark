/**
 * useChatAvailability (v1.0.97): Anthropic never makes chat available, Azure counts
 * via the main-process key check, and a refresh key re-checks after Settings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useChatAvailability } from '@/hooks/useChatAvailability';
import { resetLegacyAiKeyMigrationForTests } from '@/lib/ai-key-migration';

const win = window as unknown as { settings?: unknown };

function installSettings(over: { hasGemini?: boolean; ollamaUrl?: string; hasAzure?: boolean } = {}) {
  const s = {
    hasApiKey: vi.fn(async () => over.hasGemini ?? false),
    getOllamaSettings: vi.fn(async () => ({ url: over.ollamaUrl ?? '' })),
    hasAzureKey: vi.fn(async () => over.hasAzure ?? false),
    setAzureKey: vi.fn(async () => ({ success: true })),
    setBetaFeatures: vi.fn(async () => ({ success: true })),
  };
  win.settings = s;
  return s;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ark-beta-features', '1');
  resetLegacyAiKeyMigrationForTests();
});
afterEach(() => { delete win.settings; });

describe('useChatAvailability', () => {
  it('is unavailable with only an Anthropic key', async () => {
    const s = installSettings();
    (s as Record<string, unknown>).hasAnthropicKey = vi.fn(async () => true);
    (s as Record<string, unknown>).setAnthropicKey = vi.fn(async () => ({ success: true }));
    localStorage.setItem('ark-anthropic-key', 'sk-ant-xyz');
    const { result } = renderHook(() => useChatAvailability());
    await waitFor(() => expect(s.hasApiKey).toHaveBeenCalled());
    await waitFor(() => expect(result.current.message).toMatch(/No AI provider configured/));
    expect(result.current.available).toBe(false);
    expect(result.current.message).not.toMatch(/Anthropic/);
  });

  it('reports Azure available from hasAzureKey plus endpoint and deployment', async () => {
    installSettings({ hasAzure: true });
    localStorage.setItem('ark-azure-endpoint', 'https://x.openai.azure.com');
    localStorage.setItem('ark-azure-deployment', 'gpt-4o');
    const { result } = renderHook(() => useChatAvailability());
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.message).toMatch(/Chat with the AI Assistant/);
  });

  it('re-checks when the refresh key changes (leaving Settings)', async () => {
    const s = installSettings();
    const { result, rerender } = renderHook(({ k }) => useChatAvailability(k), { initialProps: { k: 'settings' } });
    await waitFor(() => expect(s.hasApiKey).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.available).toBe(false));
    s.hasApiKey.mockResolvedValue(true);
    rerender({ k: 'browse' });
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(s.hasApiKey).toHaveBeenCalledTimes(2);
  });
});
