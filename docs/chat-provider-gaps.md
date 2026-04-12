# Chat Provider Implementation — Gaps Check (2026-03-14)

Review of the multi-provider chat implementation (Ollama, Gemini, Azure OpenAI, Anthropic selector).

## Gaps fixed

1. **Anthropic selected but not implemented**  
   Backend fell through to Ollama when `provider === 'anthropic'`.  
   **Fix:** `getModelForProvider` now throws a clear error: *"Anthropic (Claude) is not yet supported for chat. Please select Azure OpenAI, Gemini, or Ollama."*

2. **SendMessagePayload type incomplete**  
   Payload sent to IPC could include `azureEndpoint`, `azureKey`, `azureDeployment` but the type did not.  
   **Fix:** `SendMessagePayload` in `src/types/chat.ts` now has optional `azureEndpoint?`, `azureKey?`, `azureDeployment?`.

3. **useAIChat hook ignored selected provider**  
   The hook sent messages without `provider` or Azure credentials, so the backend always used the default (Ollama/Gemini).  
   **Fix:** `useAIChat` now reads `ark-chat-provider` from localStorage and, when provider is `azure-openai`, adds Azure credentials from localStorage to the payload.

4. **Gemini selected with no API key**  
   `getApiKey()` threw a generic error.  
   **Fix:** When `effective === 'gemini'`, we catch the error and throw a message that names Gemini and points to Settings / choosing another model.

## Behaviour confirmed

- **AIChatPanel** sends `provider` and Azure credentials when Azure is selected; payload is typed as `SendMessagePayload`.
- **IPC** builds `providerOptions.azure` only when `provider === 'azure-openai'` and all three credentials are present; otherwise passes `undefined`.
- **Backend** uses `getModelForProvider(provider, providerOptions)`; legacy callers (no `provider`) get `getDefaultProvider()` (Ollama vs Gemini from settings).
- **Validation step** still runs when a Gemini API key exists, regardless of which provider was used for the response (cross-provider validation). No change.

## Remaining / accepted limitations

- **Anthropic** is not implemented; selecting it returns a clear “not yet supported” error.
- **Azure API version** is hardcoded to `2024-12-01-preview` in `electron/ai-chat.ts`. Other Azure resources may need a different version (future: make configurable in Settings).
- **Single model cache** in the backend: only one model (and config key) is cached. Switching provider creates a new model and overwrites the cache. Acceptable for sequential use.
- **useAIChat** is not used by the main Chat UI (dashboard uses `AIChatPanel`). The hook now respects the stored provider for any future callers.
