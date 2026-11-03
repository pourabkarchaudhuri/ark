/**
 * The Settings search (Ctrl K) index (1.0.97 B37): one entry per setting row, on every page. Each
 * row in a page carries `data-setting-id`, and a test checks that every such id has an entry here,
 * so a row added later cannot be missed by the search.
 */
export type SettingsPageId = 'general' | 'providers' | 'understanding' | 'guide' | 'about';

export const PAGE_LABELS: Record<SettingsPageId, string> = {
  general: 'General',
  providers: 'AI providers',
  understanding: 'Game understanding',
  guide: 'Guide',
  about: 'About',
};

export interface SettingEntry {
  id: string;
  page: SettingsPageId;
  label: string;
  desc: string;
  /** Extra words people might type. */
  keywords: string;
}

const e = (id: string, page: SettingsPageId, label: string, desc: string, keywords = ''): SettingEntry => ({ id, page, label, desc, keywords });

export const SETTINGS_INDEX: readonly SettingEntry[] = [
  // General
  e('launch', 'general', 'Launch on startup', 'Starts in the tray when you log in.', 'autostart login boot tray'),
  e('onhold', 'general', 'Auto On Hold', 'Playing to On Hold after 4 weeks unplayed. You get an Undo.', 'status idle paused'),
  e('autoplay', 'general', 'Auto Playing', 'Want to Play to Playing after a 10-minute session.', 'status session'),
  e('overlay', 'general', 'Show the overlay', 'Corner HUD while a tracked game runs. Best in borderless windowed.', 'in-game hud hotkey shortcut cycle detail'),
  e('adult', 'general', 'Allow adult content', 'When off, sexually explicit games are hidden everywhere.', 'nsfw explicit mature'),
  e('hltb', 'general', 'HowLongToBeat times', 'Sends the game title to howlongtobeat.com. Cached for 30 days.', 'how long to beat hours'),
  e('ggdeals', 'general', 'gg.deals prices', 'Best prices and all-time lows from gg.deals. Needs a free API key.', 'price key api deal region currency reseller keyshop'),
  e('analytics', 'general', 'Usage analytics', 'Anonymous app launches and screens to Google Analytics. Off by default.', 'privacy telemetry google'),
  e('backup', 'general', 'Backup', 'Export or import your library as a JSON file.', 'export import restore library json file'),
  e('wrapped', 'general', 'Ark Wrapped', 'Your year in games: stats, top games, genre mix.', 'year review'),
  e('beta', 'general', 'Beta features', 'AI Chat button and cloud connectors in AI providers.', 'chat experimental'),
  e('dev', 'general', 'Developer mode', 'Data Flow page, status panels and pipeline diagnostics.', 'developer debug'),
  // AI providers
  e('route-chat', 'providers', 'Chat route', 'Which connector AI Chat uses.', 'route provider model chat llm litellm'),
  e('route-embeddings', 'providers', 'Embedding route', 'Which model reads games for similarity.', 'embedding embed vector route model'),
  e('route-reranker', 'providers', 'Reranker route', 'Which model sorts the best matches first.', 'rerank reranker route model'),
  e('connector-keys', 'providers', 'API keys', 'Keys for Anthropic, OpenAI, Gemini and more.', 'key api byok claude gpt gemini azure openrouter cohere'),
  e('connector-compat', 'providers', 'OpenAI-compatible endpoint', 'vLLM, LM Studio, llama.cpp or any custom server.', 'custom endpoint base url openai compatible local vllm lm studio llama localai self-hosted'),
  e('connector-models', 'providers', 'Models', 'Which models a connector offers and which is the default.', 'model default fetch deployment'),
  e('connection-test', 'providers', 'Connection test', 'Test input, timeout, retries, re-checks.', 'test connection timeout retry ping latency'),
  e('routing-policy', 'providers', 'When a route fails', 'What Ark does if the routed provider errors or times out.', 'fail fallback error retry'),
  e('builtin-ai', 'providers', 'Built-in local AI', 'The AI that runs on this PC: status, models, downloads.', 'llama local download model gpu cpu folder remove'),
  e('own-ollama', 'providers', 'Use my own Ollama', 'Point Ark at an Ollama you already run instead of the built-in AI.', 'ollama local server address url'),
  // Game understanding
  e('u-embedding-model', 'understanding', 'Embedding model', 'The model that reads each game. Change it in AI providers.', 'embedding route model'),
  e('u-batch', 'understanding', 'Batch size', 'Speed against graphics memory.', 'batch vram gpu memory'),
  e('u-detail', 'understanding', 'Detailed reading', 'Reads story, gameplay and style separately.', 'chunk facets'),
  e('u-anypart', 'understanding', 'Match on any part', 'Two games count as alike when any part lines up.', 'max sim chunk'),
  e('u-compact', 'understanding', 'Compact vectors', 'Faster searches, slightly less precise. Needs an index rebuild.', 'mrl 256 compact'),
  e('u-reranker-model', 'understanding', 'Reranker model', 'The model that puts the best matches first. Change it in AI providers.', 'rerank route model'),
  e('u-rerank-similar', 'understanding', 'Rerank similar games', 'Applies to Similar Games and the galaxy map.', 'neighbor order'),
  e('u-rerank-oracle', 'understanding', 'Rerank Oracle shelves', 'Lets the AI re-sort each shelf.', 'shelf recommendation order'),
  e('u-blend', 'understanding', 'AI influence on shelves', 'How much the AI re-sorts the engine order.', 'blend slider rerank'),
  e('u-rebuild-index', 'understanding', 'Rebuild similarity index', 'Quick, no AI needed.', 'rebuild index similar ann'),
  e('u-refresh', 'understanding', 'Refresh detailed reading', 'Library first, then the catalog. Runs while you play.', 'rechunk refresh'),
  e('u-rebuild-all', 'understanding', 'Rebuild everything', 'The AI re-reads library, Steam and Epic.', 'rebuild reindex embeddings resume'),
  e('u-sweep', 'understanding', 'Matching tune-up test', 'Scores other matching weights on a small test set.', 'sweep weights advanced'),
  // Guide
  e('g-tours', 'guide', 'Guided tours', 'Walkthroughs of each view.', 'tour help guide walkthrough'),
  e('g-features', 'guide', 'What Ark can do', 'The features of Ark in one list.', 'features manual'),
  e('g-faq', 'guide', 'How the AI works', 'Plain answers about recommendations, the galaxy map and privacy.', 'faq privacy accuracy'),
  // About
  e('a-version', 'about', 'Check for updates', 'Version and release notes.', 'update version release upgrade'),
  e('a-team', 'about', 'Team', 'Who builds Ark.', 'credits authors developers'),
  e('a-built-with', 'about', 'Built with', 'Libraries in this build and their versions.', 'credits open source licenses packages'),
  e('a-terms', 'about', 'Terms', 'Terms of use and data handling.', 'license privacy legal'),
];

/** Entries whose label, description or keywords contain every word typed. */
export function searchSettings(query: string): SettingEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return SETTINGS_INDEX.filter((s) => {
    const hay = `${s.label} ${s.desc} ${s.keywords} ${PAGE_LABELS[s.page]}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
