/**
 * Which Steam catalog rows the Upcoming calendar shows. Shared by the main-process query and the
 * renderer fallback so both pick exactly the same rows.
 *
 *   recent  — released between fromMs and now with >= minRecentReviews reviews (most reviewed first)
 *   future  — dated after now (nearest first)
 */
export interface UpcomingSelectOptions {
  fromMs: number;
  toMs: number;
  nowMs: number;
  minRecentReviews: number;
  maxRecent: number;
  maxFuture: number;
}

export interface UpcomingRowLike {
  releaseDate: number; // unix seconds (0 = unknown)
  reviewCount: number;
}

export class UpcomingSelector<T extends UpcomingRowLike> {
  private recent: T[] = [];
  private future: T[] = [];
  constructor(private o: UpcomingSelectOptions) {}

  admit(entry: T): void {
    const ms = (entry.releaseDate || 0) * 1000;
    if (!ms || ms < this.o.fromMs || ms > this.o.toMs) return;
    if (ms > this.o.nowMs) this.future.push(entry);
    else if ((entry.reviewCount ?? 0) >= this.o.minRecentReviews) this.recent.push(entry);
  }

  result(): T[] {
    this.recent.sort((a, b) => b.reviewCount - a.reviewCount);
    this.future.sort((a, b) => a.releaseDate - b.releaseDate);
    return [...this.recent.slice(0, this.o.maxRecent), ...this.future.slice(0, this.o.maxFuture)];
  }
}
