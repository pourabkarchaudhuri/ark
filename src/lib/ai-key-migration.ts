/**
 * One-time move of cloud AI keys that older builds kept in plaintext localStorage (v1.0.97).
 *
 * - The Azure OpenAI and Anthropic keys move into main's encrypted store, then leave
 *   localStorage. Each is only removed after main confirms the save, so a failure never
 *   loses a key (the next launch tries again).
 * - Non-secret settings (Azure endpoint/deployment/version, Anthropic model) stay where they are.
 *
 * Callers that check which providers are configured await this first, so the first
 * launch after the update already sees the migrated keys.
 */

export const LEGACY_AZURE_KEY_LS = 'ark-azure-key';
export const LEGACY_ANTHROPIC_KEY_LS = 'ark-anthropic-key';

type KeySetter = ((key: string) => Promise<{ success: boolean } | undefined>) | undefined;

async function moveKey(lsKey: string, set: KeySetter): Promise<void> {
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(lsKey);
  } catch {
    return;
  }
  if (legacy === null) return;
  const key = legacy.trim();
  if (!key) {
    try { localStorage.removeItem(lsKey); } catch { /* ignore */ }
    return;
  }
  if (!set) return;
  try {
    const result = await set(key);
    if (result?.success) localStorage.removeItem(lsKey);
  } catch {
    /* keep it for the next launch */
  }
}

let migration: Promise<void> | null = null;

async function runMigration(): Promise<void> {
  const s = window.settings;
  await moveKey(LEGACY_AZURE_KEY_LS, s?.setAzureKey);
  await moveKey(LEGACY_ANTHROPIC_KEY_LS, s?.setAnthropicKey);
}

/** Runs the migration once per renderer session; later calls share the same promise. */
export function ensureLegacyAiKeysMigrated(): Promise<void> {
  if (!migration) migration = runMigration();
  return migration;
}

/** Test seam: forget that the migration ran. */
export function resetLegacyAiKeyMigrationForTests(): void {
  migration = null;
}
