/**
 * LiteLLM sidecar manager (1.0.97 B35) with a fake child process: lazy start, a private port and
 * master key, secrets only in the environment (never argv, the config file or the logs), health
 * wait, config regeneration and restart when the routes change, the restart cap with backoff, kill
 * on quit and the per-launch config folder's removal. No real process is ever started.
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { LitellmSidecar, SidecarError, redactLine, SIDECAR_PORT_BASE } from '../../../electron/litellm-sidecar';
import { sidecarDeps, type Spawned } from './helpers';

const spec = (hash = 'h1', env: Record<string, string> = { ARK_KEY_0: 'sk-ant-api03-TOPSECRET' }) => ({
  config: { model_list: [{ model_name: 'ark-chat', litellm_params: { model: 'anthropic/x', api_key: 'os.environ/ARK_KEY_0' } }] },
  env,
  hash,
});
const argOf = (s: Spawned, flag: string) => s.args[s.args.indexOf(flag) + 1];

function make(over = {}) {
  const t = sidecarDeps(over);
  return { ...t, sidecar: new LitellmSidecar(t.deps) };
}

describe('start', () => {
  it('starts lazily: nothing runs until the first ensure()', async () => {
    const t = make();
    expect(t.spawned).toHaveLength(0);
    expect(t.sidecar.status().state).toBe('stopped');
    const info = await t.sidecar.ensure(spec());
    expect(t.spawned).toHaveLength(1);
    expect(info.baseUrl).toBe('http://127.0.0.1:47600');
    expect(t.sidecar.status()).toMatchObject({ state: 'ready', port: 47600, configHash: 'h1' });
  });

  it('runs `python -I ark_litellm.py --config <file> --port <n>` from the runtime folder', async () => {
    const t = make();
    await t.sidecar.ensure(spec());
    const s = t.spawned[0]!;
    expect(s.command).toBe(path.join('C:/ark/litellm-runtime', 'python', 'python.exe'));
    expect(s.args.slice(0, 2)).toEqual(['-I', path.join('C:/ark/litellm-runtime', 'ark_litellm.py')]);
    expect(argOf(s, '--port')).toBe('47600');
    expect(argOf(s, '--config')).toMatch(/ai-router-run[\\/]run-[0-9a-f]+[\\/]config\.yaml$/);
    expect(s.cwd).toBe('C:/ark/litellm-runtime');
  });

  it('the default port range is above the built-in llama.cpp range and never 11434', () => {
    expect(SIDECAR_PORT_BASE).toBeGreaterThan(47473);
    expect(SIDECAR_PORT_BASE).not.toBe(11434);
  });

  it('concurrent callers share one start', async () => {
    const t = make();
    const [a, b] = await Promise.all([t.sidecar.ensure(spec()), t.sidecar.ensure(spec())]);
    expect(t.spawned).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it('reports a missing runtime without spawning', async () => {
    const t = make({ fileExists: () => false });
    await expect(t.sidecar.ensure(spec())).rejects.toMatchObject({ code: 'no_runtime' });
    expect(t.spawned).toHaveLength(0);
    expect(t.sidecar.status().state).toBe('stopped');
  });

  it('reports a sidecar that never becomes healthy, and kills it', async () => {
    const t = make();
    t.state.healthy = () => false;
    await expect(t.sidecar.ensure(spec())).rejects.toThrow(/did not become healthy/);
    expect(t.spawned[0]!.child.killed).toBe(true);
    expect(t.sidecar.status().state).toBe('stopped');
  });

  it('reports a sidecar that dies while starting, with the redacted tail of its log', async () => {
    const t = make();
    t.state.healthy = () => false;
    t.state.onSpawn = (s) => {
      s.child.stderr.emit('data', 'Traceback: bad key sk-ant-api03-TOPSECRET rejected');
      s.child.crash(3);
    };
    const err = await t.sidecar.ensure(spec()).catch((e) => e as Error);
    expect(err).toBeInstanceOf(SidecarError);
    expect(err.message).toMatch(/exited \(code 3\)/);
    expect(err.message).not.toContain('TOPSECRET');
    expect(err.message).toContain('***');
  });

  it('puts the child in the kill-on-close job object', async () => {
    const t = make();
    await t.sidecar.ensure(spec());
    expect(t.jobPids).toEqual([t.spawned[0]!.child.pid]);
  });
});

describe('secrets', () => {
  it('keys and the master key go through the environment only', async () => {
    const t = make();
    const info = await t.sidecar.ensure(spec());
    const s = t.spawned[0]!;
    expect(s.env.ARK_KEY_0).toBe('sk-ant-api03-TOPSECRET');
    expect(s.env.LITELLM_MASTER_KEY).toBe(info.masterKey);
    // Not in argv, not in the config file.
    const argv = s.args.join(' ');
    expect(argv).not.toContain('TOPSECRET');
    expect(argv).not.toContain(info.masterKey);
    const file = [...t.files.values()][0]!.data;
    expect(file).not.toContain('TOPSECRET');
    expect(file).not.toContain(info.masterKey);
    expect(file).toContain('os.environ/ARK_KEY_0');
  });

  it('the child gets only what it needs from Ark\'s own environment', async () => {
    const t = make();
    await t.sidecar.ensure(spec());
    const env = t.spawned[0]!.env;
    expect(Object.keys(env).sort()).toEqual(['ARK_KEY_0', 'LITELLM_MASTER_KEY', 'NO_PROXY', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUTF8', 'SystemRoot', 'TEMP'].sort());
  });

  it('every launch has a new master key', async () => {
    const t = make();
    const a = await t.sidecar.ensure(spec('h1'));
    const b = await t.sidecar.ensure(spec('h2'));
    expect(a.masterKey).not.toBe(b.masterKey);
  });

  it('log lines and logger output never contain a key', async () => {
    const t = make();
    const info = await t.sidecar.ensure(spec());
    t.spawned[0]!.child.stdout.emit('data', `request with Bearer ${info.masterKey} and key sk-ant-api03-TOPSECRET failed`);
    t.spawned[0]!.child.crash(1);
    await new Promise((r) => setTimeout(r, 30));
    for (const line of t.logs) {
      expect(line).not.toContain('TOPSECRET');
      expect(line).not.toContain(info.masterKey);
    }
  });

  it('redactLine removes every secret value and anything key-shaped', () => {
    expect(redactLine('a SECRETVALUE b SECRETVALUE', ['SECRETVALUE'])).toBe('a *** b ***');
    expect(redactLine('key=sk-proj-abcdefghijklmnop and AIzaSyA-1234567890abcdefghijk', [])).toBe('key=*** and ***');
    expect(redactLine('tiny', ['ti'])).toBe('tiny'); // values under 4 characters are not worth masking
  });

  it('the per-launch config folder is private to the launch and removed when the process exits', async () => {
    const t = make();
    await t.sidecar.ensure(spec());
    expect(t.files.size).toBe(1);
    t.spawned[0]!.child.crash(0);
    expect(t.removed).toHaveLength(1);
    expect(t.removed[0]).toMatch(/run-[0-9a-f]+$/);
    expect(t.files.size).toBe(0);
  });
});

describe('config changes', () => {
  it('the same config keeps the running process', async () => {
    const t = make();
    await t.sidecar.ensure(spec('h1'));
    await t.sidecar.ensure(spec('h1'));
    expect(t.spawned).toHaveLength(1);
  });

  it('a changed config regenerates the file and restarts LiteLLM', async () => {
    const t = make();
    await t.sidecar.ensure(spec('h1'));
    const info = await t.sidecar.ensure(spec('h2', { ARK_KEY_0: 'sk-ant-api03-ROTATED-KEY' }));
    expect(t.spawned).toHaveLength(2);
    expect(t.spawned[0]!.child.killed).toBe(true);
    expect(t.spawned[1]!.env.ARK_KEY_0).toBe('sk-ant-api03-ROTATED-KEY');
    expect(t.sidecar.status()).toMatchObject({ state: 'ready', configHash: 'h2' });
    expect(info.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // The old run folder is gone, the new one exists.
    expect(t.removed).toHaveLength(1);
    expect(t.files.size).toBe(1);
  });

  it('two callers asking for the new config at once restart once: no untracked second process', async () => {
    const t = make();
    await t.sidecar.ensure(spec('h1'));
    const [a, b] = await Promise.all([t.sidecar.ensure(spec('h2')), t.sidecar.ensure(spec('h2'))]);
    expect(a).toEqual(b);
    expect(t.spawned).toHaveLength(2);
    expect(t.spawned.filter((s) => !s.child.killed)).toHaveLength(1);
  });

  it('a change that arrives during a start waits for it, then restarts once', async () => {
    const t = make();
    const first = t.sidecar.ensure(spec('h1'));
    const second = t.sidecar.ensure(spec('h2'));
    await Promise.all([first, second]);
    expect(t.sidecar.status().configHash).toBe('h2');
    expect(t.spawned.length).toBe(2);
  });
});

describe('crashes', () => {
  it('restarts a crashed sidecar with backoff using the latest spec', async () => {
    const t = make();
    await t.sidecar.ensure(spec('h1'));
    t.spawned[0]!.child.crash(1);
    expect(t.sidecar.status()).toMatchObject({ state: 'stopped', restarts: 1 });
    await vi.waitFor(() => expect(t.sidecar.status().state).toBe('ready'), { timeout: 1000 });
    expect(t.spawned).toHaveLength(2);
  });

  it('gives up after three restarts in a row and stays failed until reset()', async () => {
    const t = make();
    await t.sidecar.ensure(spec('h1'));
    for (let i = 0; i < 3; i++) {
      t.spawned.at(-1)!.child.crash(1);
      await vi.waitFor(() => expect(t.sidecar.status().state).toBe('ready'), { timeout: 1000 });
    }
    t.spawned.at(-1)!.child.crash(1);
    const st = t.sidecar.status();
    expect(st.state).toBe('failed');
    expect(st.lastError).toMatch(/stopped restarting after 3 attempts/);
    await expect(t.sidecar.ensure(spec('h1'))).rejects.toMatchObject({ code: 'failed_too_often' });
    expect(t.spawned).toHaveLength(4);
    t.sidecar.reset();
    await t.sidecar.ensure(spec('h1'));
    expect(t.sidecar.status()).toMatchObject({ state: 'ready', restarts: 0 });
  });

  it('a run that stayed healthy for a while resets the count', async () => {
    let now = 0;
    const t = make({ now: () => now, stableMs: 1000 });
    await t.sidecar.ensure(spec('h1'));
    now += 5000;
    t.spawned[0]!.child.crash(1);
    expect(t.sidecar.status().restarts).toBe(1); // reset to 0, then this crash counted
  });
});

describe('quit', () => {
  it('stopSync kills the child, removes the config folder and refuses further starts', async () => {
    const t = make();
    await t.sidecar.ensure(spec());
    t.sidecar.stopSync();
    expect(t.spawned[0]!.child.killed).toBe(true);
    expect(t.removed).toHaveLength(1);
    expect(t.sidecar.status().state).toBe('stopped');
    await expect(t.sidecar.ensure(spec())).rejects.toThrow(/shutting down/);
  });

  it('a config folder Windows still holds is removed once the dying process lets go (sync waits on quit)', async () => {
    let failures = 3;
    const sleeps: number[] = [];
    const removedOk: string[] = [];
    const t = make({
      fs: {
        mkdirSync: () => undefined,
        writeFileSync: () => undefined,
        rmSync: (dir: string) => { if (failures-- > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); removedOk.push(dir); },
      },
      sleepSync: (ms: number) => { sleeps.push(ms); },
    });
    await t.sidecar.ensure(spec());
    t.sidecar.stopSync();
    expect(removedOk).toHaveLength(1);
    expect(sleeps).toHaveLength(3);
  });

  it('while running, a locked folder is retried on a timer', async () => {
    let failures = 1;
    const removedOk: string[] = [];
    const t = make({
      fs: {
        mkdirSync: () => undefined,
        writeFileSync: () => undefined,
        rmSync: (dir: string) => { if (failures-- > 0) throw new Error('EBUSY'); removedOk.push(dir); },
      },
    });
    await t.sidecar.ensure(spec());
    await t.sidecar.stop();
    expect(removedOk).toHaveLength(0);
    await vi.waitFor(() => expect(removedOk).toHaveLength(1), { timeout: 1500 });
  });

  it('a crash after quit does not restart anything', async () => {
    const t = make();
    await t.sidecar.ensure(spec());
    t.sidecar.stopSync();
    await new Promise((r) => setTimeout(r, 60));
    expect(t.spawned).toHaveLength(1);
  });

  it('stop() ends the process without scheduling a restart', async () => {
    const t = make();
    await t.sidecar.ensure(spec());
    await t.sidecar.stop();
    await new Promise((r) => setTimeout(r, 60));
    expect(t.spawned).toHaveLength(1);
    expect(t.sidecar.status().state).toBe('stopped');
  });
});
