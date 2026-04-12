# Tests

## Chat prompt tests (Azure OpenAI)

Runs the 50 prompts in `chat-prompts.json` through the chat module with **Azure OpenAI** as the provider and writes results to `chat-prompts-results.json`.

### Prerequisites

Set Azure OpenAI credentials (in `.env` in the project root or in your shell):

- `AZURE_OPENAI_ENDPOINT` (or `AZURE_OPENAI_API_ENDPOINT`) — e.g. `https://your-resource.openai.azure.com`
- `AZURE_OPENAI_KEY` (or `AZURE_OPENAI_API_KEY`)
- `AZURE_OPENAI_DEPLOYMENT` (or `AZURE_OPENAI_DEPLOYMENT_NAME`) — deployment name (e.g. `gpt-4o`)
- `AZURE_OPENAI_KEY_VERSION` or `AZURE_OPENAI_API_VERSION` (optional) — API version, e.g. `2025-04-01-preview`; defaults to `2024-12-01-preview` if unset

### Run

```bash
npm run test:chat-prompts
```

Results are written to `tests/chat-prompts-results.json` with one entry per prompt: `id`, `category`, `prompt`, `content`, `toolsUsed`, and optional `error`.

### Reviewing results

- **Library** prompts should show `searchSteamGames` then `addGameToLibrary` / `removeGameFromLibrary` or `getLibraryGames` where appropriate.
- **Review / comparison / game-info** should show `searchSteamGames` and `getGameDetails` with on-topic, factual answers (Metacritic, description, etc.).
- **Recommendations** should show `getGameRecommendations` when the (test) library allows it, or a clear “library is empty” message.
- **News / Steam sale / “how long”** rely on web search; responses should cite or summarize search results, not invent dates.
- **“This game” / “add this game”** without a named game should either use game context (when provided) or ask which game the user means.

If responses are generic or wrong, adjust the system prompt or tool descriptions in `electron/ai-chat.ts` and/or extend `needsWebSearch` in `electron/web-search.ts`, then re-run.
