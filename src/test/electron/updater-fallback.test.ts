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
import { resolveInstallerUrl, runFallbackDownload } from '../../../electron/updater-fallback';

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
  const fetchImpl = (_u: string, init?: RequestInit) => fetch(`${base}/x.exe`, init);
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
});
