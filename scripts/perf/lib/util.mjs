import { execFile } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function median(a) {
  const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(a, p) {
  const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!s.length) return NaN;
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export const round = (x, d = 1) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

/**
 * Every descendant of `rootPid` (Electron's own processes AND non-Electron children such as
 * llama-server or the Python sidecar) with working set and cumulative CPU seconds.
 */
export function sampleProcessTree(rootPid) {
  const ps =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,UserModeTime,KernelModeTime | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ error: String(err), procs: [] });
      let rows;
      try {
        rows = JSON.parse(stdout);
      } catch {
        return resolve({ error: 'parse', procs: [] });
      }
      if (!Array.isArray(rows)) rows = [rows];
      const kids = new Map();
      for (const r of rows) {
        if (!kids.has(r.ParentProcessId)) kids.set(r.ParentProcessId, []);
        kids.get(r.ParentProcessId).push(r);
      }
      const byPid = new Map(rows.map((r) => [r.ProcessId, r]));
      const out = [];
      const walk = (pid) => {
        const self = byPid.get(pid);
        if (self) out.push(self);
        for (const k of kids.get(pid) ?? []) walk(k.ProcessId);
      };
      walk(rootPid);
      resolve({
        procs: out.map((r) => ({
          pid: r.ProcessId,
          name: r.Name,
          workingSetMB: Math.round((r.WorkingSetSize / 1048576) * 10) / 10,
          cpuSec: ((r.UserModeTime ?? 0) + (r.KernelModeTime ?? 0)) / 1e7,
        })),
      });
    });
  });
}
