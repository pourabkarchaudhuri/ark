/**
 * LlamaRuntime (the built-in llama.cpp process manager) with a fake child process: lazy start,
 * health wait, private port + key, GPU-to-CPU fallback, restart cap with backoff, idle unload,
 * option changes, job-object assignment and kill on quit. No real process is ever started.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { LlamaRuntime, RuntimeError, parseGpuLogLine, type ChildLike, type LlamaRuntimeDeps } from '../../../electron/local-ai/llama-runtime';

class FakeChild extends EventEmitter {
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

interface Spawned { command: string; args: string[]; child: FakeChild }

function makeRuntime(over: Partial<LlamaRuntimeDeps> = {}) {
  const spawned: Spawned[] = [];
  const jobPids: number[] = [];
  let nextPid = 1000;
  let healthy: (s: Spawned) => boolean = () => true;
  let onSpawn: (s: Spawned) => void = () => undefined;
  const runtime = new LlamaRuntime({
    runtimeDir: () => 'C:/ark/llama-runtime',
    modelPath: (role) => `C:/models/${role}.gguf`,
    fileExists: () => true,
    spawn: (command, args) => {
      const child = new FakeChild(nextPid++);
      const s = { command, args, child };
      spawned.push(s);
      queueMicrotask(() => onSpawn(s));
      return child.asChild();
    },
    fetchFn: async (url) => {
      const port = /:(\d+)\//.exec(url)?.[1];
      const s = [...spawned].reverse().find((x) => x.args[x.args.indexOf('--port') + 1] === port);
      const ok = !!s && !s.child.killed && healthy(s);
      return { ok, status: ok ? 200 : 503 };
    },
    pickPort: async (exclude) => {
      let p = 47410;
      while (exclude.includes(p)) p++;
      return p;
    },
    assignToJob: (pid) => { jobPids.push(pid); return true; },
    randomKey: (() => { let n = 0; return () => `key${++n}`; })(),
    healthIntervalMs: 5,
    startTimeoutMs: { embed: 200, rerank: 200, 'rerank-qwen': 200, chat: 200 },
    backoffMs: [10, 20, 30],
    ...over,
  });
  return {
    runtime, spawned, jobPids,
    setHealthy: (fn: (s: Spawned) => boolean) => { healthy = fn; },
    setOnSpawn: (fn: (s: Spawned) => void) => { onSpawn = fn; },
  };
}

const argOf = (s: Spawned, flag: string) => s.args[s.args.indexOf(flag) + 1];

describe('LlamaRuntime start', () => {
  it('starts lazily: nothing runs until the first ensure()', async () => {
    const t = makeRuntime();
    expect(t.spawned).toHaveLength(0);
    await t.runtime.ensure('embed');
    expect(t.spawned).toHaveLength(1);
  });

  it('binds 127.0.0.1 on a private port with a random api key, never 11434', async () => {
    const t = makeRuntime();
    const info = await t.runtime.ensure('embed');
    const s = t.spawned[0];
    expect(argOf(s, '--host')).toBe('127.0.0.1');
    expect(Number(argOf(s, '--port'))).toBe(info.port);
    expect(info.port).toBeGreaterThanOrEqual(47410);
    expect(info.port).not.toBe(11434);
    expect(argOf(s, '--api-key')).toBe(info.apiKey);
    expect(info.baseUrl).toBe(`http://127.0.0.1:${info.port}`);
  });

  it('uses embedding/pooling flags per role', async () => {
    const t = makeRuntime();
    await t.runtime.ensure('embed');
    await t.runtime.ensure('rerank');
    await t.runtime.ensure('rerank-qwen');
    await t.runtime.ensure('chat', { numCtx: 16384 });
    const [embed, rerank, qwen, chat] = t.spawned;
    expect(embed.args).toEqual(expect.arrayContaining(['--embedding', '--pooling', 'cls']));
    expect(rerank.args).toEqual(expect.arrayContaining(['--reranking', '--pooling', 'rank']));
    expect(qwen.args).not.toContain('--embedding');
    expect(qwen.args).not.toContain('--reranking');
    expect(chat.args).toContain('--jinja');
    expect(argOf(chat, '-c')).toBe('16384');
    // Four servers, four different ports.
    expect(new Set(t.spawned.map((s) => argOf(s, '--port'))).size).toBe(4);
  });

  it('shares one start between concurrent callers', async () => {
    const t = makeRuntime();
    const [a, b] = await Promise.all([t.runtime.ensure('embed'), t.runtime.ensure('embed')]);
    expect(t.spawned).toHaveLength(1);
    expect(a.port).toBe(b.port);
  });

  it('puts every child in the kill-on-close job object', async () => {
    const t = makeRuntime();
    await t.runtime.ensure('embed');
    expect(t.jobPids).toEqual([t.spawned[0].child.pid]);
  });

  it('waits for /health before reporting ready', async () => {
    const t = makeRuntime();
    let calls = 0;
    t.setHealthy(() => ++calls >= 4);
    await t.runtime.ensure('embed');
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(t.runtime.roleStatus('embed').state).toBe('ready');
  });

  it('rejects with no_model when the model is not downloaded, and no_runtime when llama-server is missing', async () => {
    const noModel = makeRuntime({ modelPath: () => null });
    await expect(noModel.runtime.ensure('embed')).rejects.toMatchObject({ code: 'no_model' });
    expect(noModel.spawned).toHaveLength(0);
    const noRuntime = makeRuntime({ fileExists: () => false });
    await expect(noRuntime.runtime.ensure('embed')).rejects.toBeInstanceOf(RuntimeError);
    expect(noRuntime.runtime.isRuntimeAvailable()).toBe(false);
  });

  it('reports a start timeout with the tail of the server log', async () => {
    const t = makeRuntime();
    t.setHealthy(() => false);
    t.setOnSpawn((s) => s.child.stderr.emit('data', 'slow loading tensors\n'));
    await expect(t.runtime.ensure('embed')).rejects.toThrow(/did not become healthy.*slow loading tensors/s);
    expect(t.spawned[0].child.killed).toBe(true);
    expect(t.runtime.roleStatus('embed').state).toBe('stopped');
  });

  it('restarts the server when the launch options change (num_batch step-down)', async () => {
    const t = makeRuntime();
    await t.runtime.ensure('embed', { numBatch: 2048 });
    await t.runtime.ensure('embed', { numBatch: 2048 });
    expect(t.spawned).toHaveLength(1);
    await t.runtime.ensure('embed', { numBatch: 1024 });
    expect(t.spawned).toHaveLength(2);
    expect(t.spawned[0].child.killed).toBe(true);
    expect(argOf(t.spawned[1], '-b')).toBe('1024');
    expect(argOf(t.spawned[1], '-ub')).toBe('1024');
  });
});

describe('LlamaRuntime GPU fallback', () => {
  it('relaunches on the CPU once when the GPU launch dies with a Vulkan memory error', async () => {
    const t = makeRuntime();
    t.setOnSpawn((s) => {
      if (argOf(s, '-ngl') !== '0') {
        s.child.stderr.emit('data', 'ggml_vulkan: vk::Device::allocateMemory: ErrorOutOfDeviceMemory\n');
        s.child.crash(3);
      }
    });
    t.setHealthy((s) => argOf(s, '-ngl') === '0');
    const info = await t.runtime.ensure('embed');
    expect(t.spawned.map((s) => argOf(s, '-ngl'))).toEqual(['99', '0']);
    expect(info.cpuFallback).toBe(true);
    expect(t.runtime.roleStatus('embed').cpuFallback).toBe(true);
  });

  it('asks for the log lines the status panel reads and keeps Vulkan out of the CPU relaunch', async () => {
    const t = makeRuntime();
    t.setOnSpawn((s) => {
      if (argOf(s, '-ngl') !== '0') { s.child.stderr.emit('data', 'ggml_vulkan: vk::Device::allocateMemory: ErrorOutOfDeviceMemory
'); s.child.crash(3); }
    });
    t.setHealthy((s) => argOf(s, '-ngl') === '0');
    await t.runtime.ensure('embed');
    const [gpuLaunch, cpuLaunch] = t.spawned;
    expect(argOf(gpuLaunch, '-lv')).toBe('4');
    expect(gpuLaunch.args).not.toContain('--device');
    expect(argOf(cpuLaunch, '--device')).toBe('none');
  });

  it('treats a server that starts with no Vulkan device as a plain CPU server, not a failure', async () => {
    const t = makeRuntime();
    t.setOnSpawn((s) => { s.child.stderr.emit('data', 'load_tensors:   CPU_Mapped model buffer size =   201.80 MiB
'); });
    const info = await t.runtime.ensure('embed');
    expect(t.spawned).toHaveLength(1);
    expect(info.cpuFallback).toBe(false);
    expect(info.gpu.gpuBytes).toBe(0);
    expect(info.gpu.deviceName).toBeNull();
  });

  it('keeps the CPU choice for later starts in the session', async () => {
    const t = makeRuntime();
    t.setOnSpawn((s) => {
      if (argOf(s, '-ngl') !== '0') { s.child.stderr.emit('data', 'failed to allocate buffer\n'); s.child.crash(1); }
    });
    t.setHealthy((s) => argOf(s, '-ngl') === '0');
    await t.runtime.ensure('embed');
    await t.runtime.stop('embed');
    t.spawned.length = 0;
    await t.runtime.ensure('embed');
    expect(t.spawned.map((s) => argOf(s, '-ngl'))).toEqual(['0']);
  });

  it('does not retry on the CPU for an unrelated failure', async () => {
    const t = makeRuntime();
    t.setOnSpawn((s) => { s.child.stderr.emit('data', 'error: bad model file\n'); s.child.crash(2); });
    await expect(t.runtime.ensure('embed')).rejects.toThrow(/exited \(code 2\)/);
    expect(t.spawned).toHaveLength(1);
  });

  it('parses the offload and buffer lines of the server log', () => {
    const gpu = { device: null, deviceName: null, layersOffloaded: null, layersTotal: null, gpuBytes: 0, cpuBytes: 0 } as Parameters<typeof parseGpuLogLine>[1];
    parseGpuLogLine('load_tensors: offloaded 25/25 layers to GPU', gpu);
    parseGpuLogLine('load_tensors:      Vulkan0 model buffer size =  1024.00 MiB', gpu);
    parseGpuLogLine('load_tensors:  CPU_Mapped model buffer size =   100.00 MiB', gpu);
    expect(gpu.layersOffloaded).toBe(25);
    expect(gpu.layersTotal).toBe(25);
    expect(gpu.device).toBe('Vulkan0');
    parseGpuLogLine('llama_prepare_model_devices: using device Vulkan1 (NVIDIA GeForce RTX 3070 Ti Laptop GPU) (0000:01:00.0) - 7246 MiB free', gpu);
    expect(gpu.device).toBe('Vulkan1');
    expect(gpu.deviceName).toBe('NVIDIA GeForce RTX 3070 Ti Laptop GPU');
    expect(gpu.gpuBytes).toBe(1024 * 1024 * 1024);
    expect(gpu.cpuBytes).toBe(100 * 1024 * 1024);
  });
});

describe('LlamaRuntime crash handling', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('restarts a crashed server with backoff, at most maxRestarts times in a row', async () => {
    const now = { t: 0 };
    const t = makeRuntime({ now: () => now.t, maxRestarts: 3, stableMs: 60_000 });
    await t.runtime.ensure('embed');
    expect(t.spawned).toHaveLength(1);
    // Crash right after starting: three restarts, then it gives up.
    for (let i = 0; i < 3; i++) {
      t.spawned[i].child.crash(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(t.spawned).toHaveLength(i + 2);
      expect(t.runtime.roleStatus('embed').state).toBe('ready');
    }
    t.spawned[3].child.crash(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(t.spawned).toHaveLength(4);
    expect(t.runtime.roleStatus('embed').state).toBe('failed');
    await expect(t.runtime.ensure('embed')).rejects.toMatchObject({ code: 'failed_too_often' });
  });

  it('a server that stayed healthy for stableMs resets the restart count', async () => {
    const now = { t: 0 };
    const t = makeRuntime({ now: () => now.t, maxRestarts: 1, stableMs: 1_000 });
    await t.runtime.ensure('embed');
    now.t += 5_000;
    t.spawned[0].child.crash(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(t.spawned).toHaveLength(2);
    now.t += 5_000;
    t.spawned[1].child.crash(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(t.spawned).toHaveLength(3);
    expect(t.runtime.roleStatus('embed').state).toBe('ready');
  });

  it('reset() lets a failed role start again', async () => {
    const t = makeRuntime({ maxRestarts: 0 });
    await t.runtime.ensure('embed');
    t.spawned[0].child.crash(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(t.runtime.roleStatus('embed').state).toBe('failed');
    t.runtime.reset('embed');
    await t.runtime.ensure('embed');
    expect(t.runtime.roleStatus('embed').state).toBe('ready');
  });
});

describe('LlamaRuntime idle unload, stop and quit', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('unloads each role after its idle window (chat sooner than embed)', async () => {
    const t = makeRuntime({ idleMs: { chat: 10 * 60_000, embed: 30 * 60_000 } });
    await t.runtime.ensure('embed');
    await t.runtime.ensure('chat');
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 10);
    expect(t.runtime.roleStatus('chat').state).toBe('stopped');
    expect(t.runtime.roleStatus('embed').state).toBe('ready');
    await vi.advanceTimersByTimeAsync(20 * 60_000 + 10);
    expect(t.runtime.roleStatus('embed').state).toBe('stopped');
    expect(t.spawned.every((s) => s.child.killed)).toBe(true);
  });

  it('use pushes the idle deadline out', async () => {
    const t = makeRuntime({ idleMs: { embed: 1_000 } });
    await t.runtime.ensure('embed');
    await vi.advanceTimersByTimeAsync(800);
    t.runtime.markUsed('embed');
    await vi.advanceTimersByTimeAsync(800);
    expect(t.runtime.roleStatus('embed').state).toBe('ready');
    await vi.advanceTimersByTimeAsync(400);
    expect(t.runtime.roleStatus('embed').state).toBe('stopped');
  });

  it('an idle unload is not treated as a crash (no restart)', async () => {
    const t = makeRuntime({ idleMs: { embed: 100 } });
    await t.runtime.ensure('embed');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.spawned).toHaveLength(1);
  });

  it('stopAllSync kills every child at once and blocks new starts', async () => {
    const t = makeRuntime();
    await t.runtime.ensure('embed');
    await t.runtime.ensure('rerank');
    t.runtime.stopAllSync();
    expect(t.spawned.every((s) => s.child.killed)).toBe(true);
    await expect(t.runtime.ensure('embed')).rejects.toThrow(/shutting down/);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.spawned).toHaveLength(2);
  });

  it('stopAll stops running servers and frees their ports for reuse', async () => {
    const t = makeRuntime();
    const a = await t.runtime.ensure('embed');
    await t.runtime.stopAll();
    expect(t.runtime.peek('embed')).toBeNull();
    const b = await t.runtime.ensure('embed');
    expect(b.port).toBe(a.port);
  });
});
