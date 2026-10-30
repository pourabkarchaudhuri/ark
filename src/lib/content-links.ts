/**
 * Links inside sanitized store HTML (Steam/Epic descriptions, requirements), v1.0.97.
 *
 * In the app window a protocol-relative href ("//host/x") resolves to
 * file://host/x (a remote SMB share) and a store-relative one ("/en-US/p/x") to
 * a missing local file that blanks the app. Hrefs are therefore normalised at
 * sanitize time, and every click is intercepted and resolved against the
 * game's store origin before anything opens in the OS browser.
 */
import DOMPurify from 'dompurify';

export const STEAM_STORE_ORIGIN = 'https://store.steampowered.com';
export const EPIC_STORE_ORIGIN = 'https://store.epicgames.com';

const KEPT_HREF_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** Href rewrite used by the sanitize hook; null = drop the attribute. */
function normalizeHref(raw: string): string | null {
  const href = raw.trim();
  if (!href) return null;
  if (href.startsWith('//')) return `https:${href}`;
  // Store-relative and in-page links are kept; the click handler resolves them.
  if (href.startsWith('/') || href.startsWith('#')) return href;
  try {
    return KEPT_HREF_SCHEMES.has(new URL(href).protocol) ? href : null;
  } catch {
    return null;
  }
}

let purifier: ReturnType<typeof DOMPurify> | null = null;

/** A dedicated DOMPurify instance so the href hook does not leak into other callers. */
function getPurifier(): ReturnType<typeof DOMPurify> {
  if (purifier) return purifier;
  const p = DOMPurify(window);
  p.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element) || !node.hasAttribute('href')) return;
    const next = normalizeHref(node.getAttribute('href') ?? '');
    if (next === null) node.removeAttribute('href');
    else node.setAttribute('href', next);
  });
  purifier = p;
  return p;
}

export function sanitizeStoreHtml(html: string): string {
  return getPurifier().sanitize(html);
}

/**
 * Resolve a clicked anchor's raw href: '//x' → https, '/x' → store origin,
 * '#x' → ignored, otherwise only absolute http(s). Returns null to do nothing.
 */
export function resolveContentLinkHref(raw: string | null | undefined, storeOrigin: string): string | null {
  const href = (raw ?? '').trim();
  if (!href || href.startsWith('#')) return null;
  let candidate: string;
  if (href.startsWith('//')) candidate = `https:${href}`;
  else if (href.startsWith('/')) candidate = `${storeOrigin}${href}`;
  else candidate = href;
  try {
    const u = new URL(candidate);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}
