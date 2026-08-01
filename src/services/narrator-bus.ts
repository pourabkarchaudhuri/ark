/**
 * NarratorBus
 *
 * Fact-sheet → template narration for Codex (Curator voice). Deterministic, instant, offline.
 *
 * Voices:
 *   - Curator (formal, past, 3rd person — Codex spreads)
 */

import { gameGraphStore } from './game-graph-store';
import { libraryStore } from './library-store';
import { journeyStore } from './journey-store';
import type { GameStatus } from '@/types/game';
import type { StellarClass } from '@/components/ann-graph-view';

export interface FactSheet {
  gameId: string;
  title: string;
  status: GameStatus | null;
  hoursPlayed: number;
  lastPlayedAt: string | null;
  /** Days since lastPlayedAt. Infinity when never played. */
  daysSinceLastPlay: number;
  /** Louvain community id; -1 when graph not built. */
  community: number;
  /** Normalized PageRank in [0, 1]. */
  pageRankNorm: number;
  /** PR delta in [-1, 1]. 0 when no PPR seed. */
  prDelta: number;
  /** Authority normalized in [0, 1]. */
  authorityNorm: number;
  /** Hub normalized in [0, 1]. */
  hubNorm: number;
  /** Sampled betweenness percentile rank ∈ [0, 1]. 0 when betweenness unavailable. */
  betweennessRank: number;
  /** Stellar classification if assigned. */
  stellarClass: StellarClass | null;
}

type Context =
  | 'firstVisit'
  | 'recentReturn'
  | 'longAbsence'
  | 'broker'
  | 'completed'
  | 'abandoned'
  | 'unowned';

/** Deterministic template pick: hash gameId into the array index so a node always speaks the same line. */
function pickTemplate(templates: readonly string[], gameId: string): string {
  let h = 5381;
  for (let i = 0; i < gameId.length; i++) h = ((h << 5) + h + gameId.charCodeAt(i)) >>> 0;
  return templates[h % templates.length];
}

function renderTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

class NarratorBus {
  /** Mass max for PageRank normalization — recomputed when graph rebuilds. */
  private _prMax = 1e-9;
  private _authMax = 1e-9;
  private _hubMax = 1e-9;
  private _bcMax = 1e-9;
  private _unsubs: Array<() => void> = [];
  private _initialized = false;

  init(): void {
    if (this._initialized) return;
    this._initialized = true;
    this._refreshNorms();
    this._unsubs.push(gameGraphStore.subscribe(() => {
      this._refreshNorms();
    }));
  }

  dispose(): void {
    for (const u of this._unsubs) u();
    this._unsubs = [];
    this._initialized = false;
  }

  private _refreshNorms(): void {
    const buffers = gameGraphStore.getScoreBuffers();
    if (!buffers) {
      this._prMax = 1e-9; this._authMax = 1e-9; this._hubMax = 1e-9; this._bcMax = 1e-9;
      return;
    }
    let pr = 1e-9, au = 1e-9, hu = 1e-9;
    for (let i = 0; i < buffers.pageRank.length; i++) {
      if (buffers.pageRank[i] > pr) pr = buffers.pageRank[i];
      if (buffers.authority[i] > au) au = buffers.authority[i];
      if (buffers.hub[i] > hu) hu = buffers.hub[i];
    }
    this._prMax = pr; this._authMax = au; this._hubMax = hu;
    const nb = gameGraphStore.getNodeBetweenness();
    let bc = 1e-9;
    if (nb) for (let i = 0; i < nb.length; i++) if (nb[i] > bc) bc = nb[i];
    this._bcMax = bc;
  }

  /**
   * Build a structured fact sheet for a game. Pure data — no narration generated yet.
   */
  buildFactSheet(gameId: string, title?: string): FactSheet {
    const entry = libraryStore.getEntry(gameId);
    const journey = journeyStore.getEntry(gameId);
    const scores = gameGraphStore.getScores(gameId);
    const buffers = gameGraphStore.getScoreBuffers();

    let lastPlayedAt: string | null = null;
    let daysSinceLastPlay = Infinity;
    if (entry?.lastPlayedAt) {
      lastPlayedAt = entry.lastPlayedAt;
      daysSinceLastPlay = (Date.now() - new Date(entry.lastPlayedAt).getTime()) / 86_400_000;
    } else if (journey?.lastPlayedAt) {
      lastPlayedAt = journey.lastPlayedAt;
      daysSinceLastPlay = (Date.now() - new Date(journey.lastPlayedAt).getTime()) / 86_400_000;
    }

    let betweennessRank = 0;
    if (buffers && this._bcMax > 0) {
      const nb = gameGraphStore.getNodeBetweenness();
      const idx = buffers.nodeIds.indexOf(gameId);
      if (idx >= 0 && nb) betweennessRank = nb[idx] / this._bcMax;
    }

    return {
      gameId,
      title: title || entry?.cachedMeta?.title || journey?.title || gameId,
      status: entry?.status ?? null,
      hoursPlayed: entry?.hoursPlayed ?? journey?.hoursPlayed ?? 0,
      lastPlayedAt,
      daysSinceLastPlay,
      community: scores?.community ?? -1,
      pageRankNorm: scores ? Math.min(1, scores.pageRank / this._prMax) : 0,
      prDelta: scores?.personalizedPageRank
        ? Math.max(-1, Math.min(1, this._deltaFor(gameId)))
        : 0,
      authorityNorm: scores ? Math.min(1, scores.authority / this._authMax) : 0,
      hubNorm: scores ? Math.min(1, scores.hub / this._hubMax) : 0,
      betweennessRank,
      stellarClass: null, // Set by Galaxy view via setStellarClass(); avoids circular import
    };
  }

  private _deltaFor(gameId: string): number {
    const prd = gameGraphStore.getPRDelta();
    if (!prd) return 0;
    const buffers = gameGraphStore.getScoreBuffers();
    if (!buffers) return 0;
    const idx = buffers.nodeIds.indexOf(gameId);
    return idx >= 0 ? prd[idx] : 0;
  }

  private _chooseContext(facts: FactSheet): Context {
    if (facts.status === 'Completed') return 'completed';
    if (facts.status === 'On Hold' && facts.hoursPlayed > 0) return 'abandoned';
    if (!facts.status) return facts.betweennessRank > 0.55 ? 'broker' : 'unowned';
    if (facts.daysSinceLastPlay === Infinity) return 'firstVisit';
    if (facts.daysSinceLastPlay > 60) return 'longAbsence';
    if (facts.betweennessRank > 0.55) return 'broker';
    return 'recentReturn';
  }

  /**
   * Curator voice — formal, past tense, 3rd person. For Codex spreads.
   * Returns a left page (classification flavor) + right page (narrative observation).
   */
  getCuratorSpread(gameId: string, communityName?: string, stellarClass?: StellarClass): { left: string; right: string } {
    const facts = this.buildFactSheet(gameId);
    if (stellarClass) facts.stellarClass = stellarClass;

    const leftTemplates: Record<string, string[]> = {
      hypergiant: [
        'A hypergiant of the {{communityName}}. Its gravity well shaped a generation of designs.',
        'Catalogued in the {{communityName}}. Its emissions defined the territory.',
      ],
      quasar: [
        'A quasar — bright across every frame. The {{communityName}} routes through it.',
        'Multiple constellations cite this body as their origin point.',
      ],
      pulsar: [
        'A pulsar of the {{communityName}}. Its frequency is its own.',
        'Burns hot in a corner few have charted. A cult-class luminary.',
      ],
      neutronstar: [
        'A neutron star of the {{communityName}}. Tight, dense, devoted.',
        'Niche-cluster icon. Coordinates yielded only to those who looked.',
      ],
      mdwarf: [
        'An M-class dwarf. Steady warmth on the inner edge of the {{communityName}}.',
        'Standard catalog entry. Notable for its constancy.',
      ],
    };
    const rightTemplates: Record<Context, string[]> = {
      completed: [
        'Reached its terminal arc on {{lastDate}}. Conquered after {{hours}}h.',
        'A traversal completed. {{hours}}h, then quiet.',
      ],
      abandoned: [
        'Last seen {{daysAgo}} days ago. {{hours}}h logged. The probe found no further activity.',
        'Set aside. The catalog notes {{hours}}h before the silence.',
      ],
      firstVisit: [
        'No prior contact. The probe begins its survey.',
        'Untouched by the pilot. Its surface remains unobserved.',
      ],
      recentReturn: [
        'Recently visited. {{hours}}h to date. The pilot returns.',
        'Active. The corona recognizes the pilot.',
      ],
      longAbsence: [
        'Untouched for {{daysAgo}} days. The corona has dimmed.',
        'Last recorded activity: {{daysAgo}} days past. The body waits.',
      ],
      broker: [
        'A bridge. Its function matters more than its substance.',
        'A node of passage. The pilot has crossed here, perhaps unaware.',
      ],
      unowned: [
        'Beyond the pilot’s holdings. Catalogued for completeness.',
        'Outside the surveyed range. Coordinates retained for future contact.',
      ],
    };

    const classKey = (facts.stellarClass ?? 'MDwarf').toLowerCase();
    const leftBank = leftTemplates[classKey] ?? leftTemplates.mdwarf;
    const leftTpl = pickTemplate(leftBank, gameId);
    const ctx = this._chooseContext(facts);
    const rightTpl = pickTemplate(rightTemplates[ctx], gameId);
    const vars = {
      communityName: communityName || 'unmapped reach',
      hours: facts.hoursPlayed.toFixed(facts.hoursPlayed < 10 ? 1 : 0),
      daysAgo: facts.daysSinceLastPlay === Infinity ? 'many' : Math.floor(facts.daysSinceLastPlay),
      lastDate: facts.lastPlayedAt ? new Date(facts.lastPlayedAt).toLocaleDateString() : '—',
    };
    return {
      left: renderTemplate(leftTpl, vars),
      right: renderTemplate(rightTpl, vars),
    };
  }
}

export const narratorBus = new NarratorBus();
