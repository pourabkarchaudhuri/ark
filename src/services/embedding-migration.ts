/**
 * Persisted state of a re-embed ("layout migration"). Pure — no storage, no Ollama.
 *
 * The question it answers: "are the vectors on disk the ones the current build would make?"
 *
 *   done      data matches the current layout stamp (and model tag)
 *   pending   data is stale (layout/model changed) or a run was interrupted — a re-index is recommended
 *   running   a re-index is in flight right now (a record found in this state at startup means the app quit mid-run)
 *   declined  the user chose "Later" for this exact target (stamp + model tag); re-offered when the target changes
 *
 * The record is stored in `embed-meta` under MIGRATION_META_KEY. Because every row written by a forced run is stamped
 * with the run id (CachedEmbedding.reindexRun), an interrupted run RESUMES: a restarted run with the same id skips games
 * it already redid — a plain "force" has no memory and would redo everything.
 */

export const MIGRATION_META_KEY = 'layout-migration';

export type MigrationStateName = 'pending' | 'running' | 'done' | 'declined';
export type MigrationReason = 'layout-changed' | 'model-changed' | 'interrupted' | 'user';
export type MigrationPhase = 'library' | 'steam' | 'epic' | 'ann';

export interface EmbeddingMigrationRecord {
  key: typeof MIGRATION_META_KEY;
  state: MigrationStateName;
  /** Layout stamp the stored vectors are at (what the last completed run produced). */
  dataStamp: string;
  /** Embedding model tag the stored vectors came from, when known. */
  dataModelTag?: string;
  reason?: MigrationReason;
  /** Id of the current/last forced run (rows rewritten by it carry the same id). */
  runId?: string;
  /** Target (`stamp|modelTag`) the run was started for — a resume is only valid against the same target. */
  runTarget?: string;
  /** Target the user declined: `${stamp}|${modelTag}`. */
  declinedFor?: string;
  phase?: MigrationPhase;
  updatedAt: number;
  completedAt?: number;
}

export interface MigrationTarget {
  /** Current layout stamp (embedding-layout.ts EMBEDDING_LAYOUT_STAMP). */
  stamp: string;
  /** Current embedding model tag ('' / undefined when the main process has not reported it). */
  modelTag?: string;
  now: number;
}

const targetKey = (t: Pick<MigrationTarget, 'stamp' | 'modelTag'>) => `${t.stamp}|${t.modelTag ?? ''}`;

/** What the app should believe at startup, given what was persisted. `changed` → persist the result. */
export function evaluateMigration(
  stored: EmbeddingMigrationRecord | null,
  target: MigrationTarget,
): { record: EmbeddingMigrationRecord; changed: boolean } {
  // First run with this feature: the data on disk was produced by the current build's layout (this release
  // introduced stamps without changing the layout), so it is current.
  if (!stored) {
    return {
      record: {
        key: MIGRATION_META_KEY, state: 'done', dataStamp: target.stamp,
        ...(target.modelTag ? { dataModelTag: target.modelTag } : {}),
        updatedAt: target.now, completedAt: target.now,
      },
      changed: true,
    };
  }

  const rec: EmbeddingMigrationRecord = { ...stored };
  let changed = false;
  const set = (patch: Partial<EmbeddingMigrationRecord>) => { Object.assign(rec, patch, { updatedAt: target.now }); changed = true; };

  if (rec.state === 'running') {
    // Nothing is running at startup: the previous session quit (or crashed) mid-run. Keep the run id so it resumes.
    set({ state: 'pending', reason: 'interrupted' });
  }

  // A pending run is only resumable against the target it was started for: rows it redid under an older layout/model
  // are stale now, so the run id is dropped and the next run starts from scratch.
  if (rec.state === 'pending' && rec.runId && rec.runTarget && rec.runTarget !== targetKey(target)) {
    const modelChanged = !!target.modelTag && !rec.runTarget.endsWith(`|${target.modelTag}`);
    set({ runId: undefined, runTarget: undefined, reason: modelChanged ? 'model-changed' : 'layout-changed' });
  }

  if (rec.state === 'done') {
    if (rec.dataStamp !== target.stamp) set({ state: 'pending', reason: 'layout-changed' });
    else if (target.modelTag && rec.dataModelTag && rec.dataModelTag !== target.modelTag) set({ state: 'pending', reason: 'model-changed' });
    else if (target.modelTag && !rec.dataModelTag) set({ dataModelTag: target.modelTag }); // learn the tag once
  } else if (rec.state === 'declined') {
    // A decline only covers the target it was made for.
    if (rec.declinedFor !== targetKey(target)) set({ state: 'pending', reason: rec.reason ?? 'layout-changed', declinedFor: undefined });
  }

  return { record: rec, changed };
}

/** Start (or resume, when `resumeRunId` matches the record's run) a run. */
export function beginMigration(
  rec: EmbeddingMigrationRecord,
  target: MigrationTarget,
  opts: { resume?: boolean } = {},
): EmbeddingMigrationRecord {
  const reuse = opts.resume === true && !!rec.runId && rec.state === 'pending';
  return {
    ...rec,
    state: 'running',
    // Time + random suffix: two runs started in the same millisecond must not share an id (the second would skip
    // everything the first already redid).
    runId: reuse ? rec.runId : `run-${target.now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    runTarget: reuse ? rec.runTarget : targetKey(target),
    phase: 'library',
    reason: rec.state === 'done' ? 'user' : rec.reason,
    declinedFor: undefined,
    updatedAt: target.now,
  };
}

export function setMigrationPhase(rec: EmbeddingMigrationRecord, phase: MigrationPhase, now: number): EmbeddingMigrationRecord {
  return { ...rec, phase, updatedAt: now };
}

/** A run finished everything (library, Steam, Epic, ANN): the data is now at the current target. */
export function completeMigration(rec: EmbeddingMigrationRecord, target: MigrationTarget): EmbeddingMigrationRecord {
  return {
    key: MIGRATION_META_KEY, state: 'done', dataStamp: target.stamp,
    ...(target.modelTag ? { dataModelTag: target.modelTag } : {}),
    runId: rec.runId, runTarget: rec.runTarget, updatedAt: target.now, completedAt: target.now,
  };
}

/** A run ended without finishing (cancelled, breaker trip, Ollama gone): resumable. */
export function interruptMigration(rec: EmbeddingMigrationRecord, now: number): EmbeddingMigrationRecord {
  return { ...rec, state: 'pending', reason: 'interrupted', updatedAt: now };
}

/** The user chose "Later" for the current target. */
export function declineMigration(rec: EmbeddingMigrationRecord, target: MigrationTarget): EmbeddingMigrationRecord {
  return { ...rec, state: 'declined', declinedFor: targetKey(target), updatedAt: target.now };
}

export interface ReindexAllSummary {
  libraryOk: boolean;
  library: number;
  steam: number;
  epic: number;
  steamOutcome: string;
  epicOutcome: string;
  ann: boolean;
  complete: boolean;
}

/** One line for Settings: what a full re-index achieved, or exactly where it stopped (and that it can resume). */
export function describeReindexAllResult(r: ReindexAllSummary): string {
  const games = (r.library + r.steam + r.epic).toLocaleString();
  if (r.complete) return `Done — ${games} games re-read, similarity index rebuilt`;
  const why = (o: string) =>
    o === 'tripped' ? 'paused because Ollama stopped responding'
      : o === 'unavailable' ? 'skipped because Ollama isn\'t running'
        : o === 'cancelled' ? 'cancelled'
          : o === 'error' ? 'failed'
            : 'not started';
  let where: string;
  if (!r.libraryOk) where = 'your library was not finished';
  else if (r.steamOutcome !== 'done') where = `Steam games ${why(r.steamOutcome)}`;
  else if (r.epicOutcome !== 'done') where = `Epic games ${why(r.epicOutcome)}`;
  else where = 'the similarity index could not be rebuilt';
  return `Not finished (${games} games so far) — ${where}. Progress is saved; you can resume.`;
}

/** Should the UI recommend a re-index? */
export function reindexRecommended(rec: EmbeddingMigrationRecord | null): boolean {
  return rec?.state === 'pending';
}
