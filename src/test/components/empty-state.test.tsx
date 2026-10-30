import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmptyState } from '@/components/empty-state';

describe('EmptyState no-browse-results', () => {
  it('shows browse copy (not the empty-library copy) and a Retry action', () => {
    const onAction = vi.fn();
    render(<EmptyState type="no-browse-results" onAction={onAction} />);
    expect(screen.getByText('Nothing to Show Here')).toBeInTheDocument();
    expect(screen.queryByText(/No Games in Library/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('renders no button when there is no action', () => {
    render(<EmptyState type="no-browse-results" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
