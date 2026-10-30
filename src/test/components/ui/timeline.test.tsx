import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Timeline } from '@/components/ui/timeline';

// Mock framer-motion — Proxy pattern (matches journey-view.test.tsx) so
// this file is resilient to whichever framer-motion mock the shared module
// registry sees first under --no-isolate.
vi.mock('framer-motion', () => {
  const motionHandler = {
    get(_: unknown, tag: string) {
      return ({ children, style, className, ...props }: Record<string, unknown>) => {
        const Tag = tag as keyof JSX.IntrinsicElements;
        const safe: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) {
          if (
            !['initial', 'animate', 'exit', 'whileInView', 'viewport', 'transition',
              'variants', 'whileHover', 'whileTap', 'whileFocus', 'whileDrag',
              'layout', 'layoutId', 'onAnimationComplete'].includes(k)
          ) {
            safe[k] = v;
          }
        }
        return (
          <Tag style={style as React.CSSProperties} className={className as string} {...safe}>
            {children as React.ReactNode}
          </Tag>
        );
      };
    },
  };
  return {
    motion: new Proxy({}, motionHandler),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useScroll: () => ({ scrollYProgress: { get: () => 0 } }),
    useTransform: () => ({ get: () => 0 }),
    useMotionValue: () => ({ get: () => 0, set: () => {}, on: () => () => {} }),
  };
});

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
  describe('line height', () => {
    const original = globalThis.ResizeObserver;
    afterEach(() => {
      globalThis.ResizeObserver = original;
    });

    it('follows the observed content when it resizes, and disconnects on unmount', () => {
      let callback: ResizeObserverCallback | null = null;
      const observe = vi.fn();
      const disconnect = vi.fn();
      globalThis.ResizeObserver = class {
        constructor(cb: ResizeObserverCallback) { callback = cb; }
        observe = observe;
        unobserve = vi.fn();
        disconnect = disconnect;
      } as unknown as typeof ResizeObserver;

      const { container, unmount } = render(<Timeline data={[{ title: '2025', content: <p>A</p> }]} />);
      const content = container.querySelector('.relative.max-w-7xl') as HTMLElement;
      expect(observe).toHaveBeenCalledWith(content);
      const line = container.querySelector('.bg-gradient-to-b') as HTMLElement;

      const resize = (h: number) => {
        content.getBoundingClientRect = () => ({ height: h, width: 100, top: 0, left: 0, right: 100, bottom: h, x: 0, y: 0, toJSON: () => ({}) });
        act(() => { callback!([{ target: content } as unknown as ResizeObserverEntry], {} as ResizeObserver); });
      };
      resize(800);
      expect(line.style.height).toBe('800px');
      resize(1300);
      expect(line.style.height).toBe('1300px');

      unmount();
      expect(disconnect).toHaveBeenCalled();
    });
  });
});
