import { memo } from 'react';
import { Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { HltbState } from '@/hooks/useHltbTimes';

function fmt(hours: number | null): string | null {
  if (hours === null) return null;
  return hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m` : `${hours >= 10 ? Math.round(hours) : hours}h`;
}

/**
 * "How long to beat" badge for the game details header (data: howlongtobeat.com). It says what it is
 * on the badge itself; the tooltip explains each number. It is information only — not a link.
 */
export const HltbChip = memo(function HltbChip({ state }: { state: HltbState }) {
  if (state.status === 'loading') {
    return (
      <Badge variant="outline" className="border-white/10 text-white/30 animate-pulse" aria-label="Loading HowLongToBeat times">
        <Clock className="w-3 h-3 mr-1" />
        HowLongToBeat…
      </Badge>
    );
  }
  if (state.status !== 'ready') return null;
  const t = state.times;
  const main = fmt(t.mainHours);
  const extra = fmt(t.mainExtraHours);
  const full = fmt(t.completionistHours);
  const all = fmt(t.allStylesHours);
  if (!main && !all) return null;
  const tooltip = [
    `How long to beat ${t.name}${t.year ? ` (${t.year})` : ''}, from HowLongToBeat player reports:`,
    main && `• Main story: ${main} — just the main objectives`,
    extra && `• Main + extras: ${extra} — story plus side content`,
    full && `• Completionist: ${full} — everything, 100%`,
    !main && all && `• All play styles: ${all}`,
  ].filter(Boolean).join('\n');
  return (
    <Badge
      variant="outline"
      className="border-violet-500/30 text-violet-300 bg-violet-500/10 cursor-default"
      title={tooltip}
      aria-label={tooltip}
    >
      <Clock className="w-3 h-3 mr-1" />
      <span className="font-semibold">HowLongToBeat</span>
      {main ? <span>&nbsp;· Main {main}</span> : <span>&nbsp;· {all}</span>}
      {extra && <span className="text-violet-300/70">&nbsp;· +Extras {extra}</span>}
      {full && <span className="text-violet-300/70">&nbsp;· 100% {full}</span>}
    </Badge>
  );
});
