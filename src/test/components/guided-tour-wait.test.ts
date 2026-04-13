import { describe, it, expect, beforeEach } from 'vitest';
import { waitForTourDomReady } from '@/components/guided-tour';

/** Minimal DOM for the welcome tour’s unique selectors (app-logo appears twice in steps). */
function mountWelcomeTourTargets(): void {
  for (const sel of [
    'app-logo',
    'view-toggle',
    'browse-button',
    'library-button',
    'search-input',
    'filter-trigger',
    'settings-button',
  ]) {
    const el = document.createElement('div');
    el.setAttribute('data-tour', sel);
    document.body.appendChild(el);
  }
}

describe('waitForTourDomReady', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves when all welcome step targets exist', async () => {
    mountWelcomeTourTargets();
    await expect(
      waitForTourDomReady('welcome', { timeoutMs: 3000, intervalMs: 10 }),
    ).resolves.toBeUndefined();
  });

  it('eventually resolves after targets appear', async () => {
    const p = waitForTourDomReady('welcome', { timeoutMs: 4000, intervalMs: 15 });
    await new Promise((r) => setTimeout(r, 40));
    mountWelcomeTourTargets();
    await expect(p).resolves.toBeUndefined();
  });
});
