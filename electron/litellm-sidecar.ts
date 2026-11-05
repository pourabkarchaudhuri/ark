/**
 * LiteLLM sidecar manager (1.0.97 B35).
 *
 * Runs `python -I resources/litellm-runtime/ark_litellm.py` (the bundled CPython with LiteLLM
 * installed from a hash-locked file): LiteLLM's OpenAI-compatible proxy on 127.0.0.1 with a free
 * random port and a per-launch random master key. It routes chat, embeddings and reranking to the
 * connectors the user configured (see ai-router/).
 *
 * Secrets:
 *  - the generated config only carries `os.environ/ARK_KEY_<n>` references; the real keys and the
 *    master key reach the child through its environment, never the config file, argv or logs;
 *  - the config sits in a per-launch folder under the work dir and is deleted when the process
 *    exits (or on quit); log lines are scrubbed of every secret value before they are kept.
 *
 * Lifecycle: started lazily on the first request that needs it; a different config (routes, keys,
 * connectors changed) regenerates the file and restarts the process; a crash restarts it with
 * backoff, at most `maxRestarts` times in a row (a run that stayed healthy for `stableMs` resets the
 * count), then the sidecar is `failed` until `reset()`. The child joins Ark's kill-on-close Windows
 * job object and `stopSync()` kills it on quit, so no orphan survives.
 *
 * Everything that touches the OS (spawn, fetch, ports, job object, files, clock) is injectable.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pickFreePort } from './local-ai/ports.js';
import { scrubSecrets } from './secret-scrub.js';

/** The slice of a child process the manager uses (a fake in tests). */
export interface ChildLike {
  pid?: number;
  stdout?: { on(event: 'data', fn: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: 'data', fn: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'exit', fn: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SidecarState = 'stopped' | 'starting' | 'ready' | 'failed';

export interface SidecarSpec {
  /** Generated LiteLLM config (no secrets). */
  config: unknown;
  /** ARK_KEY_<n> -> secret value. */
  env: Record<string, string>;
  /** Changes whenever config or any secret changes. */
  hash: string;
  /**
   * Changes only when something a routed role depends on changes. A request that merely needs the
   * routes served (embed, rerank, chat) is satisfied by a running sidecar with the same `routedHash`,
   * whatever happened to the connectors that are not routed. Absent: `hash` decides.
   */
  routedHash?: string;
  /** The caller needs a sidecar started with exactly this `hash` (a connection test of a not-yet-routed connector). */
  exact?: boolean;
}

export interface SidecarInfo {
  baseUrl: string;
  masterKey: string;
}

export interface SidecarStatus {
  state: SidecarState;
  port: number | null;
  pid: number | null;
  restarts: number;
  lastError: string | null;
  configHash: string | null;
  /** `routedHash` of the running config. */
  routedHash: string | null;
}

export class SidecarError extends Error {
  constructor(
    message: string,
    readonly code: 'no_runtime' | 'no_port' | 'start_failed' | 'failed_too_often',
    /** `bindFailure`: the child could not bind its port (taken meanwhile). `retryAfterMs`: refused by the start-failure cooldown, nothing was spawned. */
    readonly extra: { bindFailure?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'SidecarError';
  }
}

export interface SidecarFs {
  mkdirSync(dir: string): void;
  writeFileSync(file: string, data: string): void;
  rmSync(target: string): void;
}

export interface LitellmSidecarDeps {
  /** Folder holding python/python.exe and ark_litellm.py. */
  runtimeDir: () => string;
  /** Folder under which each launch gets its own private config folder. */
  workDir: () => string;
  spawn?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildLike;
  fetchFn?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>;
  pickPort?: (exclude: number[]) => Promise<number | null>;
  assignToJob?: (pid: number) => boolean;
  randomKey?: () => string;
  now?: () => number;
  fileExists?: (p: string) => boolean;
  fs?: SidecarFs;
  /** OS variables the interpreter needs (SystemRoot, TEMP). Nothing else of Ark's environment is passed on. */
  baseEnv?: () => Record<string, string>;
  /** Blocking wait used only on the quit path while a config folder is still locked. */
  sleepSync?: (ms: number) => void;
  log?: (msg: string) => void;
  healthIntervalMs?: number;
  startTimeoutMs?: number;
  maxRestarts?: number;
  backoffMs?: number[];
  stableMs?: number;
  /** Proxy variables resolved from the OS / Electron session (HTTPS_PROXY, HTTP_PROXY). */
  proxyEnv?: () => Promise<Record<string, string>>;
  /** Cooldowns after consecutive failed starts, in ms (the last one repeats). */
  startFailureCooldownMs?: number[];
}

const DEFAULT_START_TIMEOUT_MS = 90_000;
const DEFAULT_BACKOFF_MS = [500, 2_000, 5_000];
const DEFAULT_STABLE_MS = 60_000;
/** After a failed start, further requests fail fast for this long instead of spawning Python again. */
const DEFAULT_START_FAILURE_COOLDOWN_MS = [5_000, 15_000, 60_000];
export const SIDECAR_MAX_RESTARTS = 3;
const RUN_DIR_RETRIES = 8;
const RUN_DIR_RETRY_MS = 150;
const LOG_TAIL_LINES = 40;
/** The child exited because its port was already taken (the port is picked, released, and only bound ~25 s later). */
const BIND_FAILURE_RE = /address already in use|EADDRINUSE|only one usage of each socket|couldn't bind|could not bind|failed to bind/i;
/** Restarts on another port after a bind failure; these never count as start failures. */
const MAX_BIND_RETRIES = 3;
/** Port range for the sidecar: above the built-in llama.cpp range (47410-47473), never 11434. */
export const SIDECAR_PORT_BASE = 47600;
export const SIDECAR_PORT_SPAN = 64;

function timeoutSignal(ms: number): AbortSignal {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms).unref?.();
  return ac.signal;
}

/** Replace every secret value (and anything key-shaped) in a log line. Exported for tests. */
export function redactLine(line: string, secrets: Iterable<string>): string {
  let out = line;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('***');
  }
  return scrubSecrets(out);
}

/**
 * Variables that make Python reach the internet the way this PC does: the proxy the user configured
 * and the certificate bundle for networks that inspect TLS. They carry no secret of Ark's.
 */
const NETWORK_ENV = [
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
];

/**
 * `NO_PROXY` for the child: the user's own list plus loopback (v4 and v6), so Ark's calls to LiteLLM never
 * go through a proxy, plus `extraHosts` (the connectors on this machine or LAN, see `localConnectorHosts`).
 */
export function mergeNoProxy(existing: string | undefined, extraHosts: Iterable<string> = []): string {
  const parts = (existing ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  for (const h of ['127.0.0.1', 'localhost', '::1', ...extraHosts]) if (h && !parts.includes(h)) parts.push(h);
  return parts.join(',');
}

/** True for loopback, private/link-local addresses, single-label machine names and .local/.lan style names. */
export function isLocalNetworkName(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '::') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (h.includes(':')) return /^(fc|fd|fe80)/.test(h);
  return !h.includes('.') || /\.(local|lan|internal|home\.arpa|localdomain|intranet)$/.test(h);
}

/** Host names of the local-network `api_base` addresses in a generated LiteLLM config: they must bypass the injected proxy. */
export function localConnectorHosts(config: unknown): string[] {
  const out = new Set<string>();
  const list = (config as { model_list?: Array<{ litellm_params?: { api_base?: unknown } }> } | null)?.model_list;
  if (!Array.isArray(list)) return [];
  for (const m of list) {
    const base = m?.litellm_params?.api_base;
    if (typeof base !== 'string') continue;
    try {
      const host = new URL(base).hostname.replace(/^\[|\]$/g, '');
      if (isLocalNetworkName(host)) out.add(host);
    } catch { /* not a URL: nothing to bypass */ }
  }
  return [...out];
}

export function defaultBaseEnv(): Record<string, string> {
  const pick = ['SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'ProgramData', 'PATHEXT'];
  const out: Record<string, string> = {};
  for (const k of pick) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  for (const k of NETWORK_ENV) {
    for (const name of [k, k.toLowerCase()]) {
      const v = process.env[name];
      if (v) out[name] = v;
    }
  }
  return out;
}

export class LitellmSidecar {
  private readonly deps: Required<Omit<LitellmSidecarDeps, never>>;
  private state: SidecarState = 'stopped';
  private child: ChildLike | null = null;
  private port: number | null = null;
  private masterKey: string | null = null;
  private runDir: string | null = null;
  private spec: SidecarSpec | null = null;
  private specProvider: (() => SidecarSpec | null) | null = null;
  private runningHash: string | null = null;
  private runningRoutedHash: string | null = null;
  /** Consecutive failed starts (not crashes of a healthy run), and when requests may try again. */
  private startFailures = 0;
  private failedUntil = 0;
  private failedHash: string | null = null;
  private restarts = 0;
  private startedHealthyAt: number | null = null;
  private lastError: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private shuttingDown = false;
  private secrets: string[] = [];
  private logTail: string[] = [];
  private readonly usedPorts = new Set<number>();
  private readonly listeners = new Set<(s: SidecarStatus) => void>();

  constructor(deps: LitellmSidecarDeps) {
    this.deps = {
      spawn: (cmd, args, options) => nodeSpawn(cmd, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as unknown as ChildProcess as unknown as ChildLike,
      fetchFn: (url, init) => fetch(url, init),
      pickPort: (exclude) => pickFreePort({ base: SIDECAR_PORT_BASE + Math.floor(Math.random() * 256), span: SIDECAR_PORT_SPAN, exclude }),
      assignToJob: () => false,
      randomKey: () => `sk-ark-${randomBytes(24).toString('hex')}`,
      now: () => Date.now(),
      fileExists: (p) => fs.existsSync(p),
      fs: {
        mkdirSync: (dir) => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); },
        writeFileSync: (file, data) => { fs.writeFileSync(file, data, { encoding: 'utf8', mode: 0o600 }); },
        rmSync: (target) => { fs.rmSync(target, { recursive: true, force: true }); },
      },
      baseEnv: defaultBaseEnv,
      sleepSync: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
      log: () => undefined,
      healthIntervalMs: 250,
      startTimeoutMs: DEFAULT_START_TIMEOUT_MS,
      maxRestarts: SIDECAR_MAX_RESTARTS,
      backoffMs: DEFAULT_BACKOFF_MS,
      stableMs: DEFAULT_STABLE_MS,
      proxyEnv: async () => ({}),
      startFailureCooldownMs: DEFAULT_START_FAILURE_COOLDOWN_MS,
      ...deps,
    } as LitellmSidecar['deps'];
  }

  pythonPath(): string {
    return path.join(this.deps.runtimeDir(), 'python', 'python.exe');
  }

  launcherPath(): string {
    return path.join(this.deps.runtimeDir(), 'ark_litellm.py');
  }

  isRuntimeAvailable(): boolean {
    return this.deps.fileExists(this.pythonPath()) && this.deps.fileExists(this.launcherPath());
  }

  status(): SidecarStatus {
    return {
      state: this.state, port: this.port, pid: this.child?.pid ?? null, restarts: this.restarts,
      lastError: this.lastError, configHash: this.runningHash, routedHash: this.runningRoutedHash,
    };
  }

  /**
   * Where a restart after a crash gets its config: the caller's current one, not the one of the last
   * request, so a removed key or connector is never brought back. `null` means nothing needs LiteLLM now.
   */
  setSpecProvider(fn: (() => SidecarSpec | null) | null): void {
    this.specProvider = fn;
  }

  onChange(fn: (s: SidecarStatus) => void): () => void {
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

  /** Connection details of the running sidecar without starting one. */
  peek(): SidecarInfo | null {
    return this.state === 'ready' && this.port !== null && this.masterKey
      ? { baseUrl: `http://127.0.0.1:${this.port}`, masterKey: this.masterKey }
      : null;
  }

  /**
   * The sidecar running exactly `spec`, started (or restarted with the regenerated config) on demand.
   * Concurrent callers share one start.
   */
  ensure(spec: SidecarSpec): Promise<SidecarInfo> {
    // One start/restart at a time: two callers with different configs must never both spawn (the
    // loser would be an untracked python.exe). A second caller with the same config finds the first
    // one's result and returns it.
    const run = this.queue.then(() => this.ensureNow(spec), () => this.ensureNow(spec));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async ensureNow(spec: SidecarSpec): Promise<SidecarInfo> {
    if (this.shuttingDown) throw new SidecarError('Ark is shutting down', 'start_failed');
    // A different config than the one that failed to start gets a fresh try at once (the user fixed or
    // removed the bad connector); only the same config stays failed until Re-check.
    if (this.state === 'failed' && this.failedHash !== null && spec.hash !== this.failedHash) this.reset();
    if (this.state === 'failed') {
      throw new SidecarError(this.lastError ?? 'The AI router failed too often; use Re-check to try again', 'failed_too_often');
    }
    this.spec = spec;
    if (this.state === 'ready') {
      const same = spec.exact || spec.routedHash === undefined || this.runningRoutedHash === null
        ? this.runningHash === spec.hash
        : this.runningRoutedHash === spec.routedHash;
      if (same) return this.peek()!;
      this.deps.log('[AI Router] routes or keys changed: regenerating the config and restarting LiteLLM');
      await this.stop();
    }
    // Circuit breaker: a start that just failed is not repeated for a cooldown, so a queue of embed
    // batches does not wait N x 90 s for N doomed spawns. A different config may try at once.
    if (this.failedUntil > this.deps.now() && this.failedHash === spec.hash) {
      throw new SidecarError(this.lastError ?? 'LiteLLM did not start a moment ago; trying again shortly', 'start_failed', { retryAfterMs: this.failedUntil - this.deps.now() });
    }
    return this.start(spec);
  }

  /** Start; a child that lost the race for its port is started again on another one (up to MAX_BIND_RETRIES), never counted as a failed start. */
  private async start(spec: SidecarSpec): Promise<SidecarInfo> {
    const badPorts: number[] = [];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.startOnce(spec, badPorts, attempt < MAX_BIND_RETRIES);
      } catch (err) {
        if (!(err instanceof SidecarError && err.extra.bindFailure && attempt < MAX_BIND_RETRIES) || this.shuttingDown) throw err;
        this.deps.log(`[AI Router] port ${this.port} was taken before LiteLLM bound it; retrying on another port`);
      }
    }
  }

  private async startOnce(spec: SidecarSpec, badPorts: number[], mayRetryBind: boolean): Promise<SidecarInfo> {
    if (!this.isRuntimeAvailable()) {
      this.lastError = 'The bundled LiteLLM runtime is missing from this install';
      this.state = 'stopped';
      this.emit();
      throw new SidecarError(this.lastError, 'no_runtime');
    }
    this.state = 'starting';
    this.lastError = null;
    this.emit();
    try {
      const port = await this.deps.pickPort([...this.usedPorts, ...badPorts]);
      if (port === null) throw new SidecarError('No free local port for the AI router', 'no_port');
      this.usedPorts.add(port);
      const masterKey = this.deps.randomKey();
      this.port = port;
      this.masterKey = masterKey;
      this.secrets = [masterKey, ...Object.values(spec.env)];
      this.logTail = [];
      this.stopping = false;

      const runDir = path.join(this.deps.workDir(), `run-${randomBytes(6).toString('hex')}`);
      this.deps.fs.mkdirSync(runDir);
      this.runDir = runDir;
      const cfgPath = path.join(runDir, 'config.yaml');
      this.deps.fs.writeFileSync(cfgPath, JSON.stringify(spec.config));

      const base = this.deps.baseEnv();
      let proxy: Record<string, string> = {};
      try { proxy = await this.deps.proxyEnv(); } catch { /* no proxy information: connect directly */ }
      const env: NodeJS.ProcessEnv = {
        ...proxy,
        ...base, // an explicit HTTPS_PROXY / SSL_CERT_FILE of the user wins over what the session resolved
        ...spec.env,
        LITELLM_MASTER_KEY: masterKey,
        PYTHONUTF8: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        NO_PROXY: mergeNoProxy(base.NO_PROXY ?? base.no_proxy, localConnectorHosts(spec.config)),
      };
      delete env.no_proxy;
      let child: ChildLike;
      try {
        child = this.deps.spawn(this.pythonPath(), ['-I', this.launcherPath(), '--config', cfgPath, '--port', String(port)], {
          cwd: this.deps.runtimeDir(), env,
        });
      } catch (err) {
        throw new SidecarError(`Could not start LiteLLM: ${err instanceof Error ? err.message : String(err)}`, 'start_failed');
      }
      this.child = child;
      if (typeof child.pid === 'number' && !this.deps.assignToJob(child.pid)) {
        this.deps.log('[AI Router] job object unavailable; relying on kill-on-quit');
      }

      let exited: { code: number | null; signal: string | null } | null = null;
      const onLog = (chunk: Buffer | string) => {
        for (const raw of String(chunk).split(/\r?\n/)) {
          if (!raw.trim()) continue;
          this.logTail.push(redactLine(raw, this.secrets));
          if (this.logTail.length > LOG_TAIL_LINES) this.logTail.shift();
        }
      };
      child.stdout?.on('data', onLog);
      child.stderr?.on('data', onLog);
      child.on('error', (err) => { this.lastError = redactLine(err.message, this.secrets); });
      child.on('exit', (code, signal) => {
        exited = { code, signal };
        this.onExit(child, code, signal);
      });

      const baseUrl = `http://127.0.0.1:${port}`;
      const deadline = this.deps.now() + this.deps.startTimeoutMs;
      while (this.deps.now() < deadline) {
        if (exited || this.shuttingDown || this.stopping) break;
        try {
          const res = await this.deps.fetchFn(`${baseUrl}/health/liveliness`, { signal: timeoutSignal(2_000) });
          // /health/liveliness is unauthenticated: anything on the port can answer it. Only a server that
          // accepts this launch's master key is the LiteLLM we spawned.
          if (res.ok && !exited && await this.ownsPort(baseUrl, masterKey)) {
            this.state = 'ready';
            this.runningHash = spec.hash;
            this.runningRoutedHash = spec.routedHash ?? null;
            this.startFailures = 0;
            this.failedUntil = 0;
            this.failedHash = null;
            this.startedHealthyAt = this.deps.now();
            this.emit();
            this.deps.log(`[AI Router] LiteLLM ready on 127.0.0.1:${port}`);
            return { baseUrl, masterKey };
          }
        } catch {
          // Not listening yet.
        }
        await new Promise<void>((r) => setTimeout(r, this.deps.healthIntervalMs));
      }

      const ex = exited as { code: number | null; signal: string | null } | null;
      const tail = this.logTail.slice(-6).join(' | ').slice(0, 400);
      const reason = ex
        ? `LiteLLM exited (code ${ex.code ?? 'none'}${ex.signal ? `, ${ex.signal}` : ''})${tail ? `: ${tail}` : ''}`
        : `LiteLLM did not become healthy within ${Math.round(this.deps.startTimeoutMs / 1000)}s${tail ? `: ${tail}` : ''}`;
      const bindFailure = !!ex && BIND_FAILURE_RE.test(this.logTail.join('\n'));
      if (bindFailure) badPorts.push(port);
      this.stopping = true;
      this.killChild(child);
      this.cleanupRun(port);
      throw new SidecarError(reason, 'start_failed', { bindFailure });
    } catch (err) {
      this.state = 'stopped';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.runningHash = null;
      this.runningRoutedHash = null;
      if (!(mayRetryBind && err instanceof SidecarError && err.extra.bindFailure)) this.noteStartFailure(err, spec); // may move the state on to 'failed'
      this.emit();
      throw err;
    }
  }

  /** True when the server on `baseUrl` accepts this launch's master key (so it is the LiteLLM Ark spawned). */
  private async ownsPort(baseUrl: string, masterKey: string): Promise<boolean> {
    try {
      const res = await this.deps.fetchFn(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${masterKey}` }, signal: timeoutSignal(2_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Count a failed start; cool down, and give up (state `failed`, offering Re-check) after `maxRestarts` in a row. */
  private noteStartFailure(err: unknown, spec: SidecarSpec): void {
    if (this.shuttingDown || (err instanceof SidecarError && err.code === 'no_runtime')) return;
    this.startFailures += 1;
    const steps = this.deps.startFailureCooldownMs;
    this.failedUntil = this.deps.now() + (steps[Math.min(this.startFailures - 1, steps.length - 1)] ?? 0);
    this.failedHash = spec.hash;
    if (this.startFailures >= Math.max(1, this.deps.maxRestarts)) {
      this.state = 'failed';
      this.lastError = `${this.lastError ?? 'LiteLLM did not start'}; stopped trying after ${this.startFailures} attempts`;
    }
  }

  private onExit(child: ChildLike, code: number | null, signal: string | null): void {
    if (this.child !== child) return; // an older child, already replaced or abandoned
    const wasReady = this.state === 'ready';
    const port = this.port;
    this.child = null;
    this.cleanupRun(port);
    if (this.stopping || this.shuttingDown) {
      if (this.state !== 'failed') this.state = 'stopped'; // a start that failed too often stays failed until Re-check
      this.runningHash = null;
      this.runningRoutedHash = null;
      this.emit();
      return;
    }
    if (!wasReady) return; // start() sees the exit and reports it
    const healthyFor = this.startedHealthyAt === null ? 0 : this.deps.now() - this.startedHealthyAt;
    if (healthyFor >= this.deps.stableMs) this.restarts = 0;
    this.lastError = `LiteLLM crashed (code ${code ?? 'none'}${signal ? `, ${signal}` : ''})`;
    this.runningHash = null;
    this.runningRoutedHash = null;
    this.deps.log(`[AI Router] ${this.lastError}`);
    this.scheduleRestart();
  }

  /** Restart a crashed sidecar after a backoff, or give up after `maxRestarts` in a row. */
  private scheduleRestart(waitMs?: number): void {
    if (this.shuttingDown || !this.spec) return;
    // `waitMs`: the last try was refused by the start-failure cooldown, nothing was spawned, so wait it out without using up a restart.
    if (waitMs === undefined && this.restarts >= this.deps.maxRestarts) {
      this.state = 'failed';
      this.lastError = `${this.lastError ?? 'LiteLLM failed'}; stopped restarting after ${this.restarts} attempts`;
      this.emit();
      return;
    }
    const delay = waitMs !== undefined
      ? Math.max(50, waitMs)
      : this.deps.backoffMs[Math.min(this.restarts, this.deps.backoffMs.length - 1)] ?? 1_000;
    if (waitMs === undefined) this.restarts += 1;
    this.state = 'stopped';
    this.emit();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shuttingDown || this.state !== 'stopped' || !this.spec) return;
      // The caller's current config, not the one of the last request (keys or connectors may have been removed since).
      const spec = this.specProvider ? this.specProvider() : this.spec;
      if (!spec) return; // nothing needs LiteLLM any more: the next request starts it
      void this.ensure(spec).catch((err) => {
        this.deps.log(`[AI Router] restart failed: ${err instanceof Error ? err.message : String(err)}`);
        if (this.state === 'failed') return;
        this.scheduleRestart(err instanceof SidecarError ? err.extra.retryAfterMs : undefined);
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  private killChild(child: ChildLike): void {
    try { child.kill(); } catch { /* already gone */ }
  }

  /** Remove the per-launch config folder and free the port. */
  private cleanupRun(port: number | null, sync = false): void {
    if (port !== null) this.usedPorts.delete(port);
    const dir = this.runDir;
    this.runDir = null;
    if (dir) this.removeRunDir(dir, sync);
  }

  /**
   * Delete a per-launch config folder. Windows refuses while the dying python process still holds the
   * file, so a failure is retried: with short synchronous waits on the quit path (nothing runs after
   * it), with timers otherwise. A folder that still survives is swept at the next start.
   */
  private removeRunDir(dir: string, sync: boolean, attempt = 0): void {
    try {
      this.deps.fs.rmSync(dir);
      return;
    } catch {
      // Still locked.
    }
    if (attempt >= RUN_DIR_RETRIES) return;
    if (sync) {
      this.deps.sleepSync(RUN_DIR_RETRY_MS);
      this.removeRunDir(dir, true, attempt + 1);
    } else {
      const t = setTimeout(() => this.removeRunDir(dir, false, attempt + 1), RUN_DIR_RETRY_MS * (attempt + 1));
      t.unref?.();
    }
  }

  /** Stop the running sidecar (routes changed, quit). */
  async stop(): Promise<void> {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const child = this.child;
    if (!child) {
      if (this.state !== 'failed') this.state = 'stopped';
      this.runningHash = null;
      this.runningRoutedHash = null;
      return;
    }
    this.stopping = true;
    this.killChild(child);
    this.child = null;
    this.cleanupRun(this.port);
    this.state = 'stopped';
    this.runningHash = null;
    this.runningRoutedHash = null;
    this.emit();
  }

  /** Quit path: kill now, never wait. The job object covers a crash of Ark itself. */
  stopSync(): void {
    this.shuttingDown = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.stopping = true;
    if (this.child) this.killChild(this.child);
    this.child = null;
    this.cleanupRun(this.port, true);
    this.state = 'stopped';
    this.runningHash = null;
  }

  /** Clear a `failed` state so the next request tries again. */
  reset(): void {
    this.restarts = 0;
    this.startFailures = 0;
    this.failedUntil = 0;
    this.failedHash = null;
    this.lastError = null;
    if (this.state === 'failed') this.state = 'stopped';
    this.emit();
  }

  /** Test seam: allow use again after stopSync. */
  __resumeForTests(): void {
    this.shuttingDown = false;
  }
}
