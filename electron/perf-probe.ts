/**
 * Main-process performance probes (release gate, scripts/perf/measure.mjs).
 *
 * Everything here is inert unless ARK_PERF=1 is in the environment: with the
 * variable unset `installPerfProbes()` returns immediately and nothing is
 * patched, so a normal run pays nothing.
 *
 * With ARK_PERF=1 it publishes `globalThis.__arkPerf` (read by the harness via
 * Playwright's `electronApp.evaluate`, no IPC surface is added):
 *   - event-loop delay histogram (`monitorEventLoopDelay`, p50/p99/max, resettable)
 *   - per-channel IPC counts and payload bytes (ipcMain.handle / .on, and
 *     webContents.send for main -> renderer traffic)
 *   - app.getAppMetrics() for every Electron process, plus the main process's
 *     own memory and CPU
 *   - `ai`: the built-in local AI (llama-server per role) and the LiteLLM sidecar, read through the app's own modules
 *     (dynamic imports, so a build that lacks them, such as v1.0.96, just reports null): process state, an
 *     embedding + rerank burst through the app's code path or straight to llama-server (router overhead), and the
 *     manifest override the download probe uses. No key or port ever leaves the main process.
 */

import { createRequire } from 'node:module';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const require = createRequire(import.meta.url);

interface ChannelStat {
  calls: number;
  errors: number;
  argBytes: number;
  resultBytes: number;
  totalMs: number;
  maxMs: number;
  /** Most calls seen inside any one second (a status push storm shows here, an average hides it). */
  maxPerSec: number;
}

interface AiBurstOptions {
  /** 'app': the app's own code path (route lookup + built-in backend). 'direct': HTTP straight to llama-server. */
  mode: 'app' | 'direct';
  embedTexts?: number;
  rerankDocs?: number;
  rounds?: number;
}

interface AiBurstResult {
  mode: string;
  embedMs: number[];
  rerankMs: number[];
  embedOk: boolean;
  rerankOk: boolean;
  error: string | null;
}

interface DownloadOverride {
  file: string;
  url: string;
  size: number;
  sha256: string;
}

interface PerfProbeApi {
  version: 2;
  /** Event-loop delay in ms since the last reset (resetAfter=true restarts the window). */
  eventLoop(resetAfter?: boolean): Record<string, number>;
  /** Per-channel IPC stats since the last reset. */
  ipc(resetAfter?: boolean): {
    invoke: Record<string, ChannelStat>;
    send: Record<string, ChannelStat>;
    probeMs: number;
  };
  /** Toggle payload byte accounting (JSON.stringify per call is itself main-thread work). */
  setByteAccounting(on: boolean): void;
  /** Number of handlers registered per channel (a flat count means no handler churn). */
  handlerCount(): number;
  /**
   * Start / stop the event-loop-delay sampler. Its 10 ms timer wakes the main thread ~100x a second (about 2% of a
   * core by itself), so the hidden-idle CPU measurement switches it off while it measures.
   */
  eventLoopMonitor(on: boolean): void;
  /** app.getAppMetrics() + main process memory/CPU. */
  processMetrics(): unknown;
  /** Stops the main-process CPU profile started at boot by ARK_PERF_CPUPROF=1 and writes it to `file` (.cpuprofile). */
  stopCpuProfile(file: string): Promise<string | null>;
  /** (Re)starts the main-process CPU profile, e.g. to isolate an idle window after boot. */
  startCpuProfile(): boolean;
  /** The built-in local AI and the LiteLLM sidecar (see the header). */
  ai: {
    status(): Promise<unknown>;
    burst(opts: AiBurstOptions): Promise<AiBurstResult>;
    /** Point the chat model's manifest entry at a local HTTP server (download probe). */
    prepareDownload(o: DownloadOverride): Promise<{ modelId: string } | null>;
    restoreDownload(): Promise<boolean>;
    /** Configure one non-built-in chat route (a local OpenAI-compatible server) and start the sidecar by testing it. */
    startSidecar(o: { baseUrl: string; model: string }): Promise<unknown>;
  };
}

const stat = (): ChannelStat => ({ calls: 0, errors: 0, argBytes: 0, resultBytes: 0, totalMs: 0, maxMs: 0, maxPerSec: 0 });

/** `injected.electron` is a test seam (src/test/perf-probe.test.ts); the app calls it with no argument. */
export function installPerfProbes(injected?: { electron?: any }): void {
  if (process.env.ARK_PERF !== '1') return;
  const g = globalThis as unknown as { __arkPerf?: PerfProbeApi };
  if (g.__arkPerf) return;

  const electron = injected?.electron ?? require('electron');
  const { app, ipcMain } = electron;

  let byteAccounting = true;
  let probeMs = 0;
  let invoke: Record<string, ChannelStat> = {};
  let send: Record<string, ChannelStat> = {};
  let handlers = 0;
  const windows = new Map<string, number[]>();

  const sizeOf = (v: unknown): number => {
    if (v == null) return 0;
    if (typeof v === 'string') return v.length;
    if (v instanceof ArrayBuffer) return v.byteLength;
    if (ArrayBuffer.isView(v)) return v.byteLength;
    try {
      const t0 = performance.now();
      const n = JSON.stringify(v)?.length ?? 0;
      probeMs += performance.now() - t0;
      return n;
    } catch {
      return 0;
    }
  };
  const bytes = (v: unknown): number => (byteAccounting ? sizeOf(v) : 0);

  const record = (table: Record<string, ChannelStat>, channel: string, ms: number, a: number, r: number, failed: boolean) => {
    const s = (table[channel] ??= stat());
    s.calls++;
    if (failed) s.errors++;
    s.argBytes += a;
    s.resultBytes += r;
    s.totalMs += ms;
    if (ms > s.maxMs) s.maxMs = ms;
    // sliding one-second window: a burst that straddles a second boundary still counts as one burst
    const now = performance.now();
    const key = `${table === send ? 's' : 'i'}:${channel}`;
    const w = windows.get(key) ?? [];
    w.push(now);
    while (w.length && w[0] <= now - 1000) w.shift();
    windows.set(key, w);
    if (w.length > s.maxPerSec) s.maxPerSec = w.length;
  };

  // ipcMain.handle / ipcMain.on: wrap each listener as it is registered.
  const origHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel: string, listener: (...a: unknown[]) => unknown) => {
    handlers++;
    return origHandle(channel, async (event: unknown, ...args: unknown[]) => {
      const t0 = performance.now();
      let failed = false;
      let result: unknown;
      try {
        result = await listener(event, ...args);
        return result;
      } catch (err) {
        failed = true;
        throw err;
      } finally {
        record(invoke, channel, performance.now() - t0, bytes(args), failed ? 0 : bytes(result), failed);
      }
    });
  };
  const origOn = ipcMain.on.bind(ipcMain);
  ipcMain.on = (channel: string, listener: (...a: unknown[]) => unknown) => {
    handlers++;
    return origOn(channel, (event: unknown, ...args: unknown[]) => {
      const t0 = performance.now();
      let failed = false;
      try {
        return listener(event, ...args);
      } catch (err) {
        failed = true;
        throw err;
      } finally {
        record(invoke, `on:${channel}`, performance.now() - t0, bytes(args), 0, failed);
      }
    });
  };

  // Main -> renderer pushes
  app.on('web-contents-created', (_e: unknown, wc: { send: (channel: string, ...a: unknown[]) => void }) => {
    const origSend = wc.send.bind(wc);
    wc.send = (channel: string, ...args: unknown[]) => {
      record(send, channel, 0, bytes(args), 0, false);
      return origSend(channel, ...args);
    };
  });

  // ARK_PERF_CPUPROF=1: profile the main process from the first line of main.ts (boot cost), see stopCpuProfile()
  let profiler: { post: (m: string, p?: unknown, cb?: (e: Error | null, r?: any) => void) => void } | null = null;
  const startProfiler = (): boolean => {
    try {
      if (!profiler) {
        const inspector = require('node:inspector');
        const session = new inspector.Session();
        session.connect();
        session.post('Profiler.enable');
        session.post('Profiler.setSamplingInterval', { interval: 500 });
        profiler = session;
      }
      profiler!.post('Profiler.start');
      return true;
    } catch {
      return false;
    }
  };
  if (process.env.ARK_PERF_CPUPROF === '1') startProfiler();

  const hist = monitorEventLoopDelay({ resolution: 10 });
  hist.enable();
  const ms = (ns: number) => Math.round((ns / 1e6) * 100) / 100;


  // ---------------------------------------------------------------------------------------------- built-in AI probes
  // Variable specifiers keep tsc from resolving the modules, so the same file back-ports onto a build without them.
  const load = async (spec: string): Promise<any> => {
    try {
      return await import(spec);
    } catch {
      return null;
    }
  };
  const synthText = (i: number): string =>
    `Game ${i}: a ${['cozy farming', 'fast roguelike', 'story-rich adventure', 'tactical strategy', 'open-world survival', 'co-op shooter'][i % 6]} title with ` +
    `${['crafting', 'exploration', 'deck building', 'base building', 'boss fights', 'puzzles'][i % 6]} and a long campaign. Players praise the art direction, ` +
    `the soundtrack and the progression; critics mention pacing in the middle hours, ${3 + (i % 5)} difficulty modes and regular free updates after launch number ${i}.`;
  let manifestOverridden = false;

  const ai: PerfProbeApi['ai'] = {
    async status() {
      const out: Record<string, unknown> = { runtime: null, sidecar: null, backend: null, embeddingsVia: null, rerankerVia: null, chatVia: null };
      try {
        const svc = (await load('./local-ai/service.js'))?.getLocalAiService?.();
        if (svc) {
          out.runtime = svc.runtime.status().map((r: any) => ({ role: r.role, state: r.state, pid: r.pid, restarts: r.restarts, cpuFallback: r.cpuFallback }));
        }
      } catch (e) {
        out.runtimeError = String(e);
      }
      try {
        const backend = await load('./local-ai/backend.js');
        out.backend = backend?.getBackendKind?.() ?? null;
      } catch {
        /* absent */
      }
      try {
        const rs = await load('./ai-router/service.js');
        if (rs) {
          const { sidecar } = rs.getAiRouterService();
          const st = sidecar.status();
          out.sidecar = { state: st.state, pid: st.pid, restarts: st.restarts };
          out.embeddingsVia = rs.routeFor('embeddings').via;
          out.rerankerVia = rs.routeFor('reranker').via;
          out.chatVia = rs.routeFor('chat').via;
        }
      } catch (e) {
        out.sidecarError = String(e);
      }
      return out;
    },

    async burst(opts: AiBurstOptions): Promise<AiBurstResult> {
      const res: AiBurstResult = { mode: opts.mode, embedMs: [], rerankMs: [], embedOk: true, rerankOk: true, error: null };
      const nText = opts.embedTexts ?? 32;
      const nDocs = opts.rerankDocs ?? 32;
      const rounds = opts.rounds ?? 1;
      const texts = Array.from({ length: nText }, (_, i) => synthText(i));
      const docs = Array.from({ length: nDocs }, (_, i) => synthText(i + 1000));
      const query = 'a cozy game with crafting and a long story campaign';
      try {
        const svc = (await load('./local-ai/service.js'))?.getLocalAiService?.();
        const embedApp = (await load('./ollama-setup.js'))?.generateEmbeddingsBatchDetailed;
        const rerankApp = (await load('./ipc/ollama-handlers.js'))?.rerankViaNativeEndpoint;
        if (!svc || !embedApp || !rerankApp) throw new Error('built-in AI modules missing in this build');
        const post = async (role: 'embed' | 'rerank', path: string, body: unknown): Promise<unknown> => {
          // peek first: ensure() with default launch options could restart a server the app started with its session options
          const info = svc.runtime.peek(role) ?? (await svc.runtime.ensure(role));
          const r = await fetch(`${info.baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${info.apiKey}` },
            body: JSON.stringify(body),
          });
          const text = await r.text();
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          svc.runtime.markUsed(role);
          return JSON.parse(text);
        };
        for (let i = 0; i < rounds; i++) {
          let t0 = performance.now();
          if (opts.mode === 'app') {
            const e = await embedApp(texts);
            res.embedOk = res.embedOk && !e.error && e.embeddings.every((v: unknown) => Array.isArray(v));
          } else {
            const e = (await post('embed', '/v1/embeddings', { input: texts, encoding_format: 'float' })) as { data?: unknown[] };
            res.embedOk = res.embedOk && (e.data?.length ?? 0) === texts.length;
          }
          res.embedMs.push(performance.now() - t0);
          t0 = performance.now();
          if (opts.mode === 'app') {
            const r = await rerankApp(query, docs, docs.length, 'perf');
            res.rerankOk = res.rerankOk && r.code === 'ok';
          } else {
            const r = (await post('rerank', '/v1/rerank', { query, documents: docs, top_n: docs.length })) as { results?: unknown[] };
            res.rerankOk = res.rerankOk && (r.results?.length ?? 0) === docs.length;
          }
          res.rerankMs.push(performance.now() - t0);
        }
      } catch (e) {
        res.error = e instanceof Error ? e.message : String(e);
        res.embedOk = false;
        res.rerankOk = false;
      }
      return res;
    },

    async prepareDownload(o: DownloadOverride) {
      const man = await load('./local-ai/manifest.js');
      if (!man?.getManifest || !man.__setManifestForTests) return null;
      const clone = JSON.parse(JSON.stringify(man.getManifest()));
      const chat = clone.models.find((m: any) => m.role === 'chat');
      if (!chat) return null;
      chat.file = o.file;
      chat.sources = [{ kind: 'huggingface', url: o.url, sha256: o.sha256, size: o.size, verifiedWith: { build: clone.runtime.build, check: 'metadata' } }];
      man.__setManifestForTests(clone);
      manifestOverridden = true;
      // the store may have cached the previous chat file's state
      try {
        const svc = (await load('./local-ai/service.js'))?.getLocalAiService?.();
        await svc?.store.refresh?.();
      } catch {
        /* the download call refreshes it again */
      }
      return { modelId: chat.id as string };
    },

    async restoreDownload() {
      const man = await load('./local-ai/manifest.js');
      if (!man?.__setManifestForTests || !manifestOverridden) return false;
      man.__setManifestForTests(null);
      manifestOverridden = false;
      return true;
    },

    async startSidecar(o: { baseUrl: string; model: string }) {
      const rs = await load('./ai-router/service.js');
      if (!rs) return null;
      const { store, router, sidecar } = rs.getAiRouterService();
      store.upsertConnector({ id: 'perf-fake', kind: 'openai-compatible', name: 'Perf fake server', baseUrl: o.baseUrl, roles: ['chat'] });
      store.setRoute('chat', 'perf-fake', o.model, { force: true });
      const t0 = performance.now();
      let error: string | null = null;
      try {
        await router.test('perf-fake', { role: 'chat', model: o.model });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const st = sidecar.status();
      return { state: st.state, pid: st.pid, startMs: Math.round(performance.now() - t0), error };
    },
  };


  g.__arkPerf = {
    version: 2,
    eventLoop(resetAfter = false) {
      const out = {
        count: hist.count,
        min: ms(hist.min),
        mean: ms(hist.mean),
        p50: ms(hist.percentile(50)),
        p99: ms(hist.percentile(99)),
        max: ms(hist.max),
      };
      if (resetAfter) hist.reset();
      return out;
    },
    ipc(resetAfter = false) {
      const out = { invoke, send, probeMs: Math.round(probeMs * 100) / 100 };
      if (resetAfter) {
        invoke = {};
        send = {};
        probeMs = 0;
        windows.clear();
      }
      // Detach from the live tables when resetting; otherwise hand back a copy.
      return resetAfter ? out : JSON.parse(JSON.stringify(out));
    },
    setByteAccounting(on: boolean) {
      byteAccounting = on;
    },
    handlerCount: () => handlers,
    eventLoopMonitor(on: boolean) {
      if (on) hist.enable();
      else hist.disable();
    },
    startCpuProfile: startProfiler,
    ai,
    stopCpuProfile(file: string) {
      return new Promise<string | null>((resolve) => {
        if (!profiler) return resolve(null);
        profiler.post('Profiler.stop', undefined, (err, res) => {
          if (err || !res?.profile) return resolve(null);
          require('node:fs').writeFileSync(file, JSON.stringify(res.profile));
          resolve(file);
        });
      });
    },
    processMetrics() {
      return {
        pid: process.pid,
        appMetrics: app.getAppMetrics(),
        mainMemory: process.memoryUsage(),
        mainCpu: process.cpuUsage(),
        uptimeS: process.uptime(),
      };
    },
  };
}
