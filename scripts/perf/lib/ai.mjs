/**
 * Built-in AI measurements (1.0.98 harness upgrade): llama-server per role, the LiteLLM sidecar, the model download path,
 * router overhead. Everything runs against a SCRATCH %LOCALAPPDATA% that holds hard links (or copies) of models the person
 * already has; the real %LOCALAPPDATA%\Ark is never written.
 *
 * Fakes served from this process: a "model" file with HTTP Range support (download probe) and a minimal
 * OpenAI-compatible server (the non-built-in route that makes the app start LiteLLM).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { sampleProcessTree, sleep, median, round } from './util.mjs';

// ------------------------------------------------------------------------------------------ scratch LOCALAPPDATA

/**
 * `modelsSrc` is a folder of .gguf files (+ their .verified.json markers). Returns the scratch LOCALAPPDATA root to hand
 * to the app (`<root>\Ark\models` holds the links). Hard links first (no extra disk, the app never writes a model file);
 * a copy when the volumes differ.
 */
export function seedModelsDir(modelsSrc, label = 'ai') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ark-perf-${label}-local-`));
  const dest = path.join(root, 'Ark', 'models');
  fs.mkdirSync(dest, { recursive: true });
  const files = [];
  for (const f of fs.readdirSync(modelsSrc)) {
    const src = path.join(modelsSrc, f);
    if (!fs.statSync(src).isFile() || !/\.(gguf|json)$/i.test(f) || /\.part$/i.test(f)) continue;
    try {
      fs.linkSync(src, path.join(dest, f));
    } catch {
      fs.copyFileSync(src, path.join(dest, f));
    }
    if (/\.gguf$/i.test(f)) files.push(f);
  }
  return { root, modelsDir: dest, files };
}

export function removeScratch(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort; hard links only drop their own entry */
  }
}

// ------------------------------------------------------------------------------------------ fake servers

/**
 * A synthetic "model": `sizeBytes` of a repeating pseudo-random 1 MiB block, served with HTTP Range (206 + Content-Range)
 * so the app's resumable download behaves as against Hugging Face. The sha256 is computed up front from the same block.
 * `rateMBps` (optional) throttles the stream; unthrottled loopback is the worst case for the main thread.
 */
export async function startFakeModelServer({ sizeBytes = 512 * 1024 * 1024, rateMBps = 0 } = {}) {
  const BLOCK = 1024 * 1024;
  const block = crypto.randomBytes(BLOCK);
  const h = crypto.createHash('sha256');
  for (let off = 0; off < sizeBytes; off += BLOCK) h.update(off + BLOCK <= sizeBytes ? block : block.subarray(0, sizeBytes - off));
  const sha256 = h.digest('hex');
  const stats = { requests: 0, ranged: 0, bytesSent: 0 };
  const server = http.createServer((req, res) => {
    stats.requests++;
    let start = 0;
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (m) {
      start = Number(m[1]);
      stats.ranged++;
    }
    if (start >= sizeBytes) {
      res.writeHead(416, { 'Content-Range': `bytes */${sizeBytes}` });
      return res.end();
    }
    const len = sizeBytes - start;
    res.writeHead(m ? 206 : 200, {
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(len),
      ...(m ? { 'Content-Range': `bytes ${start}-${sizeBytes - 1}/${sizeBytes}` } : {}),
    });
    let pos = start;
    const pump = () => {
      while (pos < sizeBytes) {
        const inBlock = pos % BLOCK;
        const chunk = block.subarray(inBlock, Math.min(BLOCK, inBlock + (sizeBytes - pos)));
        pos += chunk.length;
        stats.bytesSent += chunk.length;
        if (!res.write(chunk)) return void res.once('drain', rateMBps ? () => setTimeout(pump, (chunk.length / (rateMBps * 1048576)) * 1000) : pump);
        if (rateMBps) return void setTimeout(pump, (chunk.length / (rateMBps * 1048576)) * 1000);
      }
      res.end();
    };
    res.on('close', () => { pos = sizeBytes; });
    pump();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}/perf-synthetic.gguf`, size: sizeBytes, sha256, stats, close: () => new Promise((r) => server.close(() => r())) };
}

/** Minimal OpenAI-compatible server (models, chat, embeddings, rerank): the "non-built-in route" for the LiteLLM probe. */
export async function startFakeOpenAi() {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j = null;
      try { j = JSON.parse(body); } catch { /* not JSON */ }
      hits.push(`${req.method} ${req.url}`);
      const send = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const p = req.url.split('?')[0];
      if (p.endsWith('/models')) return send({ object: 'list', data: [{ id: 'fake-chat', object: 'model' }] });
      if (p.endsWith('/chat/completions')) return send({ id: 'cmpl-1', object: 'chat.completion', created: 1, model: j?.model || 'fake-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
      send({ error: { message: `not found ${p}` } }, 404);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, hits, close: () => new Promise((r) => server.close(() => r())) };
}

// ------------------------------------------------------------------------------------------ process reading

/** Split the non-Electron children of the app into llama-server, python (LiteLLM) and anything else. */
export function classifyExternal(external = []) {
  const llama = external.filter((p) => /^llama-server(\.exe)?$/i.test(p.name));
  const python = external.filter((p) => /^pythonw?(\d[\d.]*)?(\.exe)?$/i.test(p.name));
  const other = external.filter((p) => !llama.includes(p) && !python.includes(p));
  const ws = (a) => round(a.reduce((x, p) => x + p.workingSetMB, 0), 1);
  return { llama, python, other, llamaWorkingSetMB: ws(llama), pythonWorkingSetMB: ws(python) };
}

/** llama-server processes mapped to their role through the pids the app reports (`ai.status().runtime`). */
export function llamaByRole(tree, aiStatus) {
  const byPid = new Map(tree.map((p) => [p.pid, p]));
  const out = {};
  for (const r of aiStatus?.runtime ?? []) {
    const p = r.pid ? byPid.get(r.pid) : null;
    if (p) out[r.role] = { pid: p.pid, state: r.state, workingSetMB: p.workingSetMB, cpuSec: p.cpuSec };
  }
  return out;
}

/** Cumulative-CPU delta of the processes present in both samples, as % of one core. */
export function cpuPctBetween(a, b, pids, wallS) {
  if (!(wallS > 0)) return null;
  const at = new Map(a.map((p) => [p.pid, p.cpuSec]));
  let d = 0;
  for (const p of b) if (pids.includes(p.pid) && at.has(p.pid)) d += p.cpuSec - at.get(p.pid);
  return round((d / wallS) * 100, 2);
}

/** Processes still alive under `rootPid` (orphans keep their parent id), after waiting up to `waitS`. */
export async function leftoversAfterQuit(rootPid, waitS = 20) {
  const t0 = Date.now();
  let procs = [];
  while (Date.now() - t0 < waitS * 1000) {
    procs = (await sampleProcessTree(rootPid)).procs.filter((p) => !/^(conhost|cmd)\.exe$/i.test(p.name));
    if (!procs.length) break;
    await sleep(1000);
  }
  return procs.map((p) => ({ name: p.name, pid: p.pid }));
}

// ------------------------------------------------------------------------------------------ the phases

const ELD = (probes, reset = true) => probes.eventLoop(reset).catch(() => null);

/** Warm start of the embed and rerank servers through the app's own path; returns once both report ready. */
export async function warmServers(probes, log, timeoutS = 240) {
  const t0 = Date.now();
  const first = await probes.ai('burst', { mode: 'app', embedTexts: 4, rerankDocs: 4, rounds: 1 }).catch((e) => ({ error: String(e) }));
  const burst = first;
  let st = null;
  while (Date.now() - t0 < timeoutS * 1000) {
    st = await probes.aiStatus();
    const ready = (role) => st?.runtime?.some((r) => r.role === role && r.state === 'ready');
    if (ready('embed') && ready('rerank')) break;
    await sleep(1000);
  }
  log(`  AI warm-up ${Math.round((Date.now() - t0) / 1000)} s, burst ok ${burst?.embedOk}/${burst?.rerankOk}${burst?.error ? ` (${burst.error})` : ''}`);
  return { ms: Date.now() - t0, burst, status: st };
}

/**
 * llama-server per role: working set, idle CPU (servers loaded, nothing asked), CPU during an embedding + rerank burst, and
 * the router overhead (app path vs direct to llama-server, interleaved so thermal drift hits both the same).
 */
export async function measureLlama(probes, log, { rounds = 10, idleS = 20, settleS = 2, quietTimeoutS = 600, embedTexts = 32, rerankDocs = 32 } = {}) {
  const out = { rounds, embedTexts, rerankDocs };
  out.warm = await warmServers(probes, log);
  const st0 = await probes.aiStatus();
  out.routes = { embeddings: st0?.embeddingsVia ?? null, reranker: st0?.rerankerVia ?? null, backend: st0?.backend ?? null };
  const pidsOf = (st) => (st?.runtime ?? []).filter((r) => r.pid && r.state === 'ready').map((r) => r.pid);

  // The app embeds the library in the background after boot (the embed server is already running at "Enter Ark" and works for minutes
  // on a 2000-game profile), so "idle" first means waiting until that queue has drained: 3 consecutive 5 s windows with every role under
  // 3% of a core. How long that took is reported (quietAfterS); a server that never quiets inside quietTimeoutS fails the idle budget.
  {
    const t0 = Date.now();
    let calm = 0;
    let prev = await sampleProcessTree(probes.pid);
    let tPrev = Date.now();
    while (Date.now() - t0 < quietTimeoutS * 1000 && calm < 3) {
      await sleep(5000);
      const cur = await sampleProcessTree(probes.pid);
      const stNow = await probes.aiStatus();
      const pids = pidsOf(stNow);
      const now = Date.now();
      const worst = Math.max(0, ...pids.map((p) => cpuPctBetween(prev.procs, cur.procs, [p], (now - tPrev) / 1000) ?? 0));
      calm = worst <= 3 ? calm + 1 : 0;
      prev = cur;
      tPrev = now;
    }
    out.quietAfterS = Math.round((Date.now() - t0) / 1000);
    out.quiesced = calm >= 3;
    log(`  llama servers ${out.quiesced ? 'went quiet' : 'did NOT go quiet'} after ${out.quietAfterS} s (background embedding drains first)`);
  }
  await sleep(settleS * 1000);
  const windows = 4;
  const winS = idleS / windows;
  const samples = [await sampleProcessTree(probes.pid)];
  const stamps = [Date.now()];
  for (let i = 0; i < windows; i++) {
    await sleep(winS * 1000);
    samples.push(await sampleProcessTree(probes.pid));
    stamps.push(Date.now());
  }
  const st1 = await probes.aiStatus();
  const rolesNow = llamaByRole(samples[windows].procs, st1);
  out.perRole = {};
  for (const [role, info] of Object.entries(rolesNow)) {
    const wins = [];
    for (let i = 0; i < windows; i++) wins.push(cpuPctBetween(samples[i].procs, samples[i + 1].procs, [info.pid], (stamps[i + 1] - stamps[i]) / 1000));
    out.perRole[role] = { workingSetMB: info.workingSetMB, idleCpuPct: round(median(wins), 2), idleWindowsPct: wins };
  }
  out.idle = { seconds: idleS, settleS, llamaCpuPct: cpuPctBetween(samples[0].procs, samples[windows].procs, pidsOf(st1), (stamps[windows] - stamps[0]) / 1000) };
  log(`  llama idle (${windows} x ${winS} s after ${settleS} s settle): ${JSON.stringify(Object.fromEntries(Object.entries(out.perRole).map(([k, v]) => [k, `${v.workingSetMB} MB median ${v.idleCpuPct}% windows ${v.idleWindowsPct.join('/')}`])))}`);

  // burst: interleave direct and app rounds; CPU measured over the whole interleaved window (both do the same server work)
  const direct = { embedMs: [], rerankMs: [] };
  const app = { embedMs: [], rerankMs: [] };
  const warmOpts = (mode) => ({ mode, embedTexts, rerankDocs, rounds: 1 });
  await probes.ai('burst', warmOpts('direct'));
  await probes.ai('burst', warmOpts('app'));
  await ELD(probes);
  const c = await sampleProcessTree(probes.pid);
  const tc = Date.now();
  let burstError = null;
  for (let i = 0; i < rounds; i++) {
    const order = i % 2 === 0 ? ['direct', 'app'] : ['app', 'direct'];
    for (const mode of order) {
      const r = await probes.ai('burst', warmOpts(mode));
      if (r?.error || !r?.embedOk || !r?.rerankOk) burstError = r?.error ?? `${mode}: embedOk=${r?.embedOk} rerankOk=${r?.rerankOk}`;
      (mode === 'direct' ? direct : app).embedMs.push(...(r?.embedMs ?? []));
      (mode === 'direct' ? direct : app).rerankMs.push(...(r?.rerankMs ?? []));
    }
  }
  const d = await sampleProcessTree(probes.pid);
  const td = Date.now();
  out.burstEld = await ELD(probes);
  const st2 = await probes.aiStatus();
  const burstWall = (td - tc) / 1000;
  for (const [role, info] of Object.entries(llamaByRole(d.procs, st2))) {
    out.perRole[role] = { ...(out.perRole[role] ?? {}), burstCpuPct: cpuPctBetween(c.procs, d.procs, [info.pid], burstWall), burstWorkingSetMB: info.workingSetMB };
  }
  out.burstError = burstError;
  const med = (o) => ({ embedMs: round(median(o.embedMs), 1), rerankMs: round(median(o.rerankMs), 1) });
  out.direct = { ...med(direct), samples: direct.embedMs.length };
  out.app = { ...med(app), samples: app.embedMs.length };
  const per = (dm, am) => (dm > 0 ? round(((am - dm) / dm) * 100, 2) : null);
  out.overheadPct = { embed: per(out.direct.embedMs, out.app.embedMs), rerank: per(out.direct.rerankMs, out.app.rerankMs) };
  // throughput of one embed+rerank call pair, items per second
  const itemsPerS = (o) => round(((embedTexts + rerankDocs) / ((o.embedMs + o.rerankMs) / 1000)), 2);
  out.itemsPerS = { direct: itemsPerS(out.direct), app: itemsPerS(out.app) };
  out.overheadPct.combined = per(out.direct.embedMs + out.direct.rerankMs, out.app.embedMs + out.app.rerankMs);
  log(`  router overhead (route ${out.routes.embeddings}/${out.routes.reranker}): embed ${out.overheadPct.embed}%, rerank ${out.overheadPct.rerank}%, combined ${out.overheadPct.combined}% (direct ${out.direct.embedMs}+${out.direct.rerankMs} ms, app ${out.app.embedMs}+${out.app.rerankMs} ms)`);
  return out;
}

/**
 * Model download through the app's real path (renderer -> localAi:downloadChat -> ModelStore -> resumable download -> sha256
 * verify), served by a local HTTP server with Range support. Reads the main-thread event-loop max and the status pushes.
 */
export async function measureDownload({ probes, page, modelsDir, log, sizeBytes = 512 * 1024 * 1024, timeoutS = 240 }) {
  const out = { sizeMB: round(sizeBytes / 1048576, 0) };
  const srv = await startFakeModelServer({ sizeBytes });
  const file = 'perf-synthetic.gguf';
  try {
    const prep = await probes.ai('prepareDownload', { file, url: srv.url, size: srv.size, sha256: srv.sha256 });
    if (!prep) {
      out.error = 'build has no overridable local-ai manifest';
      return out;
    }
    fs.rmSync(path.join(modelsDir, file), { force: true });
    fs.rmSync(path.join(modelsDir, `${file}.part`), { force: true });
    await ELD(probes);
    await probes.ipc(true);
    const t0 = await probes.now();
    const w0 = Date.now();
    await page.evaluate(() => window.localAi.downloadChat({ confirmed: true }));
    // finished when the verified file is in place (the .part is renamed after the hash matched); progress read from disk, not over IPC
    let done = false;
    while (Date.now() - w0 < timeoutS * 1000) {
      if (fs.existsSync(path.join(modelsDir, file)) && !fs.existsSync(path.join(modelsDir, `${file}.part`))) {
        done = true;
        break;
      }
      await sleep(200);
    }
    const wallMs = Date.now() - w0;
    const t1 = await probes.now();
    const eld = await ELD(probes);
    const ipc = await probes.ipc(true);
    const pushes = ipc.send?.['localAi:status-changed'] ?? { calls: 0, maxPerSec: 0 };
    const longTasks = await probes.longTasksBetween(t0, t1).catch(() => []);
    Object.assign(out, {
      ok: done,
      wallMs,
      mbPerS: round(sizeBytes / 1048576 / (wallMs / 1000), 1),
      eldMaxMs: eld?.max ?? null,
      eldP99Ms: eld?.p99 ?? null,
      statusPushes: pushes.calls,
      statusPushesPerSecAvg: round(pushes.calls / (wallMs / 1000), 2),
      statusPushesMaxPerSec: pushes.maxPerSec ?? null,
      statusPushKB: round((pushes.argBytes ?? 0) / 1024, 1),
      rendererLongTaskMaxMs: longTasks.length ? Math.max(...longTasks) : 0,
      serverRequests: srv.stats.requests,
      rangeRequests: srv.stats.ranged,
    });
    log(`  download ${out.sizeMB} MB: ${out.mbPerS} MB/s in ${wallMs} ms, ELD max ${out.eldMaxMs} ms, status pushes ${out.statusPushes} (${out.statusPushesPerSecAvg}/s avg, ${out.statusPushesMaxPerSec}/s max)`);
  } finally {
    await probes.ai('restoreDownload').catch(() => {});
    fs.rmSync(path.join(modelsDir, file), { force: true });
    fs.rmSync(path.join(modelsDir, `${file}.part`), { force: true });
    fs.rmSync(path.join(modelsDir, `${file}.verified.json`), { force: true });
    await srv.close();
  }
  return out;
}

/** LiteLLM sidecar: not running until a non-built-in route exists; then its working set; (the caller checks the exit on quit). */
export async function measureSidecar({ probes, log }) {
  const out = {};
  const before = await probes.aiStatus();
  const tree0 = await sampleProcessTree(probes.pid);
  out.beforeRoute = { sidecarState: before?.sidecar?.state ?? null, pythonProcesses: classifyExternal(tree0.procs.filter((p) => p.pid !== probes.pid)).python.length, embeddingsVia: before?.embeddingsVia ?? null, chatVia: before?.chatVia ?? null };
  const fake = await startFakeOpenAi();
  try {
    const r = await probes.ai('startSidecar', { baseUrl: fake.baseUrl, model: 'fake-chat' });
    out.start = r;
    await sleep(2500);
    const after = await probes.aiStatus();
    const tree1 = await sampleProcessTree(probes.pid);
    const cls = classifyExternal(tree1.procs.filter((p) => p.pid !== probes.pid));
    out.afterRoute = { sidecarState: after?.sidecar?.state ?? null, chatVia: after?.chatVia ?? null, pythonProcesses: cls.python.length, pythonWorkingSetMB: cls.pythonWorkingSetMB };
    // idle CPU of the sidecar once started
    const a = await sampleProcessTree(probes.pid);
    const ta = Date.now();
    await sleep(10_000);
    const b = await sampleProcessTree(probes.pid);
    out.idleCpuPct = cpuPctBetween(a.procs, b.procs, classifyExternal(b.procs.filter((p) => p.pid !== probes.pid)).python.map((p) => p.pid), (Date.now() - ta) / 1000);
    out.fakeHits = fake.hits.length;
    log(`  LiteLLM sidecar: ${JSON.stringify(out.afterRoute)}, idle CPU ${out.idleCpuPct}%, started in ${r?.startMs} ms${r?.error ? ` (error ${r.error})` : ''}`);
  } finally {
    await fake.close();
  }
  return out;
}
