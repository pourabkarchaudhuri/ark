/**
 * Settings → General → gg.deals prices: one row with the key state as a chip, expanding into the
 * key field, region and key-reseller switch. States from the design: first load, no key, connected,
 * rejected, unreachable and "tested too recently".
 */
import { useEffect, useState } from 'react';
import { GG_REGIONS, getGgRegion, getShowKeyshops, ggDealsService } from '@/services/ggdeals-service';
import { Chip, Row, Switch, type Tone } from '@/components/settings/ui';

type KeyState = 'none' | 'saved' | 'ok' | 'rejected' | 'unreachable' | 'wait';

const CHIP: Record<KeyState, { tone: Tone; label: string }> = {
  none: { tone: 'warn', label: 'No key' },
  saved: { tone: 'info', label: 'Key saved' },
  ok: { tone: 'live', label: 'Connected' },
  rejected: { tone: 'fault', label: 'Rejected' },
  unreachable: { tone: 'warn', label: 'Unreachable' },
  wait: { tone: 'off', label: 'Wait a moment' },
};

const MESSAGE: Partial<Record<KeyState, string>> = {
  ok: 'The key works.',
  rejected: 'gg.deals rejected this key. Check it and save again.',
  unreachable: 'gg.deals could not be reached to check the key right now.',
  wait: 'Please wait a few seconds before testing again.',
};

export function GgDealsRow() {
  const bridge = typeof window !== 'undefined' ? window.ggdeals : undefined;
  // undefined while the first answer is pending (the page shows a skeleton row).
  const [hasKey, setHasKey] = useState<boolean | undefined>(undefined);
  const [state, setState] = useState<KeyState>('none');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [region, setRegion] = useState(getGgRegion);
  const [keyshops, setKeyshops] = useState(getShowKeyshops);

  useEffect(() => {
    if (!bridge) { setHasKey(false); return; }
    let live = true;
    bridge.hasKey().then((v) => { if (live) { setHasKey(v); setState(v ? 'saved' : 'none'); } }).catch(() => { if (live) setHasKey(false); });
    return () => { live = false; };
  }, [bridge]);

  if (!bridge) return null;
  if (hasKey === undefined) {
    return (
      <div className="row" aria-busy="true" data-setting-id="ggdeals">
        <div className="grow"><div className="sk" style={{ width: '45%', height: 12 }} /><div className="sk" style={{ width: '70%', height: 8, marginTop: 8 }} /></div>
        <div className="sk" style={{ width: 72, height: 32 }} />
      </div>
    );
  }

  const resultOf = (r: { ok: boolean; error?: string }): KeyState => (r.ok ? 'ok' : r.error === 'invalid-key' ? 'rejected' : r.error === 'wait' ? 'wait' : 'unreachable');

  const save = async () => {
    setBusy(true);
    const res = await bridge.setKey(draft.trim()).catch(() => ({ success: false, error: 'Could not save the key.' }));
    if (!res.success) {
      setNote(res.error ?? 'Could not save the key.');
      setBusy(false);
      return;
    }
    setDraft('');
    setHasKey(true);
    ggDealsService.settingsChanged();
    const test = await bridge.testKey().catch(() => ({ ok: false, error: 'unavailable' as const }));
    const next = resultOf(test);
    setState(next);
    setNote(next === 'ok' ? 'Key saved and working.' : next === 'rejected' ? 'Key saved, but gg.deals rejected it. Check it and save again.' : next === 'wait' ? 'Key saved. Please wait a few seconds, then press Test to check it.' : 'Key saved. gg.deals could not be reached to check it right now.');
    setBusy(false);
  };

  const test = async () => {
    setBusy(true);
    const res = await bridge.testKey().catch(() => ({ ok: false, error: 'unavailable' as const }));
    const next = resultOf(res);
    setState(next);
    setNote(MESSAGE[next] ?? null);
    setBusy(false);
  };

  const remove = async () => {
    await bridge.clearKey().catch(() => undefined);
    setHasKey(false);
    setState('none');
    setNote('Key removed. Prices are hidden.');
    ggDealsService.settingsChanged();
  };

  const chip = CHIP[hasKey ? state : 'none'];
  const regionLabel = GG_REGIONS.find((r) => r.value === region)?.label ?? region;

  return (
    <>
      <Row
        settingId="ggdeals"
        label="gg.deals prices"
        desc={`Best prices and all-time lows. ${regionLabel}, resellers ${keyshops ? 'shown' : 'hidden'}.`}
        chip={<Chip tone={chip.tone}>{chip.label}</Chip>}
        control={<button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>{hasKey ? 'Manage' : 'Set up'}</button>}
      />
      {open && (
        <div className="sect fade" role="group" aria-label="gg.deals settings">
          <div>
            <label className="lb" htmlFor="ggdeals-key">gg.deals API key</label>
            <div className="inline">
              <input
                id="ggdeals-key" className="in" type="password" autoComplete="off" spellCheck={false}
                value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy}
                placeholder={hasKey ? 'A key is saved. Paste a new one to replace it' : 'Paste your gg.deals API key'}
              />
              <button type="button" className="btn p" onClick={() => void save()} disabled={busy || draft.trim().length < 8}>Save</button>
              {hasKey && <button type="button" className="btn" onClick={() => void test()} disabled={busy}>Test</button>}
              {hasKey && <button type="button" className="btn d" onClick={() => void remove()} disabled={busy}>Remove</button>}
            </div>
            <p className="hint">Shows current best prices and all-time lows on game pages, cards and the Oracle Deals shelf. Get a free key at gg.deals/api. The key is stored encrypted on this computer and only sent to gg.deals.</p>
            {note && <p className="hint" role="status" data-tone={state === 'ok' ? 'live' : state === 'rejected' ? 'fault' : state === 'unreachable' ? 'warn' : undefined} style={{ color: 'var(--tone, var(--color-ink-2))' }}>{note}</p>}
          </div>
          <div className="opt">
            <label className="lb" htmlFor="ggdeals-region" style={{ margin: 0 }}>Price region</label>
            <select id="ggdeals-region" className="sel" value={region} onChange={(e) => { setRegion(e.target.value); ggDealsService.setRegion(e.target.value); }}>
              {GG_REGIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div className="opt">
            <div>
              <p className="t">Show key reseller prices</p>
              <p className="d">Key resellers (grey-market shops) are often cheaper but are not official stores. Shown separately when on.</p>
            </div>
            <Switch checked={keyshops} label="Show key reseller prices" onChange={(v) => { setKeyshops(v); ggDealsService.setShowKeyshops(v); }} />
          </div>
        </div>
      )}
    </>
  );
}
