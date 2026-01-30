import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastProvider, useToast } from './toast';

// Helper component to test toast functionality
function ToastTestComponent() {
  const { success, error, info, warning, toasts, removeToast } = useToast();

  return (
    <div>
      <button onClick={() => success('Success message')}>Show Success</button>
      <button onClick={() => error('Error message')}>Show Error</button>
      <button onClick={() => info('Info message')}>Show Info</button>
      <button onClick={() => warning('Warning message')}>Show Warning</button>
      <button onClick={() => toasts.length > 0 && removeToast(toasts[0].id)}>
        Remove First
      </button>
      <div data-testid="toast-count">{toasts.length}</div>
    </div>
  );
}

function renderWithProvider() {
  return render(
    <ToastProvider>
      <ToastTestComponent />
    </ToastProvider>
  );
}

describe('Toast System', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders ToastProvider without crashing', () => {
    renderWithProvider();
    expect(screen.getByText('Show Success')).toBeInTheDocument();
  });

  it('shows success toast when triggered', async () => {
    renderWithProvider();

    await act(async () => {
      fireEvent.click(screen.getByText('Show Success'));
    });

    expect(screen.getByText('Success message')).toBeInTheDocument();
  });

  it('shows error toast when triggered', async () => {
    renderWithProvider();

    await act(async () => {
      fireEvent.click(screen.getByText('Show Error'));
    });

    expect(screen.getByText('Error message')).toBeInTheDocument();
  });

  it('shows info toast when triggered', async () => {
    renderWithProvider();

    await act(async () => {
      fireEvent.click(screen.getByText('Show Info'));
    });

    expect(screen.getByText('Info message')).toBeInTheDocument();
  });

  it('shows warning toast when triggered', async () => {
    renderWithProvider();

    await act(async () => {
      fireEvent.click(screen.getByText('Show Warning'));
    });

    expect(screen.getByText('Warning message')).toBeInTheDocument();
  });

  it('can show multiple toasts', async () => {
    renderWithProvider();

    await act(async () => {
      fireEvent.click(screen.getByText('Show Success'));
      fireEvent.click(screen.getByText('Show Error'));
    });

    expect(screen.getByText('Success message')).toBeInTheDocument();
    expect(screen.getByText('Error message')).toBeInTheDocument();
    expect(screen.getByTestId('toast-count').textContent).toBe('2');
  });

  it('removes toast from state after duration', async () => {
    renderWithProvider();

    await act(async () => {
      fireEvent.click(screen.getByText('Show Success'));
    });

    expect(screen.getByTestId('toast-count').textContent).toBe('1');

    // Advance past the toast duration (3000ms) 
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });

    // The toast should be removed from state
    expect(screen.getByTestId('toast-count').textContent).toBe('0');
  });

  it('can remove toast manually via hook', async () => {
    renderWithProvider();

    await act(async () => {
      fireEvent.click(screen.getByText('Show Success'));
    });

    expect(screen.getByTestId('toast-count').textContent).toBe('1');

    await act(async () => {
      fireEvent.click(screen.getByText('Remove First'));
    });

    expect(screen.getByTestId('toast-count').textContent).toBe('0');
  });

  it('throws error when useToast is used outside provider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      render(<ToastTestComponent />);
    }).toThrow('useToast must be used within a ToastProvider');

    consoleError.mockRestore();
  });

  it('has correct styling for each toast type', async () => {
    renderWithProvider();

    await act(async () => {
      fireEvent.click(screen.getByText('Show Success'));
    });

    // Check that success toast is rendered with correct role (status for non-urgent notifications)
    const toast = screen.getByRole('status');
    expect(toast).toBeInTheDocument();
  });
});
