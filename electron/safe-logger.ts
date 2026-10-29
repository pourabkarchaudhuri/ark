/**
 * Safe logger that prevents EPIPE errors when stdout/stderr is closed
 * This can happen when the Electron renderer process exits unexpectedly
 */

// Query-string secrets (`?key=…`, `&access_token=…`) must never reach logs: several API clients log
// request URLs, and API keys travel as query parameters.
const SECRET_PARAM_RE = /([?&](?:key|api_key|apikey|token|access_token|client_secret)=)[^&\s"'#]+/gi;

export function redactSecrets(text: string): string {
  return text.replace(SECRET_PARAM_RE, '$1[redacted]');
}

function redactArg(arg: unknown): unknown {
  if (typeof arg === 'string') return redactSecrets(arg);
  if (arg instanceof Error) {
    const msg = redactSecrets(arg.message);
    const stack = arg.stack ? redactSecrets(arg.stack) : arg.stack;
    if (msg === arg.message && stack === arg.stack) return arg;
    const copy = new Error(msg);
    copy.name = arg.name;
    copy.stack = stack;
    return copy;
  }
  if (arg && typeof arg === 'object' && !Array.isArray(arg) && Object.getPrototypeOf(arg) === Object.prototype) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(arg as Record<string, unknown>)) {
      const r = typeof v === 'string' ? redactSecrets(v) : v;
      if (r !== v) changed = true;
      out[k] = r;
    }
    return changed ? out : arg;
  }
  return arg;
}

function safeWrite(fn: (...args: unknown[]) => void, ...args: unknown[]) {
  try {
    fn.apply(console, args.map(redactArg));
  } catch (error: unknown) {
    // Ignore EPIPE errors - the pipe is closed, nothing we can do
    if (error instanceof Error && 'code' in error && error.code === 'EPIPE') {
      return;
    }
    // For other errors, try to write to stderr as a last resort
    try {
      process.stderr.write(`Logger error: ${error}\n`);
    } catch {
      // Give up silently
    }
  }
}

export const logger = {
  log: (...args: unknown[]) => safeWrite(console.log, ...args),
  error: (...args: unknown[]) => safeWrite(console.error, ...args),
  warn: (...args: unknown[]) => safeWrite(console.warn, ...args),
  info: (...args: unknown[]) => safeWrite(console.info, ...args),
  debug: (...args: unknown[]) => safeWrite(console.debug, ...args),
};

// Also handle uncaught EPIPE errors globally
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') {
    // Ignore - stdout was closed
    return;
  }
  throw err;
});

process.stderr.on('error', (err) => {
  if (err.code === 'EPIPE') {
    // Ignore - stderr was closed
    return;
  }
  throw err;
});
