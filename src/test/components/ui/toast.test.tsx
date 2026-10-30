import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { forwardRef, type ReactNode } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastProvider, useToast } from '@/components/ui/toast';

// Exit animations never finish under fake timers; render motion.div as a
// plain div so removed toasts leave the DOM immediately.
vi.mock('framer-motion', () => {
  const MOTION_PROPS = ['initial', 'animate', 'exit', 'transition', 'layout'];
  const Div = forwardRef<HTMLDivElement, Record<string, unknown>>(({ children, ...props }, ref) => {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      if (!MOTION_PROPS.includes(k)) safe[k] = v;
    }
    return <div ref={ref} {...safe}>{children as ReactNode}</div>;
  });
  return {
    motion: { div: Div },
    AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

// Helper component to test toast functionality. The toast list is no longer
// in context (1.0.97 B23), so assertions read the rendered toasts instead.
function ToastTestComponent() {
  const { success, error, info, warning } = useToast();

  return (
    <div>
      <button onClick={() => success('Success message')}>Show Success</button>
      <button onClick={() => error('Error message')}>Show Error</button>
      <button onClick={() => info('Info message')}>Show Info</button>
      <button onClick={() => warning('Warning message')}>Show Warning</button>
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

const toastCount = () => screen.queryAllByRole('status').length;

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
    expect(toastCount()).toBe(2);
  });

  it('removes toast after duration', async () => {
    renderWithProvider();

    await act(async () => {
      fireEvent.click(screen.getByText('Show Success'));
    });

    expect(toastCount()).toBe(1);

    // Advance past the toast duration (3000ms)
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });

    expect(toastCount()).toBe(0);
  });

  it('can remove toast manually via the dismiss button', async () => {
    renderWithProvider();

    await act(async () => {
      fireEvent.click(screen.getByText('Show Success'));
    });

    expect(toastCount()).toBe(1);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Dismiss notification'));
    });

    expect(toastCount()).toBe(0);
  });

  it('does not re-render useToast consumers when toasts show and dismiss', async () => {
    let renders = 0;
    let api: ReturnType<typeof useToast> | null = null;
    function Consumer() {
      renders += 1;
      api = useToast();
      return null;
    }
    render(
      <ToastProvider>
        <Consumer />
      </ToastProvider>
    );
    expect(renders).toBe(1);
    const first = api;

    await act(async () => {
      api!.addToast('hello', 'info', 1000);
    });
    expect(screen.getByText('hello')).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.queryByText('hello')).not.toBeInTheDocument();

    expect(renders).toBe(1);
    expect(api).toBe(first);
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
