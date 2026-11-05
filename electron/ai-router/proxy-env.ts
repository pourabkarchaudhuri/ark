/**
 * The proxy this PC uses, as environment variables for the LiteLLM child (1.0.98 F3).
 *
 * Electron resolves proxies itself (system settings, PAC scripts, WPAD); Python does not, so on a
 * network that needs a proxy every cloud route through LiteLLM would fail while Ark's own requests
 * work. `proxyEnvFromResolved` turns Electron's `resolveProxy` answer ("PROXY host:port; DIRECT")
 * into HTTPS_PROXY / HTTP_PROXY. Only plain http(s) proxies are mapped (SOCKS is not assumed to be
 * supported by the bundled Python HTTP stack), and the host is checked so nothing but a host name
 * and port can reach the environment.
 */
const HOST_PORT = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):\d{1,5}$/;

export function proxyEnvFromResolved(resolved: string | null | undefined): Record<string, string> {
  if (!resolved) return {};
  for (const part of resolved.split(';')) {
    const m = /^\s*(PROXY|HTTPS)\s+(\S+)\s*$/i.exec(part);
    if (m && HOST_PORT.test(m[2]!)) {
      const url = `${m[1]!.toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${m[2]}`;
      return { HTTPS_PROXY: url, HTTP_PROXY: url };
    }
    if (/^\s*DIRECT\s*$/i.test(part)) return {};
  }
  return {};
}

/** Ask Electron's default session which proxy a cloud request would use. Never throws; gives up after `timeoutMs`. */
export async function resolveSessionProxyEnv(
  resolveProxy: (url: string) => Promise<string>,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 2_000,
): Promise<Record<string, string>> {
  // An explicit proxy of the user wins; the sidecar forwards it as it is.
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy) return {};
  try {
    const answer = await Promise.race([
      resolveProxy('https://api.openai.com'),
      new Promise<string>((_, reject) => { setTimeout(() => reject(new Error('timeout')), timeoutMs).unref?.(); }),
    ]);
    return proxyEnvFromResolved(answer);
  } catch {
    return {};
  }
}
