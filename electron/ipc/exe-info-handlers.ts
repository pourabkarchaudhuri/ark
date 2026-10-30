/**
 * Exe Info IPC Handlers
 *
 * Analyzes a game's tracked executable to answer two questions the renderer
 * cannot answer on its own from a bare path:
 *
 *   1. When was the exe last modified and how big is it? (file stats — cheap)
 *   2. Who signed it, and does it look like a *launcher* rather than the game
 *      itself? A common cause of "sessions end too early" reports is the user
 *      pointing session tracking at (e.g.) `EADesktop.exe` or
 *      `EpicGamesLauncher.exe` — the launcher exits shortly after the real
 *      game process spawns, so the session appears to end within seconds.
 *
 * The renderer uses (2) to surface a "this looks like a launcher, not the
 * game — try picking the game's own .exe" hint next to the Executable field.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../safe-logger.js';
import { exePathError, isValidExePath } from './exe-path.js';

export interface ExeInfoResult {
  mtimeMs: number;
  sizeBytes: number;
  signerSubject: string | null;
  signerVerified: boolean;
  isLikelyLauncher: boolean;
  warnings: string[];
}

/**
 * Substrings we look for in the Authenticode signer subject to classify an
 * exe as "launcher-owned" rather than "game-owned". These are matched
 * case-insensitively against the CN / O of the signing certificate.
 *
 * A signer match alone is never enough: these publishers sign their own games
 * too (cs2.exe is Valve-signed, GTA5.exe Rockstar-signed), so it only counts
 * together with a launcher-shaped filename. 'Origin' and 'GOG' were dropped —
 * as bare substrings they hit unrelated signer names.
 */
const LAUNCHER_SIGNER_KEYWORDS = [
  'EA Digital Illusions',
  'Electronic Arts',
  'Riot Games',
  'Steam',
  'Valve',
  'Rockstar Games',
  'Ubisoft',
  'Epic Games',
  'Bethesda',
  'Blizzard',
  'Battle.net',
  'Uplay',
];

/** Lowercase basenames of well-known launcher/client exes — flagged on name alone. */
const KNOWN_LAUNCHER_BASENAMES = new Set([
  'steam.exe',
  'steamwebhelper.exe',
  'eadesktop.exe',
  'origin.exe',
  'epicgameslauncher.exe',
  'battle.net.exe',
  'battle.net launcher.exe',
  'riotclientservices.exe',
  'riotclientux.exe',
  'upc.exe',
  'ubisoftconnect.exe',
  'galaxyclient.exe',
  'bethesdanetlauncher.exe',
  'rockstarlauncher.exe',
  'launcher.exe',
  'playgtav.exe',
  'launcherpatcher.exe',
]);

/**
 * Filename shapes that imply "this is a launcher, not the game". 'launcher'
 * matches anywhere (MyGameLauncher.exe); 'loader' / 'bootstrap' only as a
 * whole word so names like downloader.exe don't trip it.
 */
const LAUNCHER_BASENAME_PATTERNS = [
  /launcher/,
  /(^|[^a-z0-9])loader([^a-z0-9]|$)/,
  /(^|[^a-z0-9])bootstrap([^a-z0-9]|$)/,
];

/**
 * Pure launcher heuristic. True when the basename is a known launcher exe, or
 * when the filename looks like a launcher AND the signer is a launcher-owning
 * publisher.
 */
export function isLikelyLauncherExe(exePath: string, signerSubject: string | null): boolean {
  const basenameLower = path.win32.basename(exePath).toLowerCase();
  if (KNOWN_LAUNCHER_BASENAMES.has(basenameLower)) return true;

  const stem = basenameLower.replace(/\.exe$/, '');
  const nameLooksLikeLauncher = LAUNCHER_BASENAME_PATTERNS.some((re) => re.test(stem));
  if (!nameLooksLikeLauncher || !signerSubject) return false;

  const subjLower = signerSubject.toLowerCase();
  return LAUNCHER_SIGNER_KEYWORDS.some((kw) => subjLower.includes(kw.toLowerCase()));
}

/**
 * Characters that can't appear in a real Windows path and mean something to
 * a shell. The path never reaches a shell any more; this is defence in depth
 * for paths that arrive from imported library data.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_PATH_CHARS = /["<>|?*\x00-\x1f]/;

/**
 * Constant PowerShell script. The exe path is read from $env:ARK_EXE and is
 * never interpolated, so no quoting rules apply. -LiteralPath keeps [ ] in
 * folder names (e.g. "Game [GOTY]") from being read as wildcards; UTF-8 output
 * keeps non-ASCII signer names intact.
 *
 * Status is forced to a string via .ToString() so we don't have to guess
 * whether ConvertTo-Json renders the SignatureStatus enum as its name (PS 7+)
 * or its numeric value (PS 5.1).
 */
export const SIGNATURE_SCRIPT =
  `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ` +
  `Get-AuthenticodeSignature -LiteralPath $env:ARK_EXE | ` +
  `Select-Object ` +
  `@{Name='Status';Expression={$_.Status.ToString()}}, ` +
  `@{Name='Subject';Expression={if ($_.SignerCertificate) { $_.SignerCertificate.Subject } else { $null }}} | ` +
  `ConvertTo-Json -Compress`;

export type ExecFileFn = (
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeout: number; windowsHide: boolean }
) => Promise<string>;

/** Promise-wrapped child_process.execFile (no shell) with a hard timeout. */
const realExecFile: ExecFileFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { ...opts, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(typeof stdout === 'string' ? stdout : String(stdout ?? ''));
      }
    );
  });

type StatFn = (p: string) => Promise<{ mtimeMs: number; size: number }>;
const realStat: StatFn = (p) => fs.promises.stat(p);

// Test-only injectable seam: `require('electron')` / child_process aren't
// swappable through vi.mock here — same pattern as launch-handlers.ts.
let _stat: StatFn = realStat;
let _execFile: ExecFileFn = realExecFile;
let _platform: () => string = () => process.platform;

export function __setExeInfoDepsForTests(deps?: {
  stat?: StatFn;
  execFile?: ExecFileFn;
  platform?: () => string;
}): void {
  _stat = deps?.stat ?? realStat;
  _execFile = deps?.execFile ?? realExecFile;
  _platform = deps?.platform ?? (() => process.platform);
}

/**
 * Analyze an exe's on-disk metadata + Authenticode signature.
 * Never throws — errors are captured into `warnings` so the renderer can
 * still show partial info (e.g. file stats without signature data).
 */
export async function analyzeExe(exePath: unknown): Promise<ExeInfoResult> {
  const warnings: string[] = [];
  const result: ExeInfoResult = {
    mtimeMs: 0,
    sizeBytes: 0,
    signerSubject: null,
    signerVerified: false,
    isLikelyLauncher: false,
    warnings,
  };

  if (!isValidExePath(exePath)) {
    warnings.push(exePathError(exePath) ?? 'Invalid exePath');
    return result;
  }
  if (FORBIDDEN_PATH_CHARS.test(exePath)) {
    warnings.push('exePath contains characters that are not valid in a file path');
    return result;
  }

  // ---- File stats (fast, always safe) ----
  let statOk = false;
  try {
    const st = await _stat(exePath);
    result.mtimeMs = st.mtimeMs;
    result.sizeBytes = st.size;
    statOk = true;
  } catch (err: any) {
    warnings.push(`stat failed: ${err?.message ?? String(err)}`);
  }

  // ---- Authenticode signature (Windows only, and only for a file that exists) ----
  const platform = _platform();
  if (platform !== 'win32') {
    warnings.push(`Signature check not supported on ${platform}`);
  } else if (statOk) {
    try {
      const raw = await _execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', SIGNATURE_SCRIPT],
        { env: { ...process.env, ARK_EXE: exePath }, timeout: 10_000, windowsHide: true }
      );
      const trimmed = raw.trim();

      if (trimmed) {
        const parsed = JSON.parse(trimmed) as { Status?: string; Subject?: string | null };
        const status = typeof parsed?.Status === 'string' ? parsed.Status : '';
        const subject =
          typeof parsed?.Subject === 'string' && parsed.Subject.length > 0
            ? parsed.Subject
            : null;
        result.signerSubject = subject;
        result.signerVerified = status === 'Valid';
        if (status && status !== 'Valid') {
          warnings.push(`Authenticode status: ${status}`);
        }
      } else {
        warnings.push('Empty response from Get-AuthenticodeSignature');
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // Common causes: PowerShell missing/blocked, ExecutionPolicy=Restricted,
      // file permission errors, or a 10s timeout. Not a hard failure — we
      // still return stats + a warning.
      warnings.push(`Signature check failed: ${msg.slice(0, 200)}`);
      logger.warn('[ExeInfo] Get-AuthenticodeSignature failed:', msg);
    }
  }

  // ---- Launcher heuristic ----
  result.isLikelyLauncher = isLikelyLauncherExe(exePath, result.signerSubject);

  return result;
}

export function register(): void {
  ipcMain.handle('exe-info:analyze', async (
    _event: any,
    args: { exePath: string }
  ): Promise<ExeInfoResult> => analyzeExe(args?.exePath));
}
