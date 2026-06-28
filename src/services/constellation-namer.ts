/**
 * Constellation Namer
 *
 * Generates human-readable names for Louvain communities, cached deterministically
 * by community-membership hash so names only regenerate when membership actually
 * shifts (a Louvain rerun on identical edges produces identical names).
 *
 * Two-tier strategy:
 *  - **Template tier** (instant, offline): "The {topGenre} {suffix}" using the dominant
 *    genre of each community's top-PR games. Always available.
 *  - **AI tier** (future): LangChain prompt batched through ai-handlers. Slots in
 *    cleanly because both tiers write through the same cache and emit the same shape.
 *
 * This commit ships the template tier + cache scaffolding. AI tier ready to wire when
 * NarratorBus lands (Phase 2 refinement).
 */

import type { GraphNode } from './galaxy-cache';

export interface ConstellationName {
  communityId: number;
  name: string;
  /** Centroid position of community members (x, y, z). */
  centroid: { x: number; y: number; z: number };
  /** Member count. Communities below COMMUNITY_MIN_SIZE are hidden from labeling. */
  size: number;
  /** Top genre that influenced the naming. */
  topGenre: string | null;
  /** Cache key — sha-like hash of sorted member ids. Constant for identical membership. */
  membershipHash: string;
  /** 'template' or 'ai' — lets the UI badge AI-named constellations differently. */
  source: 'template' | 'ai';
}

const DB_NAME = 'ark-constellations';
const DB_VERSION = 1;
const STORE = 'names';
const COMMUNITY_MIN_SIZE = 20; // ignore tiny clusters — labels would clutter the field

// Evocative suffixes for template names — chosen so adjacent communities don't repeat.
const SUFFIXES = ['Drift', 'Reach', 'Span', 'Expanse', 'Field', 'Hollow', 'Veil', 'Strand', 'Quarter', 'Verge'];

let dbInstance: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      dbInstance = req.result;
      dbInstance.onclose = () => { dbInstance = null; dbPromise = null; };
      dbInstance.onversionchange = () => { dbInstance?.close(); dbInstance = null; dbPromise = null; };
      resolve(dbInstance);
    };
  });
  return dbPromise;
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

async function idbPut<T>(key: string, value: T): Promise<void> {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** Deterministic, fast (djb2) hash over sorted gameIds. Cache key. */
function hashMembership(memberIds: string[]): string {
  const sorted = [...memberIds].sort();
  let h = 5381;
  for (const id of sorted) {
    for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) >>> 0;
    h = ((h << 5) + h + 124) >>> 0; // delim
  }
  return h.toString(36);
}

/** Title-case a single word. */
function titleCase(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}

/** Build a template name from a community's dominant genre. */
function buildTemplateName(topGenre: string | null, suffixIndex: number): string {
  const suffix = SUFFIXES[suffixIndex % SUFFIXES.length];
  if (!topGenre) return `The ${suffix}`;
  // Strip multi-word genres to first significant token for tightness
  const head = topGenre.split(/[\s-]/)[0];
  return `The ${titleCase(head)} ${suffix}`;
}

/**
 * Compute centroid + dominant genre for a community.
 * Dominant genre = most frequent across top-10 PR members' first genre.
 */
function summarizeCommunity(members: GraphNode[], pageRank: Float32Array | null, nodeIdToGraphIdx: Map<string, number>): {
  centroid: { x: number; y: number; z: number };
  topGenre: string | null;
} {
  let sx = 0, sy = 0, sz = 0;
  for (const m of members) { sx += m.x; sy += m.y; sz += m.z; }
  const inv = 1 / Math.max(1, members.length);
  const centroid = { x: sx * inv, y: sy * inv, z: sz * inv };

  // Top 10 by PR for genre dominance
  const ranked = pageRank
    ? [...members].sort((a, b) => {
        const ai = nodeIdToGraphIdx.get(a.id) ?? -1;
        const bi = nodeIdToGraphIdx.get(b.id) ?? -1;
        const ap = ai >= 0 ? pageRank[ai] : 0;
        const bp = bi >= 0 ? pageRank[bi] : 0;
        return bp - ap;
      }).slice(0, 10)
    : members.slice(0, 10);

  const counts = new Map<string, number>();
  for (const m of ranked) {
    const g = m.genres[0];
    if (!g) continue;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let topGenre: string | null = null;
  let topCount = 0;
  for (const [g, c] of counts) {
    if (c > topCount) { topGenre = g; topCount = c; }
  }
  return { centroid, topGenre };
}

/**
 * Main entry — group nodes by community, summarize, name (cache-first), persist.
 * Returns names ordered by descending community size.
 */
export async function generateConstellationNames(
  nodes: GraphNode[],
  community: Int32Array,
  graphNodeIds: string[],
  pageRank: Float32Array | null,
): Promise<ConstellationName[]> {
  if (!nodes.length || !community.length) return [];

  // Map graph-index nodeIds to GraphNode instances. nodes[] is the rendered set,
  // graphNodeIds[] is the community array's parallel index — these may diverge in size.
  const nodeById = new Map<string, GraphNode>();
  for (const n of nodes) nodeById.set(n.id, n);
  const nodeIdToGraphIdx = new Map<string, number>();
  for (let i = 0; i < graphNodeIds.length; i++) nodeIdToGraphIdx.set(graphNodeIds[i], i);

  // Group members by community
  const byCommunity = new Map<number, GraphNode[]>();
  for (let i = 0; i < graphNodeIds.length; i++) {
    const cid = community[i];
    if (cid < 0) continue;
    const node = nodeById.get(graphNodeIds[i]);
    if (!node) continue;
    if (!byCommunity.has(cid)) byCommunity.set(cid, []);
    byCommunity.get(cid)!.push(node);
  }

  const ordered = [...byCommunity.entries()]
    .filter(([, m]) => m.length >= COMMUNITY_MIN_SIZE)
    .sort((a, b) => b[1].length - a[1].length);

  const out: ConstellationName[] = [];
  let assignedSuffixes = 0;
  for (const [communityId, members] of ordered) {
    const memberIds = members.map((m) => m.id);
    const membershipHash = hashMembership(memberIds);
    const cacheKey = `c${communityId}-${membershipHash}`;

    let cached = await idbGet<ConstellationName>(cacheKey);
    const { centroid, topGenre } = summarizeCommunity(members, pageRank, nodeIdToGraphIdx);

    if (!cached) {
      const name = buildTemplateName(topGenre, assignedSuffixes++);
      const entry: ConstellationName = {
        communityId,
        name,
        centroid,
        size: members.length,
        topGenre,
        membershipHash,
        source: 'template',
      };
      await idbPut(cacheKey, entry);
      cached = entry;
    } else {
      // Refresh centroid (positions may have shifted slightly with new builds) but keep name + source
      cached.centroid = centroid;
      cached.size = members.length;
      cached.topGenre = topGenre;
    }
    out.push(cached);
  }
  return out;
}
