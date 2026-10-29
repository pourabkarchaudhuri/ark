/**
 * HowLongToBeat completion times (main process: electron/hltb-api.ts).
 */
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

declare global {
  interface Window {
    hltb?: {
      getTimes: (query: { title: string; year?: number }) => Promise<HltbTimes | null>;
    };
  }
}

export {};
