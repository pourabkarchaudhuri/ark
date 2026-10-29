/**
 * gg.deals price UI: a small badge for cards and a price block for the game details page.
 * Both render nothing without a gg.deals key, without a Steam app id, or when there is no deal data.
 */
import { memo, useEffect, useState } from 'react';
import { TrendingDown, Tag } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GgDealsPrice } from '@/types/ggdeals';
import {
  formatDealPrice,
  getShowKeyshops,
  ggDealsService,
  headlinePrice,
  isAtHistoricalLow,
} from '@/services/ggdeals-service';

/** gg.deals price for a Steam game: undefined while loading, null when there is none. */
export function useGgDealPrice(steamAppId: number | undefined | null): GgDealsPrice | null | undefined {
  const [price, setPrice] = useState<GgDealsPrice | null | undefined>(() =>
    steamAppId ? ggDealsService.peek(steamAppId) : null);
  const [, setVersion] = useState(0);

  useEffect(() => ggDealsService.subscribe(() => setVersion((v) => v + 1)), []);

  useEffect(() => {
    if (!steamAppId || !ggDealsService.available) {
      setPrice(null);
      return;
    }
    let cancelled = false;
    const known = ggDealsService.peek(steamAppId);
    if (known !== undefined) {
      setPrice(known);
      return;
    }
    setPrice(undefined);
    ggDealsService.getPrice(steamAppId).then((p) => { if (!cancelled) setPrice(p); }).catch(() => { if (!cancelled) setPrice(null); });
    return () => { cancelled = true; };
  }, [steamAppId]);

  return price;
}

function openExternal(url: string) {
  const shell = (window as unknown as { electron?: { openExternal?: (u: string) => unknown } }).electron;
  if (shell?.openExternal) void shell.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** Compact "best price" badge for game cards. */
export const DealBadge = memo(function DealBadge({ steamAppId, className }: { steamAppId?: number | null; className?: string }) {
  const price = useGgDealPrice(steamAppId);
  if (!price) return null;
  const head = headlinePrice(price, getShowKeyshops());
  if (!head) return null;
  const low = !head.keyshop && isAtHistoricalLow(price);
  return (
    <span
      className={cn(
        // leading-none + py-px keeps the badge at 14px, inside the card's fixed 16px footer row.
        'inline-flex items-center gap-1 text-[10px] leading-none font-semibold rounded px-1.5 py-px border',
        low ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' : 'text-white/60 border-white/15 bg-white/[0.04]',
        className,
      )}
      title={`Best price on gg.deals${head.keyshop ? ' (key reseller)' : ''}${low ? ' — at its all-time low' : ''}`}
    >
      <Tag className="w-2.5 h-2.5" />
      {formatDealPrice(head.amount, price.currency)}
      {low && <span className="text-emerald-300/80">· lowest ever</span>}
    </span>
  );
});

/** Price block for the game details page. */
export const DealPriceBlock = memo(function DealPriceBlock({ steamAppId }: { steamAppId?: number | null }) {
  const price = useGgDealPrice(steamAppId);
  if (price === undefined) {
    return <div className="h-16 rounded-lg bg-white/[0.03] border border-white/[0.06] animate-pulse" aria-label="Loading prices" />;
  }
  if (!price) return null;
  const showKeyshops = getShowKeyshops();
  const low = isAtHistoricalLow(price);
  const row = (label: string, amount: number | null, extra?: string) =>
    amount === null ? null : (
      <div className="flex items-center justify-between text-xs">
        <span className="text-white/50">{label}</span>
        <span className="font-mono text-white/85">
          {formatDealPrice(amount, price.currency)}
          {extra && <span className="text-white/35"> {extra}</span>}
        </span>
      </div>
    );
  return (
    <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-3 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-white/80">Best prices</span>
        {low && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-300">
            <TrendingDown className="w-3 h-3" /> Lowest price ever
          </span>
        )}
      </div>
      {row('Official stores', price.currentRetail)}
      {row('All-time low', price.historicalRetail, '(official)')}
      {showKeyshops && row('Key resellers', price.currentKeyshops)}
      {showKeyshops && row('All-time low', price.historicalKeyshops, '(resellers)')}
      <button
        onClick={() => openExternal(price.url)}
        className="text-[10px] text-white/35 hover:text-white/70 underline-offset-2 hover:underline"
      >
        Prices by GG.deals — see all offers
      </button>
    </div>
  );
});
