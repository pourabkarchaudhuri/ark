/**
 * Classifies an update failure into something a user can act on.
 *
 * electron-updater surfaces raw Node/Chromium error text ("net::ERR_CONNECTION_RESET",
 * "ECONNRESET", "sha512 checksum mismatch"...). Users only ever saw "error downloading update",
 * which hides whether the fix is "retry", "free disk space" or "your network is blocking it".
 * Pure and dependency-free so it is unit-testable.
 */

export type UpdateErrorKind =
  | 'blocked-by-client'
  | 'network-reset'
  | 'network-timeout'
  | 'dns'
  | 'tls'
  | 'http'
  | 'checksum'
  | 'disk-full'
  | 'file-locked'
  | 'unknown';

export interface UpdateErrorInfo {
  kind: UpdateErrorKind;
  /** Node/Chromium error code when one could be found, e.g. ECONNRESET. */
  code?: string;
  httpStatus?: number;
  /** One-sentence, user-facing explanation and next step. */
  hint: string;
}

const CODE_RE = /\b(E[A-Z]{3,}[A-Z_]*|ERR_[A-Z_]+|CERT_[A-Z_]+|UNABLE_TO_[A-Z_]+)\b/;

export function classifyUpdateError(err: unknown): UpdateErrorInfo {
  const e = (err ?? {}) as { message?: unknown; code?: unknown; statusCode?: unknown };
  const message = typeof e.message === 'string' ? e.message : typeof err === 'string' ? err : '';
  const rawCode = typeof e.code === 'string' ? e.code : undefined;
  const code = rawCode ?? CODE_RE.exec(message)?.[1];
  const upper = (code ?? '').toUpperCase();
  const lower = message.toLowerCase();
  const status =
    typeof e.statusCode === 'number'
      ? e.statusCode
      : Number(/\b(?:status(?: code)?|http)\D{0,4}([45]\d\d)\b/i.exec(message)?.[1]) || undefined;

  if (upper.includes('BLOCKED_BY') || upper === 'BLOCKED_AT_OFFSET' || lower.includes('blocked')) {
    return {
      kind: 'blocked-by-client',
      code,
      hint: 'Something on this computer or network (security software, firewall or proxy) is blocking the installer download. Download it in your browser, or ask your IT team to allow GitHub downloads.',
    };
  }
  if (lower.includes('sha512') || lower.includes('checksum')) {
    return {
      kind: 'checksum',
      code,
      hint: 'The downloaded installer did not match its checksum, so it was discarded. Retry, or download the installer from GitHub.',
    };
  }
  if (upper === 'ENOSPC') {
    return { kind: 'disk-full', code, hint: 'Your disk is full. Free some space and retry.' };
  }
  if (['EPERM', 'EACCES', 'EBUSY'].includes(upper)) {
    return {
      kind: 'file-locked',
      code,
      hint: 'Windows or your antivirus is holding the downloaded installer file. Retry, or download it from GitHub.',
    };
  }
  if (upper.includes('CERT') || upper.startsWith('UNABLE_TO_') || upper.includes('SSL') || lower.includes('certificate')) {
    return {
      kind: 'tls',
      code,
      hint: 'The secure connection to GitHub was rejected, often by a proxy or antivirus inspecting traffic. Download the installer in your browser instead.',
    };
  }
  if (upper === 'ENOTFOUND' || upper === 'EAI_AGAIN' || upper.includes('NAME_NOT_RESOLVED') || upper.includes('INTERNET_DISCONNECTED')) {
    return { kind: 'dns', code, hint: 'Could not reach github.com. Check your internet connection and retry.' };
  }
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(upper) || upper.includes('TIMED_OUT') || lower.includes('timed out') || lower.includes('timeout')) {
    return { kind: 'network-timeout', code, hint: 'The download timed out. Retry; if it keeps happening, download the installer in your browser.' };
  }
  if (
    ['ECONNRESET', 'ECONNABORTED', 'EPIPE'].includes(upper) ||
    upper.includes('CONNECTION_RESET') ||
    upper.includes('CONNECTION_CLOSED') ||
    upper.includes('EMPTY_RESPONSE') ||
    lower.includes('socket hang up') ||
    lower.includes('ended early')
  ) {
    return {
      kind: 'network-reset',
      code,
      hint: 'The connection was cut mid-download. Try the alternate download (it resumes where it stopped), or download the installer in your browser.',
    };
  }
  if (status) {
    return {
      kind: 'http',
      code,
      httpStatus: status,
      hint:
        status === 404
          ? 'The update file is not on GitHub yet. Try again in a few minutes.'
          : status === 429 || status === 403
            ? 'GitHub is rate-limiting this connection. Try again later.'
            : `GitHub answered with HTTP ${status}. Try again later.`,
    };
  }
  return { kind: 'unknown', code, hint: 'The update could not be downloaded. Retry, or download the installer from GitHub.' };
}
