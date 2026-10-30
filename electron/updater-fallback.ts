/**
 * Alternate update download: resolve the installer from the release manifest, download it with
 * resume + sha512 verification, and hand it to Windows to run.
 *
 * The URL never comes from the renderer — only from the manifest electron-updater fetched — and must
 * be https on a GitHub host, because the end of this path launches an executable.
 */
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadWithResume } from './resumable-download.js';
import { isVersionGreater } from './updater-version.js';

export interface ManifestFile {
  url?: string;
  sha512?: string;
  size?: number;
}

export interface ManifestInfo {
  version: string;
  files?: ManifestFile[];
}

const REPO_DOWNLOAD_BASE = 'https://github.com/pourabkarchaudhuri/ark/releases/download';
const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

/** Direct installer URL for a manifest, or undefined when it is missing or not an allowed host. */
export function resolveInstallerUrl(info: ManifestInfo | null | undefined): string | undefined {
  const file = info?.files?.[0];
  if (!info || !file?.url || !/^\d+\.\d+\.\d+([-.][\w.]+)?$/.test(info.version)) return undefined;
  const raw = /^https?:\/\//i.test(file.url)
    ? file.url
    : `${REPO_DOWNLOAD_BASE}/v${info.version}/${encodeURIComponent(file.url)}`;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

export interface FallbackDeps {
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  openPath: (p: string) => Promise<string>;
  tmpDir?: string;
  onProgress?: (p: { transferred: number; total: number }) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Removes one temp-folder entry (injectable so tests can simulate a locked file). */
  rm?: (p: string) => void;
}

const defaultRm = (p: string) => fs.rmSync(p, { recursive: true, force: true });

/** %TEMP%/ark-update: where the alternate download keeps its installers. */
export function updateDir(tmpDir?: string): string {
  return path.join(tmpDir ?? os.tmpdir(), 'ark-update');
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

const INSTALLER_NAME = /^Ark-Setup-(\d+\.\d+\.\d+(?:[-.][\w.]+?)?)\.exe(?:\.part)?$/;

/**
 * Startup cleanup: deletes Ark-Setup-<v>.exe / .part for the running version or older. Those are
 * installed (or superseded) and each is hundreds of MB. A file still locked by a running installer
 * (EBUSY/EPERM) is skipped quietly; the next start tries again. Returns the names removed.
 */
export function cleanupStaleUpdateFiles(opts: { currentVersion: string; tmpDir?: string; rm?: (p: string) => void }): string[] {
  const dir = updateDir(opts.tmpDir);
  const rm = opts.rm ?? defaultRm;
  const removed: string[] = [];
  for (const name of listDir(dir)) {
    const m = INSTALLER_NAME.exec(name);
    if (!m || isVersionGreater(m[1], opts.currentVersion)) continue;
    try {
      rm(path.join(dir, name));
      removed.push(name);
    } catch {
      // Locked or already gone: not worth reporting.
    }
  }
  return removed;
}

/** Before a download: drop everything except this version's installer and its resumable .part. */
function pruneForVersion(dir: string, version: string, rm: (p: string) => void): void {
  const keep = new Set([`Ark-Setup-${version}.exe`, `Ark-Setup-${version}.exe.part`]);
  for (const name of listDir(dir)) {
    if (keep.has(name)) continue;
    try {
      rm(path.join(dir, name));
    } catch {
      // A locked leftover must not block the download.
    }
  }
}

export interface FallbackResult {
  path: string;
  launched: boolean;
  openError?: string;
}

export async function runFallbackDownload(info: ManifestInfo, deps: FallbackDeps): Promise<FallbackResult> {
  const url = resolveInstallerUrl(info);
  const file = info.files?.[0];
  if (!url || !file) throw new Error('No valid installer in the update manifest');
  if (!file.sha512) throw new Error('The update manifest has no checksum, so the installer cannot be verified');

  const dir = updateDir(deps.tmpDir);
  const dest = path.join(dir, `Ark-Setup-${info.version}.exe`);
  pruneForVersion(dir, info.version, deps.rm ?? defaultRm);
  await downloadWithResume({
    url,
    destPath: dest,
    expectedSize: file.size,
    sha512: file.sha512,
    fetchImpl: deps.fetchImpl,
    onProgress: deps.onProgress,
    sleep: deps.sleep,
  });
  // Only reached after the sha512 check passed.
  const openError = await deps.openPath(dest);
  return openError ? { path: dest, launched: false, openError } : { path: dest, launched: true };
}
