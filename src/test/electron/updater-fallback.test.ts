/**
 * Alternate update download: the installer URL is taken only from the manifest and must be an https
 * GitHub URL; the installer is opened only after its sha512 matched.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveInstallerUrl, runFallbackDownload, cleanupStaleUpdateFiles } from '../../../electron/updater-fallback';

describe('resolveInstallerUrl', () => {
  it('builds the GitHub release URL from a relative manifest path', () => {
    expect(resolveInstallerUrl({ version: '1.0.84', files: [{ url: 'Ark-Setup-1.0.84.exe' }] }))
      .toBe('https://github.com/pourabkarchaudhuri/ark/releases/download/v1.0.84/Ark-Setup-1.0.84.exe');
  });

  it('accepts absolute https URLs on GitHub hosts only', () => {
    expect(resolveInstallerUrl({ version: '1.0.84', files: [{ url: 'https://objects.githubusercontent.com/x/Ark.exe' }] }))
      .toMatch(/^https:\/\/objects\.githubusercontent\.com\//);
    expect(resolveInstallerUrl({ version: '1.0.84', files: [{ url: 'http://github.com/x.exe' }] })).toBeUndefined();
    expect(resolveInstallerUrl({ version: '1.0.84', files: [{ url: 'https://evil.example.com/Ark.exe' }] })).toBeUndefined();
    expect(resolveInstallerUrl({ version: '1.0.84', files: [{ url: 'https://github.com.evil.io/Ark.exe' }] })).toBeUndefined();
  });

  it('rejects missing data and odd versions (no path injection through the version)', () => {
    expect(resolveInstallerUrl(null)).toBeUndefined();
    expect(resolveInstallerUrl({ version: '1.0.84', files: [] })).toBeUndefined();
    expect(resolveInstallerUrl({ version: '../../x', files: [{ url: 'a.exe' }] })).toBeUndefined();
  });

  it('encodes the file name', () => {
    expect(resolveInstallerUrl({ version: '1.0.84', files: [{ url: 'Ark Setup 1.0.84.exe' }] }))
      .toContain('/v1.0.84/Ark%20Setup%201.0.84.exe');
  });
});

describe('runFallbackDownload', () => {
  const PAYLOAD = crypto.randomBytes(32 * 1024);
  const SHA = crypto.createHash('sha512').update(PAYLOAD).digest('base64');
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end(PAYLOAD));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // The real URL is a GitHub URL; route it to the local server.
  // (The signal is dropped: under jsdom it is jsdom's AbortSignal, which Node's fetch rejects.)
  const fetchImpl = (_u: string, init?: RequestInit) => fetch(`${base}/x.exe`, { ...init, signal: undefined });
  const info = (sha512?: string) => ({ version: '1.0.84', files: [{ url: 'Ark-Setup-1.0.84.exe', size: PAYLOAD.length, sha512 }] });

  it('downloads, verifies, then opens the installer', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-fb-'));
    const openPath = vi.fn(async () => '');
    const res = await runFallbackDownload(info(SHA), { fetchImpl, openPath, tmpDir });
    expect(res.launched).toBe(true);
    expect(openPath).toHaveBeenCalledWith(res.path);
    expect(fs.readFileSync(res.path).equals(PAYLOAD)).toBe(true);
  });

  it('never opens an installer whose checksum does not match', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-fb-'));
    const openPath = vi.fn(async () => '');
    await expect(runFallbackDownload(info('wrong'), { fetchImpl, openPath, tmpDir })).rejects.toThrow(/sha512/);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('refuses a manifest without a checksum', async () => {
    const openPath = vi.fn(async () => '');
    await expect(runFallbackDownload(info(undefined), { fetchImpl, openPath })).rejects.toThrow(/checksum/);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('reports when Windows could not open the file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-fb-'));
    const res = await runFallbackDownload(info(SHA), { fetchImpl, openPath: async () => 'No application', tmpDir });
    expect(res).toMatchObject({ launched: false, openError: 'No application' });
  });

  it('clears older installers and abandoned partials before downloading, keeping this version\'s .part', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-fb-'));
    const dir = path.join(tmpDir, 'ark-update');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['Ark-Setup-1.0.80.exe', 'Ark-Setup-1.0.82.exe.part', 'stray.tmp']) fs.writeFileSync(path.join(dir, f), 'x');
    // A valid prefix of this version's installer: the download must resume from it, not delete it.
    fs.writeFileSync(path.join(dir, 'Ark-Setup-1.0.84.exe.part'), PAYLOAD.subarray(0, 1024));
    const seenRanges: Array<string | undefined> = [];
    const rangeFetch = async (_u: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.Range;
      seenRanges.push(range);
      const start = Number(/bytes=(\d+)-/.exec(range ?? '')?.[1] ?? 0);
      return new Response(PAYLOAD.subarray(start), {
        status: start ? 206 : 200,
        headers: start ? { 'content-range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}` } : {},
      });
    };
    const res = await runFallbackDownload(info(SHA), { fetchImpl: rangeFetch, openPath: async () => '', tmpDir });
    expect(seenRanges[0]).toBe('bytes=1024-');
    expect(fs.readFileSync(res.path).equals(PAYLOAD)).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(['Ark-Setup-1.0.84.exe']);
  });
});

describe('cleanupStaleUpdateFiles', () => {
  const mk = () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-fb-'));
    const dir = path.join(tmpDir, 'ark-update');
    fs.mkdirSync(dir, { recursive: true });
    return { tmpDir, dir };
  };

  it('removes installers and partials for the running version or older, keeps newer ones and other files', () => {
    const { tmpDir, dir } = mk();
    const names = [
      'Ark-Setup-1.0.9.exe', 'Ark-Setup-1.0.95.exe.part', 'Ark-Setup-1.0.96.exe',
      'Ark-Setup-1.0.97.exe', 'Ark-Setup-1.0.97.exe.part', 'notes.txt',
    ];
    for (const f of names) fs.writeFileSync(path.join(dir, f), 'x');
    const removed = cleanupStaleUpdateFiles({ currentVersion: '1.0.96', tmpDir });
    expect(removed.sort()).toEqual(['Ark-Setup-1.0.9.exe', 'Ark-Setup-1.0.95.exe.part', 'Ark-Setup-1.0.96.exe']);
    expect(fs.readdirSync(dir).sort()).toEqual(['Ark-Setup-1.0.97.exe', 'Ark-Setup-1.0.97.exe.part', 'notes.txt']);
  });

  it('skips a locked file quietly and still removes the rest', () => {
    const { tmpDir, dir } = mk();
    for (const f of ['Ark-Setup-1.0.90.exe', 'Ark-Setup-1.0.91.exe']) fs.writeFileSync(path.join(dir, f), 'x');
    const rm = vi.fn((p: string) => {
      if (p.endsWith('1.0.90.exe')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      fs.rmSync(p, { force: true });
    });
    expect(() => cleanupStaleUpdateFiles({ currentVersion: '1.0.96', tmpDir, rm })).not.toThrow();
    expect(rm).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(dir)).toEqual(['Ark-Setup-1.0.90.exe']);
  });

  it('does nothing when the folder does not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-fb-'));
    expect(cleanupStaleUpdateFiles({ currentVersion: '1.0.96', tmpDir })).toEqual([]);
  });
});
