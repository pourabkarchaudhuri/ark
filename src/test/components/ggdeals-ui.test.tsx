/**
 * gg.deals in the renderer: price helpers, request batching across cards, and the badge / price
 * block (hidden without a key or data).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { formatDealPrice, headlinePrice, isAtHistoricalLow, ggDealsService, GG_KEYSHOPS_LS_KEY } from '@/services/ggdeals-service';
import { DealBadge, DealPriceBlock } from '@/components/deal-price';
import type { GgDealsPrice } from '@/types/ggdeals';

const HADES: GgDealsPrice = { title: 'Hades', url: 'https://gg.deals/game/hades/', currency: 'USD', currentRetail: 24.99, currentKeyshops: 17.32, historicalRetail: 6.24, historicalKeyshops: 5.52 };
const AT_LOW: GgDealsPrice = { ...HADES, currentRetail: 6.24 };

function installBridge(prices: Record<string, GgDealsPrice | null>, hasKey = true) {
  const getPrices = vi.fn(async (ids: number[]) => ({ prices: Object.fromEntries(ids.map((id) => [String(id), prices[String(id)] ?? null])) }));
  (window as unknown as { ggdeals: unknown }).ggdeals = {
    hasKey: vi.fn(async () => hasKey), setKey: vi.fn(), clearKey: vi.fn(), testKey: vi.fn(), getPrices,
  };
  ggDealsService.settingsChanged();
  return getPrices;
}

afterEach(() => {
  delete (window as unknown as { ggdeals?: unknown }).ggdeals;
  localStorage.removeItem(GG_KEYSHOPS_LS_KEY);
  ggDealsService.settingsChanged();
});

describe('price helpers', () => {
  it('formats in the price currency, flags all-time lows, and prefers official prices unless keyshops are on', () => {
    expect(formatDealPrice(0, 'USD')).toBe('Free');
    expect(formatDealPrice(24.99, 'USD')).toMatch(/24\.99/);
    expect(isAtHistoricalLow(HADES)).toBe(false);
    expect(isAtHistoricalLow(AT_LOW)).toBe(true);
    expect(headlinePrice(HADES, false)).toEqual({ amount: 24.99, keyshop: false });
    expect(headlinePrice(HADES, true)).toEqual({ amount: 17.32, keyshop: true });
  });
});

describe('ggDealsService', () => {
  it('batches concurrent lookups from many cards into one request', async () => {
    const getPrices = installBridge({ 1: HADES, 2: AT_LOW });
    const [a, b, c] = await Promise.all([ggDealsService.getPrice(1), ggDealsService.getPrice(2), ggDealsService.getPrice(3)]);
    expect(getPrices).toHaveBeenCalledTimes(1);
    expect(a?.title).toBe('Hades');
    expect(b?.currentRetail).toBe(6.24);
    expect(c).toBeNull();
    await ggDealsService.getPrice(1); // cached
    expect(getPrices).toHaveBeenCalledTimes(1);
  });

  it('asks nothing without a saved key', async () => {
    const getPrices = installBridge({ 1: HADES }, false);
    expect(await ggDealsService.getPrice(1)).toBeNull();
    expect(getPrices).not.toHaveBeenCalled();
  });
});

describe('DealBadge / DealPriceBlock', () => {
  it('badge shows the official price and an all-time-low marker', async () => {
    installBridge({ 2: AT_LOW });
    render(<DealBadge steamAppId={2} />);
    expect(await screen.findByText(/6\.24/)).toBeInTheDocument();
    expect(screen.getByText(/lowest ever/)).toBeInTheDocument();
  });

  it('price block lists official prices; keyshops only when switched on', async () => {
    installBridge({ 1: HADES });
    const { unmount } = render(<DealPriceBlock steamAppId={1} />);
    expect(await screen.findByText('Official stores')).toBeInTheDocument();
    expect(screen.queryByText('Key resellers')).not.toBeInTheDocument();
    expect(screen.getByText(/Prices by GG.deals/)).toBeInTheDocument();
    unmount();
    localStorage.setItem(GG_KEYSHOPS_LS_KEY, 'true');
    render(<DealPriceBlock steamAppId={1} />);
    expect(await screen.findByText('Key resellers')).toBeInTheDocument();
  });

  it('renders nothing without the bridge, a key, or a Steam id', async () => {
    expect(render(<DealBadge steamAppId={1} />).container.textContent).toBe('');
    installBridge({}, false);
    const { container } = render(<DealBadge steamAppId={1} />);
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(render(<DealPriceBlock steamAppId={null} />).container.textContent).toBe('');
  });
});
