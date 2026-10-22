import type { SteamAppDetails } from '@/types/steam';
import type { EpicCatalogItem, EpicProductReviews } from '@/types/epic';
import { libraryStore } from '@/services/library-store';
import { getStoreFromId } from '@/types/game';

export interface NodeDetailData {
  steam?: SteamAppDetails;
  epic?: { item: EpicCatalogItem; reviews: EpicProductReviews | null };
  stores: ('steam' | 'epic')[];
}

/** Fetch live store details (Steam + Epic, including a linked cross-store twin). Null when nothing resolved. */
export async function fetchNodeDetail(nodeId: string): Promise<NodeDetailData | null> {
  const store = getStoreFromId(nodeId);
  const libEntry = libraryStore.getEntry(nodeId);
  const meta = libEntry?.cachedMeta;
  const secondaryId = libEntry?.secondaryGameId;
  const secondaryStore = secondaryId ? getStoreFromId(secondaryId) : null;
  const secondaryMeta = secondaryId ? libraryStore.getEntry(secondaryId)?.cachedMeta : undefined;

  const stores: ('steam' | 'epic')[] = [];
  if (store === 'steam' || store === 'epic') stores.push(store);
  if ((secondaryStore === 'steam' || secondaryStore === 'epic') && !stores.includes(secondaryStore)) stores.push(secondaryStore);

  const result: NodeDetailData = { stores };
  const fetches: Promise<void>[] = [];

  const steamAppId = store === 'steam'
    ? Number(nodeId.match(/^steam-(\d+)$/)?.[1])
    : secondaryStore === 'steam'
      ? Number(secondaryId!.match(/^steam-(\d+)$/)?.[1])
      : meta?.steamAppId ?? null;
  if (steamAppId) {
    fetches.push((async () => {
      try {
        const details = await window.steam?.getAppDetails(steamAppId);
        if (details) result.steam = details;
      } catch { /* store unreachable — panel shows what resolved */ }
    })());
  }

  const epicNs = store === 'epic'
    ? (meta?.epicNamespace ?? nodeId.replace(/^epic-/, '').split(':')[0])
    : (secondaryStore === 'epic' ? secondaryMeta?.epicNamespace : meta?.epicNamespace);
  const epicOfferId = store === 'epic'
    ? (meta?.epicOfferId ?? nodeId.replace(/^epic-/, '').split(':')[1])
    : (secondaryStore === 'epic' ? secondaryMeta?.epicOfferId : meta?.epicOfferId);
  const epicSlug = store === 'epic' ? meta?.epicSlug : (secondaryStore === 'epic' ? secondaryMeta?.epicSlug : meta?.epicSlug);
  if (epicNs && epicOfferId) {
    fetches.push((async () => {
      try {
        const [item, reviews] = await Promise.all([
          window.epic?.getGameDetails(epicNs, epicOfferId) ?? Promise.resolve(null),
          epicSlug ? (window.epic?.getProductReviews(epicSlug) ?? Promise.resolve(null)) : Promise.resolve(null),
        ]);
        if (item) result.epic = { item, reviews };
      } catch { /* store unreachable */ }
    })());
  }

  await Promise.all(fetches);
  return result.steam || result.epic ? result : null;
}
