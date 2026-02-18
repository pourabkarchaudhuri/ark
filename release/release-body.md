## What's New in Ark v1.0.31

### Major Features
- **Medals System** — Gamified progression with 40+ badges across 5 branches (Explorer, Completionist, Collector, Analyst, Veteran), Taste DNA 8-axis radar, badge vault, skill tree, and commander XP ranking
- **Oracle Recommendations** — 17-layer scoring pipeline in a Web Worker producing themed shelves (Hidden Gems, Genre Deep Dives, Comfort Picks, etc.) with match-score breakdowns; shelf ordering optimized via Thompson Sampling bandit
- **Ollama Embedding Integration** — Auto-detects local Ollama installation, pulls required model, and generates semantic embeddings for richer recommendation matching
- **Year Wrapped** — Spotify-Wrapped-style gaming recap accessible from Settings with animated slides

### Enhancements
- **Showcase 3D Card Carousel** — New default Voyage view with tilt interaction and status rings
- **Voyage Refactor** — Captain's Log with per-month grouping; Medals tab replaces standalone Analytics view
- **Gantt Virtualization** — OCD timeline uses @tanstack/react-virtual for vertical row virtualization
- **Import/Export Overhaul** — Full wipe-and-replace semantics across all stores

### Performance
- Debounced localStorage writes (300ms coalescing) in library, journey, and custom-game stores
- Fingerprint-based early exit in useDeferredFilterSort
- Chunked search-index build with requestIdleCallback yielding
- Splash star count halved, cold-start wait reduced 1200 to 400ms
- Set-based genre dedup, guarded library enrichment

### New UI Primitives
- 3D tilt card, Evervault animated card, BlurText, CountUp, GradientText, ShinyText
