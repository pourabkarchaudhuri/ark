/**
 * The router graph of the AI providers page (1.0.97 B37): connector nodes on the left, the LiteLLM
 * router in the middle and what the routed role is used for on the right, joined by wires whose
 * style says the state (moving accent = live). Below 1040 px it becomes a plain list.
 */
import { useEffect, useState } from 'react';
import type { AiConnector, AiRole } from '@/services/ai-router-types';
import { Chip, Icon, ICON, Switch, type Tone } from '@/components/settings/ui';
import { KIND_LORE, ROLE_DECKS, graphLayout, type ModelList, type NodeDisplay } from '@/components/settings/ai-providers-logic';
import { ROLE_LABEL, ROLE_NOUN, monogram } from '@/components/settings/use-ai-router';

export interface GraphItem {
  connector: AiConnector;
  display: NodeDisplay;
  models: ModelList;
}

interface Props {
  role: AiRole;
  items: GraphItem[];
  hiddenCount: number;
  routeText: string;
  counts: { armed: number; fault: number; off: number };
  openId: string | null;
  hotId: string | null;
  onHot: (id: string | null) => void;
  onOpen: (id: string) => void;
  onRoute: (id: string) => void;
  onToggle: (id: string, on: boolean) => void;
}

/** True below 1040 px, where the graph gives way to a list (only one of the two is rendered). */
export function useNarrow(): boolean {
  const query = '(max-width: 1040px)';
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return narrow;
}

const toneOf = (t: NodeDisplay['tone']): Tone => t;

function summary(i: GraphItem): string {
  const { connector: c, models } = i;
  if (c.kind === 'builtin') return KIND_LORE.builtin;
  const active = models.rows.filter((r) => r.active).length;
  return `${KIND_LORE[c.kind]} · ${active} of ${models.rows.length} model${models.rows.length === 1 ? '' : 's'}`;
}

export function RouterGraph(p: Props) {
  const n = p.items.length;
  const L = graphLayout(n, p.hiddenCount);
  const live = p.items.find((i) => i.display.routed);
  const deckTone = live ? 'live' : 'off';
  const noun = ROLE_NOUN[p.role];
  const decks = ROLE_DECKS[p.role];
  const routerTone: Tone = live ? 'live' : 'nokey';
  const narrow = useNarrow();

  if (narrow) {
    return (
      <div className="plist" style={{ display: 'flex' }}>
        {listItems(p)}
      </div>
    );
  }

  return (
    <>
      <div className="panel stagewrap">
        <div className="stage" style={{ height: L.stageH }}>
          <p style={{ position: 'absolute', left: 'var(--space-4)', top: 'var(--space-2)', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-ink-3)' }}>Connectors that offer {noun}</p>
          <p style={{ position: 'absolute', left: 320, top: L.routerLabelY, width: 220, textAlign: 'center', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-ink-3)' }}>Router</p>
          <p style={{ position: 'absolute', left: 580, top: L.deckLabelY, width: 124, textAlign: 'center', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-ink-3)' }}>Uses this route</p>

          <svg width={720} height={L.stageH} aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible' }}>
            {p.items.map((it, i) => (
              <path key={it.connector.id} className="w" data-tone={it.display.tone} data-hot={p.hotId === it.connector.id} d={L.wire(i)} />
            ))}
            {L.deckWires.map((d, i) => <path key={`deck${i}`} className="w" data-tone={live ? 'deck' : 'off'} d={d} />)}
          </svg>

          {p.items.map((it, i) => {
            const c = it.connector;
            const d = it.display;
            return (
              <div
                key={c.id} className="node" data-tone={toneOf(d.tone)} data-routed={d.routed} data-open={p.openId === c.id}
                style={{ top: L.nodeY(i) }} onMouseEnter={() => p.onHot(c.id)} onMouseLeave={() => p.onHot(null)}
              >
                <div className="bar" />
                <div style={{ padding: 'var(--space-2) var(--space-3) 0', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <span className="mono">{monogram(c)}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-md)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                  <span className="chip">{d.chip}</span>
                </div>
                <p style={{ margin: 'var(--space-1) var(--space-3) 0', fontSize: 'var(--text-xs)', color: 'var(--color-ink-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{summary(it)}</p>
                <div style={{ position: 'absolute', left: 'var(--space-3)', right: 'var(--space-3)', bottom: 'var(--space-2)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <button
                    type="button" className="btn" aria-pressed={d.routed} disabled={!d.canAct && !d.opensDrawer}
                    onClick={() => (d.opensDrawer ? p.onOpen(c.id) : p.onRoute(c.id))} style={{ flex: 1, height: 28, fontSize: 'var(--text-xs)' }}
                  >{d.routeLabel}</button>
                  <button type="button" className="btn icon" aria-label={`Settings for ${c.name}`} aria-expanded={p.openId === c.id} onClick={() => p.onOpen(c.id)} style={{ width: 28, height: 28 }}><Icon d={ICON.general} /></button>
                  {c.kind !== 'builtin' && (
                    <button type="button" className="sw" role="switch" aria-checked={c.enabled !== false} aria-label={`Enable ${c.name}`} onClick={() => p.onToggle(c.id, c.enabled === false)} style={{ width: 40, height: 22 }}><span /></button>
                  )}
                </div>
              </div>
            );
          })}

          {p.hiddenCount > 0 && (
            <p style={{ position: 'absolute', left: 'var(--space-4)', top: L.hiddenY, width: 236, fontSize: 'var(--text-xs)', lineHeight: 1.5, color: 'var(--color-ink-3)' }}>
              {p.hiddenCount} {p.hiddenCount === 1 ? 'connector doesn’t' : 'connectors don’t'} offer {noun}.
            </p>
          )}

          <div className="node" data-tone={routerTone} data-routed={!!live} style={{ left: 320, top: L.routerTop, width: 220, height: 210 }}>
            <div className="bar" />
            <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
              <div className="inline" style={{ justifyContent: 'space-between' }}>
                <p style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-md)', fontWeight: 700, letterSpacing: '0.04em' }}>LiteLLM</p>
                <span className="chip">{live ? 'Live' : 'No route'}</span>
              </div>
              <p className="d" style={{ marginTop: 'var(--space-1)' }}>Router · {ROLE_LABEL[p.role]}</p>
              <p style={{ margin: 'var(--space-4) 0 var(--space-1)', fontSize: 'var(--text-xs)', color: 'var(--color-ink-3)' }}>Active route</p>
              <p className="fade" style={{ fontSize: 'var(--text-sm)', color: 'var(--tone)', wordBreak: 'break-all' }}>{p.routeText || `No route for ${noun}. Pick a connector and press Route here.`}</p>
              <p style={{ margin: 'var(--space-4) 0 0', fontSize: 'var(--text-xs)', color: 'var(--color-ink-3)', fontVariantNumeric: 'tabular-nums' }}>{p.counts.armed} armed · {p.counts.fault} fault · {p.counts.off} off</p>
            </div>
          </div>

          {decks.map((name, i) => (
            <div key={name} className="node" data-tone={deckTone} style={{ left: 580, top: i === 0 ? L.deck1Y : L.deck2Y, width: 124, height: 56 }}>
              <div className="bar" />
              <div style={{ padding: 'var(--space-2)' }}><p className="t" style={{ fontSize: 'var(--text-sm)' }}>{name}</p></div>
            </div>
          ))}
        </div>
      </div>

    </>
  );
}

function listItems(p: Props) {
  return (
    <>
        {p.items.map((it) => (
          <div className="item" key={it.connector.id} data-tone={toneOf(it.display.tone)}>
            <span className="mono">{monogram(it.connector)}</span>
            <span className="grow"><span className="t" style={{ display: 'block' }}>{it.connector.name}</span><span className="d" style={{ display: 'block' }}>{summary(it)}</span></span>
            <Chip tone={toneOf(it.display.tone)}>{it.display.chip}</Chip>
            {!it.display.routed && (it.display.canAct || it.display.opensDrawer) && (
              <button type="button" className="btn" onClick={() => (it.display.opensDrawer ? p.onOpen(it.connector.id) : p.onRoute(it.connector.id))}>{it.display.routeLabel}</button>
            )}
            <button type="button" className="btn icon" aria-label={`Settings for ${it.connector.name}`} onClick={() => p.onOpen(it.connector.id)} style={{ width: 44, height: 44 }}><Icon d={ICON.general} size={16} /></button>
            {it.connector.kind !== 'builtin' && (
              <Switch checked={it.connector.enabled !== false} onChange={(on) => p.onToggle(it.connector.id, on)} label={`Enable ${it.connector.name}`} />
            )}
          </div>
        ))}
    </>
  );
}
