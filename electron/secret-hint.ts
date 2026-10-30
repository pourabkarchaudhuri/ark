/**
 * Write-only secrets (v1.0.97): the renderer gets `{ has, hint }` instead of the
 * decrypted key, matching the gg.deals key. Short keys reveal nothing.
 */
export interface SecretHint {
  has: boolean;
  hint: string;
}

const MIN_LEN_FOR_EDGES = 12;

export function secretHint(key: string | null | undefined): SecretHint {
  if (!key) return { has: false, hint: '' };
  if (key.length < MIN_LEN_FOR_EDGES) return { has: true, hint: '••••' };
  return { has: true, hint: `${key.slice(0, 4)}…${key.slice(-4)}` };
}
