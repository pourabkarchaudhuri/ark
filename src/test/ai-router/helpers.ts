/**
 * Shared fakes for the AI router tests: an in-memory store file, a reversible fake safeStorage,
 * the legacy key slots, and a fake child process / sidecar.
 */
import { EventEmitter } from 'node:events';
import { RouterStore, type LegacyKeys, type LegacySlot, type RouterStoreIo } from '../../../electron/ai-router/connectors';
import type { ChildLike, LitellmSidecarDeps } from '../../../electron/litellm-sidecar';

export const BUILTIN_MODELS = { chat: 'gemma3:12b', embeddings: 'snowflake-arctic-embed2', reranker: 'bge-reranker-v2-m3' };

export function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    // Not real encryption: reversible and unlike the plain text, so a test can tell the two apart.
    encryptString: (s: string) => Buffer.from(`ENC(${s.split('').reverse().join('')})`, 'utf8'),
    decryptString: (b: Buffer) => {
      const m = /^ENC\((.*)\)$/.exec(b.toString('utf8'));
      if (!m) throw new Error('bad ciphertext');
      return m[1]!.split('').reverse().join('');
    },
  };
}

export function memoryLegacyKeys(initial: Partial<Record<LegacySlot, string>> = {}): LegacyKeys & { slots: Partial<Record<LegacySlot, string>> } {
  const slots = { ...initial };
  return {
    slots,
    get: (slot) => slots[slot] ?? null,
    set: (slot, key) => { slots[slot] = key; },
    clear: (slot) => { delete slots[slot]; },
  };
}

export function makeStore(opts: { file?: string | null; legacy?: Partial<Record<LegacySlot, string>>; safeStorage?: ReturnType<typeof fakeSafeStorage> | null } = {}) {
  const disk = { text: opts.file ?? null as string | null, writes: 0 };
  const io: RouterStoreIo = {
    read: () => disk.text,
    write: (data) => { disk.text = data; disk.writes++; },
    now: () => 1_000,
    safeStorage: opts.safeStorage === undefined ? fakeSafeStorage() : opts.safeStorage,
  };
  const legacy = memoryLegacyKeys(opts.legacy);
  const store = new RouterStore(io, legacy, BUILTIN_MODELS);
  return { store, disk, legacy, io, reload: () => new RouterStore(io, legacy, BUILTIN_MODELS) };
}

/** A fake child process; `crash()` simulates it dying, `kill()` exits it like a real kill. */
export class FakeChild extends EventEmitter {
  pid: number;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  constructor(pid: number) { super(); this.pid = pid; }
  kill(): boolean {
    if (this.killed) return true;
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
  crash(code = 1): void { this.emit('exit', code, null); }
  asChild(): ChildLike { return this as unknown as ChildLike; }
}

export interface Spawned { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; child: FakeChild }

export function sidecarDeps(over: Partial<LitellmSidecarDeps> = {}) {
  const spawned: Spawned[] = [];
  const files = new Map<string, { data: string }>();
  const removed: string[] = [];
  const jobPids: number[] = [];
  const logs: string[] = [];
  let nextPid = 4000;
  const state = {
    healthy: (_s: Spawned) => true,
    onSpawn: (_s: Spawned) => undefined as void,
  };
  const deps: LitellmSidecarDeps = {
    runtimeDir: () => 'C:/ark/litellm-runtime',
    workDir: () => 'C:/ark-data/ai-router-run',
    fileExists: () => true,
    spawn: (command, args, options) => {
      const child = new FakeChild(nextPid++);
      const s = { command, args, env: options.env, cwd: options.cwd, child };
      spawned.push(s);
      queueMicrotask(() => state.onSpawn(s));
      return child.asChild();
    },
    fetchFn: async (url) => {
      const port = /:(\d+)\//.exec(url)?.[1];
      const s = [...spawned].reverse().find((x) => x.args[x.args.indexOf('--port') + 1] === port);
      const ok = !!s && !s.child.killed && state.healthy(s);
      return { ok, status: ok ? 200 : 503 };
    },
    pickPort: async (exclude) => {
      let p = 47600;
      while (exclude.includes(p)) p++;
      return p;
    },
    assignToJob: (pid) => { jobPids.push(pid); return true; },
    randomKey: (() => { let n = 0; return () => `sk-ark-master-${++n}`; })(),
    fs: {
      mkdirSync: () => undefined,
      writeFileSync: (file, data) => { files.set(file, { data }); },
      rmSync: (target) => {
        removed.push(target);
        for (const f of [...files.keys()]) if (f.startsWith(target)) files.delete(f);
      },
    },
    baseEnv: () => ({ SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp' }),
    log: (m) => logs.push(m),
    healthIntervalMs: 5,
    startTimeoutMs: 200,
    backoffMs: [10, 20, 30],
    ...over,
  };
  return { deps, spawned, files, removed, jobPids, logs, state };
}
