/**
 * Small building blocks of the redesigned Settings pages (1.0.97 B37): the switch, status chip,
 * panel and row, segmented control, meter, toast and page header, styled by settings.css.
 * Real buttons, inputs and labels throughout, so keyboard and screen-reader use work.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type Tone = 'live' | 'info' | 'warn' | 'fault' | 'off' | 'accent' | 'armed' | 'nokey';

/** Icon paths from the design boards (24px grid, 2px round stroke). */
export const ICON = {
  back: 'm12 19-7-7 7-7M19 12H5',
  general: 'M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4',
  providers: 'M14 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM7 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM21 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM12 7v4M12 11l-6.5 6M12 11l6.5 6',
  brain: 'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18ZM12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18ZM12 5v13',
  guide: 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
  info: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0zM12 16v-4M12 8h.01',
  search: 'M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0zM21 21l-4.3-4.3',
  arrow: 'M5 12h14M12 5l7 7-7 7',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  warn: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3zM12 9v4M12 17h.01',
  plus: 'M12 5v14M5 12h14',
  close: 'M18 6 6 18M6 6l12 12',
  chevron: 'm6 9 6 6 6-6',
  check: 'M20 6 9 17l-5-5',
  refresh: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5',
  replay: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5',
  layers: 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83zM2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17',
  play: 'M6 3l14 9-14 9z',
  spinner: 'M21 12a9 9 0 1 1-6.2-8.6',
  sparkles: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  rocket: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2zM9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5',
  compass: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0zM16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36z',
  library: 'M16 6l4 14M12 6v14M8 8v12M4 4v16',
  map: 'M14.1 5.9 9 3 3 6v15l6-3 6 3 6-3V3zM9 3v15M15 6v15',
  eye: 'M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z',
  radio: 'M4.9 19.1C1 15.2 1 8.8 4.9 4.9M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5M19.1 4.9C23 8.8 23 15.1 19.1 19M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
  calendar: 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM16 2v4M8 2v4M3 10h18',
  bag: 'M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0',
  trophy: 'M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M18 2H6v7a6 6 0 0 0 12 0V2zM10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22',
  tv: 'M7 21h10M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
  heart: 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z',
  shield: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
  message: 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z',
  trending: 'M22 7l-8.5 8.5-5-5L2 17M16 7h6v6',
  code: 'm16 18 6-6-6-6M8 6l-6 6 6 6',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9z',
} as const;

export function Icon({ d, size = 14, className }: { d: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d={d} />
    </svg>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <Icon d={ICON.spinner} size={size} className="spin" />;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" className="sw" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Chip({ tone, children, tag, className }: { tone: Tone; children: ReactNode; tag?: boolean; className?: string }) {
  return <span className={cn('chip', tag && 'tag', className)} data-tone={tone}>{children}</span>;
}

export function Panel({ title, id, children, className }: { title?: string; id: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('panel', className)} aria-labelledby={title ? `h-${id}` : undefined}>
      {title && <h2 id={`h-${id}`} className="ph">{title}</h2>}
      {children}
    </section>
  );
}

/**
 * One settings row. `settingId` ties the row to its entry in the search index (a test checks every
 * row has one); `control` sits on the right.
 */
export function Row({ settingId, label, desc, chip, control, extra, leading }: {
  settingId?: string;
  label: ReactNode;
  desc?: ReactNode;
  chip?: ReactNode;
  control?: ReactNode;
  /** Below the text: hotkeys, warnings, progress. */
  extra?: ReactNode;
  leading?: ReactNode;
}) {
  return (
    <div className="row" data-setting-id={settingId}>
      <div className="inline grow" style={{ gap: 'var(--space-3)' }}>
        {leading}
        <div className="grow">
          <div className="inline"><p className="t">{label}</p>{chip}</div>
          {desc && <p className="d">{desc}</p>}
          {extra}
        </div>
      </div>
      {control}
    </div>
  );
}

export function SwitchRow({ settingId, label, desc, checked, onChange, chip, extra, disabled }: {
  settingId?: string; label: string; desc?: ReactNode; checked: boolean; onChange: (next: boolean) => void; chip?: ReactNode; extra?: ReactNode; disabled?: boolean;
}) {
  return <Row settingId={settingId} label={label} desc={desc} chip={chip} extra={extra} control={<Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />} />;
}

/** A tray of mutually exclusive choices (radio semantics). */
export function Seg<T extends string | number>({ label, options, value, onChange, small = true }: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  small?: boolean;
}) {
  return (
    <div className={cn('tray', small && 'sm')} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Meter({ pct, label, color, className }: { pct: number; label: string; color?: string; className?: string }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className={cn('meter', className)} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v}>
      <i style={{ width: `${v}%`, ...(color ? { background: color } : {}) }} />
    </div>
  );
}

export function PageHeader({ title, lede, children }: { title: string; lede: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div style={{ minWidth: 0 }}>
        <h1 className="page-title">{title}</h1>
        <p className="page-lede">{lede}</p>
      </div>
      {children}
    </header>
  );
}

export interface ToastMessage {
  id: number;
  text: string;
  tone?: 'fault';
  action?: { label: string; run: () => void };
}

export function Toast({ toast, onDismiss }: { toast: ToastMessage; onDismiss: () => void }) {
  return (
    <div role={toast.tone === 'fault' ? 'alert' : 'status'} className="toast" data-tone={toast.tone}>
      {toast.tone === 'fault' && <Chip tone="fault" tag>Failed</Chip>}
      <span>{toast.text}</span>
      {toast.action && <button type="button" className="btn" onClick={() => { toast.action!.run(); onDismiss(); }}>{toast.action.label}</button>}
      <button type="button" className="btn q icon" aria-label="Dismiss" onClick={onDismiss}><Icon d={ICON.close} /></button>
    </div>
  );
}

/** Opens a link in the system browser when the desktop bridge is there, otherwise a new tab. */
export function openExternal(url: string): void {
  const shell = (window as unknown as { electron?: { openExternal?: (url: string) => unknown } }).electron;
  if (shell?.openExternal) void shell.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); openExternal(href); }}>{children}</a>
  );
}
