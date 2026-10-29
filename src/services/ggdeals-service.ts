/**
 * gg.deals prices in the renderer: one place that batches lookups from every card on screen into a
 * few IPC calls, keeps an in-session cache, and holds the user's display choices (region, keyshops).
 * The API key itself lives only in the main process.
 */
import type { GgDealsError, GgDealsPrice } from '@/types/ggdeals';

export const GG_REGION_LS_KEY = 'ark:ggdealsRegion';
export const GG_KEYSHOPS_LS_KEY = 'ark:ggdealsKeyshops';
export const GG_REGIONS = [
  { value: 'us', label: 'United States (USD)' },
  { value: 'gb', label: 'United Kingdom (GBP)' },
  { value: 'eu', label: 'Europe (EUR)' },
  { value: 'de', label: 'Germany (EUR)' },
  { value: 'fr', label: 'France (EUR)' },
  { value: 'pl', label: 'Poland (PLN)' },
  { value: 'ca', label: 'Canada (CAD)' },
  { value: 'au', label: 'Australia (AUD)' },
  { value: 'br', label: 'Brazil (BRL)' },
  { value: 'in', label: 'India (INR)' },
] as const;

const BATCH_DELAY_MS = 40;
const BATCH_MAX = 100;
const SESSION_TTL_MS = 60 * 60 * 1000;

function lsGet(key: string): string | null {
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export function getGgRegion(): string {
  const v = lsGet(GG_REGION_LS_KEY);
  return GG_REGIONS.some((r) => r.value === v) ? (v as string) : 'us';
}

export function getShowKeyshops(): boolean {
  return lsGet(GG_KEYSHOPS_LS_KEY) === 'true';
}

/** Format an amount in the price's own currency (never converted). */
export function formatDealPrice(amount: number, currency: string): string {
  if (amount === 0) return 'Free';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Is the current official price at (or within 2% of) its all-time low? */
export function isAtHistoricalLow(p: GgDealsPrice): boolean {
  return p.currentRetail !== null && p.historicalRetail !== null && p.currentRetail > 0
    && p.currentRetail <= p.historicalRetail * 1.02;
}

/** The price to headline: the official price, or a cheaper keyshop price when keyshops are shown. */
export function headlinePrice(p: GgDealsPrice, includeKeyshops: boolean): { amount: number; keyshop: boolean } | null {
  const retail = p.currentRetail;
  const keyshop = includeKeyshops ? p.currentKeyshops : null;
  if (retail !== null && (keyshop === null || retail <= keyshop)) return { amount: retail, keyshop: false };
  if (keyshop !== null) return { amount: keyshop, keyshop: true };
  return null;
}

type Listener = () => void;

class GgDealsService {
  private cache = new Map<string, { price: GgDealsPrice | null; at: number }>();
  private pending = new Map<number, Array<(p: GgDealsPrice | null) => void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private keyState: boolean | null = null;
  private lastError: GgDealsError | null = null;
  private listeners = new Set<Listener>();

  get available(): boolean {
    return typeof window !== 'undefined' && !!window.ggdeals && typeof window.ggdeals.getPrices === 'function';
  }

  /** Whether a key is saved (cached; refreshed by Settings after changes). */
  async hasKey(): Promise<boolean> {
    if (!this.available) return false;
    if (this.keyState === null) {
      try {
        this.keyState = await window.ggdeals!.hasKey();
      } catch {
        this.keyState = false;
      }
    }
    return this.keyState;
  }

  /** Call after the key or display settings change: clears caches and re-renders subscribers. */
  settingsChanged(): void {
    this.keyState = null;
    this.lastError = null;
    this.cache.clear();
    this.listeners.forEach((l) => l());
  }

  setRegion(region: string): void {
    lsSet(GG_REGION_LS_KEY, region);
    this.settingsChanged();
  }

  setShowKeyshops(show: boolean): void {
    lsSet(GG_KEYSHOPS_LS_KEY, show ? 'true' : 'false');
    this.listeners.forEach((l) => l());
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get error(): GgDealsError | null {
    return this.lastError;
  }

  private key(appId: number) {
    return `${getGgRegion()}:${appId}`;
  }

  /** Cached price if known: undefined = not looked up yet, null = no deal data. */
  peek(appId: number): GgDealsPrice | null | undefined {
    const hit = this.cache.get(this.key(appId));
    return hit && Date.now() - hit.at < SESSION_TTL_MS ? hit.price : undefined;
  }

  /** One game's price; concurrent calls from many cards are batched into one IPC request. */
  async getPrice(appId: number): Promise<GgDealsPrice | null> {
    const known = this.peek(appId);
    if (known !== undefined) return known;
    if (!(await this.hasKey())) return null;
    return new Promise((resolve) => {
      const list = this.pending.get(appId) ?? [];
      list.push(resolve);
      this.pending.set(appId, list);
      if (this.pending.size >= BATCH_MAX) this.flush();
      else if (!this.timer) this.timer = setTimeout(() => this.flush(), BATCH_DELAY_MS);
    });
  }

  /** Many prices at once (Oracle pre-worker step). Missing ids = no deal data. */
  async getPrices(appIds: number[]): Promise<Map<number, GgDealsPrice>> {
    const out = new Map<number, GgDealsPrice>();
    if (!(await this.hasKey())) return out;
    const results = await Promise.all(appIds.map((id) => this.getPrice(id).then((p) => [id, p] as const)));
    for (const [id, p] of results) if (p) out.set(id, p);
    return out;
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = [...this.pending.entries()].slice(0, BATCH_MAX);
    for (const [id] of batch) this.pending.delete(id);
    if (this.pending.size > 0) this.timer = setTimeout(() => this.flush(), BATCH_DELAY_MS);
    if (batch.length === 0) return;
    const ids = batch.map(([id]) => id);
    const settle = (prices: Record<string, GgDealsPrice | null>) => {
      const at = Date.now();
      for (const [id, resolvers] of batch) {
        const p = prices[String(id)] ?? null;
        if (String(id) in prices) this.cache.set(this.key(id), { price: p, at });
        resolvers.forEach((r) => r(p));
      }
    };
    window.ggdeals!.getPrices(ids, getGgRegion())
      .then((res) => {
        this.lastError = res.error ?? null;
        if (res.error === 'invalid-key' || res.error === 'no-key') this.keyState = res.error === 'no-key' ? false : this.keyState;
        settle(res.prices ?? {});
      })
      .catch(() => settle({}));
  }
}

export const ggDealsService = new GgDealsService();
