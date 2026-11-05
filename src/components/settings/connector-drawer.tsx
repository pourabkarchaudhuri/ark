/**
 * The connector drawer of the AI providers page (1.0.97 B37, design "Redesign · AI providers"):
 * enable switch, address / key / endpoint fields, the models offered for the viewed role, the
 * connection test and its settings, Advanced (base URL override, LiteLLM id) and the route button.
 * Keys are write-only here: saved through `aiRouter.setKey`, never read back.
 */
import { useRef, useState } from 'react';
import type { AiConnector, AiRole, AiRoutePolicy, ConnectorKind } from '@/services/ai-router-types';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { BuiltInLocalAiPanel } from '@/components/settings/built-in-local-ai';
import { ExternalOllamaSection } from '@/components/settings/external-ollama-section';
import { Chip, ExtLink, Icon, ICON, Seg, Spinner, Switch, type Tone } from '@/components/settings/ui';
import { KEY_SITES, KIND_LORE, TEST_INPUT, describeTest, isModelId, routeCta, smallestModel, testFor, type ModelList, type ModelPrefs, type NodeDisplay } from '@/components/settings/ai-providers-logic';
import type { ConnectorDraft } from '@/components/settings/ai-providers-page';
import { ROLE_LABEL, ROLE_NOUN, ROLES, connectorLabel, litellmId, monogram } from '@/components/settings/use-ai-router';

export const CONNECTOR_SAVED_PLACEHOLDER = 'Key saved. Paste a new one to replace it';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Not hidden, and not inside a closed <details> (other than its own summary). */
function isTabbable(el: HTMLElement): boolean {
  if (el.closest('[hidden]')) return false;
  for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) {
    if (!d.open && el.closest('summary')?.parentElement !== d) return false;
  }
  return true;
}

export type TestWith = 'default' | 'smallest';

const TONE: Record<NodeDisplay['tone'], Tone> = { live: 'live', armed: 'armed', nokey: 'nokey', fault: 'fault', off: 'off' };

interface Props {
  connector: AiConnector;
  /** Not saved yet (Azure needs its endpoint and deployment first). */
  isDraft: boolean;
  role: AiRole;
  display: NodeDisplay;
  models: ModelList;
  prefs: ModelPrefs | undefined;
  policy: AiRoutePolicy;
  testing: boolean;
  testWith: TestWith;
  onTestWith: (v: TestWith) => void;
  onClose: () => void;
  onToggleEnabled: (on: boolean) => void;
  onRoute: () => void;
  onTest: (model: string | undefined) => void;
  onPrefs: (next: ModelPrefs) => void;
  onPolicy: (patch: Partial<AiRoutePolicy>) => void;
  /** Persist connector fields; resolves with an error text, or null on success. */
  onSaveFields: (fields: Partial<AiConnector> & { kind: ConnectorKind }) => Promise<string | null>;
  onRemove: () => void;
  /** A key was saved or removed: refresh the page state. */
  onKeyChanged: (note: { tone: 'live' | 'fault' | 'info'; text: string } | null) => void;
  /** The last key message (saved, rejected, removed), shown under the key field until a newer test or key change. */
  keyNote: { tone: 'live' | 'fault' | 'info'; text: string } | null;
  /** The user is typing a new key: the old key message no longer describes it. */
  onKeyNoteClear: () => void;
  /** Unsaved field edits and the pasted key, kept by the page across role tabs and closing the drawer. */
  draft: ConnectorDraft | undefined;
  onDraft: (patch: ConnectorDraft) => void;
  onDiscardDraft: () => void;
  fetchedBusy: boolean;
  onFetchModels: () => void;
  fetchError: string | null;
  /** Make sure the connector exists in main before a key is saved for it. */
  ensureSaved: () => Promise<string | null>;
}

export function ConnectorDrawer(p: Props) {
  const c = p.connector;
  const noun = ROLE_NOUN[p.role];
  const custom = c.kind === 'openai-compatible';
  const keyed = c.kind !== 'builtin' && c.kind !== 'ollama';
  const cta = routeCta(c, p.role, noun, p.display);
  const lastTest = testFor(c, p.role);
  const shown = lastTest ? describeTest(lastTest) : null;
  const rows = p.models.rows;
  const activeIds = rows.filter((r) => r.active).map((r) => r.id);

  // ── Field drafts ──────────────────────────────────────────────────────────────────────────────
  const d = p.draft ?? {};
  const fromStore = (key: string): string => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };
  const name = d.name ?? c.name;
  const baseUrl = d.baseUrl ?? c.baseUrl ?? '';
  const endpoint = d.endpoint ?? c.endpoint ?? fromStore('ark-azure-endpoint');
  const deployment = d.deployment ?? c.deployment ?? fromStore('ark-azure-deployment');
  const apiVersion = d.apiVersion ?? c.apiVersion ?? fromStore('ark-azure-api-version');
  const roles = d.roles ?? c.roles ?? ['chat'];
  const override = d.override ?? c.baseUrl ?? '';
  const setName = (v: string) => p.onDraft({ name: v });
  const setBaseUrl = (v: string) => p.onDraft({ baseUrl: v });
  const setEndpoint = (v: string) => p.onDraft({ endpoint: v });
  const setDeployment = (v: string) => p.onDraft({ deployment: v });
  const setApiVersion = (v: string) => p.onDraft({ apiVersion: v });
  const setRoles = (v: AiRole[]) => p.onDraft({ roles: v });
  const setOverride = (v: string) => p.onDraft({ override: v });
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [savingFields, setSavingFields] = useState(false);

  const dirty = c.kind === 'azure-openai'
    ? p.isDraft || endpoint !== (c.endpoint ?? '') || deployment !== (c.deployment ?? '') || apiVersion !== (c.apiVersion ?? '')
    : custom ? name !== c.name || baseUrl !== (c.baseUrl ?? '') || roles.join() !== (c.roles ?? []).join()
      : c.kind === 'ollama' ? baseUrl !== (c.baseUrl ?? '')
        : override !== (c.baseUrl ?? '');

  const saveFields = async () => {
    setSavingFields(true);
    setFieldError(null);
    const base = { kind: c.kind, id: c.id, name: c.name, enabled: c.enabled !== false } as Partial<AiConnector> & { kind: ConnectorKind };
    const input: Partial<AiConnector> & { kind: ConnectorKind } =
      c.kind === 'azure-openai' ? { ...base, endpoint: endpoint.trim(), deployment: deployment.trim(), apiVersion: apiVersion.trim() }
        : custom ? { ...base, name: name.trim() || c.name, baseUrl: baseUrl.trim(), roles }
          : c.kind === 'ollama' ? { ...base, baseUrl: baseUrl.trim() }
            : { ...base, baseUrl: override.trim() || undefined };
    const err = await p.onSaveFields(input);
    setSavingFields(false);
    if (err) setFieldError(err);
  };

  // ── Key ───────────────────────────────────────────────────────────────────────────────────────
  const keyDraft = d.keyDraft ?? '';
  const setKeyDraft = (v: string) => { p.onDraft({ keyDraft: v }); if (p.keyNote) p.onKeyNoteClear(); };
  const [keyBusy, setKeyBusy] = useState(false);
  const [confirmKey, setConfirmKey] = useState(false);
  const site = KEY_SITES[c.kind];

  const saveKey = async () => {
    const key = keyDraft.trim();
    if (!key || !window.aiRouter) return;
    setKeyBusy(true);
    const ensured = await p.ensureSaved();
    if (ensured) { p.onKeyChanged({ tone: 'fault', text: ensured }); setKeyBusy(false); return; }
    try {
      const res = await window.aiRouter.setKey({ connectorId: c.id, key });
      if (!res.success) {
        p.onKeyChanged({ tone: 'fault', text: res.error });
      } else {
        p.onDraft({ keyDraft: '' });
        const t = res.test;
        p.onKeyChanged(!t ? { tone: 'info', text: 'Key saved. Run the test before routing.' }
          : t.ok ? { tone: 'live', text: `Key saved and working · ${t.latencyMs} ms` }
            : { tone: 'fault', text: `Key saved, but ${c.name} rejected it. The connector stays unrouted until a test passes.` });
      }
    } catch {
      p.onKeyChanged({ tone: 'fault', text: 'Could not save the key.' });
    }
    setKeyBusy(false);
  };

  const removeKey = async () => {
    setConfirmKey(false);
    if (!window.aiRouter) return;
    try {
      const res = await window.aiRouter.clearKey(c.id);
      p.onKeyChanged(res.success ? { tone: 'info', text: 'Key removed from this PC.' } : { tone: 'fault', text: res.error });
    } catch {
      p.onKeyChanged({ tone: 'fault', text: 'Could not remove the key.' });
    }
  };

  // ── Models ────────────────────────────────────────────────────────────────────────────────────
  const [addDraft, setAddDraft] = useState('');
  const prefs: ModelPrefs = p.prefs ?? { added: [], off: [] };
  const toggleModel = (id: string, on: boolean) => {
    const off = on ? prefs.off.filter((x) => x !== id) : [...prefs.off, id];
    p.onPrefs({ ...prefs, off, def: prefs.def === id && !on ? undefined : prefs.def });
  };
  const addModel = () => {
    const id = addDraft.trim();
    if (!isModelId(id) || rows.some((r) => r.id === id)) return;
    p.onPrefs({ ...prefs, added: [...prefs.added, id], off: prefs.off.filter((x) => x !== id) });
    setAddDraft('');
  };

  // ── Test ──────────────────────────────────────────────────────────────────────────────────────
  const [copied, setCopied] = useState(false);
  const testModel = p.testWith === 'smallest' ? smallestModel(activeIds) ?? undefined : p.models.def ?? undefined;
  const lite = litellmId(c.kind, p.models.def ?? '');
  const copy = () => {
    try { void navigator.clipboard?.writeText(lite); } catch { /* clipboard blocked */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const tin = TEST_INPUT[p.role];

  // ── Keyboard: Escape closes, Tab stays inside, and the page returns focus to the opener ──────────
  const asideRef = useRef<HTMLElement>(null);
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const root = asideRef.current;
    // Events from the confirm dialogs (portalled) bubble through React: only handle keys from inside the drawer.
    if (!root || e.defaultPrevented || !(e.target instanceof Node) || !root.contains(e.target)) return;
    if (e.key === 'Escape') { e.stopPropagation(); p.onClose(); return; }
    if (e.key !== 'Tab') return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isTabbable);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === root)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <aside ref={asideRef} tabIndex={-1} onKeyDown={onKeyDown} style={{ outline: 'none' }} className="panel drawer" aria-labelledby="drawer-title" data-tone={TONE[p.display.tone]}>
      <div className="bar" />
      <div style={{ padding: 'var(--space-4)', display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)' }}>
        <span className="mono" style={{ width: 32, height: 32, fontSize: 'var(--text-xs)' }}>{monogram(c)}</span>
        <div className="grow">
          <h2 id="drawer-title" style={{ fontSize: 'var(--text-lg)', fontWeight: 600, overflowWrap: 'anywhere' }}>{connectorLabel(c)}</h2>
          <p className="d" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-1) var(--space-2)' }}>{KIND_LORE[c.kind]} · <Chip tone={TONE[p.display.tone]}>{p.testing ? 'Testing' : p.display.chip}</Chip></p>
        </div>
        <button type="button" className="btn q icon" aria-label="Close settings" onClick={p.onClose}><Icon d={ICON.close} /></button>
      </div>

      {p.display.tone === 'fault' && lastTest && !lastTest.ok && c.kind !== 'builtin' && (
        <div className="alert" role="alert" data-tone="fault" style={{ margin: '0 var(--space-4) var(--space-4)' }}>
          <div><strong>{shown?.text}.</strong> {shown?.advice ?? lastTest.message}</div>
        </div>
      )}

      {c.kind !== 'builtin' && (
        <div className="sect" data-setting-id={undefined}>
          <div className="row" style={{ padding: 0, minHeight: 0, border: 0 }}>
            <div className="grow"><p className="t">Enabled</p><p className="d">Off removes it from every route. Settings stay saved.</p></div>
            <Switch checked={c.enabled !== false} onChange={p.onToggleEnabled} label="Connector enabled" disabled={p.isDraft} />
          </div>
        </div>
      )}

      {c.kind === 'builtin' ? (
        <div className="sect" data-setting-id="builtin-ai">
          <BuiltInLocalAiPanel />
        </div>
      ) : (
        <div className="sect" data-setting-id={c.kind === 'openai-compatible' ? 'connector-compat' : 'connector-keys'}>
          {c.kind === 'ollama' && (
            <div>
              <label className="lb" htmlFor="srv">Server address</label>
              <input id="srv" className="in" type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434" />
              <p className="hint">Runs on this PC or your network. No key needed.</p>
            </div>
          )}
          {custom && (
            <>
              <div><label className="lb" htmlFor="cname">Name</label><input id="cname" className="in" type="text" value={name} onChange={(e) => setName(e.target.value)} /></div>
              <div>
                <label className="lb" htmlFor="cbase">Base URL</label>
                <input id="cbase" className="in" type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:8000/v1" />
                <p className="hint">Any server that speaks the OpenAI API: vLLM, LM Studio, llama.cpp, LocalAI, TGI, or a hosted gateway.</p>
              </div>
              <div>
                <p className="lb">This server provides</p>
                <div className="tray sm" role="group" aria-label="Capabilities">
                  {ROLES.map((r) => (
                    <button key={r} type="button" role="checkbox" aria-checked={roles.includes(r)} onClick={() => setRoles(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r])}>{ROLE_LABEL[r]}</button>
                  ))}
                </div>
              </div>
            </>
          )}
          {c.kind === 'azure-openai' && (
            <>
              <div><label className="lb" htmlFor="ep">Endpoint</label><input id="ep" className="in" type="text" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://your-resource.openai.azure.com/" /></div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 'var(--space-2)' }}>
                <div><label className="lb" htmlFor="dep">Deployment</label><input id="dep" className="in" type="text" value={deployment} onChange={(e) => setDeployment(e.target.value)} placeholder="gpt-4o" /></div>
                <div><label className="lb" htmlFor="ver">API version</label><input id="ver" className="in" type="text" value={apiVersion} onChange={(e) => setApiVersion(e.target.value)} placeholder="2025-04-01-preview" /></div>
              </div>
            </>
          )}
          {(dirty || fieldError) && (
            <div className="inline">
              <button type="button" className="btn p" disabled={savingFields || !dirty} onClick={() => void saveFields()}>{savingFields ? <Spinner /> : null}{p.isDraft ? 'Add connector' : 'Save changes'}</button>
              {!p.isDraft && <button type="button" className="btn q" disabled={savingFields} onClick={() => { setFieldError(null); p.onDiscardDraft(); }}>Cancel</button>}
              {fieldError && <span role="alert" className="chip" data-tone="fault">{fieldError}</span>}
            </div>
          )}
          {(keyed || custom) && (
            <div>
              <label className="lb" htmlFor="key">API key{custom && <span style={{ fontWeight: 400, color: 'var(--color-ink-3)' }}> (optional)</span>}</label>
              <div className="inline">
                <input
                  id="key" className="in" type="password" autoComplete="off" spellCheck={false} value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)}
                  disabled={p.isDraft}
                  placeholder={c.hasKey ? CONNECTOR_SAVED_PLACEHOLDER : custom ? 'Leave empty if the server has no auth' : (site?.hint ?? 'API key')}
                />
                <button type="button" className={c.hasKey ? 'btn' : 'btn p'} disabled={keyBusy || p.isDraft || keyDraft.trim().length < 8} onClick={() => void saveKey()}>
                  {keyBusy ? <Spinner /> : null}{c.hasKey ? 'Replace' : 'Save'}
                </button>
              </div>
              <p className="hint">
                {c.hasKey ? <>Encrypted on this PC, sent only to {c.name}. <button type="button" className="btn link" onClick={() => setConfirmKey(true)}>Remove key</button></> : site ? <>Get one at <ExtLink href={site.url}>{site.site}</ExtLink>.</> : 'Encrypted on this PC and sent only to this server.'}
              </p>
              {p.keyNote && <p className="hint" role="status" data-tone={p.keyNote.tone === 'info' ? 'info' : p.keyNote.tone} style={{ color: 'var(--tone)' }}>{p.keyNote.text}</p>}
            </div>
          )}
        </div>
      )}

      {c.kind !== 'builtin' && (
        <div className="sect" style={{ gap: 'var(--space-2)' }} data-setting-id="connector-models">
          <div className="row" style={{ padding: 0, minHeight: 0, border: 0 }}>
            <p className="lb" style={{ margin: 0 }}>{ROLE_LABEL[p.role]} models</p>
            {(c.kind === 'ollama' || custom) && !p.isDraft && (
              <button type="button" className="btn q" onClick={p.onFetchModels} disabled={p.fetchedBusy} style={{ height: 24, fontSize: 'var(--text-xs)' }}>
                {p.fetchedBusy ? <Spinner size={12} /> : null}Fetch from server
              </button>
            )}
          </div>
          {p.fetchError && <p className="hint" role="alert" style={{ color: 'var(--color-fault)' }}>{p.fetchError}</p>}
          {c.serves.includes(p.role) || p.isDraft ? (
            c.kind === 'azure-openai' ? (
              <p className="hint" style={{ margin: 0 }}>{c.deployment ? <>Uses the deployment <span style={{ color: 'var(--color-accent-ink)' }}>{c.deployment}</span>. One deployment is one model.</> : 'Save the endpoint and deployment above first.'}</p>
            ) : (
              <>
                {rows.map((m) => (
                  <div className="row" key={m.id} style={{ gap: 'var(--space-3)', padding: 'var(--space-1) 0', minHeight: 0, border: 0 }}>
                    <button type="button" className="ck" role="checkbox" aria-checked={m.active} aria-label={`Use ${m.id}`} onClick={() => toggleModel(m.id, !m.active)}>{m.active && <Icon d={ICON.check} size={11} />}</button>
                    <span className="grow" style={{ fontSize: 'var(--text-sm)', color: m.active ? 'var(--color-ink)' : 'var(--color-ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.id}</span>
                    <button type="button" className="rd" role="radio" aria-checked={m.id === p.models.def} aria-label={`Make ${m.id} the default`} disabled={!m.active} onClick={() => p.onPrefs({ ...prefs, def: m.id })}>Default</button>
                  </div>
                ))}
                {rows.length === 0 && <p className="hint" style={{ margin: 0 }}>No models yet. Add the id of one below{custom ? ' or fetch the list from the server' : ''}.</p>}
                <div className="inline">
                  <label className="vh" htmlFor="addm">Add model id</label>
                  <input id="addm" className="in" type="text" value={addDraft} placeholder="Add model id" style={{ height: 30 }} onChange={(e) => setAddDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addModel(); }} />
                  <button type="button" className="btn" style={{ height: 30 }} disabled={!isModelId(addDraft) || rows.some((r) => r.id === addDraft.trim())} onClick={addModel}>Add</button>
                </div>
              </>
            )
          ) : (
            <p className="hint" style={{ margin: 0 }}>{c.name} doesn&apos;t offer {noun}. Pick another role above to manage its other models.</p>
          )}
        </div>
      )}

      {c.kind !== 'builtin' && (
        <div className="sect" aria-labelledby="h-test" data-setting-id="connection-test">
          <p id="h-test" className="t">Connection test</p>
          <div className="opt"><span className="lb" style={{ margin: 0 }}>Test with</span>
            <Seg label="Test with" value={p.testWith} onChange={p.onTestWith} options={[{ value: 'default', label: 'Default' }, { value: 'smallest', label: 'Smallest' }]} />
          </div>
          <div className="opt"><span className="lb" style={{ margin: 0 }}>Timeout</span>
            <Seg label="Timeout" value={p.policy.timeoutSec} onChange={(v) => p.onPolicy({ timeoutSec: v })} options={[{ value: 10, label: '10 s' }, { value: 30, label: '30 s' }, { value: 60, label: '60 s' }]} />
          </div>
          <div className="opt"><span className="lb" style={{ margin: 0 }}>Retries</span>
            <Seg label="Retries" value={p.policy.retries} onChange={(v) => p.onPolicy({ retries: v })} options={[{ value: 0, label: 'None' }, { value: 1, label: '1' }, { value: 2, label: '2' }]} />
          </div>
          <div className="opt"><span className="lb" style={{ margin: 0 }}>Re-check</span>
            <Seg label="Re-check while armed" value={p.policy.recheckMin} onChange={(v) => p.onPolicy({ recheckMin: v })} options={[{ value: 0, label: 'Off' }, { value: 30, label: '30 min' }, { value: 120, label: '2 h' }]} />
          </div>
          <div>
            <label className="lb" htmlFor="tprompt">Test input</label>
            <input id="tprompt" className="in" type="text" readOnly value={tin.text} />
            <p className="hint">{tin.hint}</p>
          </div>
          <div className="row" style={{ padding: 0, minHeight: 0, border: 0 }}>
            <div><p className="t">Test when a key is saved</p><p className="d">Catches a bad key before it&apos;s routed.</p></div>
            <Switch checked={p.policy.testOnKeySave} onChange={(v) => p.onPolicy({ testOnKeySave: v })} label="Test when a key is saved" />
          </div>
          <div className="inline" style={{ gap: 'var(--space-3)' }}>
            <button type="button" className="btn" onClick={() => p.onTest(testModel)} disabled={p.testing || p.isDraft || c.enabled === false || (c.needsKey && !c.hasKey)}>
              {p.testing ? <Spinner /> : null}Run test
            </button>
            <span aria-live="polite" className="chip fade" data-tone={p.testing ? 'off' : shown ? (shown.tone === 'live' ? 'live' : shown.tone === 'nokey' ? 'nokey' : 'fault') : 'off'}>
              {p.testing ? 'Testing…' : shown ? shown.text : 'Not tested yet'}
            </span>
          </div>
          {shown?.advice && shown.tone !== 'live' && <div className="alert" data-tone={shown.tone === 'nokey' ? 'nokey' : 'fault'}>{shown.advice}</div>}
        </div>
      )}

      <div className="sect">
        <details>
          <summary className="disc">Advanced<Icon d={ICON.chevron} className="chev" /></summary>
          <div className="fade" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
            {(c.kind === 'gemini' || c.kind === 'anthropic' || c.kind === 'openai') && (
              <div>
                <label className="lb" htmlFor="base">Base URL override</label>
                <input id="base" className="in" type="text" value={override} onChange={(e) => setOverride(e.target.value)} placeholder="Proxy or self-hosted gateway" />
                <p className="hint">Leave empty to use {c.name} directly. Press Save changes to apply.</p>
              </div>
            )}
            <div className="inline" style={{ gap: 'var(--space-2)' }}>
              <p className="hint grow" style={{ margin: 0 }}>Router id <span style={{ color: 'var(--color-accent-ink)', wordBreak: 'break-all' }}>{lite}</span></p>
              <button type="button" className="btn q" onClick={copy} style={{ height: 26, fontSize: 'var(--text-xs)' }}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
            {c.kind === 'builtin' && <ExternalOllamaSection />}
            {c.kind !== 'builtin' && !p.isDraft && (
              <div><button type="button" className="btn d" onClick={p.onRemove}>Remove connector</button></div>
            )}
          </div>
        </details>
      </div>

      <div className="sect">
        <button type="button" className="btn p" style={{ height: 36 }} disabled={cta.disabled || p.isDraft || !p.display.canAct && !p.display.opensDrawer} onClick={p.onRoute}>{cta.label}</button>
      </div>

      <ConfirmDialog
        open={confirmKey}
        onOpenChange={setConfirmKey}
        title={`Remove the ${c.name} key?`}
        description={`It is erased from this PC. You'll need to paste it again to use ${c.name}.`}
        confirmText="Remove key"
        cancelText="Keep it"
        variant="danger"
        onConfirm={() => void removeKey()}
      />
    </aside>
  );
}
