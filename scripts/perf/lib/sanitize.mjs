/**
 * Strip what is specific to the machine or the person from a result JSON before it is committed as a baseline: absolute
 * Windows / POSIX paths, the user's profile name, the temp folder. Numbers, labels and the hardware description stay.
 */
import os from 'node:os';

const WIN_PATH = /[A-Za-z]:[\\/](?:[^\s"'`<>|*?\r\n,;]+[\\/])*[^\s"'`<>|*?\r\n,;\\/]*/g;
const POSIX_HOME = /\/(?:home|Users)\/[^\s"'`<>|*?\r\n,;/]+(?:\/[^\s"'`<>|*?\r\n,;]*)*/g;

function safeUser() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME ?? '';
  }
}

export function sanitizeString(s, extra = []) {
  let out = String(s);
  // keep the last path segment: a seed folder under the user's temp folder becomes "<path>/ark-perf-seed"
  out = out.replace(WIN_PATH, (m) => `<path>/${m.split(/[\\/]/).filter(Boolean).pop() ?? ''}`);
  out = out.replace(POSIX_HOME, (m) => `<path>/${m.split('/').filter(Boolean).pop() ?? ''}`);
  const names = new Set([safeUser(), ...extra].filter((n) => n && n.length >= 3));
  for (const n of names) out = out.split(n).join('<user>');
  return out;
}

export function sanitizeResult(value, extra = []) {
  if (typeof value === 'string') return sanitizeString(value, extra);
  if (Array.isArray(value)) return value.map((v) => sanitizeResult(v, extra));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeResult(v, extra)]));
  return value;
}
