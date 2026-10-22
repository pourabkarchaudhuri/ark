import type { FC } from 'react';
import { libraryStore } from '@/services/library-store';
import type { NodeDetailData } from '../data/detail';

const SteamIcon: FC<{ className?: string }> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658a3.387 3.387 0 0 1 1.912-.59c.064 0 .128.002.19.006l2.861-4.142V8.91a4.528 4.528 0 0 1 4.524-4.524 4.528 4.528 0 0 1 4.524 4.524 4.528 4.528 0 0 1-4.524 4.524h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396a3.406 3.406 0 0 1-3.362-2.898L.309 14.04C1.555 19.63 6.304 24 11.979 24c6.627 0 12-5.373 12-12S18.606 0 11.979 0zM7.54 18.21l-1.473-.61a2.535 2.535 0 0 0 4.568.388 2.546 2.546 0 0 0-.387-2.116 2.545 2.545 0 0 0-1.907-.996l1.526.631a1.874 1.874 0 0 1-1.424 3.465 1.876 1.876 0 0 1-.903-.762zm8.4-5.874a3.02 3.02 0 0 0 3.016-3.016 3.02 3.02 0 0 0-3.016-3.016 3.02 3.02 0 0 0-3.016 3.016 3.02 3.02 0 0 0 3.016 3.016zm-.001-5.277a2.265 2.265 0 0 1 2.262 2.262 2.265 2.265 0 0 1-2.262 2.262 2.265 2.265 0 0 1-2.262-2.262c0-1.248 1.015-2.262 2.262-2.262z" />
  </svg>
);

const EpicIcon: FC<{ className?: string }> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M3.537 0C2.165 0 1.66.506 1.66 1.879V22.12c0 1.374.504 1.88 1.877 1.88h16.926c1.374 0 1.877-.506 1.877-1.88V1.88C22.34.505 21.837 0 20.463 0H3.537zm6.166 3.985h4.87v1.066h-3.612v3.06h3.248v1.065h-3.248v3.246h3.695V13.5H9.703V3.985zm-5.05.008h1.14l2.218 4.872 2.218-4.872h1.14V13.5h-1.066V6.206l-1.922 4.142h-.74L5.72 6.206V13.5H4.653V3.993z" />
  </svg>
);

/** Store info shown under a card when its info button is toggled. */
export const DetailPanel: FC<{ data: NodeDetailData | null; loading: boolean; nodeId: string }> = ({ data, loading, nodeId }) => {
  const shell = 'mt-1.5 rounded-lg border border-white/[0.06] bg-[rgba(6,6,14,0.7)] backdrop-blur-xl pointer-events-auto';
  if (loading) return null;
  if (!data) {
    return <div className={`${shell} px-3 py-2.5 text-[10px] text-white/35`}>No store details available for this game.</div>;
  }
  const s = data.steam;
  const e = data.epic;
  const epicPrice = e?.item.price?.totalPrice;
  const epicSlug = e?.item.productSlug || e?.item.offerMappings?.[0]?.pageSlug || e?.item.catalogNs?.mappings?.[0]?.pageSlug;
  const steamAppId = nodeId.match(/^steam-(\d+)$/)?.[1]
    ?? libraryStore.getEntry(nodeId)?.secondaryGameId?.match(/^steam-(\d+)$/)?.[1]
    ?? (s ? String(s.steam_appid) : null);

  return (
    <div className={`${shell} px-3 py-2.5 space-y-2 text-[10px]`} onClick={ev => ev.stopPropagation()}>
      {s?.metacritic && (
        <div className="flex items-center justify-between">
          <span className="text-white/40">Metacritic</span>
          <a href={s.metacritic.url} target="_blank" rel="noreferrer" className={`font-bold tabular-nums ${
            s.metacritic.score >= 75 ? 'text-emerald-400' : s.metacritic.score >= 50 ? 'text-yellow-400' : 'text-red-400'
          }`}>{s.metacritic.score}</a>
        </div>
      )}
      {s?.short_description && (
        <p className="text-white/50 leading-relaxed line-clamp-4">{s.short_description}</p>
      )}
      {s?.price_overview ? (
        <div className="flex items-center justify-between">
          <span className="text-white/40 flex items-center gap-1"><SteamIcon className="w-2.5 h-2.5" /> Price</span>
          <div className="flex items-center gap-1.5">
            {s.price_overview.discount_percent > 0 && (
              <span className="text-[9px] px-1 py-[1px] rounded bg-emerald-500/20 text-emerald-400 font-bold">-{s.price_overview.discount_percent}%</span>
            )}
            <span className="text-white/80 font-medium">{s.price_overview.final_formatted}</span>
          </div>
        </div>
      ) : s?.is_free ? (
        <div className="flex items-center justify-between">
          <span className="text-white/40 flex items-center gap-1"><SteamIcon className="w-2.5 h-2.5" /> Price</span>
          <span className="text-emerald-400 font-medium">Free to Play</span>
        </div>
      ) : null}
      {epicPrice && epicPrice.discountPrice != null ? (
        <div className="flex items-center justify-between">
          <span className="text-white/40 flex items-center gap-1"><EpicIcon className="w-2.5 h-2.5" /> Price</span>
          <div className="flex items-center gap-1.5">
            {epicPrice.originalPrice != null && epicPrice.originalPrice > epicPrice.discountPrice && epicPrice.originalPrice > 0 && (
              <span className="text-[9px] px-1 py-[1px] rounded bg-emerald-500/20 text-emerald-400 font-bold">
                -{Math.round(((epicPrice.originalPrice - epicPrice.discountPrice) / epicPrice.originalPrice) * 100)}%
              </span>
            )}
            <span className="text-white/80 font-medium">
              {epicPrice.discountPrice === 0 ? 'Free' : epicPrice.fmtPrice?.discountPrice ?? epicPrice.fmtPrice?.originalPrice ?? 'N/A'}
            </span>
          </div>
        </div>
      ) : null}
      <div className="pt-1 border-t border-white/[0.04] flex items-center gap-1.5">
        {steamAppId && (
          <a href={`https://store.steampowered.com/app/${steamAppId}`} target="_blank" rel="noreferrer"
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-white/[0.03] hover:bg-white/[0.07] text-white/50 hover:text-white/80 transition-colors text-[10px]">
            <SteamIcon className="w-2.5 h-2.5" /> Steam ↗
          </a>
        )}
        {epicSlug && (
          <a href={`https://store.epicgames.com/p/${epicSlug}`} target="_blank" rel="noreferrer"
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-white/[0.03] hover:bg-white/[0.07] text-white/50 hover:text-white/80 transition-colors text-[10px]">
            <EpicIcon className="w-2.5 h-2.5" /> Epic ↗
          </a>
        )}
      </div>
    </div>
  );
};
