/**
 * Decode Bay web view open (v1.0.97): when the panel is still animating (zero
 * bounds), the resize observer and the 400 ms fallback timer both used to call
 * webviewApi.open, which destroyed and reloaded the page a second time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { WebviewPanel } from '@/components/buzz-view';

type RO = { cb: ResizeObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
let observers: RO[] = [];
let rect = { x: 0, y: 0, width: 0, height: 0 };
let open: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  observers = [];
  rect = { x: 0, y: 0, width: 0, height: 0 };
  (globalThis as any).ResizeObserver = vi.fn().mockImplementation((cb: ResizeObserverCallback) => {
    const o: RO = { cb, observe: vi.fn(), disconnect: vi.fn() };
    observers.push(o);
    return o;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => ({}) }) as DOMRect,
  );
  open = vi.fn(async () => ({ success: true }));
  const off = () => () => {};
  (window as any).webviewApi = {
    open,
    close: vi.fn(),
    resize: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    openExternal: vi.fn(),
    onLoading: off,
    onTitle: off,
    onError: off,
    onNavState: off,
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as any).webviewApi;
});

describe('WebviewPanel open', () => {
  it('opens once when the observer reports a size before the fallback timer', async () => {
    render(<WebviewPanel url="https://news.example/a" onClose={() => {}} />);
    expect(open).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(100); });
    rect = { x: 10, y: 20, width: 800, height: 600 };
    // The first observer created is the open observer (the bounds observer comes after it).
    await act(async () => { observers[0].cb([], observers[0] as any); });
    expect(open).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(400); });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('still opens from the fallback timer when the observer never fires', async () => {
    render(<WebviewPanel url="https://news.example/b" onClose={() => {}} />);
    rect = { x: 0, y: 0, width: 640, height: 480 };
    await act(async () => { vi.advanceTimersByTime(450); });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('opens immediately (once) when bounds are already non-zero', async () => {
    rect = { x: 0, y: 0, width: 640, height: 480 };
    render(<WebviewPanel url="https://news.example/c" onClose={() => {}} />);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(open).toHaveBeenCalledTimes(1);
  });
});
