/**
 * useDebouncedKeySave (v1.0.97): the key field is a new-key draft, only full trimmed
 * drafts are saved, main's {success:false} shows an error, and a key still waiting
 * for its timer is saved when Settings unmounts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedKeySave, KEY_SAVE_DEBOUNCE_MS } from '@/components/settings/use-debounced-key-save';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('useDebouncedKeySave', () => {
  it('saves only the final trimmed draft after the debounce', async () => {
    const save = vi.fn(async () => ({ success: true }));
    const onSaved = vi.fn();
    const { result } = renderHook(() => useDebouncedKeySave(save, onSaved));
    act(() => result.current.setDraft('AIza'));
    act(() => result.current.setDraft(' AIzaSyFULL '));
    expect(result.current.status).toBe('saving');
    await act(async () => { await vi.advanceTimersByTimeAsync(KEY_SAVE_DEBOUNCE_MS); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('AIzaSyFULL');
    expect(result.current.status).toBe('saved');
    expect(result.current.draft).toBe('');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('never saves an empty draft', async () => {
    const save = vi.fn(async () => ({ success: true }));
    const { result } = renderHook(() => useDebouncedKeySave(save));
    act(() => result.current.setDraft('x'));
    act(() => result.current.setDraft('   '));
    await act(async () => { await vi.advanceTimersByTimeAsync(KEY_SAVE_DEBOUNCE_MS * 2); });
    expect(save).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('shows the error when main rejects the key', async () => {
    const save = vi.fn(async () => ({ success: false, error: 'That does not look like an API key.' }));
    const onSaved = vi.fn();
    const { result } = renderHook(() => useDebouncedKeySave(save, onSaved));
    act(() => result.current.setDraft('bad key'));
    await act(async () => { await vi.advanceTimersByTimeAsync(KEY_SAVE_DEBOUNCE_MS); });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('That does not look like an API key.');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('flushes the full pending key on unmount, once', async () => {
    const save = vi.fn(async () => ({ success: true }));
    const { result, unmount } = renderHook(() => useDebouncedKeySave(save));
    act(() => result.current.setDraft('sk-ant-p'));
    act(() => result.current.setDraft('sk-ant-partial-then-full'));
    unmount();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('sk-ant-partial-then-full');
    await vi.advanceTimersByTimeAsync(KEY_SAVE_DEBOUNCE_MS * 2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not re-save on unmount after the timer already saved', async () => {
    const save = vi.fn(async () => ({ success: true }));
    const { result, unmount } = renderHook(() => useDebouncedKeySave(save));
    act(() => result.current.setDraft('k1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(KEY_SAVE_DEBOUNCE_MS); });
    unmount();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
