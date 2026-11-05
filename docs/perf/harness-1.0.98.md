# Measurement harness, 1.0.98 upgrade

The 1.0.97 run had three gaps. This upgrade closes them and adds budgets for what 1.0.97 introduced (built-in llama.cpp servers, the LiteLLM sidecar, model downloads, the Settings rewrite). Run it the same way on both sides of a comparison: the baseline is a checkout of the previous tag with the CURRENT probes back-ported (`scripts/perf/apply-probes.mjs`), so one harness measures both.

## What was wrong, and the fix

| Gap in the 1.0.97 report | Root cause | Fix |
|---|---|---|
| IPC calls per Browse screen, payload, calls during scroll all read 0 | The probe was not blind (the same build counted 4 calls per Browse screen in an earlier round). Three things made the 0 meaningless: (1) the metric is the median of cycles 2..N and every Browse visit after the first is served from renderer caches, so a warm 0 is legitimate; (2) only renderer -> main `invoke` calls entered the metric, main -> renderer pushes (`localAi:status-changed` and friends) were recorded but never summed; (3) nothing proved the counters could read non-zero, so a 0 could not be told from a broken probe. | The probe's counters are unit-tested through the same wrapping the app gets (`src/test/perf-probe.test.ts`). The harness runs an **IPC self-test** at every boot (`Probes.ipcSelfTest`: it calls a known channel 5 times through the real preload bridge and checks the probe counted 5) and a result without a passing self-test fails the run and reports no IPC metrics. IPC is now recorded for EVERY scenario step (invoke calls, pushes, payload, top channels), and the budgets watch the per-cycle total, which cannot be 0 for a working app, next to the Browse screen figure. Pushes get their own sliding one-second maximum (`maxPerSec`). |
| llama-server and the LiteLLM python sidecar were never running, so their memory, CPU and leaks were not measured | The scenario ran offline with no models, so nothing started a server | `--models-src DIR` hard-links the models you already have into a SCRATCH `%LOCALAPPDATA%` (the real `%LOCALAPPDATA%\Ark` is never read or written: every launch now gets an empty scratch one). The scenario run switches to the models right after its idle reading (`Probes.enableModels`) and every cycle runs an embedding + rerank burst through the app's own code path, so the servers are alive in every per-cycle sample. A dedicated AI phase measures the rest (below). |
| The full 10-cycle scenario had not been re-run after the last fixes | n/a | Run `measure.mjs` without `--quick`; the baseline in `scripts/perf/baselines/` is a full run. |

## New measurements

Per-cycle samples now also carry: llama-server count and working set, python (LiteLLM) count and working set, and the names of any other non-Electron child.

AI phase (a separate launch on a copy of the primed profile, models in place from the start):

- **llama-server per role** (`embed`, `rerank`): working set, CPU % while idle (4 windows of 5 s, median; measured only after the servers went quiet, because the app embeds the library in the background for minutes after boot and `quietAfterS` reports how long that took), CPU % during the burst.
- **Router overhead**: the same embedding + rerank batch (32 texts, 32 documents) through the app (`generateEmbeddingsBatchDetailed`, `rerankViaNativeEndpoint`: route lookup + built-in backend) versus straight HTTP to llama-server, interleaved over `--ai-rounds` rounds, medians compared.
- **Download throughput**: a synthetic model (`--download-mb`, default 512) served by a local HTTP server with Range support, downloaded through the real `localAi:downloadChat` path (resumable download, sha256 verify). Reports MB/s, the main-thread event-loop max during the download, and the status pushes (total, average per second, busiest second).
- **LiteLLM sidecar**: must not run at boot nor before a non-built-in route exists; a local fake OpenAI-compatible server is configured as the chat route, the sidecar starts, its working set and idle CPU are read; then the app quits and the process tree is checked: nothing (python, llama-server) may remain.
- **Settings pages**: every scenario cycle clicks through each Settings page measuring paint (click to second frame), mount (click to last element added or removed, 250 ms quiet) and the longest renderer long task.

## Budgets and rules added

| Rule / budget | Limit |
|---|---|
| IPC probe self-test | must read exactly what was called |
| IPC calls and payload per scenario cycle | not above the baseline (10% + small floor) |
| Settings page mount, longest renderer long task | < 200 ms |
| Download: main event-loop max | < 100 ms |
| Download: status IPC pushes | <= 4 in any second |
| llama-server idle CPU (any role, after quiet) | < 3 % of a core |
| llama-server goes quiet after the background embedding drained | within 10 min |
| Router overhead, embedding + rerank, built-in route | < 15 % |
| llama-server process count, cycle 2 to last | no growth, never above 4, and > 0 (the scenario must exercise it) |
| llama-server working set, cycle 2 to last | < 10 % growth |
| LiteLLM python | never running with built-in routes only; exits on quit |
| Non-Electron children | only llama-server |
| Nothing left after quit | no llama-server or python, scenario run and AI phase |

## Running it

```
# baseline: a worktree of the previous tag, built (tsc -p tsconfig.node.json + vite build), probes back-ported
git worktree add <scratch>/base97 v1.0.97
node scripts/perf/apply-probes.mjs <scratch>/base97
node scripts/perf/measure.mjs --app <scratch>/base97 --label v1.0.97 --out base.json --hidden-idle-s 120 --models-src <folder with the .gguf files>
node scripts/perf/sanitize-result.mjs base.json scripts/perf/baselines/v1.0.97.json

# current tree, same flags, then the report
node scripts/perf/measure.mjs --app <built checkout> --label main --out cur.json --hidden-idle-s 120 --models-src <same folder>
node scripts/perf/measure.mjs --report --current cur.json --baseline scripts/perf/baselines/v1.0.97.json --md docs/perf/<release>-measurements.md
```

Useful while debugging the harness: `--ipc-selftest-only`, `--ai-only`, `--quick`. Cold start, idle and hidden idle stay model-free (like the 1.0.97 report) so they remain comparable; the models arrive after the idle reading.
