/**
 * Port picking for the built-in llama.cpp servers (1.0.97 B36).
 *
 * Each server binds 127.0.0.1 on a port from Ark's private range (base 47410). A port that is
 * busy (another app, or a server Ark already started) is skipped, and 11434 (Ollama's default)
 * is never used even if the range were moved over it, so a user's own Ollama keeps working next
 * to Ark. Ports live only in memory: nothing is written where another app could read them.
 */
import net from 'node:net';

export const LOCAL_AI_PORT_BASE = 47410;
export const LOCAL_AI_PORT_SPAN = 64;
/** Ollama's default port: never ours. */
export const OLLAMA_DEFAULT_PORT = 11434;

/** True when nothing listens on 127.0.0.1:port (we could bind it). */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

export interface PickPortOptions {
  base?: number;
  span?: number;
  /** Ports Ark already handed out this session (servers still starting). */
  exclude?: Iterable<number>;
  isFree?: (port: number) => Promise<boolean>;
}

/** First free port in the range, or null when every port is taken. */
export async function pickFreePort(opts: PickPortOptions = {}): Promise<number | null> {
  const base = opts.base ?? LOCAL_AI_PORT_BASE;
  const span = opts.span ?? LOCAL_AI_PORT_SPAN;
  const isFree = opts.isFree ?? isPortFree;
  const exclude = new Set(opts.exclude ?? []);
  for (let port = base; port < base + span; port++) {
    if (port === OLLAMA_DEFAULT_PORT || port < 1024 || port > 65535 || exclude.has(port)) continue;
    if (await isFree(port)) return port;
  }
  return null;
}
