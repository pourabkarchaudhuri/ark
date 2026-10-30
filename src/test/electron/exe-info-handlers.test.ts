/**
 * exe-info:analyze — the exe path must never reach a shell (it travels to
 * PowerShell through the ARK_EXE env var only), and the launcher heuristic
 * must not flag first-party games just because their publisher also ships a
 * launcher. Uses the __setExeInfoDepsForTests seam (see launch-handlers.test.ts
 * for why vi.mock('electron') can't reach createRequire'd modules).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  analyzeExe,
  isLikelyLauncherExe,
  SIGNATURE_SCRIPT,
  __setExeInfoDepsForTests,
} from '../../../electron/ipc/exe-info-handlers';

const SIGNED = (subject: string) =>
  JSON.stringify({ Status: 'Valid', Subject: subject });

function mockDeps(overrides?: {
  stat?: () => Promise<{ mtimeMs: number; size: number }>;
  stdout?: string;
  platform?: string;
}) {
  const stat = vi.fn(overrides?.stat ?? (async () => ({ mtimeMs: 123, size: 456 })));
  const execFile = vi.fn(async () => overrides?.stdout ?? SIGNED('CN=Some Studio'));
  __setExeInfoDepsForTests({ stat, execFile, platform: () => overrides?.platform ?? 'win32' });
  return { stat, execFile };
}

beforeEach(() => {
  __setExeInfoDepsForTests();
});

describe('analyzeExe — no shell, path only in env', () => {
  it('passes a constant script in argv and the path only via ARK_EXE', async () => {
    const { execFile } = mockDeps();
    const exe = 'C:\\Games\\Witcher 3 [GOTY]\\bin\\witcher3.exe';
    const result = await analyzeExe(exe);

    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args, opts] = execFile.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string>; windowsHide: boolean; timeout: number },
    ];
    expect(file).toBe('powershell.exe');
    expect(args).toEqual(['-NoProfile', '-NonInteractive', '-Command', SIGNATURE_SCRIPT]);
    expect(args.join(' ')).not.toContain('witcher3');
    expect(opts.env.ARK_EXE).toBe(exe);
    expect(opts.windowsHide).toBe(true);
    expect(opts.timeout).toBe(10_000);
    expect(SIGNATURE_SCRIPT).toContain('-LiteralPath $env:ARK_EXE');
    expect(result.signerSubject).toBe('CN=Some Studio');
    expect(result.signerVerified).toBe(true);
    expect(result.mtimeMs).toBe(123);
  });

  it('passes brackets and a curly apostrophe through unchanged in env', async () => {
    const { execFile } = mockDeps();
    const exe = 'C:\\Games\\Assassin\u2019s Creed [GOTY]\\ac.exe';
    await analyzeExe(exe);
    const opts = (execFile.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2];
    expect(opts.env.ARK_EXE).toBe(exe);
  });

  it.each([
    'C:\\x" & calc & ".exe',
    'C:\\Games\\a|b.exe',
    'C:\\Games\\<evil>.exe',
    'C:\\Games\\wild*.exe',
    'C:\\Games\\new\nline.exe',
  ])('rejects %j without stat or PowerShell', async (exe) => {
    const { stat, execFile } = mockDeps();
    const result = await analyzeExe(exe);
    expect(stat).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.isLikelyLauncher).toBe(false);
  });

  it('rejects non-.exe and relative paths', async () => {
    const { execFile } = mockDeps();
    expect((await analyzeExe('C:\\Games\\run.bat')).warnings).toEqual(['Executable path must end with .exe']);
    expect((await analyzeExe('game.exe')).warnings).toEqual(['Executable path must be absolute']);
    expect((await analyzeExe(undefined)).warnings).toEqual(['No executable path provided']);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('skips the PowerShell step when stat fails', async () => {
    const { execFile } = mockDeps({ stat: async () => { throw new Error('ENOENT'); } });
    const result = await analyzeExe('C:\\Games\\gone.exe');
    expect(execFile).not.toHaveBeenCalled();
    expect(result.warnings[0]).toContain('stat failed');
  });

  it('flags launchers from the analyze result', async () => {
    mockDeps({ stdout: SIGNED('CN=Valve Corp.') });
    expect((await analyzeExe('C:\\Steam\\steam.exe')).isLikelyLauncher).toBe(true);
    expect((await analyzeExe('C:\\Steam\\steamapps\\common\\cs2\\cs2.exe')).isLikelyLauncher).toBe(false);
  });
});

describe('isLikelyLauncherExe', () => {
  it.each<[string, string | null, boolean]>([
    ['C:\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe', 'CN=Valve Corp., O=Valve Corp.', false],
    ['C:\\Program Files (x86)\\Steam\\steam.exe', null, true],
    ['C:\\Games\\GTAV\\GTA5.exe', 'CN=Rockstar Games, Inc.', false],
    ['C:\\Games\\GTAV\\PlayGTAV.exe', 'CN=Rockstar Games, Inc.', true],
    ['C:\\Games\\MyGame\\MyGameLauncher.exe', 'CN=Ubisoft Entertainment Sweden AB', true],
    ['C:\\Games\\MyGame\\MyGameLauncher.exe', null, false],
    ['C:\\Riot Games\\VALORANT\\live\\VALORANT.exe', 'CN=Riot Games, Inc.', false],
    ['C:\\Epic\\Fortnite\\FortniteClient-Win64-Shipping.exe', 'CN=Epic Games Inc.', false],
    ['C:\\Program Files\\Electronic Arts\\EA Desktop\\EADesktop.exe', null, true],
    ['C:\\Games\\Tool\\downloader.exe', 'CN=Valve Corp.', false],
    ['C:\\Games\\Tool\\game_loader.exe', 'CN=Valve Corp.', true],
    ['C:\\Games\\Indie\\launcher.exe', null, true],
    ['C:\\Games\\Witcher\\witcher3.exe', 'CN=GOG Sp. z o.o.', false],
  ])('%s signed %j -> %s', (exe, signer, expected) => {
    expect(isLikelyLauncherExe(exe, signer)).toBe(expected);
  });
});
