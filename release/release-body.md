## Ark 1.0.59

Wave 3 + Embedding Space neighbor restore (single ship).

### Fixed
- **ES neighbor lines empty after Phase B.1** — max-sim no longer passes `excludeId` into usearch; over-fetch `k*16`; nodeMap-only draw; euclidean fallback + status chip.
- **The Path** — clearer disabled reasons when journey games aren't in the galaxy; Explore Path expands neighbors via the fixed query.

### Added
- **Re-chunk catalog (idle)** — Settings → Ollama; library then catalog facet chunks; progress/cancel; polite during sessions; ANN upsert; Rebuild ANN recommended when done.
- **Weight-sweep harness (Beta)** — synthetic MRR over `CHUNK_WEIGHTS`; does not auto-change production weights.
- **MRL-256 (default off)** — `ollama.embeddingMrl256Enabled`; ANN uses 256-d prefixes; toggle clears index for rebuild.

### Preserved
- Overlay two-level + Shift+Win+D; closes on game exit; no mouse forward.
- No Timeshear / Cartographer / Monuments.
- Oracle/graph stay pooled; Rebuild ANN + What’s New intact.
