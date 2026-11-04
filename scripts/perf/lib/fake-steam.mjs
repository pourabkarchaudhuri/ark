/**
 * Local stand-in for api.steampowered.com's IStoreService/GetAppList (the real host is unreachable from the
 * build network, and the harness must not use real keys anyway). Serves a deterministic 155k-entry list in
 * 50,000-entry pages, like the real endpoint, so the main process does the full refresh work: download
 * parse, sort, store write.
 *
 * The app is pointed at it with `--host-resolver-rules=MAP api.steampowered.com 127.0.0.1:<port>` plus
 * `--ignore-certificate-errors` on the TEST process only (self-signed cert generated here with openssl).
 */
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-perf-cert-'));
  const key = path.join(dir, 'k.pem');
  const crt = path.join(dir, 'c.pem');
  let openssl = 'openssl';
  for (const c of ['C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe']) {
    if (fs.existsSync(c)) {
      openssl = c;
      break;
    }
  }
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=api.steampowered.com'], {
    stdio: 'ignore',
    env: { ...process.env, OPENSSL_CONF: process.env.OPENSSL_CONF ?? '' },
  });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

export async function startFakeSteam({ entries = 155000, pageSize = 50000 } = {}) {
  const apps = new Array(entries);
  for (let i = 0; i < entries; i++) apps[i] = { appid: 20 + i * 10, name: `Fake Game ${(entries - i).toString(36)} ${i}`, last_modified: 1700000000 + i, price_change_number: i };
  const stats = { requests: 0, urls: [] };
  const server = https.createServer(makeCert(), (req, res) => {
    stats.requests++;
    stats.urls.push((req.url ?? '').split('?')[0]);
    const u = new URL(req.url ?? '/', 'https://api.steampowered.com');
    if (u.pathname.includes('IStoreService/GetAppList')) {
      const last = Number(u.searchParams.get('last_appid') ?? 0);
      const max = Math.min(Number(u.searchParams.get('max_results') ?? pageSize), pageSize);
      const start = last ? apps.findIndex((a) => a.appid > last) : 0;
      const page = start < 0 ? [] : apps.slice(start, start + max);
      const more = start >= 0 && start + max < apps.length;
      const body = JSON.stringify({ response: { apps: page, have_more_results: more, last_appid: page.length ? page[page.length - 1].appid : undefined } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, stats, close: () => new Promise((r) => server.close(r)) };
}
