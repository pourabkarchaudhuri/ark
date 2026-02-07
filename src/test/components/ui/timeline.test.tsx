import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Timeline } from '@/components/ui/timeline';

// Mock framer-motion to avoid scroll/animation issues in tests
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, style, className, ...props }: Record<string, unknown>) => (
      <div style={style as React.CSSProperties} className={className as string} {...props}>
        {children as React.ReactNode}
      </div>
    ),
  },
  useScroll: () => ({ scrollYProgress: { get: () => 0 } }),
  useTransform: () => ({ get: () => 0 }),
}));

describe('Timeline', () => {
  it('renders timeline entries with titles', () => {
    const data = [
      { title: '2025', content: <p>Games from 2025</p> },
      { title: '2024', content: <p>Games from 2024</p> },
    ];

    render(<Timeline data={data} />);

    expect(screen.getAllByText('2025').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2024').length).toBeGreaterThan(0);
    expect(screen.getByText('Games from 2025')).toBeInTheDocument();
    expect(screen.getByText('Games from 2024')).toBeInTheDocument();
  });

  it('renders the animated gradient line container', () => {
    const data = [{ title: '2025', content: <p>Content</p> }];

    const { container } = render(<Timeline data={data} />);

    // The gradient line is a div with the vertical line classes
    const lineElement = container.querySelector('.bg-gradient-to-b');
    expect(lineElement).toBeInTheDocument();
  });

  it('renders empty when no data', () => {
    const { container } = render(<Timeline data={[]} />);

    // Should still render the container but with no entry items
    expect(container.querySelector('.relative')).toBeInTheDocument();
  });

  it('renders timeline dots for each entry', () => {
    const data = [
      { title: '2025', content: <p>A</p> },
      { title: '2024', content: <p>B</p> },
      { title: '2023', content: <p>C</p> },
    ];

    const { container } = render(<Timeline data={data} />);

    // Each entry has a dot (rounded-full inside the sticky column)
    const dots = container.querySelectorAll('.rounded-full.bg-fuchsia-500\\/30');
    expect(dots.length).toBe(3);
  });
});
