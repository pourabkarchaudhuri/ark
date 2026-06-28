# Ark v1.0.40 — Embedding Speed & Polite Background

This release focuses entirely on making Ollama-backed embeddings faster, kinder to your GPU when you're gaming, and a no-brainer to install for first-time users.

## Performance

- **Single-request array batching** — The IPC handler now sends sub-batches of 256 texts as one array to Ollama's `/api/embed`, replacing the previous 20-way parallel single-text Promise.all that pegged CPU at 100%. Ollama processes the array sequentially internally — no parallel CPU spike, dramatically faster wall-clock.
- **Full GPU offload** — On GPUs, all layers are forced via `num_gpu: 999` (catches Optimus/hybrid laptops where Ollama auto-leaves layers on CPU). Internal Ollama batch raised to `num_batch: 2048`, the throughput sweet spot for arctic-embed2 on consumer GPUs.
- **Two concurrent in-flight requests on GPU** — Worker pool of 2 overlaps HTTP/JSON-shuffle wall-clock of one sub-batch with GPU compute of another. CPU stays cheap (no inference on host). Degrades gracefully to serial when `OLLAMA_NUM_PARALLEL=1` (default).
- **Length-sorted sub-batches** — Items grouped by text length before batching, improving queue utilisation when concurrent in-flight is active.
- **Model kept hot** — `keep_alive: -1` pins the embedding model in memory; no more ~80 s reload between bursts.

## Polite background mode

When you alt-tab, minimise, or hide Ark for ≥2 s, the embedding pipeline automatically switches to a polite profile:
- Sub-batch drops 256 → 100
- `num_batch` drops 2048 → 256 (~8× less GPU compute per pass)
- Single in-flight request (no GPU queue pressure)
- 100 ms cooldown between bursts (foreground app gets uncontended GPU windows)

Focus instantly restores full throughput. Heavy games now run uninterrupted in the foreground while embedding catches up in the background.

## VRAM auto-fallback

On tight-VRAM GPUs, if a sub-batch returns all-null (Ollama OOM signature), the worker silently steps the internal batch ladder down: `2048 → 1024 → 512 → Ollama default`. The stepped-down value sticks for the rest of the session. No more silent zero-embed runs.

## Auto-install embedding model in splash

First-launch updaters get the 1.2 GB arctic-embed2 model pulled automatically during the splash screen. The "Enter Ark" button is gated while the pull is actively in progress so the reco engine isn't half-ready when the user enters. Already-installed users see no extra wait. Hard 10-minute ceiling ensures users are never stranded behind a stuck pull.

## New diagnostics

- **Embed performance probe** — `window.ollama.embedDiagnostic()` from DevTools returns: GPU mode, VRAM bytes, embeds/sec, ms/embed, current profile (sub-batch, num_batch, in-flight, polite flag), Ollama version. Hard numbers for measuring real throughput.
- **GPU mode detection eager** — Runs after model warm-up during splash; foreground batches no longer pay first-time GPU-detection round-trip.

## Power-user knobs

- **Configurable model quantization** — `ARK_EMBEDDING_MODEL_TAG` env var overrides the embedding model tag for users who manually quantize arctic-embed2 (e.g. `snowflake-arctic-embed2:568m-q8_0`). Validation enforces the `snowflake-arctic-embed2:*` prefix to preserve embedding-space compatibility.

## Test fixes

- `getTopSellers` Epic catalog tests now stub global fetch so the renderer egdata fallback returns empty deterministically. Tests no longer flake based on live api.egdata.app response counts.

---

**Default behaviour unchanged for existing users.** Cached embeddings remain valid (no IDB migration, no model version bump). The performance gains take effect immediately on next embedding pass.
