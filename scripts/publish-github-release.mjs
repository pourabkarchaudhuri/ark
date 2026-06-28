/**
 * Create a GitHub release for the current package.json version and upload
 * NSIS installer, blockmap, and latest.yml from release/.
 * Requires: GITHUB_TOKEN with repo scope (or contents + write for releases).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('Set GITHUB_TOKEN');
  process.exit(1);
}

const repo = 'pourabkarchaudhuri/ark';
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const v = pkg.version;
const body = fs.readFileSync(path.join(root, 'release', 'release-body.md'), 'utf8');

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function main() {
  const createRes = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: `v${v}`,
      name: `v${v}`,
      body,
      draft: false,
      prerelease: false,
    }),
  });
  const createText = await createRes.text();
  if (!createRes.ok) {
    console.error(createText);
    process.exit(1);
  }
  const release = JSON.parse(createText);
  const releaseId = release.id;
  console.log('Created release', release.html_url, 'id=', releaseId);

  const files = [
    `Ark-Setup-${v}.exe`,
    `Ark-Setup-${v}.exe.blockmap`,
    'latest.yml',
  ];

  for (const name of files) {
    const filePath = path.join(root, 'release', name);
    const buf = fs.readFileSync(filePath);
    const url = `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
    const up = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(buf.length),
      },
      body: buf,
    });
    const upText = await up.text();
    if (!up.ok) {
      console.error('Upload failed', name, upText);
      process.exit(1);
    }
    console.log('Uploaded', name);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
