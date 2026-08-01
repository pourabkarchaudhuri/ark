# Ark 1.0.48

Six workstreams shipped together:

## Insights & Telemetry gate removal
- The Insights & Telemetry tab is always visible for library games; zero sessions show a proper empty state instead of hiding the tab.
- Fixed reactivity: the tab subscribes to `sessionStore` so analytics populate when a session is recorded while the page is open.

## Game-details hero backgrounds
- Steam and Epic detail pages share the same hero image layer via `buildGameImageChain`, preferring `header_image` over wide page backgrounds.
- `onError` walks the chain; a dead URL falls back to the flat backdrop.

## Tiered reranker + Qwen3 download + status
- New tier ladder: native `/api/rerank` → Qwen3 graded logprobs → Qwen3 binary (Ollama < 0.12.11) → arctic-embed cosine.
- Qwen3 auto-download runs in the background with real progress on `ollama:rerank-progress` (separate from embedding setup).
- Status panel, splash, data-flow view, and Oracle badges report the resolved tier honestly.

## Broadcast cards
- Fixed card height and a single outer shell for imminent and non-imminent events.
- Blurred-fill letterbox backdrop so logos and wide banners read consistently at 260px width.
- Load/error state machine ported from TransmissionCard.

## Oracle explanation drawer
- One right-side drawer replaces both explanation popovers; shares Taste DNA panel chrome.
- Headline verdict, evidence chips, score breakdown, scroll-into-view on open, Escape to close.

## Voyage: Scenes & Audit
- **Scenes** — play episodes clustered into binge/drip/marathon/return types; gaps render as content; log-scaled magnitude; navigation spine.
- **Audit** — three record-quality rings (Completion, Hygiene, Accuracy); severity-ranked rule queue; snooze/dismiss persisted to localStorage; inline resolution. Grades records, never playing.

## Tests
- Vitest coverage for voyage scene clustering, audit rules + snooze persistence, rerank tier detection, Qwen3 logprob/binary scoring, and telemetry zero-session reactivity.
