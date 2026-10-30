/**
 * Small pure helpers shared by the game details page, the detail panel and the dashboard.
 */

const EPIC_STORE_BASE = 'https://store.epicgames.com/en-US';

/**
 * Epic store link for a product. A real product slug opens its page; without one, fall back to a
 * store search by title. The catalog namespace is never a product slug (it opens a 404), so it is
 * not accepted here.
 */
export function epicStoreUrl(slug: string | null | undefined, title: string | null | undefined): string | null {
  const s = slug?.trim();
  if (s) return `${EPIC_STORE_BASE}/p/${s}`;
  const t = title?.trim();
  if (t) return `${EPIC_STORE_BASE}/browse?q=${encodeURIComponent(t)}`;
  return null;
}

export interface SteamLanguage {
  name: string;
  /** Steam marks languages with full audio support with an asterisk. */
  fullAudio: boolean;
}

/**
 * Parse Steam's `supported_languages` HTML, e.g.
 * `English<strong>*</strong>, French<br><strong>*</strong>languages with full audio support`.
 * The footnote after the first `<br>` is dropped; asterisks become the `fullAudio` flag.
 */
export function parseSteamLanguages(html: string | null | undefined): SteamLanguage[] {
  if (!html) return [];
  const list = html.split(/<br\s*\/?>/i)[0];
  const out: SteamLanguage[] = [];
  const seen = new Set<string>();
  for (const piece of list.split(',')) {
    const fullAudio = /\*/.test(piece);
    const name = piece.replace(/<[^>]*>/g, '').replace(/\*/g, '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, fullAudio });
  }
  return out;
}

/**
 * A library game is live when its own id is running, or (for an entry keyed by another store's
 * id, e.g. an epic- entry that also carries a steamAppId) when its Steam id is.
 */
export function isGameLive(
  game: { id: string; steamAppId?: number | null },
  liveGames: ReadonlySet<string> | null | undefined,
): boolean {
  if (!liveGames) return false;
  return liveGames.has(game.id) || (game.steamAppId != null && liveGames.has(`steam-${game.steamAppId}`));
}
