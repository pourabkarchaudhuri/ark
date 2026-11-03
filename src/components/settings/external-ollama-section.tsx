/**
 * "Use my own Ollama" (1.0.97 B36, moved into the built-in connector's Advanced in B37). Off by
 * default: Ark uses its built-in AI and never touches Ollama or its models folder. Turned on, Ark
 * talks to the Ollama at the address below for embeddings, reranking and local chat.
 */
import { useCallback, useEffect, useState } from 'react';
import { embeddingService } from '@/services/embedding-service';
import { DEFAULT_OLLAMA_RERANK_MODEL } from '@/services/ollama-rerank';
import { isHttpUrl, useOllamaSettings } from '@/components/settings/use-ollama-settings';
import { Icon, ICON, Spinner, Switch } from '@/components/settings/ui';

type RerankProbe = { state: 'idle' | 'testing' | 'ok' | 'fail'; ollamaUp?: boolean; modelInstalled?: boolean; latencyMs?: number; error?: string };

export function ExternalOllamaSection() {
  // null until the built-in local AI reports (or when there is no desktop bridge): the fields stay visible then.
  const [external, setExternal] = useState<boolean | null>(null);
  const { values, set, status, error, urlValid } = useOllamaSettings();
  const [probe, setProbe] = useState<RerankProbe>({ state: 'idle' });

  useEffect(() => {
    const api = window.localAi;
    if (!api?.status) return;
    let live = true;
    api.status().then((s) => { if (live) setExternal(s.externalOllama.enabled); }).catch(() => {});
    const off = api.onStatusChanged?.((s) => { if (live) setExternal(s.externalOllama.enabled); });
    return () => { live = false; off?.(); };
  }, []);

  const toggle = useCallback(async (next: boolean) => {
    setExternal(next);
    try {
      const s = await window.localAi?.setExternalOllama({ enabled: next });
      if (s) setExternal(s.externalOllama.enabled);
      embeddingService.resetAvailability();
    } catch {
      setExternal(!next);
    }
  }, []);

  const testReranker = async () => {
    if (!window.ollama?.rerankDiagnostic) { setProbe({ state: 'fail', error: 'Diagnostic IPC not available. Restart the app.' }); return; }
    setProbe({ state: 'testing' });
    try {
      const r = await window.ollama.rerankDiagnostic();
      setProbe({ state: r.rerankWorking ? 'ok' : 'fail', ollamaUp: r.ollamaUp, modelInstalled: r.modelInstalled, latencyMs: r.latencyMs, error: r.error });
    } catch (e) {
      setProbe({ state: 'fail', error: e instanceof Error ? e.message : 'Probe threw an exception' });
    }
  };

  return (
    <div className="stack" style={{ gap: 'var(--space-3)' }} data-setting-id="own-ollama">
      <div className="row" style={{ padding: 0, minHeight: 0, border: 0 }}>
        <div>
          <p className="t">Use my own Ollama</p>
          <p className="d">Off by default: Ark uses its built-in AI and never touches Ollama or its models folder. Turn this on only if you want Ark to talk to an Ollama you already run.</p>
        </div>
        {external !== null && <Switch checked={external} onChange={(v) => void toggle(v)} label="Use my own Ollama" />}
      </div>
      {(external === null || external) && (
        <>
          <div>
            <label className="lb" htmlFor="own-ollama-url">Ollama address</label>
            <input id="own-ollama-url" className="in" type="text" value={values.url} onChange={(e) => set({ url: e.target.value })} placeholder="http://localhost:11434" aria-invalid={!urlValid} />
            {urlValid
              ? <p className="hint">Leave as is unless you run Ollama on another machine.</p>
              : <p className="hint" style={{ color: 'var(--color-fault)' }}>Enter a full address starting with http:// or https://, for example http://localhost:11434. Your other changes still save.</p>}
          </div>
          <div>
            <label className="lb" htmlFor="own-ollama-model">Chat model</label>
            <input id="own-ollama-model" className="in" type="text" value={values.model} onChange={(e) => set({ model: e.target.value })} placeholder="gemma3:12b" />
            <p className="hint">The AI that chats with you and explains picks. Enter the Ollama model name.</p>
          </div>
          <div>
            <label className="lb" htmlFor="own-ollama-rerank">Reranker model</label>
            <input id="own-ollama-rerank" className="in" type="text" value={values.rerankModel} onChange={(e) => set({ rerankModel: e.target.value })} placeholder={DEFAULT_OLLAMA_RERANK_MODEL} />
            <p className="hint">A small helper AI that puts the best matches first. Install it with <code>ollama pull {DEFAULT_OLLAMA_RERANK_MODEL}</code></p>
          </div>
          <div className="inline" style={{ flexWrap: 'wrap' }}>
            <button type="button" className="btn" disabled={probe.state === 'testing' || !window.ollama?.rerankDiagnostic} onClick={() => void testReranker()}>
              {probe.state === 'testing' ? <><Spinner />Testing…</> : 'Test reranker'}
            </button>
            {probe.state === 'ok' && <span className="chip" data-tone="live" role="status"><Icon d={ICON.check} size={12} />Reranker working{typeof probe.latencyMs === 'number' ? ` (${probe.latencyMs}ms)` : ''}</span>}
            {probe.state === 'fail' && (
              <span className="chip" data-tone="warn" role="status">
                {!probe.ollamaUp && probe.ollamaUp !== undefined ? 'Local AI not running' : probe.modelInstalled === false ? `Model not pulled: ${probe.error}` : probe.error || 'Probe failed'}
              </span>
            )}
          </div>
          <p className="d" role="status" style={{ margin: 0 }}>
            {status === 'saving' && 'Saving…'}
            {status === 'saved' && 'Saved'}
            {status === 'error' && <span style={{ color: 'var(--color-fault)' }}>{error}</span>}
            {status === 'idle' && 'Changes save automatically.'}
          </p>
        </>
      )}
    </div>
  );
}

export { isHttpUrl };
