/**
 * Release packaging (1.0.97 B01): the installer's .env is written through an allow-list, the
 * afterPack check fails on any packaged AZURE_* assignment, and the publish script's upload
 * helpers treat HTTP errors and half-uploaded assets correctly. All file-system only, no network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RELEASE_ENV_KEYS, filterReleaseEnv, envKeyNames, findForbiddenEnvNames } from '../../../scripts/lib/release-env.mjs';
import { checkPackagedDir } from '../../../scripts/after-pack-check.mjs';
import { CURL_STATUS_MARKER, parseCurlUpload, isUploadSuccess, staleAssetIds } from '../../../scripts/lib/release-upload.mjs';

const FIXTURE_ENV = [
  '# dev keys',
  'AZURE_OPENAI_ENDPOINT=https://example.invalid/',
  'AZURE_OPENAI_KEY=fake-azure-key',
  'STEAM_API_KEY=fake-steam',
  'GA_MEASUREMENT_ID=G-FAKE',
  '',
  'GA_API_SECRET="fake-secret"',
  'SOMETHING_ELSE=1',
  'export AZURE_OPENAI_DEPLOYMENT=gpt',
].join('\r\n');

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-pack-test-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('filterReleaseEnv', () => {
  it('keeps only the allow-listed keys and drops every AZURE_* and unknown key', () => {
    const out = filterReleaseEnv(FIXTURE_ENV);
    expect(envKeyNames(out)).toEqual(['STEAM_API_KEY', 'GA_MEASUREMENT_ID', 'GA_API_SECRET']);
    expect(out).not.toMatch(/AZURE_/);
    expect(out).not.toMatch(/SOMETHING_ELSE/);
    expect(out).toContain('STEAM_API_KEY=fake-steam');
  });

  it('allow-list has no AZURE_* name and covers the keys the packaged main process reads', () => {
    expect(RELEASE_ENV_KEYS.some((k: string) => k.startsWith('AZURE_'))).toBe(false);
    expect([...RELEASE_ENV_KEYS].sort()).toEqual(['GA_API_SECRET', 'GA_MEASUREMENT_ID', 'STEAM_API_KEY']);
  });

  it('drops allow-listed keys with an empty value and returns "" for an empty input', () => {
    expect(filterReleaseEnv('STEAM_API_KEY=\nGA_API_SECRET=""\n')).toBe('');
    expect(filterReleaseEnv('')).toBe('');
  });
});

describe('afterPack check', () => {
  it('passes a clean unpacked dir', () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, '.env'), filterReleaseEnv(FIXTURE_ENV));
    fs.mkdirSync(path.join(d, 'resources'));
    // Compiled code that only reads the variable is not an assignment.
    fs.writeFileSync(path.join(d, 'resources', 'main.js'), 'const k = process.env.AZURE_OPENAI_KEY;\n');
    expect(checkPackagedDir(d)).toEqual([]);
  });

  it('fails when the packaged .env carries an AZURE_* key', () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, '.env'), FIXTURE_ENV);
    const problems = checkPackagedDir(d);
    expect(problems.join('\n')).toMatch(/AZURE_OPENAI_KEY/);
  });

  it('fails when any nested text file assigns an AZURE_* name', () => {
    const d = tmpDir();
    fs.mkdirSync(path.join(d, 'resources', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(d, 'resources', 'deep', 'copy.env'), 'AZURE_OPENAI_KEY=leak\n');
    expect(checkPackagedDir(d)).toHaveLength(1);
    expect(findForbiddenEnvNames('  AZURE_X = 1\nSTEAM_API_KEY=2')).toEqual(['AZURE_X']);
  });
});

describe('publish upload helpers', () => {
  it('splits the HTTP status off curl output and rejects non-2xx even with a JSON body', () => {
    const ok = parseCurlUpload(`{"state":"uploaded","size":10}${CURL_STATUS_MARKER}201`);
    expect(ok).toEqual({ status: 201, body: { state: 'uploaded', size: 10 } });
    expect(isUploadSuccess(ok)).toBe(true);

    const exists = parseCurlUpload(`{"message":"Validation Failed","errors":[{"code":"already_exists"}]}${CURL_STATUS_MARKER}422`);
    expect(exists.status).toBe(422);
    expect(isUploadSuccess(exists)).toBe(false);
  });

  it('treats a missing status marker or non-JSON body as a failure', () => {
    expect(isUploadSuccess(parseCurlUpload('{"state":"uploaded"}'))).toBe(false);
    expect(parseCurlUpload(`<html>bad gateway</html>${CURL_STATUS_MARKER}502`)).toEqual({ status: 502, body: null });
  });

  it('lists only same-name assets that are not fully uploaded', () => {
    const assets = [
      { id: 1, name: 'Ark-Setup-1.0.97.exe', state: 'starter' },
      { id: 2, name: 'Ark-Setup-1.0.97.exe', state: 'uploaded' },
      { id: 3, name: 'latest.yml', state: 'new' },
    ];
    expect(staleAssetIds(assets, 'Ark-Setup-1.0.97.exe')).toEqual([1]);
    expect(staleAssetIds(assets, 'latest.yml')).toEqual([3]);
    expect(staleAssetIds(undefined, 'latest.yml')).toEqual([]);
  });
});
