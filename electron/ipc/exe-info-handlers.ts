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
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../safe-logger.js';

interface ExeInfoResult {
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
  'GOG',
  'Uplay',
  'Origin',
];

/** Filename substrings that strongly imply "this is a launcher, not the game". */
const LAUNCHER_BASENAME_KEYWORDS = ['launcher', 'bootstrap', 'loader'];

/** Promise-wrapped child_process.exec with a hard timeout. */
function execWithTimeout(cmd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      cmd,
      {
        encoding: 'utf-8',
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(typeof stdout === 'string' ? stdout : String(stdout ?? ''));
      }
    );
  });
}

export function register(): void {
  /**
   * Analyze an exe's on-disk metadata + Authenticode signature.
   * Never throws — errors are captured into `warnings` so the renderer can
   * still show partial info (e.g. file stats without signature data).
   */
  ipcMain.handle('exe-info:analyze', async (
    _event: any,
    args: { exePath: string }
  ): Promise<ExeInfoResult> => {
    const warnings: string[] = [];
    const result: ExeInfoResult = {
      mtimeMs: 0,
      sizeBytes: 0,
      signerSubject: null,
      signerVerified: false,
      isLikelyLauncher: false,
      warnings,
    };

    const exePath = args?.exePath;
    if (typeof exePath !== 'string' || !exePath) {
      warnings.push('Invalid exePath');
      return result;
    }
    if (!path.isAbsolute(exePath)) {
      warnings.push('exePath must be absolute');
      return result;
    }
    if (!exePath.toLowerCase().endsWith('.exe')) {
      warnings.push('exePath must end with .exe');
      return result;
    }

    // ---- File stats (fast, always safe) ----
    try {
      const st = await fs.promises.stat(exePath);
      result.mtimeMs = st.mtimeMs;
      result.sizeBytes = st.size;
    } catch (err: any) {
      warnings.push(`stat failed: ${err?.message ?? String(err)}`);
      // Continue — signature check may still work.
    }

    // ---- Authenticode signature (Windows only) ----
    if (process.platform === 'win32') {
      try {
        // Escape single quotes for a PowerShell single-quoted string literal.
        const escaped = exePath.replace(/'/g, "''");
        // Force Status to a string via .ToString() so we don't have to guess
        // whether ConvertTo-Json will render the SignatureStatus enum as its
        // name (PS 7+) or its numeric value (PS 5.1).
        const psScript =
          `Get-AuthenticodeSignature -FilePath '${escaped}' | ` +
          `Select-Object ` +
          `@{Name='Status';Expression={$_.Status.ToString()}}, ` +
          `@{Name='Subject';Expression={if ($_.SignerCertificate) { $_.SignerCertificate.Subject } else { $null }}} | ` +
          `ConvertTo-Json -Compress`;
        const cmd = `powershell.exe -NoProfile -NonInteractive -Command "${psScript.replace(/"/g, '\\"')}"`;
        const raw = await execWithTimeout(cmd, 10_000);
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
    } else {
      warnings.push(`Signature check not supported on ${process.platform}`);
    }

    // ---- Launcher heuristic ----
    // Two independent signals: filename shape and signer identity. Either is
    // enough to flag; we don't require both because renamed launcher exes are
    // common (e.g. custom shortcuts).
    const basenameLower = path.basename(exePath).toLowerCase();
    const nameLooksLikeLauncher = LAUNCHER_BASENAME_KEYWORDS.some((kw) =>
      basenameLower.includes(kw)
    );

    let signerLooksLikeLauncher = false;
    if (result.signerSubject) {
      const subjLower = result.signerSubject.toLowerCase();
      signerLooksLikeLauncher = LAUNCHER_SIGNER_KEYWORDS.some((kw) =>
        subjLower.includes(kw.toLowerCase())
      );
    }

    result.isLikelyLauncher = nameLooksLikeLauncher || signerLooksLikeLauncher;

    return result;
  });
}
