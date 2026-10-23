import { describe, it, expect } from 'vitest';
import {
  MIGRATION_META_KEY,
  beginMigration,
  completeMigration,
  declineMigration,
  describeReindexAllResult,
  evaluateMigration,
  interruptMigration,
  reindexRecommended,
  setMigrationPhase,
  type EmbeddingMigrationRecord,
} from '@/services/embedding-migration';

const T = (over: Partial<{ stamp: string; modelTag: string; now: number }> = {}) => ({
  stamp: 't10m1c1p1', modelTag: 'snowflake-arctic-embed2', now: 1_000, ...over,
});
const rec = (over: Partial<EmbeddingMigrationRecord> = {}): EmbeddingMigrationRecord => ({
  key: MIGRATION_META_KEY, state: 'done', dataStamp: 't10m1c1p1', dataModelTag: 'snowflake-arctic-embed2', updatedAt: 1, ...over,
});

describe('evaluateMigration (startup reconciliation)', () => {
  it('first run on a profile: the data is assumed current (this layout introduced stamps without changing)', () => {
    const { record, changed } = evaluateMigration(null, T());
    expect(changed).toBe(true);
    expect(record).toMatchObject({ state: 'done', dataStamp: 't10m1c1p1', dataModelTag: 'snowflake-arctic-embed2' });
    expect(reindexRecommended(record)).toBe(false);
  });

  it('done + same target: nothing to do', () => {
    const { record, changed } = evaluateMigration(rec(), T());
    expect(changed).toBe(false);
    expect(record.state).toBe('done');
  });

  it('a layout bump makes the re-index pending', () => {
    const { record, changed } = evaluateMigration(rec(), T({ stamp: 't11m1c1p1' }));
    expect(changed).toBe(true);
    expect(record).toMatchObject({ state: 'pending', reason: 'layout-changed' });
    expect(reindexRecommended(record)).toBe(true);
  });

  it('a different model tag (ARK_EMBEDDING_MODEL_TAG override) makes it pending even with an unchanged stamp', () => {
    const { record } = evaluateMigration(rec(), T({ modelTag: 'snowflake-arctic-embed2:q8_0' }));
    expect(record).toMatchObject({ state: 'pending', reason: 'model-changed' });
  });

  it('learns the model tag once when it was unknown, without flagging anything', () => {
    const { record, changed } = evaluateMigration(rec({ dataModelTag: undefined }), T());
    expect(changed).toBe(true);
    expect(record).toMatchObject({ state: 'done', dataModelTag: 'snowflake-arctic-embed2' });
  });

  it('an unknown current tag never raises a false model change', () => {
    const { record } = evaluateMigration(rec(), T({ modelTag: undefined as unknown as string }));
    expect(record.state).toBe('done');
  });

  it('a record found "running" at startup means the last session died mid-run: pending (interrupted), run id kept', () => {
    const { record } = evaluateMigration(rec({ state: 'running', runId: 'run-abc', phase: 'steam' }), T());
    expect(record).toMatchObject({ state: 'pending', reason: 'interrupted', runId: 'run-abc' });
  });
});

describe('decline is scoped to the target it was made for', () => {
  it('declined stays declined for the same target', () => {
    const pending = rec({ state: 'pending', reason: 'layout-changed', dataStamp: 't9m1c1p1' });
    const declined = declineMigration(pending, T());
    expect(declined.state).toBe('declined');
    const { record, changed } = evaluateMigration(declined, T());
    expect(changed).toBe(false);
    expect(record.state).toBe('declined');
    expect(reindexRecommended(record)).toBe(false);
  });

  it('a newer layout or model re-offers it', () => {
    const declined = declineMigration(rec({ state: 'pending', dataStamp: 't9m1c1p1' }), T());
    expect(evaluateMigration(declined, T({ stamp: 't11m1c1p1' })).record.state).toBe('pending');
    expect(evaluateMigration(declined, T({ modelTag: 'other-model' })).record.state).toBe('pending');
  });
});

describe('run lifecycle', () => {
  it('begin → running with a fresh run id and phase library; a user-started run records reason "user"', () => {
    const r = beginMigration(rec(), T());
    expect(r).toMatchObject({ state: 'running', phase: 'library', reason: 'user' });
    expect(r.runId).toMatch(/^run-/);
  });

  it('resume reuses the interrupted run id (so rows already redone are skipped); a plain begin does not', () => {
    const interrupted = rec({ state: 'pending', reason: 'interrupted', runId: 'run-old' });
    expect(beginMigration(interrupted, T({ now: 5 }), { resume: true }).runId).toBe('run-old');
    expect(beginMigration(interrupted, T({ now: 5 })).runId).not.toBe('run-old');
    // Nothing to resume from a finished record.
    expect(beginMigration(rec({ runId: 'run-old' }), T({ now: 5 }), { resume: true }).runId).not.toBe('run-old');
  });

  it('phases are recorded', () => {
    const r = setMigrationPhase(beginMigration(rec(), T()), 'steam', 7);
    expect(r).toMatchObject({ phase: 'steam', updatedAt: 7, state: 'running' });
  });

  it('complete → done at the current stamp/tag; interrupt → pending (resumable)', () => {
    const running = beginMigration(rec({ dataStamp: 't9m1c1p1', state: 'pending' }), T());
    const done = completeMigration(running, T({ now: 9 }));
    expect(done).toMatchObject({ state: 'done', dataStamp: 't10m1c1p1', dataModelTag: 'snowflake-arctic-embed2', completedAt: 9 });
    const interrupted = interruptMigration(running, 11);
    expect(interrupted).toMatchObject({ state: 'pending', reason: 'interrupted', runId: running.runId });
    expect(reindexRecommended(interrupted)).toBe(true);
  });

  it('after a completed run the same target stays done on the next startup', () => {
    const done = completeMigration(beginMigration(rec({ state: 'pending', dataStamp: 't9m1c1p1' }), T()), T());
    expect(evaluateMigration(done, T()).changed).toBe(false);
  });
});

describe('describeReindexAllResult', () => {
  const base = { libraryOk: true, library: 40, steam: 1000, epic: 50, steamOutcome: 'done', epicOutcome: 'done', ann: true, complete: true };
  it('complete', () => {
    expect(describeReindexAllResult(base)).toContain('Done');
  });
  it('says exactly where it stopped, and that it can resume', () => {
    expect(describeReindexAllResult({ ...base, complete: false, libraryOk: false })).toMatch(/library was not finished.*resume/);
    expect(describeReindexAllResult({ ...base, complete: false, steamOutcome: 'tripped' })).toMatch(/Steam games paused because Ollama/);
    expect(describeReindexAllResult({ ...base, complete: false, epicOutcome: 'unavailable' })).toMatch(/Epic games skipped/);
    expect(describeReindexAllResult({ ...base, complete: false, ann: false })).toMatch(/similarity index could not be rebuilt/);
  });
});

describe('a resume is only valid against the target the run was started for', () => {
  it('beginMigration records the target; a resume keeps it', () => {
    const started = beginMigration(rec(), T());
    expect(started.runTarget).toBe('t10m1c1p1|snowflake-arctic-embed2');
    const interrupted = interruptMigration(started, 5);
    expect(beginMigration(interrupted, T({ now: 9 }), { resume: true }).runTarget).toBe(started.runTarget);
  });

  it('same target at startup: the interrupted run stays resumable', () => {
    const interrupted = interruptMigration(beginMigration(rec(), T()), 5);
    const { record } = evaluateMigration(interrupted, T());
    expect(record.runId).toBe(interrupted.runId);
  });

  it('the layout moved on since the interrupted run: its run id is dropped (rows it redid are stale now)', () => {
    const interrupted = interruptMigration(beginMigration(rec(), T()), 5);
    const { record, changed } = evaluateMigration(interrupted, T({ stamp: 't11m1c1p1' }));
    expect(changed).toBe(true);
    expect(record).toMatchObject({ state: 'pending', reason: 'layout-changed' });
    expect(record.runId).toBeUndefined();
    // …so "resume" starts a brand-new run.
    expect(beginMigration(record, T({ stamp: 't11m1c1p1', now: 99 }), { resume: true }).runId).not.toBe(interrupted.runId);
  });

  it('the model changed since the interrupted run: dropped with reason model-changed', () => {
    const interrupted = interruptMigration(beginMigration(rec(), T()), 5);
    const { record } = evaluateMigration(interrupted, T({ modelTag: 'another-model' }));
    expect(record).toMatchObject({ state: 'pending', reason: 'model-changed' });
    expect(record.runId).toBeUndefined();
  });
});

