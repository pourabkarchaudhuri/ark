/**
 * Settings → AI providers (1.0.97 B37, design "Redesign · AI providers" and the StatesCore board):
 * the router screen. Chat, embeddings and reranking each get a route through LiteLLM (B35), with the
 * built-in llama.cpp runtime (B36) as the default connector. Everything here goes through
 * `window.aiRouter` and `window.localAi`; keys are write-only.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AiConnector, AiRole, ConnectorKind } from '@/services/ai-router-types';
import { ensureLegacyAiKeysMigrated } from '@/lib/ai-key-migration';
import type { LocalAiStatus } from '@/services/local-ai-types';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Chip, Icon, ICON, PageHeader, Panel, Seg, Spinner } from '@/components/settings/ui';
import { ConnectorDrawer, type TestWith } from '@/components/settings/connector-drawer';
import { RouterGraph, type GraphItem } from '@/components/settings/router-graph';
import {
  availableCatalog, countStates, describeNode, describeTest, loadModelPrefs, markTesting, modelList, routeRequest, saveModelPrefs, testFor,
  type CatalogItem, type ModelPrefs, type ModelPrefsStore, type NodeDisplay,
} from '@/components/settings/ai-providers-logic';
import { ROLES, ROLE_LABEL, routeId, routeName, useAiRouter } from '@/components/settings/use-ai-router';
import type { PageProps } from '@/components/settings/general-page';

interface Snack {
  id: number;
  text: string;
  chip?: { tone: 'fault'; label: string };
  actions: Array<{ label: string; run: () => void; primary?: boolean }>;
}

/** `at` is the connector's test stamp when the note was written: a later test makes the note stale. */
type KeyNote = { tone: 'live' | 'fault' | 'info'; text: string; at: number | null };

/** Unsaved edits to one connector's fields and a pasted key, kept while the drawer is closed or the role changes. */
export interface ConnectorDraft {
  name?: string; baseUrl?: string; endpoint?: string; deployment?: string; apiVersion?: string;
  roles?: AiRole[]; override?: string; keyDraft?: string;
}

/** The connector whose drawer holds each drawer-section search target. */
function connectorForFocus(focusId: string, connectors: AiConnector[], role: AiRole): string | null {
  if (focusId === 'builtin-ai' || focusId === 'own-ollama') return connectors.find((c) => c.kind === 'builtin')?.id ?? null;
  const cloud = connectors.filter((c) => c.kind !== 'builtin');
  if (focusId === 'connector-compat') return (cloud.find((c) => c.kind === 'openai-compatible') ?? cloud[0])?.id ?? null;
  if (focusId === 'connector-keys' || focusId === 'connector-models' || focusId === 'connection-test') {
    return (cloud.find((c) => c.needsKey && c.serves.includes(role)) ?? cloud.find((c) => c.needsKey) ?? cloud[0])?.id ?? null;
  }
  return null;
}

/** Connector fields as `saveConnector` takes them (never a key). */
function fieldsOf(c: AiConnector, patch: Partial<AiConnector> = {}): Partial<AiConnector> & { kind: ConnectorKind } {
  const merged = { ...c, ...patch };
  return {
    kind: c.kind, id: c.id, name: merged.name, enabled: merged.enabled !== false,
    ...(merged.baseUrl ? { baseUrl: merged.baseUrl } : {}),
    ...(merged.endpoint ? { endpoint: merged.endpoint } : {}),
    ...(merged.deployment ? { deployment: merged.deployment } : {}),
    ...(merged.apiVersion ? { apiVersion: merged.apiVersion } : {}),
    ...(merged.roles ? { roles: merged.roles } : {}),
  };
}

const ROLE_FOCUS: Record<string, AiRole> = { 'route-chat': 'chat', 'route-embeddings': 'embeddings', 'route-reranker': 'reranker' };

export const AiProvidersPage = memo(function AiProvidersPage({ onNavigate, focusId }: PageProps) {
  const { state, refresh, unavailable } = useAiRouter();
  const [role, setRole] = useState<AiRole>(() => ROLE_FOCUS[focusId ?? ''] ?? 'chat');
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);
  const [hot, setHot] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [drafts, setDrafts] = useState<AiConnector[]>([]);
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testWith, setTestWith] = useState<TestWith>('default');
  const [showResults, setShowResults] = useState(false);
  const [prefs, setPrefs] = useState<ModelPrefsStore>(loadModelPrefs);
  const [fetching, setFetching] = useState<Record<string, boolean>>({});
  const [fetchError, setFetchError] = useState<Record<string, string | null>>({});
  const [keyNotes, setKeyNotes] = useState<Record<string, KeyNote | null>>({});
  const [snack, setSnack] = useState<Snack | null>(null);
  const [embedDismissed, setEmbedDismissed] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<AiConnector | null>(null);
  const [localAi, setLocalAi] = useState<LocalAiStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, ConnectorDraft>>({});
  const openerRef = useRef<HTMLElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const appliedFocus = useRef<string | null>(null);
  const snackId = useRef(0);
  const prevTones = useRef<Record<string, string>>({});

  useEffect(() => { if (focusId && ROLE_FOCUS[focusId]) setRole(ROLE_FOCUS[focusId]); }, [focusId]);

  // A search result for a drawer section (keys, models, test, built-in AI, own Ollama) has no row
  // until a connector that holds it is open, so open one once the connectors are known.
  const loadedConnectors = state?.connectors;
  useEffect(() => {
    if (!focusId) { appliedFocus.current = null; return; }
    if (appliedFocus.current === focusId || !loadedConnectors) return;
    appliedFocus.current = focusId;
    const id = connectorForFocus(focusId, loadedConnectors, role);
    if (id) setOpenId(id);
  }, [focusId, loadedConnectors, role]);

  // Plaintext Azure and Anthropic keys left by older versions move into main before the page shows what is saved.
  useEffect(() => { void ensureLegacyAiKeysMigrated().then(() => refresh()).catch(() => {}); }, [refresh]);

  useEffect(() => {
    const api = window.localAi;
    if (!api) return;
    let live = true;
    api.status().then((s) => { if (live) setLocalAi(s); }).catch(() => {});
    const off = api.onStatusChanged?.((s) => { if (live) setLocalAi(s); });
    return () => { live = false; off?.(); };
  }, []);

  const showSnack = useCallback((s: Omit<Snack, 'id'>) => setSnack({ ...s, id: ++snackId.current }), []);
  useEffect(() => {
    if (!snack) return;
    const t = setTimeout(() => setSnack((cur) => (cur?.id === snack.id ? null : cur)), 12000);
    return () => clearTimeout(t);
  }, [snack]);

  /** Open a connector's drawer for the keyboard too: remember the opener, then move focus into the drawer. */
  const openDrawer = useCallback((id: string) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !active.closest('.drawer')) openerRef.current = active;
    setOpenId(id);
    setPicker(false);
    setTimeout(() => document.querySelector<HTMLElement>('.drawer[tabindex]')?.focus(), 0);
  }, []);

  /** Close the drawer and give focus back to what opened it. */
  const closeDrawer = useCallback(() => {
    const opener = openerRef.current;
    openerRef.current = null;
    setOpenId(null);
    setTimeout(() => { if (opener?.isConnected) opener.focus(); }, 0);
  }, []);

  const closePicker = useCallback(() => {
    setPicker(false);
    setTimeout(() => addButtonRef.current?.focus(), 0);
  }, []);
  useEffect(() => {
    if (picker) setTimeout(() => document.querySelector<HTMLElement>('[role="listbox"][aria-label="Available connectors"] [role="option"]')?.focus(), 0);
  }, [picker]);

  const setDraft = useCallback((id: string, patch: ConnectorDraft) => {
    setFieldDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? {}), ...patch } }));
  }, []);
  /** Forget a connector's unsaved edits. `keepKey` leaves a pasted key (saving fields does not save it). */
  const clearDraft = useCallback((id: string, keepKey = false) => {
    setFieldDrafts((d) => {
      const cur = d[id];
      if (!cur) return d;
      const { [id]: _gone, ...rest } = d;
      return keepKey && cur.keyDraft ? { ...rest, [id]: { keyDraft: cur.keyDraft } } : rest;
    });
  }, []);

  const builtinDown = !!localAi && localAi.backend === 'builtin' && !localAi.runtime.available;
  const all = useMemo<AiConnector[]>(() => {
    const real = state?.connectors ?? [];
    return [...real, ...drafts.filter((d) => !real.some((c) => c.id === d.id))];
  }, [state, drafts]);

  const setPref = useCallback((id: string, r: AiRole, next: ModelPrefs) => {
    setPrefs((cur) => {
      const merged = { ...cur, [id]: { ...(cur[id] ?? {}), [r]: next } };
      saveModelPrefs(merged);
      return merged;
    });
  }, []);

  const items = useMemo<GraphItem[]>(() => all.filter((c) => c.serves.includes(role)).map((connector) => ({
    connector,
    display: describeNode(connector, role, { testing: !!testing[connector.id], builtinDown: connector.kind === 'builtin' && builtinDown }),
    models: modelList(connector, role, state?.routes[role], prefs[connector.id]?.[role]),
  })), [all, role, testing, builtinDown, state, prefs]);
  const hiddenCount = all.length - items.length;
  const counts = countStates(items);
  const live = items.find((i) => i.display.routed);

  // "Scheduled re-check finds a fault": an armed or live connector that turns faulty on its own.
  useEffect(() => {
    if (!state) return;
    const next: Record<string, string> = {};
    for (const c of state.connectors) {
      const d = describeNode(c, role);
      next[c.id] = d.tone;
      if (d.tone === 'fault' && (prevTones.current[c.id] === 'armed' || prevTones.current[c.id] === 'live') && !testing[c.id]) {
        showSnack({ text: `${c.name} stopped answering at the re-check.`, chip: { tone: 'fault', label: 'Fault' }, actions: [{ label: 'Open', run: () => { openDrawer(c.id); setSnack(null); } }] });
      }
    }
    prevTones.current = next;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // The drawer shows the routed connector for the role until one is picked.
  const effectiveOpen = openId === undefined ? (live?.connector.id ?? null) : openId;
  const open = effectiveOpen ? all.find((c) => c.id === effectiveOpen) ?? null : null;
  const openItem = open ? items.find((i) => i.connector.id === open.id) : undefined;
  const openDisplay: NodeDisplay | null = open ? (openItem?.display ?? describeNode(open, role, { testing: !!testing[open.id] })) : null;
  const openModels = open ? (openItem?.models ?? modelList(open, role, state?.routes[role], prefs[open.id]?.[role])) : null;

  // ── Actions ───────────────────────────────────────────────────────────────────────────────────

  const runTest = useCallback(async (c: AiConnector, model?: string): Promise<boolean> => {
    const api = window.aiRouter;
    if (!api) return false;
    setTesting((t) => ({ ...t, [c.id]: true }));
    try {
      const res = await api.test({ connectorId: c.id, role, ...(model ? { model } : {}) });
      await refresh();
      return res.success && res.test.ok;
    } catch {
      return false;
    } finally {
      setTesting((t) => ({ ...t, [c.id]: false }));
    }
  }, [role, refresh]);

  const route = useCallback(async (c: AiConnector, modelOverride?: string) => {
    const api = window.aiRouter;
    if (!api) return;
    setNotice(null);
    const list = modelList(c, role, state?.routes[role], prefs[c.id]?.[role]);
    const req = routeRequest(c, role, list);
    if (modelOverride !== undefined) req.model = modelOverride;
    if (c.kind !== 'builtin' && !testFor(c, role)?.ok) {
      // A connector is only routed after a test passes: pressing "Route here" runs it first.
      const ok = await runTest(c, req.model || undefined);
      if (!ok) { setNotice(`${c.name} did not pass its test, so it was not routed. Open its settings to see why.`); openDrawer(c.id); return; }
    }
    try {
      const res = await api.setRoute(req);
      if (!res.success) setNotice(res.error);
      else if (c.kind !== 'builtin' && window.settings?.setPreferredChatProvider && role === 'chat') {
        // The chat toolbar still reads the old provider choice: keep it pointing at this route.
        const legacy = c.kind === 'gemini' || c.kind === 'azure-openai' || c.kind === 'anthropic' ? c.kind : 'ollama';
        void window.settings.setPreferredChatProvider(legacy).catch(() => {});
        try { localStorage.setItem('ark-preferred-chat-provider', legacy); } catch { /* storage unavailable */ }
      } else if (c.kind === 'builtin' && role === 'chat') {
        void window.settings?.setPreferredChatProvider?.('ollama').catch(() => {});
        try { localStorage.setItem('ark-preferred-chat-provider', 'ollama'); } catch { /* storage unavailable */ }
      }
    } catch {
      setNotice('Could not change the route.');
    }
    await refresh();
  }, [role, state, prefs, runTest, refresh, openDrawer]);

  const saveFields = useCallback(async (input: Partial<AiConnector> & { kind: ConnectorKind }): Promise<string | null> => {
    const api = window.aiRouter;
    if (!api) return 'The AI router is not available.';
    try {
      const res = await api.saveConnector(input);
      if (!res.success) return res.error;
      if (input.kind === 'azure-openai') {
        // The old chat code still reads these from the browser.
        try {
          localStorage.setItem('ark-azure-endpoint', input.endpoint ?? '');
          localStorage.setItem('ark-azure-deployment', input.deployment ?? '');
          localStorage.setItem('ark-azure-api-version', input.apiVersion ?? '');
        } catch { /* storage unavailable */ }
      }
      setDrafts((d) => d.filter((x) => x.id !== input.id));
      if (input.id) clearDraft(input.id, true);
      await refresh();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Could not save.';
    }
  }, [refresh, clearDraft]);

  const toggleEnabled = useCallback(async (c: AiConnector, on: boolean) => {
    const wasRouted = ROLES.filter((r) => c.routedFor.includes(r)).map((r) => ({ role: r, model: state!.routes[r].model }));
    const err = await saveFields(fieldsOf(c, { enabled: on }));
    if (err) { setNotice(err); return; }
    if (!on && wasRouted.length > 0) {
      const first = wasRouted[0]!.role;
      const alt = (state?.connectors ?? []).find((o) => o.id !== c.id && o.kind !== 'builtin' && o.enabled !== false && testFor(o, first)?.ok && o.serves.includes(first));
      showSnack({
        text: `${c.name} is off. ${wasRouted.map((w) => ROLE_LABEL[w.role]).join(' and ')} ${wasRouted.length > 1 ? 'have' : 'has'} no route.`,
        actions: [
          { label: 'Undo', run: () => { void (async () => { await saveFields(fieldsOf(c, { enabled: true })); for (const w of wasRouted) await window.aiRouter?.setRoute({ role: w.role, connectorId: c.id, model: w.model }); await refresh(); setSnack(null); })(); } },
          ...(alt ? [{ label: `Route ${alt.name}`, primary: true, run: () => { void route(alt); setSnack(null); } }] : []),
        ],
      });
    }
  }, [state, saveFields, showSnack, refresh, route]);

  const changePolicy = useCallback(async (patch: Parameters<NonNullable<typeof window.aiRouter>['setPolicy']>[0]) => {
    try { await window.aiRouter?.setPolicy(patch); await refresh(); } catch { setNotice('Could not save that setting.'); }
  }, [refresh]);

  const testAll = useCallback(async () => {
    const api = window.aiRouter;
    if (!api) return;
    setShowResults(true);
    const ids = items.filter((i) => i.connector.kind !== 'builtin' && i.connector.enabled !== false).map((i) => i.connector.id);
    // Merge into the map: a single test already running keeps its spinner, and finishing leaves it alone.
    setTesting((t) => markTesting(t, ids, true));
    try { await api.testAll(); await refresh(); } catch { setNotice('Could not run the tests.'); }
    setTesting((t) => markTesting(t, ids, false));
  }, [items, refresh]);

  const addFromCatalog = useCallback(async (item: CatalogItem) => {
    setPicker(false);
    if (item.connectorKind === 'azure-openai') {
      const draft: AiConnector = { id: 'azure-openai', kind: 'azure-openai', name: 'Azure OpenAI', hasKey: false, needsKey: true, state: 'nokey', routedFor: [], serves: ['chat', 'embeddings'] };
      setDrafts((d) => (d.some((x) => x.id === draft.id) ? d : [...d, draft]));
      openDrawer(draft.id);
      return;
    }
    const before = new Set((state?.connectors ?? []).map((c) => c.id));
    const err = await saveFields({
      kind: item.connectorKind, name: item.id === 'compat' ? 'OpenAI-compatible server' : item.name,
      ...(item.baseUrl ? { baseUrl: item.baseUrl } : {}), ...(item.roles ? { roles: item.roles } : {}),
      ...(item.connectorKind !== 'openai-compatible' ? { id: item.connectorKind } : {}),
    });
    if (err) { setNotice(err); return; }
    const s = await refresh();
    const added = s?.connectors.find((c) => !before.has(c.id)) ?? s?.connectors.find((c) => c.kind === item.connectorKind);
    if (added) {
      openDrawer(added.id);
      // Add what the provider offers for the viewed role, when it offers it.
      if (!added.serves.includes(role)) setRole(added.serves[0] ?? role);
    }
  }, [state, saveFields, refresh, role, openDrawer]);

  const fetchModels = useCallback(async (c: AiConnector) => {
    const api = window.aiRouter;
    if (!api) return;
    setFetching((f) => ({ ...f, [c.id]: true }));
    setFetchError((f) => ({ ...f, [c.id]: null }));
    try {
      const res = await api.fetchModels(c.id);
      if (!res.success) setFetchError((f) => ({ ...f, [c.id]: res.error }));
      else {
        const cur = prefs[c.id]?.[role] ?? { added: [], off: [] };
        setPref(c.id, role, { ...cur, added: [...new Set([...cur.added, ...res.models])] });
      }
    } catch {
      setFetchError((f) => ({ ...f, [c.id]: 'Could not reach the server.' }));
    }
    setFetching((f) => ({ ...f, [c.id]: false }));
  }, [prefs, role, setPref]);

  const removeConnector = useCallback(async (c: AiConnector) => {
    setConfirmRemove(null);
    const res = await window.aiRouter?.removeConnector(c.id).catch(() => ({ success: false as const, error: 'Could not remove it.' }));
    if (res && !res.success) setNotice(res.error);
    setOpenId(undefined);
    setDrafts((d) => d.filter((x) => x.id !== c.id));
    clearDraft(c.id);
    await refresh();
  }, [refresh, clearDraft]);

  // ── First run and faults ──────────────────────────────────────────────────────────────────────

  const autoModels = localAi?.models.filter((m) => m.auto) ?? [];
  const downloading = autoModels.some((m) => m.state === 'downloading' || m.state === 'queued' || m.state === 'verifying');
  const builtinReady = !!localAi && localAi.runtime.available && autoModels.length > 0 && autoModels.every((m) => m.state === 'ready');
  const othersArmed = (state?.connectors ?? []).some((c) => c.kind !== 'builtin' && c.enabled !== false && c.test?.ok);
  const firstRun = !!localAi && localAi.backend === 'builtin' && !builtinReady && !downloading && !othersArmed;
  const routerFault = state?.status.fault ?? null;
  const sidecarFailed = state?.status.sidecar.state === 'failed';

  const roleTabs = ROLES.map((r) => ({ role: r, name: routeName(state, r) }));
  const embedChanged = state?.rebuild && !embedDismissed ? state.rebuild.to : null;
  const results = items.filter((i) => i.connector.enabled !== false && i.connector.kind !== 'builtin');
  const okCount = results.filter((i) => testFor(i.connector, role)?.ok).length;
  const catalog = availableCatalog(state?.connectors ?? []);

  if (unavailable && !state) {
    return (
      <>
        <PageHeader title="AI providers" lede="The AI router is available in the desktop app." />
      </>
    );
  }

  return (
    <>
      <PageHeader title="AI providers" lede="Bring your own keys, or point Ark at any OpenAI-compatible server. Chat, embeddings and reranking each get their own route.">
        <div className="inline" style={{ position: 'relative' }}>
          <button type="button" className="btn" onClick={() => void testAll()} disabled={Object.values(testing).some(Boolean)}>
            {Object.values(testing).some(Boolean) && <Spinner />}Test all
          </button>
          <button ref={addButtonRef} type="button" className="btn p" onClick={() => setPicker(!picker)} aria-expanded={picker} aria-haspopup="listbox"><Icon d={ICON.plus} />Add connector</button>
          {picker && (
            <div
              className="panel fade" role="listbox" aria-label="Available connectors"
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closePicker(); } }}
              style={{ position: 'absolute', right: 0, top: 40, width: 300, zIndex: 20, background: 'var(--color-paper-4)' }}>
              <div style={{ padding: 'var(--space-3)' }}><p className="t">Add a connector</p><p className="d">Any OpenAI-compatible server, or one of these providers.</p></div>
              {catalog.map((k) => (
                <button key={k.id} type="button" className="pk" role="option" aria-selected="false" onClick={() => void addFromCatalog(k)}>
                  <span className="mono" data-tone="off">{k.mono}</span><span className="grow">{k.name}</span><span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-ink-3)' }}>{k.kind}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </PageHeader>

      <div className="tray" role="tablist" aria-label="Route" style={{ alignSelf: 'flex-start' }}>
        {roleTabs.map((t) => (
          <button key={t.role} type="button" role="tab" aria-selected={t.role === role} data-setting-id={`route-${t.role}`} onClick={() => {
            // Keep the open connector when it also serves the new role, so edits made there stay in view.
            const keep = effectiveOpen && all.find((c) => c.id === effectiveOpen)?.serves.includes(t.role) ? effectiveOpen : undefined;
            setRole(t.role); setHot(null); setOpenId(keep);
          }}>
            {ROLE_LABEL[t.role]} <em>{t.name}</em>
          </button>
        ))}
      </div>

      {notice && (
        <div className="alert fade" role="alert" data-tone="fault"><div style={{ flex: 1 }}>{notice}</div><button type="button" className="btn q" onClick={() => setNotice(null)} style={{ height: 28 }}>Dismiss</button></div>
      )}

      <div className="routerlayout">
        <div className="main-col">
          <RouterGraph
            role={role} items={items} hiddenCount={hiddenCount} routeText={routeId(state, role)} counts={counts}
            openId={open?.id ?? null} hotId={hot} onHot={setHot}
            onOpen={openDrawer}
            onRoute={(id) => { const c = all.find((x) => x.id === id); if (c) void route(c); }}
            onToggle={(id, on) => { const c = all.find((x) => x.id === id); if (c) void toggleEnabled(c, on); }}
          />

          {firstRun && (
            <section className="panel" data-tone="nokey" style={{ padding: 'var(--space-4)' }}>
              <p className="t">No AI connected yet</p>
              <p className="d" style={{ fontSize: 'var(--text-sm)' }}>
                The built-in AI isn&apos;t ready{localAi?.runtime.available ? ' (its models are not downloaded yet)' : ' (its runtime was not found in this install)'} and no cloud keys are saved. Library tracking still works; AI Chat and Oracle reasons stay off until a connector is armed.
              </p>
              <div className="inline" style={{ flexWrap: 'wrap', marginTop: 'var(--space-3)' }}>
                <button type="button" className="btn p" onClick={() => { void window.localAi?.recheck().then(setLocalAi).catch(() => {}); }}>Check the built-in AI</button>
                <button type="button" className="btn" onClick={() => setPicker(true)}>Add a cloud key</button>
              </div>
            </section>
          )}

          {(routerFault || sidecarFailed) && (
            <div className="alert fade" role="alert" data-tone="fault">
              <div style={{ flex: 1 }}>
                <strong>The AI router had a problem.</strong>{' '}
                {routerFault ? `${ROLE_LABEL[routerFault.role]}: ${routerFault.message}` : state?.status.sidecar.lastError ?? 'It is not running.'}
                {' '}Embeddings and reranking keep working through the built-in AI; chat shows this error until the router is back.
              </div>
              <button type="button" className="btn" style={{ height: 28 }} onClick={() => { void window.aiRouter?.recheckRuntime().then(() => refresh()); }}>Re-check</button>
            </div>
          )}

          {embedChanged && (
            <div className="alert fade" role="status" data-tone="nokey">
              <div style={{ flex: 1 }}><strong>Embedding model changed to {embedChanged}.</strong> Similar games and the galaxy map need a full rebuild before they match again. Ark keeps the old vectors until the rebuild finishes.</div>
              <button type="button" className="btn" style={{ height: 28 }} onClick={() => onNavigate('understanding', 'u-rebuild-all')}>Rebuild</button>
              <button type="button" className="btn q" style={{ height: 28 }} onClick={() => setEmbedDismissed(true)}>Later</button>
            </div>
          )}

          <Panel id="routing" title="Routing">
            <div className="sect" data-setting-id="routing-policy">
              <div className="row" style={{ flexWrap: 'wrap', padding: 0, minHeight: 0, border: 0 }}>
                <div className="grow"><p className="t">When a route fails</p><p className="d">What Ark does if the routed provider errors or times out.</p></div>
                {state && (
                  <Seg
                    label="When a route fails" value={state.policy.onFail} onChange={(v) => void changePolicy({ onFail: v })}
                    options={[{ value: 'show-error', label: 'Show error' }, { value: 'retry-once', label: 'Retry once' }, { value: 'use-fallback', label: 'Use built-in AI' }]}
                  />
                )}
              </div>
            </div>
            {showResults && (
              <div className="fade" style={{ borderTop: '1px solid var(--color-rule)' }}>
                <div className="row" style={{ padding: 'var(--space-3) var(--space-4)' }}>
                  <p className="t">Connection check · {ROLE_LABEL[role]}</p>
                  <span aria-live="polite" className="d" style={{ margin: 0 }}>{Object.values(testing).some(Boolean) ? `Testing ${results.length} connectors…` : `${okCount} of ${results.length} connected`}</span>
                </div>
                <div style={{ overflowX: 'auto' }}><table className="tbl">
                  <thead><tr><th scope="col">Connector</th><th scope="col">Result</th><th scope="col">Latency</th><th scope="col">Model tested</th></tr></thead>
                  <tbody>
                    {results.map((i) => {
                      const t = testFor(i.connector, role);
                      const d = t ? describeTest(t) : null;
                      const busy = testing[i.connector.id];
                      return (
                        <tr key={i.connector.id}>
                          <td style={{ color: 'var(--color-ink)' }}>{i.connector.name}</td>
                          <td><Chip tone={busy ? 'off' : !d ? 'off' : d.tone === 'live' ? 'live' : d.tone === 'nokey' ? 'nokey' : 'fault'}>{busy ? 'Testing…' : d ? (d.tone === 'live' ? 'Connected' : d.text) : 'Not run'}</Chip></td>
                          <td>{t?.ok ? `${t.latencyMs} ms` : '—'}</td>
                          <td>{t?.model ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table></div>
              </div>
            )}
          </Panel>
        </div>

        {open && openDisplay && openModels ? (
          <ConnectorDrawer
            key={open.id}
            connector={open} isDraft={drafts.some((d) => d.id === open.id) && !(state?.connectors ?? []).some((c) => c.id === open.id)}
            role={role} display={openDisplay} models={openModels} prefs={prefs[open.id]?.[role]}
            policy={state!.policy} testing={!!testing[open.id]} testWith={testWith} onTestWith={setTestWith}
            onClose={closeDrawer}
            draft={fieldDrafts[open.id]} onDraft={(patch) => setDraft(open.id, patch)} onDiscardDraft={() => clearDraft(open.id)}
            onToggleEnabled={(on) => void toggleEnabled(open, on)}
            onRoute={() => (openDisplay.opensDrawer ? undefined : void route(open))}
            onTest={(model) => void runTest(open, model)}
            onPrefs={(next) => {
              setPref(open.id, role, next);
              // Changing the default of a routed connector re-routes it to that model at once.
              if (next.def && next.def !== prefs[open.id]?.[role]?.def && open.routedFor.includes(role) && open.kind !== 'builtin' && open.kind !== 'azure-openai') {
                void route(open, next.def);
              }
            }}
            onPolicy={(patch) => void changePolicy(patch)}
            onSaveFields={saveFields}
            onRemove={() => setConfirmRemove(open)}
            onKeyChanged={(note) => {
              const id = open.id;
              // Stamp the note with the test the connector has once the key change has landed.
              void refresh().then((s) => setKeyNotes((n) => ({ ...n, [id]: note ? { ...note, at: s?.connectors.find((c) => c.id === id)?.test?.at ?? null } : null })));
            }}
            keyNote={keyNotes[open.id] && keyNotes[open.id]!.at === (open.test?.at ?? null) ? keyNotes[open.id]! : null}
            onKeyNoteClear={() => setKeyNotes((n) => (n[open.id] ? { ...n, [open.id]: null } : n))}
            fetchedBusy={!!fetching[open.id]} onFetchModels={() => void fetchModels(open)} fetchError={fetchError[open.id] ?? null}
            ensureSaved={async () => (drafts.some((d) => d.id === open.id) ? 'Add the connector first.' : null)}
          />
        ) : (
          <aside className="panel drawer" aria-labelledby="drawer-title">
            <div style={{ padding: 'var(--space-6) var(--space-4)' }}>
              <h2 id="drawer-title" className="t">No connector selected</h2>
              <p className="d">Open a connector&apos;s settings to manage its key, models and connection test.</p>
            </div>
          </aside>
        )}
      </div>

      {snack && (
        <div className="toast" role="status" key={snack.id} style={{ position: 'fixed', bottom: 'var(--space-6)', right: 'var(--space-6)' }}>
          {snack.chip && <Chip tone={snack.chip.tone}>{snack.chip.label}</Chip>}
          <span>{snack.text}</span>
          {snack.actions.map((a) => <button key={a.label} type="button" className={a.primary ? 'btn' : 'btn q'} onClick={a.run}>{a.label}</button>)}
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove !== null}
        onOpenChange={(o) => { if (!o) setConfirmRemove(null); }}
        title={`Remove ${confirmRemove?.name ?? 'this connector'}?`}
        description="Its settings and saved key are erased from this PC and any route that used it goes back to the built-in AI."
        confirmText="Remove connector"
        cancelText="Keep it"
        variant="danger"
        onConfirm={() => { if (confirmRemove) void removeConnector(confirmRemove); }}
      />
    </>
  );
});

