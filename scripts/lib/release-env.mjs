/**
 * The .env that ships next to Ark.exe in the installer.
 *
 * The developer .env also holds keys that must never leave this machine (the Azure OpenAI key is
 * billable and only used by the --run-chat-prompts CLI). The installer copies build/.env.release,
 * written from .env through RELEASE_ENV_KEYS, never the raw file. Every key a packaged build reads
 * from process.env in electron/ must be listed here; anything else is dropped.
 *
 * Shared by scripts/build-release-env.mjs (writes the file), scripts/after-pack-check.mjs (fails
 * the build if a forbidden name was packaged) and scripts/verify-release.mjs.
 */

/** Key names (never values) allowed in the packaged .env. */
export const RELEASE_ENV_KEYS = Object.freeze(['STEAM_API_KEY', 'GA_MEASUREMENT_ID', 'GA_API_SECRET']);

/** Name prefixes that must never appear in any packaged file as an assignment. */
export const FORBIDDEN_ENV_PREFIXES = Object.freeze(['AZURE_']);

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Key names assigned in a dotenv text, in file order. */
export function envKeyNames(text) {
  return String(text ?? '').split(/\r?\n/)
    .map((line) => ASSIGNMENT.exec(line)?.[1])
    .filter(Boolean);
}

/**
 * Keep only allow-listed assignments from a dotenv text. Comments, blank lines and every other key
 * are dropped; an allow-listed key with an empty value is dropped too (the app treats a missing
 * key and an empty one the same way).
 */
export function filterReleaseEnv(text, allowed = RELEASE_ENV_KEYS) {
  const keep = new Set(allowed);
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = ASSIGNMENT.exec(line);
    if (!m || !keep.has(m[1])) continue;
    if (!m[2].trim().replace(/^['"]|['"]$/g, '')) continue;
    out.push(`${m[1]}=${m[2].trim()}`);
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

/** Names in a text assigned with a forbidden prefix (e.g. `AZURE_OPENAI_KEY=...`). */
export function findForbiddenEnvNames(text, prefixes = FORBIDDEN_ENV_PREFIXES) {
  return envKeyNames(text).filter((n) => prefixes.some((p) => n.startsWith(p)));
}
