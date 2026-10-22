import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { buildGameImageChain } from '@/lib/utils';

interface Props {
  id: string;
  title: string;
  coverUrl?: string;
  /** Fade in (opacity 0 → 1) once the image has loaded. */
  fade?: boolean;
  style?: CSSProperties;
}

const FILL: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' };

/**
 * Cover image that walks the store CDN fallback chain on error and hides itself
 * when every candidate fails, revealing the "NO IMAGE" placeholder behind it.
 */
export const EsImg = memo(function EsImg({ id, title, coverUrl, fade, style }: Props) {
  const chain = useMemo(() => buildGameImageChain(id, title, coverUrl), [id, title, coverUrl]);
  const [idx, setIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { setIdx(0); setLoaded(false); }, [chain]);
  const src = chain[idx];
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onLoad={() => setLoaded(true)}
      onError={() => { setLoaded(false); setIdx(i => i + 1); }}
      style={{ ...FILL, ...(fade ? { opacity: loaded ? 1 : 0, transition: 'opacity 0.6s ease' } : null), ...style }}
    />
  );
});

/** First URL of the fallback chain — for CSS background-image consumers (dock thumbnails). */
export function primaryImage(id: string, title: string, coverUrl?: string): string | undefined {
  return buildGameImageChain(id, title, coverUrl)[0];
}
