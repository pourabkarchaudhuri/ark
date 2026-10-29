/**
 * HowLongToBeat client (main process).
 *
 * HowLongToBeat has no official API; this uses the same two calls its own search page makes:
 *   GET  /api/search/site/init?t=<ms>   → { token }
 *   POST /api/search/site               (x-auth-token: token) → { data: [...] }
 * Ark identifies itself honestly (its own User-Agent). Traffic is kept minimal: lookups happen only
 * when a game page is opened, results are cached on disk for 30 days (misses for a day), requests go
 * one at a time, and any refusal (403 after a token refresh, 429, 5xx, unexpected response shape)
 * opens a 30-minute circuit breaker. If the site changes, only the constants below need updating.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
import { logger } from './safe-logger.js';

// ---------------------------------------------------------------------------
// Endpoint constants — the only part that changes when the site does.
// ---------------------------------------------------------------------------
const HLTB_BASE = 'https://howlongtobeat.com';
const INIT_PATH = '/api/search/site/init';
const SEARCH_PATH = '/api/search/site';
const TOKEN_MAX_AGE_MS = 30 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_SPACING_MS = 500;
const BREAKER_MS = 30 * 60 * 1000;
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 'v1';

export interface HltbQuery {
  title: string;
  /** Release year, used to tell remakes/sequels with the same name apart. */
  year?: number;
}

export interface HltbTimes {
  hltbId: number;
  name: string;
  year?: number;
  /** Hours; null when HowLongToBeat has no data for that play style. */
  mainHours: number | null;
  mainExtraHours: number | null;
  completionistHours: number | null;
  allStylesHours: number | null;
  url: string;
}

export interface HltbCacheLike {
  get<T>(key: string, allowStale?: boolean): T | null;
  set<T>(key: string, data: T, ttl: number): void;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

interface Deps {
  fetch: FetchFn;
  cache: HltbCacheLike;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  userAgent: string;
}

// ---------------------------------------------------------------------------
// Title matching
// ---------------------------------------------------------------------------
// Store-page edition suffixes that HowLongToBeat lists under the base game. "Remastered"/"Remake" are
// separate HLTB entries, so they are kept. Applied after apostrophes are removed.
const EDITION_RE = /\b(game of the year|goty|definitive|complete|deluxe|ultimate|enhanced|anniversary|gold|standard|special|collectors?|digital deluxe) edition\b|\bgame of the year\b|\bgoty\b|\bdirectors cut\b/g;
const ROMAN: Record<string, string> = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };

export function normalizeHltbTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/'/g, '')
    .replace(EDITION_RE, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ROMAN[t] ?? t)
    .join(' ');
}

/**
 * Words to search for: the title without trademark marks, punctuation and store edition suffixes
 * (HowLongToBeat's search does not match "Duty®:" or "Game of the Year Edition"). Roman numerals are
 * kept as written: the site lists "Modern Warfare II" and "Modern Warfare 2" as different games.
 */
export function hltbSearchTerms(title: string): string[] {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[™®©]/g, '')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/'/g, '')
    .toLowerCase()
    .replace(EDITION_RE, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);
}

function dice(a: string, b: string): number {
  const ta = a.split(' ');
  const tb = new Set(b.split(' '));
  if (ta.length === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return (2 * common) / (ta.length + tb.size);
}

interface RawGame {
  game_id: number;
  game_name: string;
  game_alias?: string;
  game_type?: string;
  release_world?: number;
  comp_main?: number;
  comp_plus?: number;
  comp_100?: number;
  comp_all?: number;
}

function isRawGame(v: unknown): v is RawGame {
  const g = v as RawGame;
  return !!g && typeof g.game_id === 'number' && typeof g.game_name === 'string';
}

/** Best confident match for the query, or null when nothing is close enough (never guess). */
export function pickBestMatch(query: HltbQuery, games: RawGame[]): RawGame | null {
  const q = normalizeHltbTitle(query.title);
  if (!q) return null;
  let best: { g: RawGame; score: number } | null = null;
  for (const g of games) {
    if (g.game_type && g.game_type !== 'game') continue; // DLC, mods, compilations
    const names = [g.game_name, ...(g.game_alias ? g.game_alias.split(',') : [])].map(normalizeHltbTitle);
    let score = Math.max(...names.map((n) => (n === q ? 1 : dice(q, n))));
    const year = typeof g.release_world === 'number' && g.release_world > 0 ? g.release_world : undefined;
    if (query.year && year) {
      const diff = Math.abs(query.year - year);
      if (diff <= 1) score += 0.1;
      else if (diff > 2) score -= 0.5; // same name, different game (remake / reboot)
    }
    if (!best || score > best.score) best = { g, score };
  }
  if (!best) return null;
  const year = best.g.release_world;
  const yearConfirmed = !!query.year && typeof year === 'number' && Math.abs(query.year - year) <= 1;
  if (best.score >= 0.95 || (best.score >= 0.75 && yearConfirmed)) return best.g;
  return null;
}

const toHours = (seconds: number | undefined): number | null =>
  typeof seconds === 'number' && seconds > 0 ? Math.round((seconds / 3600) * 10) / 10 : null;

function toTimes(g: RawGame): HltbTimes {
  return {
    hltbId: g.game_id,
    name: g.game_name,
    year: typeof g.release_world === 'number' && g.release_world > 0 ? g.release_world : undefined,
    mainHours: toHours(g.comp_main),
    mainExtraHours: toHours(g.comp_plus),
    completionistHours: toHours(g.comp_100),
    allStylesHours: toHours(g.comp_all),
    url: `${HLTB_BASE}/game/${g.game_id}`,
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
export class HltbClient {
  private token: { value: string; at: number } | null = null;
  private breakerUntil = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private inflight = new Map<string, Promise<HltbTimes | null>>();

  constructor(private deps: Deps) {}

  /** Times for a game, or null (unknown game, no confident match, or HowLongToBeat unavailable). */
  getTimes(query: HltbQuery): Promise<HltbTimes | null> {
    const key = `hltb:${CACHE_VERSION}:${normalizeHltbTitle(query.title)}|${query.year ?? ''}`;
    const cached = this.deps.cache.get<{ times: HltbTimes | null }>(key);
    if (cached) return Promise.resolve(cached.times);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.lookup(query, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async lookup(query: HltbQuery, key: string): Promise<HltbTimes | null> {
    if (this.deps.now() < this.breakerUntil) {
      return this.deps.cache.get<{ times: HltbTimes | null }>(key, true)?.times ?? null;
    }
    try {
      const games = await this.search(query.title);
      const match = pickBestMatch(query, games);
      const times = match ? toTimes(match) : null;
      this.deps.cache.set(key, { times }, times ? HIT_TTL_MS : MISS_TTL_MS);
      return times;
    } catch (err) {
      this.breakerUntil = this.deps.now() + BREAKER_MS;
      logger.warn(`[HLTB] Lookup failed; pausing HowLongToBeat requests for 30 min: ${(err as Error).message}`);
      // Serve a stale cached answer if there is one; never cache the failure itself.
      return this.deps.cache.get<{ times: HltbTimes | null }>(key, true)?.times ?? null;
    }
  }

  /** Requests run one at a time, spaced out. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestAt + REQUEST_SPACING_MS - this.deps.now();
      if (wait > 0) await this.deps.sleep(wait);
      try {
        return await fn();
      } finally {
        this.lastRequestAt = this.deps.now();
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.deps.fetch(`${HLTB_BASE}${path}`, {
        ...init,
        headers: {
          'User-Agent': this.deps.userAgent,
          Referer: `${HLTB_BASE}/`,
          Origin: HLTB_BASE,
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async readJson(res: Response): Promise<unknown> {
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('response too large');
    return JSON.parse(text);
  }

  private async getToken(force = false): Promise<string> {
    if (!force && this.token && this.deps.now() - this.token.at < TOKEN_MAX_AGE_MS) return this.token.value;
    const res = await this.serial(() => this.request(`${INIT_PATH}?t=${this.deps.now()}`));
    if (!res.ok) throw new Error(`token request answered HTTP ${res.status}`);
    const body = (await this.readJson(res)) as { token?: unknown };
    if (typeof body?.token !== 'string' || !body.token) throw new Error('token response has an unexpected shape');
    this.token = { value: body.token, at: this.deps.now() };
    return body.token;
  }

  private async search(title: string): Promise<RawGame[]> {
    const body = JSON.stringify({
      searchType: 'games',
      searchTerms: hltbSearchTerms(title),
      searchPage: 1,
      size: 10,
      searchOptions: {
        games: {
          userId: 0, platform: '', sortCategory: 'popular', rangeCategory: 'main', rangeTime: { min: null, max: null },
          gameplay: { perspective: '', flow: '', genre: '', difficulty: '' }, rangeYear: { min: '', max: '' }, modifier: '',
        },
        users: { sortCategory: 'postcount' }, lists: { sortCategory: 'follows' }, filter: '', sort: 0, randomizer: 0,
      },
      useCache: true,
    });
    const post = (token: string) => this.serial(() => this.request(SEARCH_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
      body,
    }));
    let res = await post(await this.getToken());
    if (res.status === 403) res = await post(await this.getToken(true)); // token expired: refresh once
    if (!res.ok) throw new Error(`search answered HTTP ${res.status}`);
    const json = (await this.readJson(res)) as { data?: unknown };
    if (!Array.isArray(json?.data)) throw new Error('search response has an unexpected shape');
    return json.data.filter(isRawGame);
  }
}

// ---------------------------------------------------------------------------
// Default instance (Electron net stack + disk cache)
// ---------------------------------------------------------------------------
let defaultClient: HltbClient | null = null;

export async function getHltbClient(): Promise<HltbClient> {
  if (defaultClient) return defaultClient;
  const { PersistentCache } = await import('./persistent-cache.js');
  const cache = new PersistentCache('hltb-cache.json');
  const version = electron?.app?.getVersion?.() ?? '0';
  const netFetch = electron?.net?.fetch as FetchFn | undefined;
  defaultClient = new HltbClient({
    fetch: netFetch ? (u, i) => netFetch(u, i) : (u, i) => fetch(u, i),
    cache,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    userAgent: `Ark/${version} (+https://github.com/pourabkarchaudhuri/ark)`,
  });
  return defaultClient;
}
