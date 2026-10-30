/**
 * Legacy plaintext AI keys in localStorage (v1.0.97): Azure and Anthropic keys move to
 * main's encrypted store; non-secret fields stay.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensureLegacyAiKeysMigrated, resetLegacyAiKeyMigrationForTests } from '@/lib/ai-key-migration';

const win = window as unknown as { settings?: unknown };

beforeEach(() => {
  localStorage.clear();
  resetLegacyAiKeyMigrationForTests();
});
afterEach(() => { delete win.settings; });

describe('ensureLegacyAiKeysMigrated', () => {
  it('moves ark-azure-key into the store and removes it from localStorage', async () => {
    const setAzureKey = vi.fn(async () => ({ success: true }));
    win.settings = { setAzureKey };
    localStorage.setItem('ark-azure-key', ' azure-secret ');
    localStorage.setItem('ark-azure-endpoint', 'https://x.openai.azure.com');
    await ensureLegacyAiKeysMigrated();
    expect(setAzureKey).toHaveBeenCalledWith('azure-secret');
    expect(localStorage.getItem('ark-azure-key')).toBeNull();
    expect(localStorage.getItem('ark-azure-endpoint')).toBe('https://x.openai.azure.com');
  });

  it('keeps the key in localStorage when main does not confirm the save', async () => {
    win.settings = { setAzureKey: vi.fn(async () => ({ success: false })) };
    localStorage.setItem('ark-azure-key', 'azure-secret');
    await ensureLegacyAiKeysMigrated();
    expect(localStorage.getItem('ark-azure-key')).toBe('azure-secret');
  });

  it('moves the Anthropic key into the store and keeps the model name', async () => {
    const setAnthropicKey = vi.fn(async () => ({ success: true }));
    win.settings = { setAzureKey: vi.fn(), setAnthropicKey };
    localStorage.setItem('ark-anthropic-key', 'sk-ant-1');
    localStorage.setItem('ark-anthropic-model', 'claude');
    await ensureLegacyAiKeysMigrated();
    expect(setAnthropicKey).toHaveBeenCalledWith('sk-ant-1');
    expect(localStorage.getItem('ark-anthropic-key')).toBeNull();
    expect(localStorage.getItem('ark-anthropic-model')).toBe('claude');
  });

  it('keeps the Anthropic key when this build cannot store it yet', async () => {
    win.settings = { setAzureKey: vi.fn() };
    localStorage.setItem('ark-anthropic-key', 'sk-ant-1');
    await ensureLegacyAiKeysMigrated();
    expect(localStorage.getItem('ark-anthropic-key')).toBe('sk-ant-1');
  });

  it('drops an empty legacy key without calling main', async () => {
    const setAzureKey = vi.fn(async () => ({ success: true }));
    win.settings = { setAzureKey };
    localStorage.setItem('ark-azure-key', '   ');
    await ensureLegacyAiKeysMigrated();
    expect(setAzureKey).not.toHaveBeenCalled();
    expect(localStorage.getItem('ark-azure-key')).toBeNull();
  });

  it('runs once per session', async () => {
    const setAzureKey = vi.fn(async () => ({ success: true }));
    win.settings = { setAzureKey };
    localStorage.setItem('ark-azure-key', 'k1');
    await Promise.all([ensureLegacyAiKeysMigrated(), ensureLegacyAiKeysMigrated()]);
    expect(setAzureKey).toHaveBeenCalledTimes(1);
  });
});
