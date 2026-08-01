import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  bumpJoyrideCleanupGen,
  sweepJoyrideDom,
  scheduleRemoveJoyrideLeftovers,
  resetJoyrideCleanupGenForTests,
} from '@/components/guided-tour';

function mountJoyrideOrphans(): { portal: HTMLElement; step: HTMLElement; floater: HTMLElement } {
  const portal = document.createElement('div');
  portal.id = 'react-joyride-portal';
  document.body.appendChild(portal);

  const step = document.createElement('div');
  step.id = 'react-joyride-step-0';
  document.body.appendChild(step);

  const floater = document.createElement('div');
  floater.className = '__floater __floater__open';
  document.body.appendChild(floater);

  return { portal, step, floater };
}

describe('Joyride leftover cleanup', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetJoyrideCleanupGenForTests();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    resetJoyrideCleanupGenForTests();
    vi.restoreAllMocks();
  });

  it('sweepJoyrideDom removes portal, step ids, and body-child floater leftovers', () => {
    mountJoyrideOrphans();

    expect(sweepJoyrideDom()).toBe(true);

    expect(document.getElementById('react-joyride-portal')).toBeNull();
    expect(document.getElementById('react-joyride-step-0')).toBeNull();
    expect(document.querySelector('.__floater')).toBeNull();
  });

  it('skips DOM mutation when expectedGen is stale after a newer bump', () => {
    mountJoyrideOrphans();
    const gen = bumpJoyrideCleanupGen();
    bumpJoyrideCleanupGen();

    expect(sweepJoyrideDom(gen)).toBe(false);
    expect(document.getElementById('react-joyride-portal')).toBeTruthy();
    expect(document.getElementById('react-joyride-step-0')).toBeTruthy();
  });

  it('mutates DOM when expectedGen matches current generation', () => {
    mountJoyrideOrphans();
    const gen = bumpJoyrideCleanupGen();

    expect(sweepJoyrideDom(gen)).toBe(true);
    expect(document.getElementById('react-joyride-portal')).toBeNull();
  });

  it('scheduleRemoveJoyrideLeftovers cancels a prior deferred sweep via generation bump', async () => {
    vi.useFakeTimers();
    mountJoyrideOrphans();

    scheduleRemoveJoyrideLeftovers();
    // New tour / endTour bumps gen before the deferred pass fires
    bumpJoyrideCleanupGen();

    // Flush double-rAF + setTimeout(0) from the scheduled sweep
    await vi.runAllTimersAsync();

    expect(document.getElementById('react-joyride-portal')).toBeTruthy();
    vi.useRealTimers();
  });
});
