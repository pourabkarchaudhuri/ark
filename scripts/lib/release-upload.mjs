/**
 * Pure helpers for scripts/publish-github-release.mjs (kept here so they are unit-testable without
 * a token or the network).
 */

/** Marker curl appends after the body (`-w`), so the HTTP status can be split off stdout. */
export const CURL_STATUS_MARKER = '\n__ARK_HTTP_STATUS__:';

/** curl arguments that print the response body followed by the marker and the HTTP status. */
export const CURL_STATUS_ARGS = Object.freeze(['-w', `${CURL_STATUS_MARKER}%{http_code}`]);

/**
 * Split curl stdout into { status, body }. A missing marker (curl died before writing it) gives
 * status 0; a body that is not JSON gives body null. Callers treat anything but 2xx as a failure.
 */
export function parseCurlUpload(stdout) {
  const text = String(stdout ?? '');
  const at = text.lastIndexOf(CURL_STATUS_MARKER);
  const status = at < 0 ? 0 : Number(text.slice(at + CURL_STATUS_MARKER.length).trim()) || 0;
  const raw = at < 0 ? text : text.slice(0, at);
  let body = null;
  try { body = raw.trim() ? JSON.parse(raw) : null; } catch { body = null; }
  return { status, body };
}

/** True when an upload response is a 2xx with an asset GitHub reports as fully uploaded. */
export function isUploadSuccess({ status, body }) {
  return status >= 200 && status < 300 && body?.state === 'uploaded';
}

/**
 * Ids of release assets with this name that are not fully uploaded. A reset upload leaves such an
 * asset behind ("starter"/"new"), and GitHub then rejects the next upload of the same name with
 * 422 already_exists, so these must be deleted before every attempt.
 */
export function staleAssetIds(assets, name) {
  return (assets ?? []).filter((a) => a?.name === name && a.state !== 'uploaded').map((a) => a.id);
}
