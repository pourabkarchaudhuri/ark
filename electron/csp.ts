/**
 * Content-Security-Policy for the built renderer pages (index.html and
 * overlay.html), v1.0.97. Injected as a <meta> tag by the Vite build only
 * (vite.config.ts), so the dev server and HMR are untouched while every
 * file:// load — packaged, e2e and production-preview runs — gets it. A meta tag
 * is used rather than webRequest.onHeadersReceived because Electron serves
 * file:// without a response-header pass.
 *
 * The point is script-src: a future DOMPurify bypass must not be able to run
 * inline script next to the full preload bridge. The other directives are kept
 * as wide as the app needs today (remote store images and videos, Google Fonts,
 * renderer fetches to egdata/gstatic/Azure and local Ollama, module workers,
 * the Decode Bay iframe fallback).
 */
export function buildContentSecurityPolicy(opts: { forHeader?: boolean } = {}): string {
  const directives: string[] = [
    "default-src 'self'",
    // The splash scene's Draco decoder (public/scene.glb is Draco-compressed)
    // compiles WebAssembly in a blob worker, which inherits this policy.
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' data: blob: https:",
    "connect-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:*",
    "worker-src 'self' blob:",
    'frame-src https: http:',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  // frame-ancestors is ignored (with a console warning) when delivered via <meta>.
  if (opts.forHeader) directives.push("frame-ancestors 'none'");
  return directives.join('; ');
}

/** The <meta> tag the Vite build inserts at the top of <head>. */
export function cspMetaTag(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${buildContentSecurityPolicy()}">`;
}
