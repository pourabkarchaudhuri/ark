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
}

export class SidecarError extends Error {
  constructor(message: string, readonly code: 'no_runtime' | 'no_port' | 'start_failed' | 'failed_too_often') {
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
}

const DEFAULT_START_TIMEOUT_MS = 90_000;
const DEFAULT_BACKOFF_MS = [500, 2_000, 5_000];
const DEFAULT_STABLE_MS = 60_000;
export const SIDECAR_MAX_RESTARTS = 3;
const RUN_DIR_RETRIES = 8;
const RUN_DIR_RETRY_MS = 150;
const LOG_TAIL_LINES = 40;
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
  return out.replace(/\b(sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/g, '***');
}

function defaultBaseEnv(): Record<string, string> {
  const pick = ['SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'ProgramData', 'PATHEXT'];
  const out: Record<string, string> = {};
  for (const k of pick) {
    const v = process.env[k];
    if (v) out[k] = v;
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
  private runningHash: string | null = null;
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
      lastError: this.lastError, configHash: this.runningHash,
    };
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
    if (this.state === 'failed') {
      throw new SidecarError(this.lastError ?? 'The AI router failed too often; use Re-check to try again', 'failed_too_often');
    }
    this.spec = spec;
    if (this.state === 'ready') {
      if (this.runningHash === spec.hash) return this.peek()!;
      this.deps.log('[AI Router] routes or keys changed: regenerating the config and restarting LiteLLM');
      await this.stop();
    }
    return this.start(spec);
  }

  private async start(spec: SidecarSpec): Promise<SidecarInfo> {
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
      const port = await this.deps.pickPort([...this.usedPorts]);
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

      const env: NodeJS.ProcessEnv = {
        ...this.deps.baseEnv(),
        ...spec.env,
        LITELLM_MASTER_KEY: masterKey,
        PYTHONUTF8: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        NO_PROXY: '127.0.0.1,localhost',
      };
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

      const base = `http://127.0.0.1:${port}`;
      const deadline = this.deps.now() + this.deps.startTimeoutMs;
      while (this.deps.now() < deadline) {
        if (exited || this.shuttingDown || this.stopping) break;
        try {
          const res = await this.deps.fetchFn(`${base}/health/liveliness`, { signal: timeoutSignal(2_000) });
          if (res.ok && !exited) {
            this.state = 'ready';
            this.runningHash = spec.hash;
            this.startedHealthyAt = this.deps.now();
            this.emit();
            this.deps.log(`[AI Router] LiteLLM ready on 127.0.0.1:${port}`);
            return { baseUrl: base, masterKey };
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
      this.stopping = true;
      this.killChild(child);
      this.cleanupRun(port);
      throw new SidecarError(reason, 'start_failed');
    } catch (err) {
      if ((this.state as SidecarState) !== 'failed') this.state = 'stopped';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.runningHash = null;
      this.emit();
      throw err;
    }
  }

  private onExit(child: ChildLike, code: number | null, signal: string | null): void {
    if (this.child !== child) return; // an older child, already replaced or abandoned
    const wasReady = this.state === 'ready';
    const port = this.port;
    this.child = null;
    this.cleanupRun(port);
    if (this.stopping || this.shuttingDown) {
      this.state = 'stopped';
      this.runningHash = null;
      this.emit();
      return;
    }
    if (!wasReady) return; // start() sees the exit and reports it
    const healthyFor = this.startedHealthyAt === null ? 0 : this.deps.now() - this.startedHealthyAt;
    if (healthyFor >= this.deps.stableMs) this.restarts = 0;
    this.lastError = `LiteLLM crashed (code ${code ?? 'none'}${signal ? `, ${signal}` : ''})`;
    this.runningHash = null;
    this.deps.log(`[AI Router] ${this.lastError}`);
    this.scheduleRestart();
  }

  /** Restart a crashed sidecar after a backoff, or give up after `maxRestarts` in a row. */
  private scheduleRestart(): void {
    if (this.shuttingDown || !this.spec) return;
    if (this.restarts >= this.deps.maxRestarts) {
      this.state = 'failed';
      this.lastError = `${this.lastError ?? 'LiteLLM failed'}; stopped restarting after ${this.restarts} attempts`;
      this.emit();
      return;
    }
    const delay = this.deps.backoffMs[Math.min(this.restarts, this.deps.backoffMs.length - 1)] ?? 1_000;
    this.restarts += 1;
    this.state = 'stopped';
    this.emit();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shuttingDown || this.state !== 'stopped' || !this.spec) return;
      void this.ensure(this.spec).catch((err) => {
        this.deps.log(`[AI Router] restart failed: ${err instanceof Error ? err.message : String(err)}`);
        if (this.state !== 'failed') this.scheduleRestart();
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
      return;
    }
    this.stopping = true;
    this.killChild(child);
    this.child = null;
    this.cleanupRun(this.port);
    this.state = 'stopped';
    this.runningHash = null;
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
    this.lastError = null;
    if (this.state === 'failed') this.state = 'stopped';
    this.emit();
  }

  /** Test seam: allow use again after stopSync. */
  __resumeForTests(): void {
    this.shuttingDown = false;
  }
}
