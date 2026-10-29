import { memo } from 'react';
import { Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { HltbState } from '@/hooks/useHltbTimes';

function fmt(hours: number | null): string | null {
  if (hours === null) return null;
  return hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m` : `${hours >= 10 ? Math.round(hours) : hours}h`;
}

function openExternal(url: string) {
  const shell = (window as unknown as { electron?: { openExternal?: (u: string) => unknown } }).electron;
  if (shell?.openExternal) void shell.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** "How long to beat" badge for the game details header (data: howlongtobeat.com). */
export const HltbChip = memo(function HltbChip({ state }: { state: HltbState }) {
  if (state.status === 'loading') {
    return (
      <Badge variant="outline" className="border-white/10 text-white/30 animate-pulse" aria-label="Loading HowLongToBeat times">
        <Clock className="w-3 h-3 mr-1" />
        …
      </Badge>
    );
  }
  if (state.status !== 'ready') return null;
  const t = state.times;
  const main = fmt(t.mainHours);
  const extra = fmt(t.mainExtraHours);
  const full = fmt(t.completionistHours);
  const headline = main ?? fmt(t.allStylesHours);
  if (!headline) return null;
  const title = [
    `HowLongToBeat: ${t.name}${t.year ? ` (${t.year})` : ''}`,
    main && `Main story: ${main}`,
    extra && `Main + extras: ${extra}`,
    full && `Completionist: ${full}`,
    'Click to open on howlongtobeat.com',
  ].filter(Boolean).join('\n');
  return (
    <Badge
      variant="outline"
      className="border-violet-500/30 text-violet-300 bg-violet-500/10 cursor-pointer hover:bg-violet-500/20"
      title={title}
      role="link"
      onClick={() => openExternal(t.url)}
    >
      <Clock className="w-3 h-3 mr-1" />
      {main ? `${main} main` : `${headline} to beat`}
      {extra && <span className="text-violet-300/60">&nbsp;· {extra} +extras</span>}
      {full && <span className="text-violet-300/60">&nbsp;· {full} 100%</span>}
    </Badge>
  );
});
