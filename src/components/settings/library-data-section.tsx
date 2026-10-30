/**
 * Settings → General → Library Data: export, import (with a confirmation that
 * states what will be replaced) and "Restore previous library" after an import.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { Check, AlertCircle, Download, Upload, Loader2, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { libraryStore, type LibraryImportPlan, type LibraryImportResult } from '@/services/library-store';
import { gameService } from '@/services/game-service';

type Status = 'idle' | 'loading' | 'success' | 'error';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Confirmation copy: what the import replaces, with real counts. */
export function describeImportPlan(plan: LibraryImportPlan): string {
  const { currentGames, fileGames, currentCustomGames, fileCustomGames } = plan.counts;
  const parts = [
    `This replaces your library: ${plural(currentGames, 'game')} now, ${fileGames} in the file.`,
  ];
  if (fileCustomGames !== null) {
    parts.push(`Custom games are replaced too: ${currentCustomGames} now, ${fileCustomGames} in the file.`);
  } else if (currentCustomGames > 0) {
    parts.push(`The file has no custom games, so your ${plural(currentCustomGames, 'custom game')} stay.`);
  }
  const replaced: string[] = [];
  const kept: string[] = [];
  (plan.journeyHistory ? replaced : kept).push('journey');
  (plan.sessionHistory ? replaced : kept).push('sessions');
  (plan.statusHistory ? replaced : kept).push('status history');
  if (replaced.length > 0) parts.push(`Your ${replaced.join(', ')} will be replaced from the file.`);
  if (kept.length > 0) parts.push(`The file has no ${kept.join(', ')}, so yours stay as they are.`);
  parts.push('A copy of your current library is kept so you can restore it afterwards.');
  return parts.join(' ');
}

function describeResult(result: LibraryImportResult, verb: string): string {
  const custom = result.customCount > 0 ? ` and ${plural(result.customCount, 'custom game')}` : '';
  return `${verb} ${plural(result.count, 'game')}${custom}`;
}

export function LibraryDataSection() {
  const [importStatus, setImportStatus] = useState<Status>('idle');
  const [exportStatus, setExportStatus] = useState<Status>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [pendingPlan, setPendingPlan] = useState<LibraryImportPlan | null>(null);
  const [canRestore, setCanRestore] = useState(() => libraryStore.getLastImportSnapshot() !== null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const scheduleReset = useCallback(() => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      setImportStatus('idle');
      setExportStatus('idle');
      setMessage(null);
    }, 3000);
  }, []);

  const handleExport = useCallback(async () => {
    setExportStatus('loading');
    try {
      const data = libraryStore.exportData();
      const librarySize = libraryStore.getSize();
      const defaultName = `ark-library-${new Date().toISOString().split('T')[0]}.json`;
      if (window.fileDialog) {
        const result = await window.fileDialog.saveFile({
          content: data,
          defaultName,
          filters: [{ name: 'JSON Files', extensions: ['json'] }],
        });
        if (result.success) { setExportStatus('success'); setMessage(`Exported ${librarySize} games`); }
        else if (result.canceled) { setExportStatus('idle'); return; }
        else { setExportStatus('error'); setMessage(result.error || 'Failed'); }
      } else {
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = defaultName;
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        setExportStatus('success'); setMessage(`Exported ${librarySize} games`);
      }
    } catch {
      setExportStatus('error'); setMessage('Failed to export');
    }
    scheduleReset();
  }, [scheduleReset]);

  /** Step 1: parse the picked file and ask before anything is replaced. */
  const reviewContent = useCallback((content: string) => {
    const parsed = libraryStore.parseImport(content);
    if (!parsed.success) {
      setImportStatus('error');
      setMessage(parsed.error);
      scheduleReset();
      return;
    }
    setPendingPlan(parsed.plan);
  }, [scheduleReset]);

  const handleImport = useCallback(async () => {
    setImportStatus('loading'); setMessage(null);
    try {
      if (window.fileDialog) {
        const result = await window.fileDialog.openFile({ filters: [{ name: 'JSON Files', extensions: ['json'] }] });
        if (result.canceled) { setImportStatus('idle'); return; }
        if (!result.success || !result.content) {
          setImportStatus('error'); setMessage(result.error || 'Failed'); scheduleReset();
        } else {
          reviewContent(result.content);
        }
      } else {
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (!file) { setImportStatus('idle'); return; }
          try { reviewContent(await file.text()); }
          catch { setImportStatus('error'); setMessage('Failed'); scheduleReset(); }
        };
        input.click();
      }
    } catch {
      setImportStatus('error'); setMessage('Failed'); scheduleReset();
    }
  }, [reviewContent, scheduleReset]);

  /** Step 2 (confirmed): apply the plan. */
  const confirmImport = useCallback(() => {
    const plan = pendingPlan;
    setPendingPlan(null);
    if (!plan) return;
    const result = libraryStore.applyImport(plan);
    if (result.success) {
      setImportStatus('success');
      setMessage(describeResult(result, 'Imported'));
      setCanRestore(libraryStore.getLastImportSnapshot() !== null);
      gameService.backfillLibraryMissingCachedMeta().catch(() => { /* non-blocking */ });
    } else {
      setImportStatus('error');
      setMessage(result.error || 'Failed');
    }
    scheduleReset();
  }, [pendingPlan, scheduleReset]);

  // Runs on Cancel, Escape and after Confirm (the dialog always closes itself):
  // only a still-pending import goes back to idle, a confirmed one keeps its result.
  const cancelImport = useCallback(() => {
    setPendingPlan(null);
    setImportStatus((s) => (s === 'loading' ? 'idle' : s));
  }, []);

  const handleRestore = useCallback(() => {
    const result = libraryStore.restoreLastImportSnapshot();
    if (result.success) {
      setImportStatus('success');
      setMessage(describeResult(result, 'Restored'));
      gameService.backfillLibraryMissingCachedMeta().catch(() => { /* non-blocking */ });
    } else {
      setImportStatus('error');
      setMessage(result.error || 'Failed');
    }
    setCanRestore(libraryStore.getLastImportSnapshot() !== null);
    scheduleReset();
  }, [scheduleReset]);

  const ok = importStatus === 'success' || exportStatus === 'success';

  return (
    <>
      <div>
        <p className="text-sm font-medium text-white/90">Export & Import</p>
        <p className="text-xs text-white/35 mt-0.5">Backup or restore your library data as JSON</p>
      </div>
      <div className="flex gap-3">
        <Button variant="ghost" size="sm" onClick={handleExport} disabled={exportStatus === 'loading'}
          className="flex-1 h-10 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-white/70">
          {exportStatus === 'loading' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
          Export Library
        </Button>
        <Button variant="ghost" size="sm" onClick={handleImport} disabled={importStatus === 'loading'}
          className="flex-1 h-10 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-white/70">
          {importStatus === 'loading' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
          Import Library
        </Button>
      </div>
      {canRestore && (
        <Button variant="ghost" size="sm" onClick={handleRestore}
          className="w-full h-9 bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.06] text-white/60">
          <RotateCcw className="h-4 w-4 mr-2" />
          Restore previous library
        </Button>
      )}
      {message && (
        <div className={cn('flex items-center gap-2 text-xs', ok ? 'text-emerald-400/70' : 'text-red-400/70')}>
          {ok ? <Check className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
          {message}
        </div>
      )}
      <p className="text-xs text-white/25">
        Import replaces your library with the file's games, plus the journey, sessions and status history it contains. You are asked first, and a copy of the current library is kept so you can restore it.
      </p>
      <ConfirmDialog
        open={pendingPlan !== null}
        onOpenChange={(open) => { if (!open) cancelImport(); }}
        title="Replace your library?"
        description={pendingPlan ? describeImportPlan(pendingPlan) : ''}
        confirmText="Replace library"
        cancelText="Cancel"
        variant="warning"
        onConfirm={confirmImport}
        onCancel={cancelImport}
      />
    </>
  );
}
