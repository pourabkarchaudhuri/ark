/**
 * Settings → Game understanding (1.0.97 B37, design "Redesign · Game understanding" plus the
 * StatesSystem boards): status tiles, Reading and Ordering controls, and the maintenance jobs.
 * Every control is wired to the setting it stands for (Ollama/embedding settings in main, the
 * embedding service's jobs); nothing here is decorative.
 */
import { memo, useCallback, useEffect, useState } from 'react';
import { describeReindexAllResult } from '@/services/embedding-migration';
import { recoStore } from '@/services/reco-store';
import { embeddingService } from '@/services/embedding-service';
import { buildRechunkJobDeps } from '@/services/rechunk-job-deps';
import { annIndex } from '@/services/ann-index';
import { catalogStore } from '@/services/catalog-store';
import { epicCatalogStore } from '@/services/epic-catalog-store';
import type { LocalAiStatus } from '@/services/local-ai-types';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmbeddingBatchSizeControl, GraphicsMemoryTile, useGpuStats } from '@/components/settings/embedding-batch-size';
import { useOllamaSettings } from '@/components/settings/use-ollama-settings';
import { routeId, useAiRouter } from '@/components/settings/use-ai-router';
import { Chip, Icon, ICON, Meter, PageHeader, Panel, Row, Spinner, SwitchRow } from '@/components/settings/ui';
import type { PageProps } from '@/components/settings/general-page';

const REINDEX_PHASES = ['library', 'steam', 'epic', 'ann'] as const;
const PHASE_LABEL: Record<(typeof REINDEX_PHASES)[number], string> = { library: 'Library', steam: 'Steam', epic: 'Epic', ann: 'Index' };

function JobNote({ tone, children }: { tone?: 'fault' | 'live'; children: React.ReactNode }) {
  return <p className="d" role="status" data-tone={tone} style={tone ? { color: 'var(--tone)' } : undefined}>{children}</p>;
}

export const GameUnderstandingPage = memo(function GameUnderstandingPage({ onNavigate }: PageProps) {
  const ollama = useOllamaSettings();
  const { values: v, set } = ollama;
  const { state: router } = useAiRouter();
  const gpu = useGpuStats();
  const [localAi, setLocalAi] = useState<LocalAiStatus | null>(null);

  const [annStatus, setAnnStatus] = useState<'idle' | 'building' | 'done' | 'error'>('idle');
  const [annMessage, setAnnMessage] = useState<string | null>(null);
  const [annProgress, setAnnProgress] = useState<{ done: number; total: number } | null>(null);
  const [rechunkBusy, setRechunkBusy] = useState(() => embeddingService.isRechunkRunning);
  const [rechunkMessage, setRechunkMessage] = useState<string | null>(() => embeddingService.rechunkMessage);
  const [rechunkProgress, setRechunkProgress] = useState(() => embeddingService.rechunkProgress);
  const [rechunkSuggestAnn, setRechunkSuggestAnn] = useState(() => embeddingService.rechunkSuggestRebuildAnn);
  const [reindexStatus, setReindexStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [reindexMessage, setReindexMessage] = useState<string | null>(null);
  const [reindexProgress, setReindexProgress] = useState<{ completed: number; total: number } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Shared, service-level job state: reopening Settings mid-job keeps counting.
  const [annJobBusy, setAnnJobBusy] = useState(() => embeddingService.isAnnRebuilding);
  const [reindexBusy, setReindexBusy] = useState(() => embeddingService.isForceReindexRunning || embeddingService.isForceReindexAllRunning);
  const [migration, setMigration] = useState(() => embeddingService.migrationState);
  const [sweepMsg, setSweepMsg] = useState<string | null>(null);
  const [sweepBusy, setSweepBusy] = useState(false);

  useEffect(() => {
    void embeddingService.refreshMigrationState();
    const sync = () => {
      const annBusy = embeddingService.isAnnRebuilding;
      setAnnJobBusy(annBusy);
      if (!annBusy) setAnnProgress(null);
      const busy = embeddingService.isForceReindexRunning || embeddingService.isForceReindexAllRunning;
      setReindexBusy(busy);
      setReindexProgress(busy ? { ...embeddingService.catalogProgress } : null);
      setMigration(embeddingService.migrationState);
      const running = embeddingService.isRechunkRunning;
      setRechunkBusy(running);
      setRechunkMessage(embeddingService.rechunkMessage);
      setRechunkProgress(running ? { ...embeddingService.rechunkProgress } : embeddingService.rechunkProgress);
      setRechunkSuggestAnn(embeddingService.rechunkSuggestRebuildAnn);
    };
    const unsubEmb = embeddingService.subscribe(sync);
    const unsubAnn = annIndex.subscribe(() => {
      if (embeddingService.isAnnRebuilding) setAnnProgress({ ...annIndex.buildProgress });
    });
    sync();
    return () => { unsubEmb(); unsubAnn(); };
  }, []);

  useEffect(() => {
    const api = window.localAi;
    if (!api) return;
    let live = true;
    api.status().then((s) => { if (live) setLocalAi(s); }).catch(() => {});
    const off = api.onStatusChanged?.((s) => { if (live) setLocalAi(s); });
    return () => { live = false; off?.(); };
  }, []);

  const resumable = migration?.state === 'pending' && !!migration.runId && migration.reason === 'interrupted';
  const annBusy = annStatus === 'building' || annJobBusy;
  const reindexRunning = reindexStatus === 'running' || reindexBusy;
  const phaseIndex = migration?.phase ? REINDEX_PHASES.indexOf(migration.phase as (typeof REINDEX_PHASES)[number]) : -1;

  // The built-in runtime can fail to start; an external Ollama has no such report here.
  const runtimeDown = !!localAi && localAi.backend === 'builtin'
    && (!localAi.runtime.available || localAi.runtime.roles.some((r) => (r.role === 'embed' || r.role === 'rerank') && r.state === 'failed'));

  const rebuildIndex = useCallback(async () => {
    setAnnStatus('building');
    setAnnMessage(null);
    setAnnProgress({ done: 0, total: 1 });
    try {
      const count = await embeddingService.rebuildAnnFromCache();
      setAnnStatus('done');
      setAnnMessage(`Rebuilt — ${count.toLocaleString()} games indexed`);
      embeddingService.clearRechunkSuggestRebuildAnn();
      setRechunkSuggestAnn(false);
    } catch (err) {
      setAnnStatus('error');
      setAnnMessage(`Rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAnnProgress(null);
    }
  }, []);

  const refreshReading = useCallback(async () => {
    setRechunkBusy(true);
    setRechunkMessage(null);
    try {
      const deps = await buildRechunkJobDeps();
      // Resume watermark unless the prior job finished (the service restarts when phase=done).
      await embeddingService.startRechunkJob(deps);
    } catch (err) {
      console.warn('[Settings] Re-chunk failed:', err);
    } finally {
      setRechunkBusy(embeddingService.isRechunkRunning);
      setRechunkMessage(embeddingService.rechunkMessage);
      setRechunkSuggestAnn(embeddingService.rechunkSuggestRebuildAnn);
    }
  }, []);

  const rebuildAll = useCallback(async () => {
    setReindexStatus('running');
    setReindexMessage(null);
    setReindexProgress({ completed: 0, total: 0 });
    try {
      // One service-level operation, in dependency order (library, Steam, Epic, similarity index).
      // An earlier interrupted run resumes: games it already redid are skipped.
      const result = await embeddingService.forceReindexAll({
        libraryGames: () => recoStore.getLibraryEmbeddingInputs(),
        resume: resumable,
        steam: { iterate: (onBatch) => catalogStore.scanAllEntries(onBatch), lastSyncTimestamp: () => catalogStore.getLastSyncTimestamp() },
        epic: { iterate: (onBatch) => epicCatalogStore.scanAllEntries(onBatch), lastSyncTimestamp: () => epicCatalogStore.getLastSyncTimestamp() },
      });
      setReindexStatus(result.complete ? 'done' : 'error');
      setReindexMessage(describeReindexAllResult(result));
    } catch (err) {
      setReindexStatus('error');
      setReindexMessage(`Re-index failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReindexProgress(null);
    }
  }, [resumable]);

  const runSweep = useCallback(async () => {
    setSweepBusy(true);
    setSweepMsg(null);
    try {
      const { runWeightSweep, generateWeightCandidates } = await import('@/services/embedding-weight-sweep');
      const { CHUNK_WEIGHTS } = await import('@/services/embedding-chunks');
      // Tiny synthetic fixture: production keeps CURRENT_POOL_VERSION unless a winner is recorded.
      const dim = 1024;
      const mk = (seed: number) => { const x = new Array(dim).fill(0); x[seed % 16] = 1; return x; };
      const corpus = [
        { gameId: 'a', chunks: [{ kind: 'facets' as const, vector: mk(1) }, { kind: 'summary' as const, vector: mk(2) }] },
        { gameId: 'b', chunks: [{ kind: 'facets' as const, vector: mk(1) }, { kind: 'summary' as const, vector: mk(3) }] },
        { gameId: 'c', chunks: [{ kind: 'facets' as const, vector: mk(9) }, { kind: 'summary' as const, vector: mk(8) }] },
      ];
      const result = runWeightSweep({
        corpus: corpus.slice(1),
        queries: [{ queryGameId: 'a', queryChunks: corpus[0].chunks, relevantIds: ['b'] }],
        candidates: generateWeightCandidates(CHUNK_WEIGHTS),
      });
      setSweepMsg(result.improved
        ? `Winner MRR ${result.winner.mrr.toFixed(3)} (baseline ${result.baseline.mrr.toFixed(3)}), suggest pool v${result.suggestedPoolVersion}; not auto-applied`
        : `No improvement: baseline MRR ${result.baseline.mrr.toFixed(3)}; production weights unchanged`);
    } catch (err) {
      setSweepMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSweepBusy(false);
    }
  }, []);

  const embedRoute = routeId(router, 'embeddings');
  const rerankRoute = routeId(router, 'reranker');
  const readPct = rechunkProgress.total > 0 ? (rechunkProgress.completed / rechunkProgress.total) * 100 : 0;
  const annPct = annProgress && annProgress.total > 0 ? (annProgress.done / annProgress.total) * 100 : 0;

  return (
    <>
      <PageHeader
        title="Game understanding"
        lede={(
          <>
            How Ark reads each game to power Similar Games, the galaxy map and the Oracle. Uses the embedding and reranker routes from{' '}
            <a href="#providers" onClick={(e) => { e.preventDefault(); onNavigate('providers'); }}>AI providers</a>.
          </>
        )}
      />

      {runtimeDown && (
        <section className="panel" data-tone="warn" role="alert">
          <div className="row">
            <div>
              <p className="t" style={{ color: 'var(--tone)' }}>The built-in AI isn&apos;t running</p>
              <p className="d">Ark can&apos;t read new games until it starts. Existing matches keep working.{localAi?.runtime.roles.find((r) => r.state === 'failed')?.lastError ? ` ${localAi.runtime.roles.find((r) => r.state === 'failed')!.lastError}` : ''}</p>
            </div>
            <button type="button" className="btn" onClick={() => { void window.localAi?.recheck().then(setLocalAi).catch(() => {}); }}>Scan again</button>
          </div>
        </section>
      )}

      <section className="panel status" aria-label="Current status">
        <div>
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <p className="t">Similarity index</p>
            {annBusy || annIndex.isBuilding ? <Chip tone="info">Building</Chip> : annIndex.isReady ? <Chip tone={annIndex.isPartial ? 'warn' : 'live'}>{annIndex.isPartial ? 'Partial' : 'Ready'}</Chip> : <Chip tone="warn">Not built</Chip>}
          </div>
          {annBusy && annProgress
            ? <><Meter pct={annPct} label="Similarity index progress" /><p className="d" style={{ fontVariantNumeric: 'tabular-nums' }}>{annProgress.done.toLocaleString()} / {annProgress.total.toLocaleString()} games</p></>
            : <p className="d" style={{ fontVariantNumeric: 'tabular-nums' }}>{annIndex.isReady ? `${annIndex.vectorCount.toLocaleString()} games indexed` : 'Rebuild it below.'}</p>}
        </div>
        <div>
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <p className="t">Detailed reading</p>
            {rechunkBusy ? <Chip tone="info">Running</Chip> : v.embeddingChunkingEnabled ? <Chip tone="live">On</Chip> : <Chip tone="off">Off</Chip>}
          </div>
          {rechunkBusy && rechunkProgress.total > 0
            ? <><Meter pct={readPct} label="Detailed reading progress" /><p className="d" style={{ fontVariantNumeric: 'tabular-nums' }}>{rechunkProgress.phase} · {rechunkProgress.completed.toLocaleString()} of {rechunkProgress.total.toLocaleString()}</p></>
            : <p className="d">{v.embeddingChunkingEnabled ? 'Runs when you refresh it below.' : 'One summary per game.'}</p>}
        </div>
        <div>
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <p className="t">Data format</p>
            {migration?.state === 'pending' ? <Chip tone="warn">{resumable ? 'Interrupted' : 'Outdated'}</Chip> : <Chip tone="live">Current</Chip>}
          </div>
          <p className="d">{migration?.state === 'pending' ? (resumable ? 'A rebuild was interrupted. Resume it below.' : 'Built with an older format. Rebuild below.') : 'Matches this version of Ark.'}</p>
        </div>
        <GraphicsMemoryTile stats={gpu} />
      </section>

      <div className="stack">
        <Panel id="reading" title="Reading">
          <Row
            settingId="u-embedding-model"
            label="Embedding model"
            desc={<span style={{ color: 'var(--color-accent-ink)' }}>{embedRoute || 'Built-in'}</span>}
            control={<button type="button" className="btn" onClick={() => onNavigate('providers', 'route-embeddings')}>Change<Icon d={ICON.arrow} /></button>}
          />
          <EmbeddingBatchSizeControl value={v.embeddingBatchSize} onChange={(n) => set({ embeddingBatchSize: n })} stats={gpu} />
          <SwitchRow settingId="u-detail" label="Detailed reading" desc="Reads story, gameplay and style separately, and only re-reads parts that changed. Off reads one summary per game." checked={v.embeddingChunkingEnabled} onChange={(on) => set({ embeddingChunkingEnabled: on })} />
          <SwitchRow settingId="u-anypart" label="Match on any part" desc="Two games count as alike when any part lines up. Recommendations aren't affected." checked={v.chunkAnnMaxSimEnabled} onChange={(on) => set({ chunkAnnMaxSimEnabled: on })} />
          <SwitchRow settingId="u-compact" label="Compact vectors" desc="Faster searches, slightly less precise. Changing this clears the similarity index, so rebuild it afterwards." checked={v.embeddingMrl256Enabled} onChange={(on) => set({ embeddingMrl256Enabled: on })} />
        </Panel>

        <Panel id="ordering" title="Ordering">
          <Row
            settingId="u-reranker-model"
            label="Reranker model"
            desc={<span style={{ color: 'var(--color-accent-ink)' }}>{rerankRoute || 'Built-in'}</span>}
            control={<button type="button" className="btn" onClick={() => onNavigate('providers', 'route-reranker')}>Change<Icon d={ICON.arrow} /></button>}
          />
          <SwitchRow settingId="u-rerank-similar" label="Rerank similar games" desc="Applies to Similar Games and the galaxy map." checked={v.neighborRerankEnabled} onChange={(on) => set({ neighborRerankEnabled: on })} />
          <SwitchRow settingId="u-rerank-oracle" label="Rerank Oracle shelves" desc="Lets the AI re-sort each shelf." checked={v.oracleRerankEnabled} onChange={(on) => set({ oracleRerankEnabled: on })} />
          <div className="sect" data-setting-id="u-blend">
            <div className="inline" style={{ justifyContent: 'space-between' }}>
              <label htmlFor="blend" className="t">AI influence on shelves</label>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-accent-ink)', fontVariantNumeric: 'tabular-nums' }}>{Math.round(v.oracleRerankBlend * 100)}%</span>
            </div>
            <input
              id="blend" type="range" min={0} max={100} value={Math.round(v.oracleRerankBlend * 100)} disabled={!v.oracleRerankEnabled}
              aria-valuetext={`${Math.round(v.oracleRerankBlend * 100)} percent`}
              style={{ ['--v' as string]: `${Math.round(v.oracleRerankBlend * 100)}%` }}
              onChange={(e) => set({ oracleRerankBlend: Number(e.target.value) / 100 })}
            />
            <div className="scale"><span>Engine order</span><span>Mostly AI</span></div>
            <p className="d">0% keeps the engine order; higher values let the AI re-sort the taste-ordered shelves more. It is always blended with the engine order, never in full.</p>
          </div>
        </Panel>

        <Panel id="maintenance" title="Maintenance">
          <p className="d" style={{ margin: 0, padding: '0 var(--space-5) var(--space-3)' }}>None of these touch your library, playtime or Voyage.</p>

          <Row
            settingId="u-rebuild-index" leading={<Chip tone="live" tag className="cost">Quick</Chip>}
            label="Rebuild similarity index" desc="Uses what Ark already knows. No AI needed."
            extra={<>
              {annBusy && annProgress && <JobNote>{annProgress.done} / {annProgress.total} games</JobNote>}
              {annMessage && <JobNote tone={annStatus === 'error' ? 'fault' : 'live'}>{annMessage}</JobNote>}
            </>}
            control={<button type="button" className="btn" disabled={annBusy} onClick={() => void rebuildIndex()}>{annBusy ? <Spinner /> : <Icon d={ICON.refresh} />}{annBusy ? 'Rebuilding…' : 'Rebuild'}</button>}
          />

          <Row
            settingId="u-refresh" leading={<Chip tone="info" tag className="cost">Gentle</Chip>}
            label="Refresh detailed reading" desc="Library first, then the catalog. Runs while you play and can be cancelled. Needs Detailed reading turned on."
            extra={<>
              {rechunkBusy && rechunkProgress.total > 0 && <JobNote>{rechunkProgress.phase}: {rechunkProgress.completed} / {rechunkProgress.total}</JobNote>}
              {(rechunkMessage || rechunkSuggestAnn) && (
                <JobNote tone={embeddingService.rechunkStatus === 'error' || embeddingService.rechunkStatus === 'blocked' ? 'fault' : 'live'}>
                  {rechunkMessage}{rechunkSuggestAnn ? ' Rebuilding the similarity index is recommended.' : ''}
                </JobNote>
              )}
            </>}
            control={rechunkBusy
              ? <button type="button" className="btn" onClick={() => embeddingService.cancelRechunkJob()}>Cancel</button>
              : <button type="button" className="btn" disabled={!v.embeddingChunkingEnabled || annBusy || reindexRunning} onClick={() => void refreshReading()}><Icon d={ICON.layers} />Refresh</button>}
          />

          {reindexRunning ? (
            <div className="row" data-setting-id="u-rebuild-all">
              <div className="grow">
                <div className="inline"><p className="t">Rebuilding everything</p><Chip tone="info" tag>{phaseIndex >= 0 ? `Step ${phaseIndex + 1} of 4` : 'Starting'}</Chip></div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 'var(--space-1)', marginTop: 'var(--space-3)' }}>
                  {REINDEX_PHASES.map((p, i) => {
                    const pct = phaseIndex < 0 ? 0 : i < phaseIndex ? 100 : i === phaseIndex && reindexProgress && reindexProgress.total > 0 ? (reindexProgress.completed / reindexProgress.total) * 100 : 0;
                    return <Meter key={p} pct={pct} label={`${PHASE_LABEL[p]} progress`} />;
                  })}
                </div>
                <div className="d" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 'var(--space-1)', fontVariantNumeric: 'tabular-nums' }}>
                  {REINDEX_PHASES.map((p, i) => (
                    <span key={p}>{PHASE_LABEL[p]}{i === phaseIndex && reindexProgress && reindexProgress.total > 0 ? ` · ${reindexProgress.completed.toLocaleString()}/${reindexProgress.total.toLocaleString()}` : ''}</span>
                  ))}
                </div>
              </div>
              <button type="button" className="btn" onClick={() => { embeddingService.cancelLibraryEmbeddings(); embeddingService.cancelCatalogEmbeddings(); }}>Cancel</button>
            </div>
          ) : (
            <Row
              settingId="u-rebuild-all" leading={<Chip tone="warn" tag className="cost">Slow</Chip>}
              label={resumable ? `Rebuild stopped${migration?.phase ? ` at ${PHASE_LABEL[migration.phase as (typeof REINDEX_PHASES)[number]] ?? migration.phase}` : ''}` : 'Rebuild everything'}
              desc={resumable
                ? 'Finished games are skipped when you resume.'
                : `The AI re-reads your library, then Steam and Epic. Picks up where it left off if interrupted.${migration?.state === 'pending' ? ' Recommended now.' : ''}`}
              extra={reindexMessage ? <JobNote tone={reindexStatus === 'error' ? 'fault' : 'live'}>{reindexMessage}</JobNote> : undefined}
              control={<button type="button" className="btn p" onClick={() => setConfirmOpen(true)}><Icon d={ICON.replay} />{resumable ? 'Resume' : 'Rebuild all'}</button>}
            />
          )}

          <details style={{ borderTop: '1px solid var(--color-rule)' }}>
            <summary className="disc" style={{ padding: 'var(--space-4) var(--space-5)' }}>Advanced: matching tune-up test<Icon d={ICON.chevron} className="chev" /></summary>
            <Row
              settingId="u-sweep" label="Try other matching weights" desc="Scores alternatives on a small test set. Changes nothing on its own."
              extra={sweepMsg ? <JobNote>{sweepMsg}</JobNote> : undefined}
              control={<button type="button" className="btn" disabled={sweepBusy} onClick={() => void runSweep()}>{sweepBusy ? <Spinner /> : <Icon d={ICON.play} />}Run sweep</button>}
            />
          </details>
        </Panel>

        <p className="d" role="status" style={{ margin: 0 }}>
          {ollama.status === 'saving' && 'Saving…'}
          {ollama.status === 'saved' && 'Saved'}
          {ollama.status === 'error' && <span style={{ color: 'var(--color-fault)' }}>{ollama.error}</span>}
          {ollama.status === 'idle' && 'Changes save automatically.'}
        </p>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={resumable ? 'Resume the interrupted rebuild?' : 'Rebuild game understanding from scratch?'}
        description={resumable
          ? 'The previous rebuild was interrupted. It will continue where it left off, skipping games it already re-read, then rebuild the similarity index. Your library, playtime, and journey are not affected. Continue?'
          : 'The AI will re-read your library and every Steam and Epic game, then rebuild the similarity index. This can take a while and keeps the AI busy until it is done; if it is interrupted it can be resumed. Your library, playtime, and journey are not affected. Continue?'}
        confirmText={resumable ? 'Resume' : 'Rebuild'}
        cancelText="Cancel"
        variant="warning"
        onConfirm={() => void rebuildAll()}
      />
    </>
  );
});
