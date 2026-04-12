import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Step } from 'react-joyride';
import { resolveStepsWithExistingTargets } from '@/components/guided-tour';

describe('resolveStepsWithExistingTargets', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps steps whose targets exist', () => {
    const a = document.createElement('div');
    a.setAttribute('data-tour', 'a');
    document.body.appendChild(a);
    const steps: Step[] = [
      { target: '[data-tour="a"]', content: 'x', title: 'A' },
      { target: '[data-tour="missing"]', content: 'y', title: 'B' },
    ];
    const out = resolveStepsWithExistingTargets(steps);
    expect(out).toHaveLength(1);
    expect(out[0].target).toBe('[data-tour="a"]');
  });

  it('returns empty when nothing matches', () => {
    const steps: Step[] = [{ target: '[data-tour="nope"]', content: 'x', title: 'A' }];
    expect(resolveStepsWithExistingTargets(steps)).toEqual([]);
  });
});
