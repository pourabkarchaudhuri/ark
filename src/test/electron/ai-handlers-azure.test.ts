/**
 * ai:sendMessage (v1.0.97): the Azure OpenAI key comes from the encrypted store in
 * main; the renderer only sends endpoint / deployment / API version.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../electron/ai-chat.js', () => ({
  processMessage: vi.fn(), searchGamesForContext: vi.fn(), chatStore: {},
}));
vi.mock('../../../electron/settings-store.js', () => ({ settingsStore: {} }));

import { buildAzureProviderOptions } from '../../../electron/ipc/ai-handlers';

const payload = { azureEndpoint: ' https://res.openai.azure.com ', azureDeployment: 'gpt-4o', azureApiVersion: '2025-01-01' };

describe('buildAzureProviderOptions', () => {
  it('uses the stored key when the payload has none', () => {
    expect(buildAzureProviderOptions(payload, 'azure-openai', 'stored-key')).toEqual({
      azure: { endpoint: 'https://res.openai.azure.com', apiKey: 'stored-key', deployment: 'gpt-4o', apiVersion: '2025-01-01' },
    });
  });

  it('prefers the stored key over anything in the payload', () => {
    expect(buildAzureProviderOptions({ ...payload, azureKey: 'renderer-key' }, 'azure-openai', 'stored-key')?.azure?.apiKey).toBe('stored-key');
  });

  it('returns nothing for other providers or missing credentials', () => {
    expect(buildAzureProviderOptions(payload, 'gemini', 'stored-key')).toBeUndefined();
    expect(buildAzureProviderOptions(payload, 'azure-openai', null)).toBeUndefined();
    expect(buildAzureProviderOptions({ azureDeployment: 'x' }, 'azure-openai', 'k')).toBeUndefined();
  });
});
