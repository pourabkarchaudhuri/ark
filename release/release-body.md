## What's New in Ark v1.0.36

### Guided Tour Overhaul
- **Spotlight effect** — Each tour step now highlights the element it's pointing at with a crisp cutout glow, instead of uniform dimming that hid the target.
- **removeChild crash eliminated** — Removed manual DOM overlay that raced React's portal teardown; Joyride handles its own overlay natively.
- **Deterministic event flow** — Tour callbacks handle `TOUR_END`, `STEP_AFTER + CLOSE`, and terminal statuses without overlap or double-fire.
- **Loading/empty state anchors** — Voyage tour resolves all steps even during skeleton loading or empty state via `data-tour` anchors on placeholder elements.
- **Lazy-loaded view retries** — Tours started from Settings for Embedding Space, Oracle, Data Flow, and DevLog now retry target resolution up to ~1.2s for Suspense chunks to mount.
- **Settings Guide tab redesign** — Clear visual hierarchy with play/replay icons, completion checkmarks, and dev-only tags.

### Rerank Status Badges
- Oracle and Embedding Space now show rerank status (off, unavailable, no scores, failed) as compact amber badges inline with metadata, instead of standalone warning paragraphs.

### AI Chat & Ollama Reranking
- Enhanced chat provider support with availability detection and improved panel UX.
- Full Ollama reranker pipeline for Oracle recommendations and Embedding Space neighbors — score normalization, query building, and graceful fallback when Ollama is unavailable.

### Other Improvements
- Journey display titles — smarter display names for Voyage timeline entries.
- Chat availability hook for provider status detection.
- New test coverage for guided tour resolution, Ollama reranking, Oracle reranking, and journey titles.

### Technical
- 640 tests passing across 37 test suites.
- Removed custom `ark-tour-overlay` DOM element; Joyride's native `overlayColor` and `spotlightPadding` handle dimming and highlighting.
- Progressive retry schedule (0, 150, 350, 700ms) for `resolveStepsWithExistingTargets` replaces single 280ms retry.
