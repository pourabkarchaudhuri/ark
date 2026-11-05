/**
 * Replace anything key-shaped in text that is about to reach the UI or a log (1.0.98 F3).
 *
 * Provider error bodies sometimes echo the request, so the common credential shapes are removed
 * here: vendor key prefixes, bearer tokens, JWTs, `key=` query parameters, `"api-key": "..."` pairs
 * and the 32-hex keys Azure issues. Exported for the router and the sidecar log scrubber.
 */
const MASK = '***';

const SHAPES: RegExp[] = [
  // Vendor prefixes: OpenAI/Anthropic sk-..., Google AIza..., GitHub, Slack, Groq, AWS access key ids.
  /\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|gsk_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g,
  // JSON web tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  // Azure OpenAI keys are 32 hex characters.
  /\b[0-9a-f]{32}\b/gi,
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SHAPES) out = out.replace(re, MASK);
  return out
    // Authorization: Bearer <token>
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${MASK}`)
    // key=..., api_key=..., access_token=... in a URL or form body
    .replace(/([?&;\s](?:api[-_]?key|key|access[-_]?token|token|auth|authorization|secret)=)[^&\s"']+/gi, `$1${MASK}`)
    // "api-key": "...", api_key: ..., authorization = ...
    .replace(/((?:api[-_ ]?key|authorization|x-api-key|secret|token)["']?\s*[:=]\s*["']?)(?!\*\*\*)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`);
}
