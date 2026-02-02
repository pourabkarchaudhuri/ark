/**
 * Safe logger that prevents EPIPE errors when stdout/stderr is closed
 * This can happen when the Electron renderer process exits unexpectedly
 */

function safeWrite(fn: (...args: unknown[]) => void, ...args: unknown[]) {
  try {
    fn.apply(console, args);
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
