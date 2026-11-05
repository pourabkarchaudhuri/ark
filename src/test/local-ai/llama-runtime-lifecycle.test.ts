/**
 * 1.0.99 runtime lifecycle: a stop() during a start cancels exactly that start (no shared cancelled promise, no
 * spawn after the stop, no dead 'ready' slot), a chat GPU out-of-memory keeps the GPU with a smaller context before
 * the CPU, the CPU fallback expires, and fallbackToCpu() relaunches a serving server on the CPU.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { LlamaRuntime, type ChildLike } from '../../../electron/local-ai/llama-runtime';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  holdExit = false;
  constructor(public pid: number) { super(); }
  kill(): boolean {
    if (!this.killed) { this.killed = true; if (!this.holdExit) queueMicrotask(() => this.emit('exit', null, 'SIGTERM')); }
    return true;
  }
}
interface Spawned { args: string[]; child: FakeChild }
const argOf = (s: Spawned, f: string) => s.args[s.args.indexOf(f) + 1];
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function make(opts: {
  healthy?: (s: Spawned) => boolean;
  onSpawn?: (s: Spawned) => void;
  pickDelay?: () => Promise<void>;
  fetchGate?: () => Promise<void>;
  ignoreKilled?: boolean;
  holdExit?: boolean;
  now?: () => number;
} = {}) {
  const spawned: Spawned[] = [];
  let pid = 100;
  const runtime = new LlamaRuntime({
    runtimeDir: () => 'C:/rt',
    modelPath: (r) => `C:/m/${r}.gguf`,
    fileExists: () => true,
    spawn: (_c, args) => {
      const child = new FakeChild(pid++);
      child.holdExit = !!opts.holdExit;
      const s = { args, child };
      spawned.push(s);
      queueMicrotask(() => opts.onSpawn?.(s));
      return child as unknown as ChildLike;
    },
    fetchFn: async (url) => {
      await opts.fetchGate?.();
      const port = /:(\d+)\//.exec(url)?.[1];
      const s = [...spawned].reverse().find((x) => argOf(x, '--port') === port);
      const ok = !!s && (opts.ignoreKilled || !s.child.killed) && (opts.healthy?.(s) ?? true);
      return { ok, status: ok ? 200 : 503 };
    },
    pickPort: async (exclude) => {
      await opts.pickDelay?.();
      let p = 47500;
      while (exclude.includes(p)) p++;
      return p;
    },
    randomKey: (() => { let n = 0; return () => `k${++n}`; })(),
    healthIntervalMs: 5,
    stopWaitMs: 40,
    startTimeoutMs: { chat: 400, embed: 400, rerank: 400, 'rerank-qwen': 400 },
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { runtime, spawned };
}

describe('stop() during a start', () => {
  it('a fresh ensure() after a stop() mid-start starts a new server instead of joining the cancelled start', async () => {
    let healthyFrom = 1;
    const t = make({ healthy: (s) => t.spawned.indexOf(s) >= healthyFrom });
    const first = t.runtime.ensure('embed');
    first.catch(() => undefined);
    await tick(); // first child spawned, still not healthy
    expect(t.spawned).toHaveLength(1);
    await t.runtime.stop('embed');
    const second = await t.runtime.ensure('embed');
    expect(t.spawned).toHaveLength(2);
    expect(t.runtime.roleStatus('embed').state).toBe('ready');
    expect(second.port).toBeGreaterThan(0);
    await expect(first).rejects.toThrow();
    // the cancelled attempt must not have touched the new server's state
    expect(t.runtime.roleStatus('embed').state).toBe('ready');
    expect(t.spawned[1].child.killed).toBe(false);
    healthyFrom = 0;
  });

  it('a stop() before the child exists (port still being picked) cancels the start: nothing is spawned', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const t = make({ pickDelay: () => gate });
    const p = t.runtime.ensure('chat');
    p.catch(() => undefined);
    await tick();
    expect(t.runtime.roleStatus('chat').state).toBe('starting');
    await t.runtime.stop('chat');
    release();
    await expect(p).rejects.toThrow();
    await tick();
    expect(t.spawned).toHaveLength(0);
    expect(t.runtime.roleStatus('chat').state).toBe('stopped');
  });

  it('a health probe that succeeds just as stop() runs never leaves a dead ready slot', async () => {
    let release!: () => void;
    let gated = false;
    let gate = new Promise<void>((r) => { release = r; });
    const t = make({ ignoreKilled: true, holdExit: true, fetchGate: () => (gated ? gate : Promise.resolve()) });
    gated = true;
    const p = t.runtime.ensure('embed');
    p.catch(() => undefined);
    await tick();
    expect(t.spawned).toHaveLength(1);
    const stopping = t.runtime.stop('embed');
    gated = false;
    release();
    await stopping;
    await expect(p).rejects.toThrow();
    expect(t.runtime.roleStatus('embed').state).toBe('stopped');
    expect(t.runtime.peek('embed')).toBeNull();
    gate = Promise.resolve();
  });
});

describe('GPU out of memory on the chat server', () => {
  const oom = (s: Spawned) => {
    s.child.stderr.emit('data', 'ggml_vulkan: Device memory allocation failed: ErrorOutOfDeviceMemory\n');
    queueMicrotask(() => s.child.emit('exit', 1, null));
  };

  it('halves the context on the GPU before it falls back to the CPU', async () => {
    const t = make({ onSpawn: (s) => { if (Number(argOf(s, '-c')) > 20000 && argOf(s, '-ngl') !== '0') oom(s); } });
    const info = await t.runtime.ensure('chat', { numCtx: 65536 });
    const ctxs = t.spawned.map((s) => Number(argOf(s, '-c')));
    expect(ctxs).toEqual([65536, 32768, 16384]);
    expect(t.spawned.every((s) => argOf(s, '-ngl') === '99')).toBe(true);
    expect(info.cpuFallback).toBe(false);
    // the requested context is unchanged, so a repeat call does not restart the server
    await t.runtime.ensure('chat', { numCtx: 65536 });
    expect(t.spawned).toHaveLength(3);
  });

  it('uses the CPU only when even the smallest GPU context fails', async () => {
    const t = make({ onSpawn: (s) => { if (argOf(s, '-ngl') !== '0') oom(s); } });
    const info = await t.runtime.ensure('chat', { numCtx: 16384 });
    expect(t.spawned.map((s) => argOf(s, '-ngl'))).toEqual(['99', '99', '0']);
    expect(info.cpuFallback).toBe(true);
  });

  it('drops the CPU fallback after the retry window', async () => {
    let clock = 1_000_000;
    const t = make({ now: () => clock, onSpawn: (s) => { if (argOf(s, '-ngl') !== '0' && t.spawned.length <= 2) oom(s); } });
    await t.runtime.ensure('chat', { numCtx: 8192 });
    expect(t.runtime.roleStatus('chat').cpuFallback).toBe(true);
    await t.runtime.stop('chat');
    clock += 31 * 60_000;
    const info = await t.runtime.ensure('chat', { numCtx: 8192 });
    expect(info.cpuFallback).toBe(false);
    expect(argOf(t.spawned[t.spawned.length - 1], '-ngl')).toBe('99');
  });
});

describe('fallbackToCpu', () => {
  it('relaunches a serving GPU server on the CPU once, and reports false when it is already there', async () => {
    const t = make();
    await t.runtime.ensure('embed');
    expect(await t.runtime.fallbackToCpu('embed')).toBe(true);
    const info = await t.runtime.ensure('embed');
    expect(info.cpuFallback).toBe(true);
    expect(argOf(t.spawned[1], '-ngl')).toBe('0');
    expect(await t.runtime.fallbackToCpu('embed')).toBe(false);
    expect(await t.runtime.fallbackToCpu('chat')).toBe(false);
  });
});
