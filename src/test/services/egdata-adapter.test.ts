import { describe, it, expect } from 'vitest';
import { egdataOfferToEpicCatalogItem } from '@/services/egdata-adapter';
import { transformEpicGame } from '@/services/epic-service';
import type { EgdataOfferLike } from '@/services/egdata-adapter';

describe('egdata-adapter', () => {
  it('returns null for missing id or namespace', () => {
    expect(egdataOfferToEpicCatalogItem(null)).toBeNull();
    expect(egdataOfferToEpicCatalogItem(undefined)).toBeNull();
    expect(egdataOfferToEpicCatalogItem({})).toBeNull();
    expect(egdataOfferToEpicCatalogItem({ id: 'x' })).toBeNull();
    expect(egdataOfferToEpicCatalogItem({ namespace: 'ns' })).toBeNull();
  });

  it('produces valid EpicCatalogItem with minimal required fields', () => {
    const offer: EgdataOfferLike = {
      id: 'offer-1',
      namespace: 'ns',
      title: 'Test Game',
    };
    const item = egdataOfferToEpicCatalogItem(offer);
    expect(item).not.toBeNull();
    expect(item!.id).toBe('offer-1');
    expect(item!.namespace).toBe('ns');
    expect(item!.title).toBe('Test Game');
    expect(item!.developer).toBe('Unknown Developer');
    expect(item!.publisher).toBe('Unknown Publisher');
    expect(item!.effectiveDate).toBeUndefined();
  });

  it('trims and defaults empty title to Unknown', () => {
    const item = egdataOfferToEpicCatalogItem({
      id: 'x',
      namespace: 'ns',
      title: '  ',
    });
    expect(item!.title).toBe('Unknown');
  });

  it('maps developerDisplayName and seller.name', () => {
    const item = egdataOfferToEpicCatalogItem({
      id: 'x',
      namespace: 'ns',
      title: 'T',
      developerDisplayName: 'Dev Co',
      publisherDisplayName: 'Pub Co',
      seller: { name: 'Seller' },
    });
    expect(item!.developer).toBe('Dev Co');
    expect(item!.publisher).toBe('Pub Co');
  });

  it('builds price.totalPrice and fmtPrice from egdata cents', () => {
    const item = egdataOfferToEpicCatalogItem({
      id: 'x',
      namespace: 'ns',
      title: 'T',
      price: { discountPrice: 2999, originalPrice: 3999, currencyCode: 'USD' },
    });
    expect(item!.price?.totalPrice.discountPrice).toBe(2999);
    expect(item!.price?.totalPrice.originalPrice).toBe(3999);
    expect(item!.price?.totalPrice.fmtPrice.discountPrice).toMatch(/\$29\.99/);
    expect(item!.price?.totalPrice.fmtPrice.originalPrice).toMatch(/\$39\.99/);
  });

  it('coerces tag id to number', () => {
    const item = egdataOfferToEpicCatalogItem({
      id: 'x',
      namespace: 'ns',
      title: 'T',
      tags: [
        { id: '1216', name: 'Action', groupName: 'genre' },
        { id: 1367, name: 'RPG', groupName: 'genre' },
      ],
    });
    expect(item!.tags).toHaveLength(2);
    expect(item!.tags![0].id).toBe(1216);
    expect(item!.tags![1].id).toBe(1367);
  });

  it('adapter + transformEpicGame yields valid Game', () => {
    const offer: EgdataOfferLike = {
      id: 'offer-1',
      namespace: 'fn',
      title: 'Test Game',
      developerDisplayName: 'Dev',
      publisherDisplayName: 'Pub',
      effectiveDate: '2024-01-15T00:00:00.000Z',
      tags: [{ id: 1216, name: 'Action', groupName: 'genre' }],
    };
    const item = egdataOfferToEpicCatalogItem(offer);
    expect(item).not.toBeNull();
    const game = transformEpicGame(item!);
    expect(game.id).toBe('epic-fn:offer-1');
    expect(game.title).toBe('Test Game');
    expect(game.developer).toBe('Dev');
    expect(game.publisher).toBe('Pub');
    expect(game.genre).toContain('Action');
    expect(game.releaseDate).toBeTruthy();
    expect(() => game.releaseDate.slice(0, 4)).not.toThrow();
  });
});
