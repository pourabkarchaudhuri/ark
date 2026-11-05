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

## Warm-up cycle

With the built-in AI running, the renderer heap steps up once over the first three cycles (v1.0.97: 38.7, 43.5, 59.9 MB, then 62.2 to 63.9 MB over the next seven cycles; DOM nodes, listeners and process counts are flat from cycle 1). The scenario therefore starts the servers and waits for the background embedding to drain before cycle 1, and the leak rules compare from `meta.warmupCycle` (4 with the AI, 2 without) to the last cycle. Growth after the warm-up still fails.

## v1.0.97 baseline (`scripts/perf/baselines/v1.0.97.json`)

Full run: 10 cycles, 60 s idle, 120 s detached hidden idle, 2 extra cold starts, 512 MB download, 10 router-overhead rounds. Same machine as the 1.0.97 report (i9-12900H, 32 GB). The tag was built with `tsc -p tsconfig.node.json` + `vite build` in a scratch worktree, with only `electron/perf-probe.ts` replaced by the current one.

| Measurement | v1.0.97 |
|---|---|
| IPC self-test | ok (5 of 5 counted, 188 handlers wrapped) |
| IPC per scenario cycle (median, warm) | 315 invoke calls, 6 pushes, 18.5 MB payload |
| IPC per Browse screen (warm) | 0 calls in 8 of 10 cycles (5 in cycles 3 and 4): a real zero, the screen is served from renderer caches; the per-cycle total above is the number that cannot be 0 |
| llama-server working set | embed 1145 MB, rerank 1136 MB |
| llama-server idle CPU (after the background embedding drained, 218 s after boot with the seeded 2000-game library) | 1.7 % / 1.6 % of a core |
| llama-server CPU during the burst | embed 21.7 %, rerank 24.4 % |
| Embedding + rerank, direct vs through the app | 23.38 vs 23.44 items/s, overhead -0.3 % (budget 15 %) |
| Download, 512 MB, local Range server | 73.1 MB/s, main event-loop max 34.8 ms (budget 100), 20 status pushes: 2.9/s average, **5 in the busiest second (budget 4: fails in v1.0.97)** |
| LiteLLM sidecar | not running at boot or with built-in routes; 343 MB and 0.4 % idle CPU once a non-built-in route exists (start 41.6 s); gone after quit with llama-server |
| Settings pages | paint 15-41 ms; mount 0-265 ms (the "understanding" page is the slow one); longest renderer long task 170 ms (budget 200) |
| Process leaks | llama-server 2 -> 2, working set +0.01 %, no python, nothing left after quit |
| Cold start / idle 60 s / hidden idle | 9.3-9.6 s to interactive (model-free launches) / 15.0 % / 0.15 % |

The baseline run fails exactly one budget by design of the new harness: the download status pushes (5/s against a limit of 4/s).

## Attributing a long task (renderer CPU profile)

`PERF_PROFILE_DIR=<dir> PERF_PROFILE_STEPS=oracle-compute,settings,upcoming node scripts/perf/measure.mjs ...` records a renderer CPU
profile (CDP `Profiler`, 200 us sampling) around each named step (`*` = every step) and writes `<dir>/c<cycle>-<step>.cpuprofile`
(open it in Chrome DevTools, or sum self/inclusive time per function). Profiling adds some cost of its own: use it to see WHICH
functions fill a long task, and the plain run for the number.

First found with it (1.0.98): the renderer long tasks of 130-500 ms during Oracle / Upcoming / Settings were the background ANN
backfill and graph build converting every 1024-dim vector to a boxed `number[]` for IPC. They land in whichever cycle the library
embedding finishes in (cycle 1 on 1.0.98, cycle 3-4 on 1.0.97), which is why a budget that looks at every cycle saw them only now.

## Baseline re-sample: llama-server idle CPU

The v1.0.97 baseline stored one 4-window mean (1.66%) for the embed role's idle CPU. Four separate
runs of the same build read 1.66, 2.0, 2.2 and 2.3%, and the 1.0.98 build reads 1.88-2.33% on the same
harness, so one sample made the budget flap. The baseline now holds the mean of those four runs (2.04%).
No code or budget factor changed.
