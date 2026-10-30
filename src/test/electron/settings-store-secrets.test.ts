/**
 * settings-store (v1.0.97): Gemini/Azure/Anthropic keys use OS encryption (Gemini with a
 * lazy migration from the old path-derived cipher), Anthropic is not a chat provider
 * until the AI router serves it, and a corrupt or locked settings.json is never
 * silently replaced.
 *
 * `require('electron')` via createRequire bypasses vi.mock, so the store is
 * built through its injectable `SettingsStoreIo` seam with an in-memory disk.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SettingsStore, type SettingsStoreIo } from '../../../electron/settings-store';

const PATH = '/ud/settings.json';

function fsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function memIo(opts: { file?: string; readError?: string; copyError?: string; safe?: boolean } = {}) {
  const files = new Map<string, string>();
  if (opts.file !== undefined) files.set(PATH, opts.file);
  const safe = opts.safe ?? true;
  const io: SettingsStoreIo & { files: Map<string, string> } = {
    files,
    settingsPath: () => PATH,
    cipherSeed: () => '/ud',
    readFile: vi.fn((p: string) => {
      if (opts.readError) throw fsError(opts.readError);
      const v = files.get(p);
      if (v === undefined) throw fsError('ENOENT');
      return v;
    }),
    writeFile: vi.fn((p: string, data: string) => { files.set(p, data); }),
    copyFile: vi.fn((src: string, dst: string) => {
      if (opts.copyError) throw fsError(opts.copyError);
      const v = files.get(src);
      if (v === undefined) throw fsError('ENOENT');
      files.set(dst, v);
    }),
    sleepSync: vi.fn(),
    now: () => 1700000000000,
    safeStorage: {
      isEncryptionAvailable: () => safe,
      encryptString: (s: string) => Buffer.from('OS' + s, 'utf8'),
      decryptString: (b: Buffer) => b.toString('utf8').slice(2),
    },
  };
  return io;
}

function saved(io: ReturnType<typeof memIo>) {
  return JSON.parse(io.files.get(PATH)!);
}

/** A settings.json holding `googleAI` encrypted with the legacy local cipher. */
function legacyFile(key: string): string {
  const io = memIo({ safe: false });
  const s = new SettingsStore(io);
  s.setGoogleAIKey(key);
  return io.files.get(PATH)!;
}

describe('Gemini key encryption', () => {
  it('stores a newly set key with OS encryption (ss:)', () => {
    const io = memIo();
    const s = new SettingsStore(io);
    s.setGoogleAIKey('AIzaNewKey_123');
    expect(saved(io).apiKeys.googleAI.startsWith('ss:')).toBe(true);
    expect(s.getGoogleAIKey()).toBe('AIzaNewKey_123');
  });

  it('migrates a legacy value to ss: on first read', () => {
    const file = legacyFile('AIzaLegacy-1');
    expect(JSON.parse(file).apiKeys.googleAI.startsWith('ss:')).toBe(false);
    const io = memIo({ file });
    const s = new SettingsStore(io);
    expect(s.getGoogleAIKey()).toBe('AIzaLegacy-1');
    expect(saved(io).apiKeys.googleAI.startsWith('ss:')).toBe(true);
    // Memoised: a second read does not rewrite.
    const writes = (io.writeFile as any).mock.calls.length;
    expect(s.getGoogleAIKey()).toBe('AIzaLegacy-1');
    expect((io.writeFile as any).mock.calls.length).toBe(writes);
  });

  it('keeps the legacy value when OS encryption is unavailable', () => {
    const file = legacyFile('AIzaLegacy-2');
    const io = memIo({ file, safe: false });
    const s = new SettingsStore(io);
    expect(s.getGoogleAIKey()).toBe('AIzaLegacy-2');
    expect(io.writeFile).not.toHaveBeenCalled();
    expect(saved(io).apiKeys.googleAI).toBe(JSON.parse(file).apiKeys.googleAI);
  });
});

describe('Azure OpenAI key slot', () => {
  it('sets, reports and clears the key, encrypted at rest', () => {
    const io = memIo();
    const s = new SettingsStore(io);
    expect(s.hasAzureOpenAIKey()).toBe(false);
    s.setAzureOpenAIKey('azure-secret');
    expect(s.hasAzureOpenAIKey()).toBe(true);
    expect(s.getAzureOpenAIKey()).toBe('azure-secret');
    expect(io.files.get(PATH)).not.toContain('azure-secret');
    s.clearAzureOpenAIKey();
    expect(s.hasAzureOpenAIKey()).toBe(false);
    expect(s.getAzureOpenAIKey()).toBeNull();
  });
});

describe('Anthropic key slot', () => {
  it('sets, reports and clears the key with OS encryption at rest', () => {
    const io = memIo();
    const s = new SettingsStore(io);
    expect(s.hasAnthropicKey()).toBe(false);
    s.setAnthropicKey('sk-ant-api03-secret');
    expect(s.hasAnthropicKey()).toBe(true);
    expect(s.getAnthropicKey()).toBe('sk-ant-api03-secret');
    expect(saved(io).apiKeys.anthropic).toMatch(/^ss:/);
    expect(io.files.get(PATH)).not.toContain('sk-ant-api03-secret');
    s.clearAnthropicKey();
    expect(s.hasAnthropicKey()).toBe(false);
    expect(saved(io).apiKeys.anthropic).toBeUndefined();
  });

  it('a stored anthropic key survives a reload', () => {
    const io = memIo();
    new SettingsStore(io).setAnthropicKey('sk-ant-1');
    expect(new SettingsStore(io).getAnthropicKey()).toBe('sk-ant-1');
  });
});

describe('Anthropic is not a chat provider', () => {
  it('getPreferredChatProvider falls back from a stored anthropic value', () => {
    const io = memIo({ file: JSON.stringify({ version: 1, apiKeys: {}, preferences: { autoLaunch: true, betaFeatures: true, preferredChatProvider: 'anthropic' }, ollama: {} }) });
    const s = new SettingsStore(io);
    expect(s.getPreferredChatProvider()).toBe('ollama');
  });

  it('setPreferredChatProvider does not store anthropic', () => {
    const io = memIo();
    const s = new SettingsStore(io);
    s.setBetaFeatures(true);
    s.setPreferredChatProvider('anthropic');
    expect(saved(io).preferences.preferredChatProvider).toBe('ollama');
  });
});

describe('unreadable settings.json', () => {
  it('backs up malformed JSON before any save', () => {
    const io = memIo({ file: '{ not json' });
    const s = new SettingsStore(io);
    const backup = [...io.files.keys()].find((k) => k.startsWith(PATH + '.corrupt-'));
    expect(backup).toBeDefined();
    expect(io.files.get(backup!)).toBe('{ not json');
    s.setAutoLaunch(false);
    expect(saved(io).preferences.autoLaunch).toBe(false);
    expect(io.files.get(backup!)).toBe('{ not json');
  });

  it('backs up a file with an unexpected version', () => {
    const file = JSON.stringify({ version: 7, apiKeys: { googleAI: 'x' } });
    const io = memIo({ file });
    new SettingsStore(io);
    expect(io.files.get(PATH + '.v7.bak')).toBe(file);
  });

  it('retries a locked read and then does not overwrite on the next save', () => {
    const io = memIo({ file: '{"version":1}', readError: 'EBUSY', copyError: 'EBUSY' });
    const s = new SettingsStore(io);
    expect((io.readFile as any).mock.calls.length).toBeGreaterThan(1);
    s.setAutoLaunch(false);
    expect(io.writeFile).not.toHaveBeenCalled();
    expect(io.files.get(PATH)).toBe('{"version":1}');
  });

  it('after a locked read, a user change backs the file up first and then saves', () => {
    const io = memIo({ file: '{"version":1}', readError: 'EPERM' });
    const s = new SettingsStore(io);
    s.setAutoLaunch(false);
    const order = [(io.copyFile as any).mock.invocationCallOrder[0], (io.writeFile as any).mock.invocationCallOrder[0]];
    expect(order[0]).toBeLessThan(order[1]);
    expect([...io.files.keys()].some((k) => k.startsWith(PATH + '.unreadable-'))).toBe(true);
    expect(saved(io).preferences.autoLaunch).toBe(false);
  });

  it('a missing file still means defaults with no backup', () => {
    const io = memIo();
    const s = new SettingsStore(io);
    expect(s.getAutoLaunch()).toBe(true);
    expect(io.copyFile).not.toHaveBeenCalled();
  });
});
