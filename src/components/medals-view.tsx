/**
 * Medals of Honor — the Badge Vault.
 *
 * Badge progress is derived from the journey entries plus the status-history, session and library
 * stores; the view re-derives whenever any of those stores change.
 */
import { memo, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import type { JourneyEntry } from '@/types/game';
import { statusHistoryStore } from '@/services/status-history-store';
import { sessionStore } from '@/services/session-store';
import { libraryStore } from '@/services/library-store';
import { useBadgeProgress } from '@/hooks/useBadgeProgress';
import { BadgeVault } from '@/components/medals/badge-vault';
import { cn } from '@/lib/utils';

interface MedalsViewProps {
  entries: JourneyEntry[];
}

// ─── Tile wrapper ───────────────────────────────────────────────────────────

function Tile({ children, className, delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div
      className={cn('rounded-2xl border border-white/[0.06] bg-white/[0.015] backdrop-blur-sm overflow-hidden', className)}
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

// ─── Main View ──────────────────────────────────────────────────────────────

export const MedalsView = memo(function MedalsView({ entries }: MedalsViewProps) {
  const [statusHistory, setStatusHistory] = useState(() => statusHistoryStore.getAll());
  const [sessions, setSessions] = useState(() => sessionStore.getAll());
  const [libraryEntries, setLibraryEntries] = useState(() => libraryStore.getAllEntries());

  useEffect(() => {
    const unsubs = [
      statusHistoryStore.subscribe(() => setStatusHistory(statusHistoryStore.getAll())),
      sessionStore.subscribe(() => setSessions(sessionStore.getAll())),
      libraryStore.subscribe(() => setLibraryEntries(libraryStore.getAllEntries())),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  const data = useBadgeProgress(entries, statusHistory, sessions, libraryEntries);

  return (
    <div className="flex flex-col gap-2 px-2 md:px-4 lg:px-6 pb-2 min-h-0 flex-1 h-[calc(100vh-12rem)] overflow-hidden">
      <div className="flex-1 min-h-0 overflow-auto">
        <Tile className="p-4" delay={0}>
          <BadgeVault badges={data.badges} unlockedCount={data.unlockedCount} />
        </Tile>
      </div>
    </div>
  );
});
