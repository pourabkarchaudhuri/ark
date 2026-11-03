/**
 * Settings → General → Library data: export, import (with a confirmation that
 * states what will be replaced) and "Restore previous library" after an import.
 * Results are reported through the page's toast (design: "Saved ark-library-[date].json").
 */

import { useState, useCallback, useRef } from 'react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { libraryStore, type LibraryImportPlan, type LibraryImportResult } from '@/services/library-store';
import { gameService } from '@/services/game-service';
import { Icon, ICON, Row, Spinner, type ToastMessage } from '@/components/settings/ui';

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

export type ToastInput = Omit<ToastMessage, 'id'>;

export function LibraryDataSection({ onToast }: { onToast: (toast: ToastInput) => void }) {
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<LibraryImportPlan | null>(null);
  const [canRestore, setCanRestore] = useState(() => libraryStore.getLastImportSnapshot() !== null);
  /** "Try another" on a failed import runs the same picker again. */
  const importAgain = useRef<() => void>(() => undefined);

  const handleExport = useCallback(async () => {
    setExporting(true);
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
        if (result.success) {
          const filePath = result.filePath;
          const show = window.fileDialog?.showFile;
          onToast({
            text: `Saved ${filePath ? filePath.split(/[\\/]/).pop() : defaultName} · ${plural(librarySize, 'game')}`,
            action: filePath && show ? { label: 'Show file', run: () => { void show(filePath); } } : undefined,
          });
        } else if (!result.canceled) {
          onToast({ text: result.error || 'Failed', tone: 'fault' });
        }
      } else {
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = defaultName;
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        onToast({ text: `Saved ${defaultName} · ${plural(librarySize, 'game')}` });
      }
    } catch {
      onToast({ text: 'Failed to export', tone: 'fault' });
    } finally {
      setExporting(false);
    }
  }, [onToast]);

  const failImport = useCallback((text: string) => {
    onToast({ text, tone: 'fault', action: { label: 'Try another', run: () => importAgain.current() } });
  }, [onToast]);

  /** Step 1: parse the picked file and ask before anything is replaced. */
  const reviewContent = useCallback((content: string) => {
    const parsed = libraryStore.parseImport(content);
    if (!parsed.success) {
      failImport(parsed.error);
      return;
    }
    setPendingPlan(parsed.plan);
  }, [failImport]);

  const handleImport = useCallback(async () => {
    setImporting(true);
    try {
      if (window.fileDialog) {
        const result = await window.fileDialog.openFile({ filters: [{ name: 'JSON Files', extensions: ['json'] }] });
        if (result.canceled) return;
        if (!result.success || !result.content) failImport(result.error || 'Failed');
        else reviewContent(result.content);
      } else {
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (!file) return;
          try { reviewContent(await file.text()); }
          catch { failImport('Failed'); }
        };
        input.click();
      }
    } catch {
      failImport('Failed');
    } finally {
      setImporting(false);
    }
  }, [reviewContent, failImport]);
  importAgain.current = () => { void handleImport(); };

  /** Step 2 (confirmed): apply the plan. */
  const confirmImport = useCallback(() => {
    const plan = pendingPlan;
    setPendingPlan(null);
    if (!plan) return;
    const result = libraryStore.applyImport(plan);
    if (result.success) {
      onToast({ text: describeResult(result, 'Imported') });
      setCanRestore(libraryStore.getLastImportSnapshot() !== null);
      gameService.backfillLibraryMissingCachedMeta().catch(() => { /* non-blocking */ });
    } else {
      onToast({ text: result.error || 'Failed', tone: 'fault' });
    }
  }, [pendingPlan, onToast]);

  const cancelImport = useCallback(() => setPendingPlan(null), []);

  const handleRestore = useCallback(() => {
    const result = libraryStore.restoreLastImportSnapshot();
    if (result.success) {
      onToast({ text: describeResult(result, 'Restored') });
      gameService.backfillLibraryMissingCachedMeta().catch(() => { /* non-blocking */ });
    } else {
      onToast({ text: result.error || 'Failed', tone: 'fault' });
    }
    setCanRestore(libraryStore.getLastImportSnapshot() !== null);
  }, [onToast]);

  return (
    <>
      <Row
        settingId="backup"
        label="Backup"
        desc="A JSON file. Import replaces your library with the file's games, plus the journey, sessions and status history it contains. You are asked first, and a copy of the current library is kept so you can restore it."
        control={(
          <div className="inline">
            <button type="button" className="btn" onClick={() => void handleExport()} disabled={exporting}>
              {exporting ? <Spinner /> : <Icon d={ICON.download} />}Export
            </button>
            <button type="button" className="btn" onClick={() => void handleImport()} disabled={importing}>
              {importing ? <Spinner /> : <Icon d={ICON.upload} />}Import
            </button>
          </div>
        )}
      />
      {canRestore && (
        <Row
          label="Restore previous library"
          desc="Puts back the copy kept before your last import."
          control={<button type="button" className="btn" onClick={handleRestore}><Icon d={ICON.replay} />Restore</button>}
        />
      )}
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
