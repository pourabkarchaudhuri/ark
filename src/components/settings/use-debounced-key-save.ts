/**
 * Debounced save for a cloud API key field in Settings → AI Models (v1.0.97).
 *
 * The field is bound to an empty draft, never to the stored key (there is no getter for
 * it), so a masked display value can never be typed over and saved as the real key.
 * Only a non-empty trimmed draft is saved. A save that main rejects ({ success: false })
 * shows its error. If Settings unmounts inside the debounce window, the pending key is
 * still saved (fire-and-forget, no state updates), and only the full latest draft,
 * never a partial one.
 */

import { useEffect, useRef, useState } from 'react';

export type KeySaveStatus = 'idle' | 'saving' | 'saved' | 'error';
export type KeySaveFn = (key: string) => Promise<{ success: boolean; error?: string } | undefined | void>;

export const KEY_SAVE_DEBOUNCE_MS = 800;

export function useDebouncedKeySave(save: KeySaveFn | undefined, onSaved?: () => void) {
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<KeySaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Latest scheduled key; null once its save has started. */
  const pendingRef = useRef<string | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // Unmount: flush a key that is still waiting for its timer.
  useEffect(() => () => {
    const key = pendingRef.current;
    pendingRef.current = null;
    if (key && saveRef.current) Promise.resolve(saveRef.current(key)).catch(() => {});
  }, []);

  useEffect(() => {
    const key = draft.trim();
    if (!key) {
      pendingRef.current = null;
      setStatus((s) => (s === 'saving' ? 'idle' : s));
      return;
    }
    pendingRef.current = key;
    setStatus('saving');
    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      pendingRef.current = null;
      const fn = saveRef.current;
      if (!fn) return;
      try {
        const result = await fn(key);
        if (result && result.success === false) {
          setStatus('error');
          setError(result.error || 'Failed to save the key');
          return;
        }
        setStatus('saved');
        setError(null);
        setDraft('');
        onSavedRef.current?.();
        setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
      } catch {
        setStatus('error');
        setError('Failed to save the key');
      }
    }, KEY_SAVE_DEBOUNCE_MS);
    // Per-change cleanup only stops the timer; the unmount effect above flushes.
    return () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };
  }, [draft]);

  return { draft, setDraft, status, error, setError, setStatus };
}
