/**
 * The Ollama/embedding settings behind Game understanding and the "use my own Ollama" section,
 * loaded from main and saved back after an 800 ms pause (1.0.97 B37; the logic of the old AI Models tab).
 *
 *  - an address still being typed ("localhost:11434") is left out of the save, so toggles still save;
 *  - a change made just before leaving the page is flushed on unmount instead of being lost;
 *  - a save main rejects shows its reason instead of staying on "Saving".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { embeddingService } from '@/services/embedding-service';
import { DEFAULT_OLLAMA_RERANK_MODEL } from '@/services/ollama-rerank';
import type { OllamaSettingsPatch } from '@/components/settings/ollama-settings-types';

export interface OllamaValues {
  url: string;
  model: string;
  rerankModel: string;
  neighborRerankEnabled: boolean;
  oracleRerankEnabled: boolean;
  oracleRerankBlend: number;
  embeddingChunkingEnabled: boolean;
  chunkAnnMaxSimEnabled: boolean;
  embeddingMrl256Enabled: boolean;
  /** 0 = Auto. */
  embeddingBatchSize: number;
}

export const DEFAULT_OLLAMA_VALUES: OllamaValues = {
  url: 'http://localhost:11434',
  model: 'gemma3:12b',
  rerankModel: DEFAULT_OLLAMA_RERANK_MODEL,
  neighborRerankEnabled: true,
  oracleRerankEnabled: true,
  oracleRerankBlend: 0.6,
  embeddingChunkingEnabled: true,
  chunkAnnMaxSimEnabled: true,
  embeddingMrl256Enabled: false,
  embeddingBatchSize: 0,
};

export type OllamaSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** True for an absolute http(s) address, which is what main accepts as the Ollama URL. */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function useOllamaSettings() {
  const [values, setValues] = useState<OllamaValues>(DEFAULT_OLLAMA_VALUES);
  const [status, setStatus] = useState<OllamaSaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);
  /** Nothing is written until the user changes something: opening a page must not save. */
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Latest scheduled payload, flushed if the page unmounts before the timer fires. */
  const pending = useRef<OllamaSettingsPatch | null>(null);
  /** Counts scheduled saves: a save that finishes after a newer edit was scheduled must not report on it. */
  const saveGen = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      if (!window.settings) { loaded.current = true; return; }
      try {
        const s = await window.settings.getOllamaSettings();
        if (!live) return;
        setValues({
          url: s.url,
          model: s.model,
          rerankModel: s.rerankModel ?? DEFAULT_OLLAMA_RERANK_MODEL,
          neighborRerankEnabled: s.neighborRerankEnabled !== false,
          oracleRerankEnabled: s.oracleRerankEnabled !== false,
          oracleRerankBlend: typeof s.oracleRerankBlend === 'number' && Number.isFinite(s.oracleRerankBlend) ? Math.min(1, Math.max(0, s.oracleRerankBlend)) : 0.6,
          embeddingChunkingEnabled: s.embeddingChunkingEnabled !== false,
          chunkAnnMaxSimEnabled: s.chunkAnnMaxSimEnabled !== false,
          embeddingMrl256Enabled: s.embeddingMrl256Enabled === true,
          embeddingBatchSize: typeof s.embeddingBatchSize === 'number' && Number.isFinite(s.embeddingBatchSize) && s.embeddingBatchSize > 0 ? s.embeddingBatchSize : 0,
        });
      } catch { /* defaults stay */ }
      loaded.current = true;
    };
    void load();
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      // Leaving inside the debounce window: still save the latest change (no setState here).
      const p = pending.current;
      pending.current = null;
      if (p && window.settings) {
        window.settings.setOllamaSettings(p).then(() => embeddingService.clearUnavailableVerdict()).catch(() => {});
      }
    };
  }, []);

  const urlValid = !values.url.trim() || isHttpUrl(values.url);

  useEffect(() => {
    if (!loaded.current || !dirty.current || !window.settings) return;
    if (timer.current) clearTimeout(timer.current);
    const payload: OllamaSettingsPatch = {
      ...(urlValid ? { url: values.url } : {}),
      model: values.model,
      rerankModel: values.rerankModel,
      neighborRerankEnabled: values.neighborRerankEnabled,
      oracleRerankEnabled: values.oracleRerankEnabled,
      oracleRerankBlend: values.oracleRerankBlend,
      embeddingChunkingEnabled: values.embeddingChunkingEnabled,
      chunkAnnMaxSimEnabled: values.chunkAnnMaxSimEnabled,
      embeddingMrl256Enabled: values.embeddingMrl256Enabled,
      embeddingBatchSize: values.embeddingBatchSize,
    };
    pending.current = payload;
    const gen = ++saveGen.current;
    if (idleTimer.current) { clearTimeout(idleTimer.current); idleTimer.current = null; }
    setStatus('saving');
    setError(null);
    timer.current = setTimeout(async () => {
      timer.current = null;
      pending.current = null;
      try {
        await window.settings!.setOllamaSettings(payload);
        // A new URL or model may make Ollama reachable: drop any cached "unavailable" verdict now.
        embeddingService.clearUnavailableVerdict();
        // A newer edit is already waiting (or saving): it will report its own result.
        if (gen !== saveGen.current) return;
        setStatus('saved');
        idleTimer.current = setTimeout(() => { idleTimer.current = null; setStatus((s) => (s === 'saved' ? 'idle' : s)); }, 2000);
      } catch (err) {
        if (gen !== saveGen.current) return;
        setStatus('error');
        const detail = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '';
        setError(detail ? `Could not save: ${detail}` : 'Could not save these settings.');
      }
    }, 800);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [values, urlValid]);

  const set = useCallback((patch: Partial<OllamaValues>) => {
    dirty.current = true;
    setValues((v) => ({ ...v, ...patch }));
  }, []);
  return { values, set, status, error, urlValid };
}
