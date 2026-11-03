/**
 * The connector switch on the AI providers screen (1.0.97 B37): switching a routed connector off
 * takes it off every route at once, keeps its settings, key and last test, refuses new routes, and
 * the old chat bridge does not turn it back on.
 */
import { describe, it, expect } from 'vitest';
import { validateConnectorInput } from '../../../electron/ai-router/types';
import { makeStore } from './helpers';

const PASS = { ok: true, at: 1, latencyMs: 12, role: 'chat' as const, model: 'gpt-5', message: 'ok' };

function routedOpenAi() {
  const t = makeStore();
  t.store.upsertConnector({ id: 'openai', kind: 'openai', name: 'OpenAI' });
  t.store.setKey('openai', 'sk-test-abcdefgh');
  t.store.recordTest('openai', PASS);
  expect(t.store.setRoute('chat', 'openai', 'gpt-5')).toMatchObject({ ok: true });
  return t;
}

describe('connector enabled flag', () => {
  it('is accepted as a boolean and dropped otherwise', () => {
    expect(validateConnectorInput({ kind: 'openai', enabled: false })).toMatchObject({ ok: true, value: { enabled: false } });
    const v = validateConnectorInput({ kind: 'openai', enabled: 'no' });
    expect(v.ok && 'enabled' in v.value).toBe(false);
  });

  it('switching off un-routes every role but keeps key, settings and the passed test', () => {
    const t = routedOpenAi();
    t.store.upsertConnector({ id: 'openai', kind: 'openai', name: 'OpenAI', enabled: false });
    expect(t.store.route('chat').connectorId).toBe('builtin');
    expect(t.store.hasKey('openai')).toBe(true);
    expect(t.store.connector('openai')).toMatchObject({ enabled: false, test: { ok: true } });
  });

  it('refuses a new route while off and accepts it again once switched on', () => {
    const t = routedOpenAi();
    t.store.upsertConnector({ id: 'openai', kind: 'openai', name: 'OpenAI', enabled: false });
    expect(t.store.setRoute('chat', 'openai', 'gpt-5')).toMatchObject({ ok: false });
    t.store.upsertConnector({ id: 'openai', kind: 'openai', name: 'OpenAI', enabled: true });
    expect(t.store.connector('openai')!.enabled).toBeUndefined();
    expect(t.store.setRoute('chat', 'openai', 'gpt-5')).toMatchObject({ ok: true });
  });

  it('a save that does not mention the switch leaves an off connector off, and an off connector is never armed', () => {
    const t = routedOpenAi();
    t.store.upsertConnector({ id: 'openai', kind: 'openai', name: 'OpenAI', enabled: false });
    t.store.upsertConnector({ id: 'openai', kind: 'openai', name: 'OpenAI (work)' });
    expect(t.store.connector('openai')).toMatchObject({ enabled: false, name: 'OpenAI (work)' });
    expect(t.store.isArmed(t.store.connector('openai')!)).toBe(false);
  });
});
