import { describe, it, expect } from 'vitest';
import type { EpicCatalogItem } from '@/types/epic';

/**
 * Epic Catalog Store Tests
 *
 * Validates the transform logic that converts EpicCatalogItem (from the
 * Epic GraphQL API) into lightweight EpicCatalogEntry objects suitable
 * for IDB persistence and embedding generation.
 *
 * These tests mirror the transformItem function from epic-catalog-store.ts
 * to avoid IDB/Electron dependencies in the test environment.
 */

// ─── Tag Classification (mirrors epic-catalog-store.ts) ──────────────────────

const EPIC_GENRE_IDS: ReadonlySet<number> = new Set([
  1080, 1083, 1084, 1110, 1115, 1116, 1117, 1120, 1121, 1146,
  1151, 1170, 1181, 1210, 1212, 1216, 1218, 1263, 1283, 1287,
  1294, 1296, 1307, 1336, 1367, 1381, 1386, 1393, 1395,
]);

const EPIC_MODE_NAMES: ReadonlySet<string> = new Set([
  'Single Player', 'Co-op', 'Multiplayer', 'Online Multiplayer',
  'Local Multiplayer', 'Competitive', 'MMO', 'Cross Platform',
]);

const EPIC_THEME_NAMES: ReadonlySet<string> = new Set([
  'Metroidvania', 'RELAXING', 'Space Sim', 'Base-Building',
]);

// ─── Transform (mirrors epic-catalog-store.ts transformItem) ────────────────

interface EpicCatalogEntry {
  epicId: string;
  namespace: string;
  offerId: string;
  name: string;
  genres: string[];
  themes: string[];
  modes: string[];
  developer: string;
  publisher: string;
  description: string;
  longDescription: string;
  releaseDate: number;
  coverUrl: string;
  isFree: boolean;
  priceFormatted?: string;
  discountPercent?: number;
}

function resolveImage(
  keyImages: Array<{ type: string; url: string }> | undefined,
): string {
  if (!keyImages?.length) return '';
  const priority = ['DieselStoreFrontTall', 'OfferImageTall', 'DieselGameBoxTall', 'DieselGameBox',
    'DieselStoreFrontWide', 'OfferImageWide', 'Thumbnail'];
  for (const type of priority) {
    const img = keyImages.find(i => i.type === type);
    if (img?.url) return img.url;
  }
  return keyImages[0]?.url ?? '';
}

function transformItem(item: EpicCatalogItem): EpicCatalogEntry | null {
  if (!item.title || !item.namespace || !item.id) return null;

  const epicId = `${item.namespace}:${item.id}`;

  const genres: string[] = [];
  const themes: string[] = [];
  const modes: string[] = [];
  if (item.tags) {
    for (const tag of item.tags) {
      const group = tag.groupName;
      const name = tag.name ?? '';

      if (group === 'genre' || (!group && EPIC_GENRE_IDS.has(tag.id))) {
        if (name) genres.push(name);
      } else if (group === 'feature' && EPIC_MODE_NAMES.has(name)) {
        modes.push(name);
      } else if (!group && EPIC_THEME_NAMES.has(name)) {
        themes.push(name);
      }
    }
  }

  let releaseDate = 0;
  if (item.effectiveDate) {
    const ts = new Date(item.effectiveDate).getTime();
    if (!isNaN(ts)) releaseDate = ts;
  }

  const totalPrice = item.price?.totalPrice;
  const isFree = totalPrice ? totalPrice.originalPrice === 0 : false;
  const discountPercent = totalPrice && totalPrice.originalPrice > 0
    ? Math.round((1 - totalPrice.discountPrice / totalPrice.originalPrice) * 100)
    : undefined;

  return {
    epicId,
    namespace: item.namespace,
    offerId: item.id,
    name: item.title,
    genres: genres.length > 0 ? genres : ['Game'],
    themes,
    modes,
    developer: item.developer || item.seller?.name || '',
    publisher: item.publisher || item.seller?.name || '',
    description: item.description || '',
    longDescription: item.longDescription || '',
    releaseDate,
    coverUrl: resolveImage(item.keyImages),
    isFree,
    priceFormatted: totalPrice?.fmtPrice?.discountPrice || totalPrice?.fmtPrice?.originalPrice,
    discountPercent: discountPercent && discountPercent > 0 ? discountPercent : undefined,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMinimalItem(overrides: Partial<EpicCatalogItem> = {}): EpicCatalogItem {
  return {
    namespace: 'test-ns',
    id: 'test-offer-123',
    title: 'Test Epic Game',
    description: 'A test game on Epic.',
    longDescription: 'A much longer description of this amazing test game.',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Epic Catalog Store — transformItem', () => {
  it('transforms a minimal EpicCatalogItem correctly', () => {
    const entry = transformItem(makeMinimalItem());
    expect(entry).not.toBeNull();
    expect(entry!.epicId).toBe('test-ns:test-offer-123');
    expect(entry!.namespace).toBe('test-ns');
    expect(entry!.offerId).toBe('test-offer-123');
    expect(entry!.name).toBe('Test Epic Game');
    expect(entry!.description).toBe('A test game on Epic.');
    expect(entry!.longDescription).toBe('A much longer description of this amazing test game.');
  });

  it('returns null when title is missing', () => {
    const entry = transformItem(makeMinimalItem({ title: '' }));
    expect(entry).toBeNull();
  });

  it('returns null when namespace is missing', () => {
    const entry = transformItem(makeMinimalItem({ namespace: '' }));
    expect(entry).toBeNull();
  });

  it('returns null when id is missing', () => {
    const entry = transformItem(makeMinimalItem({ id: '' }));
    expect(entry).toBeNull();
  });

  it('extracts genres from tags with groupName="genre"', () => {
    const entry = transformItem(makeMinimalItem({
      tags: [
        { id: 1216, name: 'Action', groupName: 'genre' },
        { id: 1367, name: 'RPG', groupName: 'genre' },
        { id: 1307, name: 'Open World', groupName: 'genre' },
      ],
    }));
    expect(entry!.genres).toEqual(['Action', 'RPG', 'Open World']);
  });

  it('falls back to EPIC_GENRE_IDS when groupName is absent', () => {
    const entry = transformItem(makeMinimalItem({
      tags: [
        { id: 1216, name: 'Action' },
        { id: 1367, name: 'RPG' },
      ],
    }));
    expect(entry!.genres).toEqual(['Action', 'RPG']);
  });

  it('discards usersay/platform/epicfeature/event tags', () => {
    const entry = transformItem(makeMinimalItem({
      tags: [
        { id: 1216, name: 'Action', groupName: 'genre' },
        { id: 9999, name: 'RELAXING', groupName: 'usersay' },
        { id: 9547, name: 'Windows', groupName: 'platform' },
        { id: 8888, name: 'Summer Sale', groupName: 'event' },
        { id: 7777, name: 'Achievements', groupName: 'epicfeature' },
      ],
    }));
    expect(entry!.genres).toEqual(['Action']);
    expect(entry!.themes).toEqual([]);
    expect(entry!.modes).toEqual([]);
  });

  it('extracts modes from feature tags', () => {
    const entry = transformItem(makeMinimalItem({
      tags: [
        { id: 1216, name: 'Action', groupName: 'genre' },
        { id: 5000, name: 'Single Player', groupName: 'feature' },
        { id: 5001, name: 'Multiplayer', groupName: 'feature' },
      ],
    }));
    expect(entry!.genres).toEqual(['Action']);
    expect(entry!.modes).toEqual(['Single Player', 'Multiplayer']);
  });

  it('does NOT fall back unknown tag names to genres', () => {
    const entry = transformItem(makeMinimalItem({
      tags: [
        { id: 99999, name: 'Custom Tag' },
      ],
    }));
    expect(entry!.genres).not.toContain('Custom Tag');
    expect(entry!.genres).toEqual(['Game']);
  });

  it('defaults genres to ["Game"] when no tags provided', () => {
    const entry = transformItem(makeMinimalItem({ tags: undefined }));
    expect(entry!.genres).toEqual(['Game']);
  });

  it('resolves cover image from keyImages with correct priority', () => {
    const entry = transformItem(makeMinimalItem({
      keyImages: [
        { type: 'Thumbnail', url: 'https://thumb.jpg' },
        { type: 'DieselStoreFrontTall', url: 'https://tall.jpg' },
        { type: 'DieselStoreFrontWide', url: 'https://wide.jpg' },
      ],
    }));
    expect(entry!.coverUrl).toBe('https://tall.jpg');
  });

  it('falls back to first image when no priority type matches', () => {
    const entry = transformItem(makeMinimalItem({
      keyImages: [
        { type: 'Unknown', url: 'https://fallback.jpg' },
      ],
    }));
    expect(entry!.coverUrl).toBe('https://fallback.jpg');
  });

  it('handles empty keyImages gracefully', () => {
    const entry = transformItem(makeMinimalItem({ keyImages: [] }));
    expect(entry!.coverUrl).toBe('');
  });

  it('parses effectiveDate to epoch ms', () => {
    const entry = transformItem(makeMinimalItem({
      effectiveDate: '2025-01-15T00:00:00.000Z',
    }));
    expect(entry!.releaseDate).toBe(new Date('2025-01-15T00:00:00.000Z').getTime());
  });

  it('sets releaseDate to 0 when effectiveDate is missing', () => {
    const entry = transformItem(makeMinimalItem({ effectiveDate: undefined }));
    expect(entry!.releaseDate).toBe(0);
  });

  it('detects free games from price data', () => {
    const entry = transformItem(makeMinimalItem({
      price: {
        totalPrice: {
          discountPrice: 0,
          originalPrice: 0,
          fmtPrice: { originalPrice: '0', discountPrice: '0', intermediatePrice: '0' },
        },
      },
    }));
    expect(entry!.isFree).toBe(true);
  });

  it('calculates discount percentage correctly', () => {
    const entry = transformItem(makeMinimalItem({
      price: {
        totalPrice: {
          discountPrice: 2999,
          originalPrice: 5999,
          fmtPrice: { originalPrice: '$59.99', discountPrice: '$29.99', intermediatePrice: '$29.99' },
        },
      },
    }));
    expect(entry!.isFree).toBe(false);
    expect(entry!.discountPercent).toBe(50);
    expect(entry!.priceFormatted).toBe('$29.99');
  });

  it('omits discount when price is not discounted', () => {
    const entry = transformItem(makeMinimalItem({
      price: {
        totalPrice: {
          discountPrice: 5999,
          originalPrice: 5999,
          fmtPrice: { originalPrice: '$59.99', discountPrice: '$59.99', intermediatePrice: '$59.99' },
        },
      },
    }));
    expect(entry!.discountPercent).toBeUndefined();
  });

  it('uses developer name, falling back to seller', () => {
    const withDev = transformItem(makeMinimalItem({
      developer: 'Studio Dev',
      seller: { name: 'Publisher Co' },
    }));
    expect(withDev!.developer).toBe('Studio Dev');

    const withoutDev = transformItem(makeMinimalItem({
      developer: undefined,
      seller: { name: 'Publisher Co' },
    }));
    expect(withoutDev!.developer).toBe('Publisher Co');
  });

  it('preserves both short and long descriptions', () => {
    const entry = transformItem(makeMinimalItem({
      description: 'Short desc',
      longDescription: 'A very long and detailed description with lots of information.',
    }));
    expect(entry!.description).toBe('Short desc');
    expect(entry!.longDescription).toBe('A very long and detailed description with lots of information.');
  });

  it('handles missing descriptions gracefully', () => {
    const entry = transformItem(makeMinimalItem({
      description: undefined,
      longDescription: undefined,
    }));
    expect(entry!.description).toBe('');
    expect(entry!.longDescription).toBe('');
  });
});

describe('Epic Catalog Store — resolveImage', () => {
  it('prefers DieselStoreFrontTall over Wide', () => {
    const url = resolveImage([
      { type: 'DieselStoreFrontWide', url: 'https://wide.jpg' },
      { type: 'DieselStoreFrontTall', url: 'https://tall.jpg' },
    ]);
    expect(url).toBe('https://tall.jpg');
  });

  it('prefers OfferImageTall when DieselStoreFrontTall is missing', () => {
    const url = resolveImage([
      { type: 'Thumbnail', url: 'https://thumb.jpg' },
      { type: 'OfferImageTall', url: 'https://offer-tall.jpg' },
    ]);
    expect(url).toBe('https://offer-tall.jpg');
  });

  it('returns empty string for undefined keyImages', () => {
    expect(resolveImage(undefined)).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(resolveImage([])).toBe('');
  });
});
