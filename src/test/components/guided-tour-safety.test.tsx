import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallBackProps, Step } from 'react-joyride';

// Stand-in Joyride: renders a marker and exposes the callback so the test can drive step events.
const joy = vi.hoisted(() => ({ callback: null as null | ((d: Partial<CallBackProps>) => void) }));
vi.mock('react-joyride', async () => {
  const actual = await vi.importActual<typeof import('react-joyride')>('react-joyride');
  return {
    ...actual,
    default: (props: { callback: (d: Partial<CallBackProps>) => void }) => {
      joy.callback = props.callback;
      return <div data-testid="joyride" />;
    },
  };
});

import { EVENTS, STATUS, ACTIONS } from 'react-joyride';
import { GuidedTour, TOUR_IDLE_TIMEOUT_MS, tourStorageKey } from '@/components/guided-tour';

const STEPS: Step[] = [
  { target: '[data-tour="a"]', content: 'A' },
  { target: '[data-tour="b"]', content: 'B' },
];

async function startTour(onFinish: () => void) {
  for (const id of ['a', 'b']) {
    const el = document.createElement('div');
    el.setAttribute('data-tour', id);
    document.body.appendChild(el);
  }
  const utils = render(<GuidedTour run tourKey={0} tourId="welcome" steps={STEPS} onFinish={onFinish} />);
  // rAF ×2 + first resolve attempt
  await act(async () => { vi.advanceTimersByTime(100); });
  expect(utils.queryByTestId('joyride')).not.toBeNull();
  return utils;
}

const stepAfter = () => joy.callback?.({ type: EVENTS.STEP_AFTER, action: ACTIONS.NEXT, status: STATUS.RUNNING, index: 0 });

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  joy.callback = null;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('GuidedTour inactivity watchdog', () => {
  it('never fires while the user keeps advancing steps', async () => {
    const onFinish = vi.fn();
    const { queryByTestId } = await startTour(onFinish);
    for (let i = 0; i < 4; i++) {
      await act(async () => { vi.advanceTimersByTime(4 * 60_000); });
      act(() => { stepAfter(); });
    }
    expect(onFinish).not.toHaveBeenCalled();
    expect(queryByTestId('joyride')).not.toBeNull();
  });

  it('closes an idle tour after 5 minutes without marking it completed', async () => {
    const onFinish = vi.fn();
    const { queryByTestId } = await startTour(onFinish);
    await act(async () => { vi.advanceTimersByTime(TOUR_IDLE_TIMEOUT_MS + 10); });
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(tourStorageKey('welcome'))).toBeNull();
    expect(queryByTestId('joyride')).toBeNull();
  });
});
