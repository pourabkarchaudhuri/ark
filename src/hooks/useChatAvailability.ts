/**
 * useChatAvailability
 * Returns whether the AI Chat can be used (at least one provider configured)
 * and a tooltip message when chat is unavailable.
 */

import { useState, useEffect } from 'react';
import { useBetaFeatures, isBetaFeatures } from '@/hooks/useBetaFeatures';
import { listConfiguredChatProviders } from '@/lib/chat-providers';
import { ensureLegacyAiKeysMigrated } from '@/lib/ai-key-migration';

export interface ChatAvailability {
  available: boolean;
  message: string;
}

const BETA_OFF_MESSAGE =
  'Turn on Beta features in Settings → General to use AI Chat.';

const UNAVAILABLE_MESSAGE =
  'No AI provider configured. Add at least one in Settings → AI Models: Ollama (local), Google Gemini, or Azure OpenAI.';
const OLLAMA_ONLY_MESSAGE =
  'Chat uses Ollama by default. Ensure Ollama is running, or add another provider in Settings → AI Models.';

/**
 * @param refreshKey Re-check when this changes. The dashboard passes its view mode, so
 *   providers added or removed in Settings (a view inside the same Dashboard) are picked
 *   up when the user leaves Settings — not on every keystroke there.
 */
export function useChatAvailability(refreshKey?: unknown): ChatAvailability {
  const [betaFeatures] = useBetaFeatures();
  const [state, setState] = useState<ChatAvailability>(() => ({
    available: false,
    message: !isBetaFeatures() ? BETA_OFF_MESSAGE : UNAVAILABLE_MESSAGE,
  }));

  useEffect(() => {
    if (!betaFeatures) {
      setState({ available: false, message: BETA_OFF_MESSAGE });
      return;
    }

    let cancelled = false;
    (async () => {
      let list: string[] = [];
      try {
        await ensureLegacyAiKeysMigrated();
        const azureEndpoint = localStorage.getItem('ark-azure-endpoint')?.trim();
        const azureDeployment = localStorage.getItem('ark-azure-deployment')?.trim();

        if (window.settings) {
          const [hasGemini, ollamaSettings, hasAzureKey] = await Promise.all([
            window.settings.hasApiKey(),
            window.settings.getOllamaSettings(),
            window.settings.hasAzureKey?.() ?? Promise.resolve(false),
          ]);
          // Anthropic is never counted: there is no chat backend for it.
          list = listConfiguredChatProviders({
            ollamaUrl: ollamaSettings?.url,
            betaFeatures: true,
            hasGeminiKey: !!hasGemini,
            azureConfigured: !!(azureEndpoint && azureDeployment && hasAzureKey),
          });
        }
      } catch {
        // ignore
      }
      if (cancelled) return;
      if (list.length === 0) {
        setState({ available: false, message: UNAVAILABLE_MESSAGE });
        return;
      }
      if (list.length === 1 && list[0] === 'ollama') {
        setState({ available: true, message: OLLAMA_ONLY_MESSAGE });
        return;
      }
      setState({ available: true, message: 'Chat with the AI Assistant — ask about games, get recommendations, or explore your library.' });
    })();
    return () => { cancelled = true; };
  }, [betaFeatures, refreshKey]);

  return state;
}
