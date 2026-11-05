/**
 * Process manager for the built-in llama.cpp servers (1.0.97 B36).
 *
 * One `llama-server` per role (embed, rerank, rerank-qwen, chat), each started lazily on the first
 * request and stopped again when idle (chat after 10 min, the others after 30). Every server
 * binds 127.0.0.1 on a free port from Ark's private range (never 11434) with a per-launch random
 * `--api-key`, so another app on the machine can neither find nor use it; ports and keys live only
 * in memory.
 *
 * Failure handling:
 *  - GPU layers go out with `-ngl`; a server that dies before it is healthy, or whose log shows a
 *    Vulkan / out-of-memory error, is relaunched once on the CPU (`-ngl 0`). The choice sticks for
 *    the session.
 *  - A server that crashes while running is restarted with backoff, at most `maxRestarts` times in
 *    a row (a run that stayed healthy for `stableMs` resets the count). A GPU-class crash while
 *    serving (Vulkan error in the log, or a second crash in a row after the weights were on the GPU)
 *    falls back to the CPU like a startup failure. After that the role is `failed` until `reset()`
 *    or until `failedCooldownMs` has passed, when the next request makes one more attempt.
 *  - `stop()` resolves only after the old process exited (bounded wait), so a relaunch never
 *    overlaps the old one's VRAM.
 *  - Ports are reserved under a lock before the pick returns, and a server only counts as ready
 *    once an authenticated request with its own api key succeeds, so a foreign listener (or a
 *    sibling role that won the same port) is never mistaken for it. A bind failure is retried on
 *    another port.
 *  - Every child is put into Ark's kill-on-close Windows job object (native `jobAssignKillOnClose`),
 *    so a crash or Task Manager kill of Ark takes the servers with it; `stopAllSync()` covers a
 *    normal quit. No tray, autostart, PATH, registry or service changes.
 *
 * Everything that touches the OS (spawn, fetch, ports, job object, clock) is injectable.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LocalAiRole } from './manifest.js';
import { pickFreePort } from './ports.js';

/** The slice of a child process the manager uses (a fake in tests). */
export interface ChildLike {
  pid?: number;
  stdout?: { on(event: 'data', fn: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: 'data', fn: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'exit', fn: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type RuntimeState = 'stopped' | 'starting' | 'ready' | 'failed';

export interface GpuInfo {
  /** Device the weights landed on, from the server log ("Vulkan0", "CPU"). */
  device: string | null;
  /** Marketing name of the GPU the weights landed on ("NVIDIA GeForce RTX 3070 Ti Laptop GPU"). */
  deviceName: string | null;
  layersOffloaded: number | null;
  layersTotal: number | null;
  gpuBytes: number;
  cpuBytes: number;
}

export interface ServerInfo {
  role: LocalAiRole;
  port: number;
  apiKey: string;
  baseUrl: string;
  gpu: GpuInfo;
  /** True when the server runs on the CPU because the GPU launch failed. */
  cpuFallback: boolean;
}

/** Context (and minimum physical batch) of the embedding and cross-encoder servers. */
export const ENCODER_CTX = 8192;

function isEncoderRole(role: LocalAiRole): boolean {
  return role === 'embed' || role === 'rerank';
}

/** -b/-ub of an encoder server: never below the context, so no input is rejected for its length. */
function encoderBatch(l: { numBatch?: number }): number {
  return Math.max(ENCODER_CTX, l.numBatch && l.numBatch > 0 ? l.numBatch : 0);
}

export interface LaunchOptions {
  /** Embed/rerank: tokens per pass (`-b`/`-ub`), never below ENCODER_CTX. Changing the effective value restarts the server. */
  numBatch?: number;
  /** CPU threads (`-t`). */
  numThread?: number;
  /** Chat: context length (`-c`). Changing it restarts the server. */
  numCtx?: number;
}

export interface RoleStatus {
  role: LocalAiRole;
  state: RuntimeState;
  port: number | null;
  pid: number | null;
  restarts: number;
  cpuFallback: boolean;
  lastError: string | null;
  gpu: GpuInfo | null;
}

export interface LlamaRuntimeDeps {
  /** Folder holding llama-server.exe and its DLLs. */
  runtimeDir: () => string;
  /** Verified model file for the role, or null when it is not downloaded yet. */
  modelPath: (role: LocalAiRole) => string | null;
  spawn?: (command: string, args: string[], options: { cwd: string }) => ChildLike;
  fetchFn?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>;
  pickPort?: (exclude: number[]) => Promise<number | null>;
  /** Put the child in the kill-on-close job object. */
  assignToJob?: (pid: number) => boolean;
  randomKey?: () => string;
  now?: () => number;
  fileExists?: (p: string) => boolean;
  log?: (msg: string) => void;
  /** Overrides of the defaults below (tests use short values). */
  idleMs?: Partial<Record<LocalAiRole, number>>;
  startTimeoutMs?: Partial<Record<LocalAiRole, number>>;
  /** How long stop() waits for the process to exit. */
  stopWaitMs?: number;
  /** How long a role stays `failed` before the next request may try again. */
  failedCooldownMs?: number;
  healthIntervalMs?: number;
  maxRestarts?: number;
  backoffMs?: number[];
  stableMs?: number;
  /** Platform executable name. */
  serverExe?: string;
}

const MIN = 60_000;
export const DEFAULT_IDLE_MS: Record<LocalAiRole, number> = {
  chat: 10 * MIN,
  embed: 30 * MIN,
  rerank: 30 * MIN,
  'rerank-qwen': 30 * MIN,
};
const DEFAULT_START_TIMEOUT_MS: Record<LocalAiRole, number> = {
  chat: 5 * MIN,
  embed: 3 * MIN,
  rerank: 3 * MIN,
  'rerank-qwen': 3 * MIN,
};
export const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_BACKOFF_MS = [500, 2_000, 5_000];
const DEFAULT_STABLE_MS = MIN;
const GPU_LAYERS_ALL = 99;
/** A log line like this means the GPU path is not usable: retry on the CPU. */
const GPU_FAILURE_RE = /out of memory|ErrorOutOfDeviceMemory|ErrorOutOfHostMemory|ErrorDeviceLost|ErrorInitializationFailed|vk::|vulkan.*(fail|error)|failed to allocate|ggml_vulkan.*error|device lost/i;
/** llama-server could not bind its port (taken by another process). */
const BIND_FAILURE_RE = /couldn't bind|could not bind|failed to bind|address already in use|EADDRINUSE|only one usage of each socket/i;
const MAX_BIND_RETRIES = 3;
const LOG_TAIL_LINES = 40;
/** Stored and scanned length of one log line (the device/offload/error lines are far shorter). */
const MAX_LOG_LINE = 300;
/** A chunk longer than this is cut to its head and tail before it is split into lines. */
const MAX_LOG_CHUNK = 16_384;
const DEFAULT_STOP_WAIT_MS = 3_000;
const DEFAULT_FAILED_COOLDOWN_MS = 60_000;

/** A signal that aborts after `ms` (AbortSignal.timeout is missing from some environments). */
function timeoutSignal(ms: number): AbortSignal {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms).unref?.();
  return ac.signal;
}

export class RuntimeError extends Error {
  constructor(message: string, readonly code: 'no_runtime' | 'no_model' | 'no_port' | 'start_failed' | 'failed_too_often') {
    super(message);
    this.name = 'RuntimeError';
  }
}

interface Slot {
  role: LocalAiRole;
  state: RuntimeState;
  child: ChildLike | null;
  port: number | null;
  apiKey: string | null;
  launch: LaunchOptions;
  restarts: number;
  startedHealthyAt: number | null;
  cpuFallback: boolean;
  gpu: GpuInfo;
  lastError: string | null;
  starting: Promise<ServerInfo> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  /** Set while we stop the child on purpose, so its exit is not treated as a crash. */
  stopping: boolean;
  /** Pending stop(): the old process may still be exiting. */
  stopPromise: Promise<void> | null;
  /** Clock time the role entered `failed`. */
  failedAt: number | null;
  /** -ngl of the current launch (0 = CPU). */
  launchedGpuLayers: number;
  logTail: string[];
}

/** Keep log handling cheap: huge chunks (request bodies at debug verbosity) are cut to head + tail. */
function boundedChunkText(chunk: Buffer | string): string {
  const half = MAX_LOG_CHUNK / 2;
  if (typeof chunk === 'string') {
    return chunk.length > MAX_LOG_CHUNK ? `${chunk.slice(0, half)}\n${chunk.slice(-half)}` : chunk;
  }
  if (chunk.length > MAX_LOG_CHUNK) {
    return `${chunk.subarray(0, half).toString('utf8')}\n${chunk.subarray(chunk.length - half).toString('utf8')}`;
  }
  return chunk.toString('utf8');
}

function emptyGpu(): GpuInfo {
  return { device: null, deviceName: null, layersOffloaded: null, layersTotal: null, gpuBytes: 0, cpuBytes: 0 };
}

/** Fold one llama-server log line into the GPU summary. Exported for tests. */
export function parseGpuLogLine(line: string, gpu: GpuInfo): void {
  const off = /offloaded\s+(\d+)\s*\/\s*(\d+)\s+layers to GPU/i.exec(line);
  if (off) {
    gpu.layersOffloaded = Number(off[1]);
    gpu.layersTotal = Number(off[2]);
  }
  // "llama_prepare_model_devices: using device Vulkan1 (NVIDIA GeForce RTX 3070 Ti Laptop GPU) (0000:01:00.0) - 7246 MiB free"
  const dev = /using device\s+(\S+)\s+\((.+?)\)(?:\s+\(|\s+-|\s*$)/i.exec(line);
  if (dev && !/^CPU/i.test(dev[1]!)) { gpu.device = dev[1]!; gpu.deviceName = dev[2]!; }
  const buf = /\b([A-Za-z_]+\d*(?:_Mapped|_Host)?)\s+model buffer size\s*=\s*([\d.]+)\s*MiB/i.exec(line);
  if (buf) {
    const bytes = Math.round(Number(buf[2]) * 1024 * 1024);
    if (/^CPU/i.test(buf[1]!)) gpu.cpuBytes += bytes;
    else { gpu.gpuBytes += bytes; gpu.device = buf[1]!; }
  }
}

export class LlamaRuntime {
  private readonly slots = new Map<LocalAiRole, Slot>();
  private readonly deps: Required<Omit<LlamaRuntimeDeps, 'idleMs' | 'startTimeoutMs'>> & Pick<LlamaRuntimeDeps, 'idleMs' | 'startTimeoutMs'>;
  private readonly usedPorts = new Set<number>();
  /** Serialises port picking so two roles never get the same port. */
  private portLock: Promise<unknown> = Promise.resolve();
  private shuttingDown = false;
  private readonly listeners = new Set<(s: RoleStatus[]) => void>();

  constructor(deps: LlamaRuntimeDeps) {
    this.deps = {
      spawn: (cmd, args, options) => nodeSpawn(cmd, args, {
        cwd: options.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as unknown as ChildProcess as unknown as ChildLike,
      fetchFn: (url, init) => fetch(url, init),
      pickPort: (exclude) => pickFreePort({ exclude }),
      assignToJob: () => false,
      randomKey: () => randomBytes(24).toString('hex'),
      now: () => Date.now(),
      fileExists: (p) => fs.existsSync(p),
      log: () => undefined,
      healthIntervalMs: 250,
      maxRestarts: DEFAULT_MAX_RESTARTS,
      backoffMs: DEFAULT_BACKOFF_MS,
      stableMs: DEFAULT_STABLE_MS,
      serverExe: 'llama-server.exe',
      ...deps,
    } as LlamaRuntime['deps'];
  }

  private slot(role: LocalAiRole): Slot {
    let s = this.slots.get(role);
    if (!s) {
      s = {
        role, state: 'stopped', child: null, port: null, apiKey: null, launch: {}, restarts: 0,
        startedHealthyAt: null, cpuFallback: false, gpu: emptyGpu(), lastError: null, starting: null,
        idleTimer: null, restartTimer: null, stopping: false, stopPromise: null, failedAt: null,
        launchedGpuLayers: 0, logTail: [],
      };
      this.slots.set(role, s);
    }
    return s;
  }

  private idleMs(role: LocalAiRole): number {
    return this.deps.idleMs?.[role] ?? DEFAULT_IDLE_MS[role];
  }

  private startTimeoutMs(role: LocalAiRole): number {
    return this.deps.startTimeoutMs?.[role] ?? DEFAULT_START_TIMEOUT_MS[role];
  }

  serverPath(): string {
    return path.join(this.deps.runtimeDir(), this.deps.serverExe);
  }

  /** True when the packaged runtime folder holds llama-server. */
  isRuntimeAvailable(): boolean {
    return this.deps.fileExists(this.serverPath());
  }

  onChange(fn: (s: RoleStatus[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snap = this.status();
    for (const fn of this.listeners) {
      try { fn(snap); } catch { /* listeners must not break the manager */ }
    }
  }

  status(): RoleStatus[] {
    return [...this.slots.values()].map((s) => ({
      role: s.role, state: s.state, port: s.port, pid: s.child?.pid ?? null, restarts: s.restarts,
      cpuFallback: s.cpuFallback, lastError: s.lastError, gpu: s.state === 'ready' ? { ...s.gpu } : null,
    }));
  }

  roleStatus(role: LocalAiRole): RoleStatus {
    return this.status().find((s) => s.role === role)
      ?? { role, state: 'stopped', port: null, pid: null, restarts: 0, cpuFallback: false, lastError: null, gpu: null };
  }

  /** Info for a running server, without starting one. */
  peek(role: LocalAiRole): ServerInfo | null {
    const s = this.slots.get(role);
    return s && s.state === 'ready' ? this.info(s) : null;
  }

  private info(s: Slot): ServerInfo {
    return {
      role: s.role, port: s.port!, apiKey: s.apiKey!, baseUrl: `http://127.0.0.1:${s.port}`,
      gpu: { ...s.gpu }, cpuFallback: s.cpuFallback,
    };
  }

  /**
   * The server for `role`, started on demand. Concurrent callers share one start. A running server
   * whose launch options differ (batch size, context) is restarted with the new ones.
   */
  async ensure(role: LocalAiRole, launch: LaunchOptions = {}): Promise<ServerInfo> {
    if (this.shuttingDown) throw new RuntimeError('Ark is shutting down', 'start_failed');
    const s = this.slot(role);
    if (s.stopPromise) await s.stopPromise; // the old process must be gone before a new one loads
    if (this.shuttingDown) throw new RuntimeError('Ark is shutting down', 'start_failed');
    if (s.state === 'failed' && s.failedAt !== null
      && this.deps.now() - s.failedAt >= (this.deps.failedCooldownMs ?? DEFAULT_FAILED_COOLDOWN_MS)) {
      // Half-open: one more try. Any crash right after it goes straight back to `failed`.
      this.deps.log(`[LocalAI] ${role}: retrying after the cool-down`);
      s.state = 'stopped';
      s.failedAt = null;
      s.restarts = this.deps.maxRestarts;
    }
    if (s.state === 'failed') {
      throw new RuntimeError(s.lastError ?? `The ${role} server failed too often; use Re-check to try again`, 'failed_too_often');
    }
    const wanted: LaunchOptions = { ...s.launch, ...launch };
    if (s.state === 'ready' && !this.sameLaunch(role, s.launch, wanted)) {
      this.deps.log(`[LocalAI] ${role}: launch options changed, restarting`);
      await this.stop(role);
    }
    if (s.state === 'ready') {
      this.touch(s);
      return this.info(s);
    }
    if (s.starting) return s.starting;
    s.launch = wanted;
    s.starting = this.start(s).finally(() => { s.starting = null; });
    return s.starting;
  }

  private sameLaunch(role: LocalAiRole, a: LaunchOptions, b: LaunchOptions): boolean {
    const batch = (l: LaunchOptions) => (isEncoderRole(role) ? encoderBatch(l) : l.numBatch);
    return batch(a) === batch(b) && a.numThread === b.numThread && a.numCtx === b.numCtx;
  }

  private touch(s: Slot): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      this.deps.log(`[LocalAI] ${s.role}: idle, unloading`);
      void this.stop(s.role);
    }, this.idleMs(s.role));
    s.idleTimer.unref?.();
  }

  /** Mark the server as used now (restarts its idle timer). */
  markUsed(role: LocalAiRole): void {
    const s = this.slots.get(role);
    if (s && s.state === 'ready') this.touch(s);
  }

  private buildArgs(s: Slot, port: number, apiKey: string, model: string, gpuLayers: number): string[] {
    const l = s.launch;
    // `-lv 4` makes b11780 print the device / offload / buffer lines parseGpuLogLine reads (the default
    // level hides them, which would report every server as CPU). That is debug verbosity, so request text may
    // appear in the log: lines are cut to MAX_LOG_LINE, chunks to MAX_LOG_CHUNK, and only startup lines are scanned.
    const args = ['-m', model, '--host', '127.0.0.1', '--port', String(port), '--api-key', apiKey, '--no-webui', '-np', '1', '-lv', '4', '-ngl', String(gpuLayers)];
    // CPU launch: do not even initialise Vulkan, so a broken driver cannot take the fallback down too.
    if (gpuLayers === 0) args.push('--device', 'none');
    if (l.numThread && l.numThread > 0) args.push('-t', String(l.numThread));
    if (isEncoderRole(s.role)) {
      // Encoder models (arctic-embed2, bge-reranker) see a whole input in ONE physical batch, so -ub is a hard
      // per-input token limit (unlike Ollama's num_batch, which only sizes the work chunks and truncates at
      // num_ctx instead of failing). 8192 = the models' trained context; texts up to ~3000 CJK characters fit.
      const batch = encoderBatch(l);
      args.push('-c', String(ENCODER_CTX), '-b', String(batch), '-ub', String(batch));
      if (s.role === 'embed') args.push('--embedding', '--pooling', 'cls');
      else args.push('--reranking', '--pooling', 'rank');
    } else if (s.role === 'rerank-qwen') {
      args.push('-c', '4096', '-b', '2048', '-ub', '2048');
    } else {
      args.push('--jinja', '-c', String(l.numCtx && l.numCtx > 0 ? l.numCtx : 8192));
    }
    return args;
  }

  private async start(s: Slot): Promise<ServerInfo> {
    const role = s.role;
    if (!this.isRuntimeAvailable()) {
      throw new RuntimeError('The built-in AI runtime is missing from this install', 'no_runtime');
    }
    const model = this.deps.modelPath(role);
    if (!model) throw new RuntimeError(`The ${role} model is not downloaded yet`, 'no_model');

    s.state = 'starting';
    s.lastError = null;
    this.emit();
    try {
      let useGpu = !s.cpuFallback;
      const avoidPorts: number[] = [];
      let bindRetries = 0;
      for (;;) {
        const outcome = await this.launchOnce(s, model, useGpu ? GPU_LAYERS_ALL : 0, avoidPorts);
        if (outcome.ok) return this.info(s);
        if (outcome.bindFailure && outcome.port !== null && bindRetries < MAX_BIND_RETRIES && !this.shuttingDown) {
          bindRetries += 1;
          avoidPorts.push(outcome.port);
          this.deps.log(`[LocalAI] ${role}: port ${outcome.port} could not be bound; retrying on another port`);
          continue;
        }
        if (useGpu && outcome.gpuProblem && !this.shuttingDown) {
          this.deps.log(`[LocalAI] ${role}: GPU launch failed (${outcome.reason}); retrying on the CPU`);
          s.cpuFallback = true;
          useGpu = false;
          continue;
        }
        throw new RuntimeError(outcome.reason, 'start_failed');
      }
    } catch (err) {
      s.lastError = err instanceof Error ? err.message : String(err);
      if ((s.state as RuntimeState) === 'failed') {
        // already failed (crash path)
      } else if (err instanceof RuntimeError && err.code === 'start_failed' && !this.shuttingDown) {
        // The GPU -> CPU retry above already ran, so the server cannot start at all. Mark the role
        // failed (cool-down retry or Re-check clears it) so tier detection skips it and the caller
        // falls through to the next tier instead of spawning the broken server on every request.
        s.state = 'failed';
        s.failedAt = this.deps.now();
      } else {
        s.state = 'stopped';
      }
      this.emit();
      throw err;
    }
  }

  /** One launch attempt: spawn, wait for /health, report why it failed. */
  private async launchOnce(
    s: Slot,
    model: string,
    gpuLayers: number,
    avoidPorts: number[] = [],
  ): Promise<{ ok: boolean; reason: string; gpuProblem: boolean; bindFailure: boolean; port: number | null }> {
    const role = s.role;
    const port = await this.reservePort(avoidPorts);
    if (port === null) throw new RuntimeError('No free local port for the built-in AI server', 'no_port');
    const apiKey = this.deps.randomKey();
    s.port = port;
    s.apiKey = apiKey;
    s.gpu = emptyGpu();
    s.logTail = [];
    s.stopping = false;
    s.launchedGpuLayers = gpuLayers;

    let child: ChildLike;
    try {
      child = this.deps.spawn(this.serverPath(), this.buildArgs(s, port, apiKey, model, gpuLayers), { cwd: this.deps.runtimeDir() });
    } catch (err) {
      this.usedPorts.delete(port);
      return { ok: false, reason: `Could not start llama-server: ${err instanceof Error ? err.message : String(err)}`, gpuProblem: false, bindFailure: false, port };
    }
    s.child = child;
    if (typeof child.pid === 'number' && !this.deps.assignToJob(child.pid)) {
      this.deps.log(`[LocalAI] ${role}: job object unavailable; relying on kill-on-quit`);
    }

    let exited: { code: number | null; signal: string | null } | null = null;
    let spawnError: string | null = null;
    let gpuProblem = false;
    // Only the startup lines carry the device / offload / failure information; once the server is
    // healthy lines are just kept (truncated) for the crash report, never regex-scanned.
    let scanning = true;
    const onLog = (chunk: Buffer | string) => {
      for (const raw of boundedChunkText(chunk).split(/\r?\n/)) {
        if (!raw.trim()) continue;
        const line = raw.length > MAX_LOG_LINE ? raw.slice(0, MAX_LOG_LINE) : raw;
        s.logTail.push(line);
        if (s.logTail.length > LOG_TAIL_LINES) s.logTail.shift();
        if (!scanning) continue;
        parseGpuLogLine(line, s.gpu);
        if (gpuLayers > 0 && GPU_FAILURE_RE.test(line)) gpuProblem = true;
      }
    };
    child.stdout?.on('data', onLog);
    child.stderr?.on('data', onLog);
    child.on('error', (err) => {
      s.lastError = err.message;
      // A failed spawn emits 'error' and never 'exit': end the start wait now (later errors, e.g. a failed kill, are not fatal).
      if (scanning) spawnError = err.message;
    });
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      this.onExit(s, child, code, signal);
    });

    const base = `http://127.0.0.1:${port}`;
    const deadline = this.deps.now() + this.startTimeoutMs(role);
    while (this.deps.now() < deadline) {
      if (exited || spawnError) break;
      if (this.shuttingDown || s.stopping) break;
      try {
        const res = await this.deps.fetchFn(`${base}/health`, { signal: timeoutSignal(2_000) });
        // /health is open to anyone on the port: ready only when our own api key is accepted too.
        if (res.ok && !exited && !spawnError && await this.ownsPort(base, apiKey)) {
          scanning = false;
          s.state = 'ready';
          s.startedHealthyAt = this.deps.now();
          this.touch(s);
          this.emit();
          this.deps.log(`[LocalAI] ${role}: ready on 127.0.0.1:${port} (${gpuLayers > 0 ? 'GPU' : 'CPU'})`);
          return { ok: true, reason: '', gpuProblem: false, bindFailure: false, port };
        }
      } catch {
        // Not listening yet.
      }
      await new Promise<void>((r) => setTimeout(r, this.deps.healthIntervalMs));
    }

    const tail = s.logTail.slice(-6).join(' | ').slice(0, 400);
    const ex = exited as { code: number | null; signal: string | null } | null;
    const failedSpawn = spawnError as string | null;
    scanning = false;
    const reason = failedSpawn
      ? `Could not start llama-server: ${failedSpawn}`
      : ex
      ? `llama-server exited (code ${ex.code ?? 'none'}${ex.signal ? `, ${ex.signal}` : ''})${tail ? `: ${tail}` : ''}`
      : `llama-server did not become healthy within ${Math.round(this.startTimeoutMs(role) / 1000)}s${tail ? `: ${tail}` : ''}`;
    s.stopping = true;
    this.killChild(child);
    this.usedPorts.delete(port);
    s.child = null;
    return {
      ok: false, reason, port,
      gpuProblem: !failedSpawn && (gpuProblem || (gpuLayers > 0 && GPU_FAILURE_RE.test(tail))),
      bindFailure: !!ex && BIND_FAILURE_RE.test(s.logTail.join('\n')),
    };
  }

  /** Pick a free port and reserve it before anyone else can pick (two roles starting together get different ports). */
  private reservePort(avoid: number[]): Promise<number | null> {
    const run = this.portLock.then(async () => {
      const port = await this.deps.pickPort([...this.usedPorts, ...avoid]);
      if (port !== null) this.usedPorts.add(port);
      return port;
    });
    this.portLock = run.catch(() => undefined);
    return run;
  }

  /** True when the server on `base` accepts our api key, i.e. it is the process we launched. */
  private async ownsPort(base: string, apiKey: string): Promise<boolean> {
    try {
      const res = await this.deps.fetchFn(`${base}/props`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: timeoutSignal(2_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private onExit(s: Slot, child: ChildLike, code: number | null, signal: string | null): void {
    if (s.child !== child) return; // an older child, already replaced or abandoned
    const wasReady = s.state === 'ready';
    const port = s.port;
    s.child = null;
    if (port !== null) this.usedPorts.delete(port);
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
    if (s.stopping || this.shuttingDown) {
      s.state = 'stopped';
      this.emit();
      return;
    }
    if (!wasReady) return; // launchOnce sees the exit and reports it
    // Crash while serving.
    const healthyFor = s.startedHealthyAt === null ? 0 : this.deps.now() - s.startedHealthyAt;
    if (healthyFor >= this.deps.stableMs) s.restarts = 0;
    s.lastError = `llama-server crashed (code ${code ?? 'none'}${signal ? `, ${signal}` : ''})`;
    this.deps.log(`[LocalAI] ${s.role}: ${s.lastError}`);
    // A driver reset / VRAM loss while serving: relaunching on the same GPU would only crash again.
    // A driver reset often leaves no log line, so a second crash in a row with the weights on the GPU counts too.
    if (!s.cpuFallback && s.launchedGpuLayers > 0
      && (GPU_FAILURE_RE.test(s.logTail.join('\n')) || (s.restarts >= 1 && s.gpu.gpuBytes > 0))) {
      s.cpuFallback = true;
      this.deps.log(`[LocalAI] ${s.role}: GPU crash while serving; restarting on the CPU`);
    }
    this.scheduleRestart(s);
  }

  /** Restart a crashed server after a backoff, or give up after `maxRestarts` in a row. */
  private scheduleRestart(s: Slot): void {
    if (this.shuttingDown) return;
    if (s.restarts >= this.deps.maxRestarts) {
      s.state = 'failed';
      s.failedAt = this.deps.now();
      s.lastError = `${s.lastError ?? 'llama-server failed'}; stopped restarting after ${s.restarts} attempts`;
      this.emit();
      return;
    }
    const delay = this.deps.backoffMs[Math.min(s.restarts, this.deps.backoffMs.length - 1)] ?? 1_000;
    s.restarts += 1;
    s.state = 'stopped';
    this.emit();
    s.restartTimer = setTimeout(() => {
      s.restartTimer = null;
      if (this.shuttingDown || s.state !== 'stopped') return;
      void this.ensure(s.role, s.launch).catch((err) => {
        this.deps.log(`[LocalAI] ${s.role}: restart failed: ${err instanceof Error ? err.message : String(err)}`);
        s.lastError = err instanceof Error ? err.message : String(err);
        this.scheduleRestart(s);
      });
    }, delay);
    s.restartTimer.unref?.();
  }

  private killChild(child: ChildLike): void {
    try { child.kill(); } catch { /* already gone */ }
  }

  /** Stop one server and wait (bounded) for the process to exit, so a relaunch never overlaps its VRAM. */
  stop(role: LocalAiRole): Promise<void> {
    const s = this.slots.get(role);
    if (!s) return Promise.resolve();
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
    if (s.restartTimer) { clearTimeout(s.restartTimer); s.restartTimer = null; }
    const child = s.child;
    if (!child) {
      if (s.state !== 'failed') s.state = 'stopped';
      return s.stopPromise ?? Promise.resolve();
    }
    s.stopping = true;
    const port = s.port;
    s.child = null;
    s.state = 'stopped';
    this.emit();
    const done: Promise<void> = this.killAndWait(child).then(() => {
      if (port !== null) this.usedPorts.delete(port);
      if (s.stopPromise === done) s.stopPromise = null;
    });
    s.stopPromise = done;
    return done;
  }

  /** Kill `child` and resolve when it exited (or after stopWaitMs). The listeners are attached before the kill. */
  private killAndWait(child: ChildLike): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => { if (timer) clearTimeout(timer); resolve(); };
      timer = setTimeout(finish, this.deps.stopWaitMs ?? DEFAULT_STOP_WAIT_MS);
      timer.unref?.();
      child.on('exit', finish);
      child.on('error', finish);
      this.killChild(child);
    });
  }

  /** Stop every server (game started, models being removed, settings changed). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.slots.keys()].map((r) => this.stop(r)));
  }

  /** Quit path: kill everything now, never wait. The job object covers a crash of Ark itself. */
  stopAllSync(): void {
    this.shuttingDown = true;
    for (const s of this.slots.values()) {
      if (s.idleTimer) clearTimeout(s.idleTimer);
      if (s.restartTimer) clearTimeout(s.restartTimer);
      s.stopping = true;
      if (s.child) this.killChild(s.child);
      s.child = null;
      s.state = 'stopped';
    }
    this.usedPorts.clear();
  }

  /** Clear a `failed` role (and the CPU-fallback choice) so the next request tries again. */
  reset(role?: LocalAiRole): void {
    for (const s of role ? [this.slot(role)] : this.slots.values()) {
      s.restarts = 0;
      s.failedAt = null;
      s.cpuFallback = false;
      s.lastError = null;
      if (s.state === 'failed') s.state = 'stopped';
    }
    this.emit();
  }

  /** Test seam: allow use again after stopAllSync. */
  __resumeForTests(): void {
    this.shuttingDown = false;
  }
}
