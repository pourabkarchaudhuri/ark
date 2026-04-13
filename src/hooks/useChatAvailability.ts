/**
 * useChatAvailability
 * Returns whether the AI Chat can be used (at least one provider configured)
 * and a tooltip message when chat is unavailable.
 */

import { useState, useEffect } from 'react';
import { useBetaFeatures, isBetaFeatures } from '@/hooks/useBetaFeatures';

export interface ChatAvailability {
  available: boolean;
  message: string;
}

const BETA_OFF_MESSAGE =
  'Turn on Beta features in Settings → General to use AI Chat.';

const UNAVAILABLE_MESSAGE =
  'No AI provider configured. Add at least one in Settings → AI Models: Ollama (local), Google Gemini, Azure OpenAI, or Anthropic.';
const OLLAMA_ONLY_MESSAGE =
  'Chat uses Ollama by default. Ensure Ollama is running, or add another provider in Settings → AI Models.';

export function useChatAvailability(): ChatAvailability {
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
      const list: string[] = [];
      try {
        const azureEndpoint = localStorage.getItem('ark-azure-endpoint')?.trim();
        const azureKey = localStorage.getItem('ark-azure-key')?.trim();
        const azureDeployment = localStorage.getItem('ark-azure-deployment')?.trim();
        if (azureEndpoint && azureKey && azureDeployment) list.push('azure');

        const anthropicKey = localStorage.getItem('ark-anthropic-key')?.trim();
        if (anthropicKey) list.push('anthropic');

        if (window.settings) {
          const [hasGemini, ollamaSettings] = await Promise.all([
            window.settings.hasApiKey(),
            window.settings.getOllamaSettings(),
          ]);
          if (hasGemini) list.push('gemini');
          if (ollamaSettings.url?.trim()) list.push('ollama');
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
  }, [betaFeatures]);

  return state;
}
