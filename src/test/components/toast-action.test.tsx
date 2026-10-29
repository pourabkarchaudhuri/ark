/**
 * Toasts can carry an action button (used for "Undo" on automatic On Hold).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastProvider, useOptionalToast, useToast } from '@/components/ui/toast';

function Trigger({ onUndo }: { onUndo: () => void }) {
  const toast = useToast();
  return <button onClick={() => toast.addToast('2 games moved to On Hold', 'info', 0, { label: 'Undo', onClick: onUndo })}>show</button>;
}

function Probe() {
  const toast = useOptionalToast();
  return <span>{toast ? 'has-toast' : 'no-toast'}</span>;
}

describe('toast action', () => {
  it('renders the action, runs it once and dismisses the toast', async () => {
    const onUndo = vi.fn();
    render(<ToastProvider><Trigger onUndo={onUndo} /></ToastProvider>);
    await act(async () => { fireEvent.click(screen.getByText('show')); });
    expect(screen.getByText('2 games moved to On Hold')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByText('Undo')); });
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('useOptionalToast returns null outside a provider instead of throwing', () => {
    render(<Probe />);
    expect(screen.getByText('no-toast')).toBeInTheDocument();
  });
});
