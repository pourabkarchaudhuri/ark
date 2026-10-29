/**
 * gg.deals prices (main process: electron/ggdeals-api.ts).
 */
export interface GgDealsPrice {
  title: string;
  url: string;
  currency: string;
  currentRetail: number | null;
  currentKeyshops: number | null;
  historicalRetail: number | null;
  historicalKeyshops: number | null;
}

export type GgDealsError = 'no-key' | 'invalid-key' | 'unavailable';

export interface GgDealsResult {
  prices: Record<string, GgDealsPrice | null>;
  error?: GgDealsError;
}

declare global {
  interface Window {
    ggdeals?: {
      hasKey: () => Promise<boolean>;
      setKey: (key: string) => Promise<{ success: boolean; error?: string }>;
      clearKey: () => Promise<{ success: boolean }>;
      testKey: () => Promise<{ ok: boolean; error?: GgDealsError | 'wait' }>;
      getPrices: (steamAppIds: number[], region?: string) => Promise<GgDealsResult>;
    };
  }
}

export {};
