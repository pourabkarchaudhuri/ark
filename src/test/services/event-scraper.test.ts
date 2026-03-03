import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pure-logic functions extracted from electron/ipc/event-scraper-handlers.ts
 * and src/services/event-resolver-service.ts for unit testing.
 *
 * These mirror the actual implementations exactly — any change to the source
 * should be reflected here.
 */

// ─── MONTHS lookup (mirrors event-scraper-handlers.ts) ─────────────────────

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7,
  sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
  'jan.': 0, 'feb.': 1, 'mar.': 2, 'apr.': 3, 'may.': 4, 'jun.': 5,
  'jul.': 6, 'aug.': 7, 'sep.': 8, 'sept.': 8, 'oct.': 9, 'nov.': 10, 'dec.': 11,
};

// ─── extractDatesFromText (mirrors event-scraper-handlers.ts) ────────────────

interface DateCandidate { start: number; end?: number; specificity: number }

function extractDatesFromText(text: string): DateCandidate[] {
  const currentYear = new Date().getFullYear();
  const validYears = new Set([currentYear, currentYear + 1]);

  function tryMonth(name: string): number | undefined {
    return MONTHS[name.toLowerCase().replace(/\.$/, '')];
  }
  function validDay(d: number): boolean { return d >= 1 && d <= 31; }
  function validYear(y: number): boolean { return validYears.has(y); }

  const candidates: DateCandidate[] = [];
  let m: RegExpExecArray | null;

  const crossMonthUS = /\b([A-Za-z]+)\.?\s+(\d{1,2})\s*[-–—]\s*([A-Za-z]+)\.?\s+(\d{1,2}),?\s*(\d{4})\b/g;
  while ((m = crossMonthUS.exec(text)) !== null) {
    const mi1 = tryMonth(m[1]); const d1 = +m[2];
    const mi2 = tryMonth(m[3]); const d2 = +m[4]; const y = +m[5];
    if (mi1 === undefined || mi2 === undefined || !validDay(d1) || !validDay(d2) || !validYear(y)) continue;
    candidates.push({
      start: new Date(y, mi1, d1).getTime() / 1000,
      end:   new Date(y, mi2, d2, 23, 59, 59).getTime() / 1000,
      specificity: 3,
    });
  }

  const crossMonthEU = /\b(\d{1,2})\s+([A-Za-z]+)\.?\s*[-–—]\s*(\d{1,2})\s+([A-Za-z]+)\.?,?\s*(\d{4})\b/g;
  while ((m = crossMonthEU.exec(text)) !== null) {
    const d1 = +m[1]; const mi1 = tryMonth(m[2]);
    const d2 = +m[3]; const mi2 = tryMonth(m[4]); const y = +m[5];
    if (mi1 === undefined || mi2 === undefined || !validDay(d1) || !validDay(d2) || !validYear(y)) continue;
    candidates.push({
      start: new Date(y, mi1, d1).getTime() / 1000,
      end:   new Date(y, mi2, d2, 23, 59, 59).getTime() / 1000,
      specificity: 3,
    });
  }

  const rangeUS = /\b([A-Za-z]+)\.?\s+(\d{1,2})\s*[-–—]\s*(\d{1,2}),?\s*(\d{4})\b/g;
  while ((m = rangeUS.exec(text)) !== null) {
    const mi = tryMonth(m[1]); const d1 = +m[2]; const d2 = +m[3]; const y = +m[4];
    if (mi === undefined || !validDay(d1) || !validDay(d2) || !validYear(y)) continue;
    candidates.push({
      start: new Date(y, mi, d1).getTime() / 1000,
      end:   new Date(y, mi, d2, 23, 59, 59).getTime() / 1000,
      specificity: 3,
    });
  }

  const rangeEU = /\b(\d{1,2})\s*[-–—]\s*(\d{1,2})\s+([A-Za-z]+)\.?,?\s*(\d{4})\b/g;
  while ((m = rangeEU.exec(text)) !== null) {
    const d1 = +m[1]; const d2 = +m[2]; const mi = tryMonth(m[3]); const y = +m[4];
    if (mi === undefined || !validDay(d1) || !validDay(d2) || !validYear(y)) continue;
    candidates.push({
      start: new Date(y, mi, d1).getTime() / 1000,
      end:   new Date(y, mi, d2, 23, 59, 59).getTime() / 1000,
      specificity: 3,
    });
  }

  const isoRange = /\b(\d{4})[-/](\d{2})[-/](\d{2})\s*(?:[-–—]|to)\s*(\d{4})[-/](\d{2})[-/](\d{2})\b/g;
  while ((m = isoRange.exec(text)) !== null) {
    const y1 = +m[1]; const mo1 = +m[2] - 1; const d1 = +m[3];
    const y2 = +m[4]; const mo2 = +m[5] - 1; const d2 = +m[6];
    if (!validYear(y1) || !validDay(d1) || !validDay(d2)) continue;
    candidates.push({
      start: new Date(y1, mo1, d1).getTime() / 1000,
      end:   new Date(y2, mo2, d2, 23, 59, 59).getTime() / 1000,
      specificity: 3,
    });
  }

  const singleUS = /\b([A-Za-z]+)\.?\s+(\d{1,2}),?\s*(\d{4})\b/g;
  while ((m = singleUS.exec(text)) !== null) {
    const mi = tryMonth(m[1]); const d = +m[2]; const y = +m[3];
    if (mi === undefined || !validDay(d) || !validYear(y)) continue;
    candidates.push({ start: new Date(y, mi, d).getTime() / 1000, specificity: 2 });
  }

  const singleEU = /\b(\d{1,2})\s+([A-Za-z]+)\.?,?\s*(\d{4})\b/g;
  while ((m = singleEU.exec(text)) !== null) {
    const d = +m[1]; const mi = tryMonth(m[2]); const y = +m[3];
    if (mi === undefined || !validDay(d) || !validYear(y)) continue;
    candidates.push({ start: new Date(y, mi, d).getTime() / 1000, specificity: 2 });
  }

  const isoSingle = /\b(\d{4})[-/](\d{2})[-/](\d{2})(?:\b|T)/g;
  while ((m = isoSingle.exec(text)) !== null) {
    const y = +m[1]; const mo = +m[2] - 1; const d = +m[3];
    if (!validYear(y) || !validDay(d) || mo < 0 || mo > 11) continue;
    candidates.push({ start: new Date(y, mo, d).getTime() / 1000, specificity: 2 });
  }

  const monthYear = /\b([A-Za-z]+)\.?\s+(\d{4})\b/g;
  while ((m = monthYear.exec(text)) !== null) {
    const mi = tryMonth(m[1]); const y = +m[2];
    if (mi === undefined || !validYear(y)) continue;
    candidates.push({ start: new Date(y, mi, 1).getTime() / 1000, specificity: 1 });
  }

  return candidates;
}

function extractDates(html: string, cleanedText: string): { start?: number; end?: number } {
  const metaContents: string[] = [];
  const metaRe = /<meta[^>]*content=["']([^"']{10,300})["'][^>]*>/gi;
  let mm: RegExpExecArray | null;
  while ((mm = metaRe.exec(html)) !== null) metaContents.push(mm[1]);

  const scriptContents: string[] = [];
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let sc: RegExpExecArray | null;
  while ((sc = scriptRe.exec(html)) !== null) {
    const content = sc[1];
    if (content.length > 10 && content.length < 200_000) scriptContents.push(content);
  }

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleText = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

  const unescape = (s: string) => s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—').replace(/&#8211;/g, '–').replace(/&#8212;/g, '—')
    .replace(/\\u002F/g, '/').replace(/\\u0026/g, '&')
    .replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\s+/g, ' ');

  const allText = [
    cleanedText,
    titleText,
    ...metaContents,
    ...scriptContents.map(unescape),
  ].join(' \n ');

  const candidates = extractDatesFromText(allText);
  if (candidates.length === 0) return {};

  const now = Date.now() / 1000;
  const future = candidates.filter((c) => c.start >= now || (c.end && c.end >= now));

  if (future.length > 0) {
    future.sort((a, b) => b.specificity - a.specificity || a.start - b.start);
    const best = future[0];
    return { start: best.start, end: best.end };
  }

  candidates.sort((a, b) => b.start - a.start);
  return { start: candidates[0].start, end: candidates[0].end };
}

// ─── extractLinks (mirrors event-scraper-handlers.ts) ───────────────────────

function extractLinks(html: string): { youtubeUrls: string[]; twitchUrls: string[] } {
  const ytSet = new Set<string>();
  const twitchSet = new Set<string>();

  const ytRe = /(?:href|src)=["'](https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|live\/|channel\/|@)|youtu\.be\/)[^"'\s]+)["']/gi;
  const twRe = /(?:href|src)=["'](https?:\/\/(?:www\.)?twitch\.tv\/[^"'\s]+)["']/gi;

  let m: RegExpExecArray | null;
  while ((m = ytRe.exec(html)) !== null) ytSet.add(m[1].replace(/&amp;/g, '&'));
  while ((m = twRe.exec(html)) !== null) twitchSet.add(m[1].replace(/&amp;/g, '&'));

  return { youtubeUrls: [...ytSet], twitchUrls: [...twitchSet] };
}

// ─── URL validation (mirrors event-scraper-handlers.ts) ─────────────────────

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ─── computeStatus (mirrors event-resolver-service.ts) ──────────────────────

type EventStatus = 'upcoming' | 'live' | 'past' | 'unknown';

function computeStatus(start?: number, end?: number): EventStatus {
  if (!start) return 'unknown';
  const now = Date.now() / 1000;
  const effectiveEnd = end ?? start + 86_400;
  if (now >= start && now <= effectiveEnd) return 'live';
  if (now < start) return 'upcoming';
  return 'past';
}

// ─── refreshStatuses (mirrors event-resolver-service.ts) ────────────────────

interface ResolvedEventLike {
  status: EventStatus;
  startDate?: number;
  endDate?: number;
}

function refreshStatuses<T extends ResolvedEventLike>(events: T[]): T[] {
  let changed = false;
  const next = events.map((ev) => {
    const newStatus = computeStatus(ev.startDate, ev.endDate);
    if (newStatus !== ev.status) {
      changed = true;
      return { ...ev, status: newStatus };
    }
    return ev;
  });
  return changed ? next : events;
}

// ─── sortEvents (mirrors buzz-view.tsx) ─────────────────────────────────────

function sortEvents<T extends { status: EventStatus; startDate?: number }>(events: T[]): T[] {
  const order: Record<string, number> = { live: 0, upcoming: 1, unknown: 2, past: 3 };
  return [...events].sort((a, b) => {
    const oa = order[a.status] ?? 2;
    const ob = order[b.status] ?? 2;
    if (oa !== ob) return oa - ob;
    if (a.startDate && b.startDate) return a.startDate - b.startDate;
    if (a.startDate) return -1;
    if (b.startDate) return 1;
    return 0;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

const Y = new Date().getFullYear();

// Helper: wrap plain text as both html and cleaned text for the two-arg extractDates
function dates(text: string) { return extractDates(text, text); }

describe('extractDatesFromText — core patterns', () => {
  it('parses US range "Month DD-DD, YYYY"', () => {
    const { start, end } = dates(`Join us June 8-10, ${Y + 1}`);
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    const s = new Date(start! * 1000);
    const e = new Date(end! * 1000);
    expect(s.getMonth()).toBe(5);
    expect(s.getDate()).toBe(8);
    expect(e.getDate()).toBe(10);
  });

  it('parses US range with en-dash "Month DD – DD, YYYY"', () => {
    const { start, end } = dates(`Event: March 2 – 5, ${Y + 1}`);
    expect(start).toBeDefined();
    const s = new Date(start! * 1000);
    expect(s.getMonth()).toBe(2);
    expect(s.getDate()).toBe(2);
  });

  it('parses EU range "DD-DD Month YYYY"', () => {
    const { start, end } = dates(`26-30 August ${Y + 1}`);
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    const s = new Date(start! * 1000);
    expect(s.getMonth()).toBe(7);
    expect(s.getDate()).toBe(26);
    expect(new Date(end! * 1000).getDate()).toBe(30);
  });

  it('parses cross-month US range "August 30 – September 2, YYYY"', () => {
    const { start, end } = dates(`Gamescom August 30 – September 2, ${Y + 1}`);
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    const s = new Date(start! * 1000);
    const e = new Date(end! * 1000);
    expect(s.getMonth()).toBe(7);
    expect(e.getMonth()).toBe(8);
  });

  it('parses cross-month EU range "06 July - 23 August YYYY"', () => {
    const { start, end } = dates(`06 July - 23 August ${Y + 1}`);
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    const s = new Date(start! * 1000);
    const e = new Date(end! * 1000);
    expect(s.getMonth()).toBe(6);
    expect(s.getDate()).toBe(6);
    expect(e.getMonth()).toBe(7);
    expect(e.getDate()).toBe(23);
  });

  it('parses single US date "Month DD, YYYY"', () => {
    const { start, end } = dates(`December 12, ${Y + 1}`);
    expect(start).toBeDefined();
    expect(end).toBeUndefined();
    const s = new Date(start! * 1000);
    expect(s.getMonth()).toBe(11);
    expect(s.getDate()).toBe(12);
  });

  it('parses single EU date "DD Month YYYY"', () => {
    const { start } = dates(`7 June ${Y + 1}`);
    expect(start).toBeDefined();
    const s = new Date(start! * 1000);
    expect(s.getMonth()).toBe(5);
    expect(s.getDate()).toBe(7);
  });

  it('parses ISO date "YYYY-MM-DD"', () => {
    const { start } = dates(`2026-03-15`);
    expect(start).toBeDefined();
    const s = new Date(start! * 1000);
    expect(s.getMonth()).toBe(2);
    expect(s.getDate()).toBe(15);
  });

  it('parses ISO date range "YYYY-MM-DD to YYYY-MM-DD"', () => {
    const { start, end } = dates(`${Y + 1}-06-15 to ${Y + 1}-06-22`);
    expect(start).toBeDefined();
    expect(end).toBeDefined();
  });

  it('parses abbreviated months with periods "Jun. 8, YYYY"', () => {
    const { start } = dates(`Jun. 8, ${Y + 1}`);
    expect(start).toBeDefined();
    const s = new Date(start! * 1000);
    expect(s.getMonth()).toBe(5);
    expect(s.getDate()).toBe(8);
  });

  it('parses abbreviated months with periods in ranges "Jan. 6-9, YYYY"', () => {
    const { start, end } = dates(`Jan. 6-9, ${Y + 1}`);
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    const s = new Date(start! * 1000);
    expect(s.getMonth()).toBe(0);
    expect(s.getDate()).toBe(6);
  });

  it('parses month + year only as fallback "February YYYY"', () => {
    const { start } = dates(`Steam Next Fest: February ${Y + 1} Edition`);
    expect(start).toBeDefined();
    const s = new Date(start! * 1000);
    expect(s.getMonth()).toBe(1);
    expect(s.getDate()).toBe(1);
  });

  it('handles abbreviated months (Sept, Oct, etc.)', () => {
    const { start } = dates(`Sept 15, ${Y + 1}`);
    expect(start).toBeDefined();
    const s = new Date(start! * 1000);
    expect(s.getMonth()).toBe(8);
  });

  it('rejects dates from irrelevant years', () => {
    const { start } = dates('Founded June 8, 2019');
    expect(start).toBeUndefined();
  });

  it('returns empty when no dates found', () => {
    const result = dates('No dates here, just text.');
    expect(result.start).toBeUndefined();
    expect(result.end).toBeUndefined();
  });

  it('rejects invalid day numbers', () => {
    const result = dates(`June 35, ${Y + 1}`);
    expect(result.start).toBeUndefined();
  });

  it('prefers future dates over past dates when both exist', () => {
    const pastDate = `January 5, ${Y}`;
    const futureDate = `December 20, ${Y}`;
    const text = `Past event: ${pastDate}. Upcoming event: ${futureDate}`;
    const { start } = dates(text);
    expect(start).toBeDefined();
    const s = new Date(start! * 1000);
    expect(s.getMonth()).toBe(11);
    expect(s.getDate()).toBe(20);
  });

  it('prefers ranges over single dates at same specificity', () => {
    const text = `Single: June 5, ${Y + 1}. Range: June 8-10, ${Y + 1}`;
    const { start, end } = dates(text);
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    const s = new Date(start! * 1000);
    expect(s.getDate()).toBe(8);
  });

  it('ignores non-month words that happen to match', () => {
    const result = dates('The application 42, 2019 was filed.');
    expect(result.start).toBeUndefined();
  });
});

describe('extractDates — HTML extraction from script/meta/title', () => {
  it('finds dates inside Next.js script data (gamescom-like)', () => {
    const html = `<html><head><title>gamescom 2026</title></head><body>
      <script>self.__next_f.push([1,"metaDescription":"gamescom 2026: The Heart of Gaming 26-30 August ${Y + 1} in Cologne"])</script>
    </body></html>`;
    const cleanedText = 'gamescom 2026';
    const { start, end } = extractDates(html, cleanedText);
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    const s = new Date(start! * 1000);
    expect(s.getMonth()).toBe(7);
    expect(s.getDate()).toBe(26);
  });

  it('finds dates inside inline script text (PC Gaming Show-like)', () => {
    const html = `<html><body>
      <script>var eventDate = "7 June ${Y + 1}";</script>
      <div>Welcome to the show</div>
    </body></html>`;
    const cleanedText = 'Welcome to the show';
    const { start } = extractDates(html, cleanedText);
    expect(start).toBeDefined();
    const s = new Date(start! * 1000);
    expect(s.getMonth()).toBe(5);
    expect(s.getDate()).toBe(7);
  });

  it('finds dates in meta tag content', () => {
    const html = `<html><head>
      <meta name="description" content="Steam Next Fest: February ${Y + 1} Edition">
    </head><body></body></html>`;
    const cleanedText = '';
    const { start } = extractDates(html, cleanedText);
    expect(start).toBeDefined();
    const s = new Date(start! * 1000);
    expect(s.getMonth()).toBe(1);
  });

  it('finds ISO dates in meta tags (DreamHack-like)', () => {
    const html = `<html><head>
      <meta property="article:modified_time" content="${Y + 1}-02-20T16:33:09+02:00">
    </head><body></body></html>`;
    const cleanedText = '';
    const { start } = extractDates(html, cleanedText);
    expect(start).toBeDefined();
  });

  it('finds dates in title tag', () => {
    const html = `<html><head><title>Event - March 9-13, ${Y + 1}</title></head><body></body></html>`;
    const cleanedText = '';
    const { start, end } = extractDates(html, cleanedText);
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    const s = new Date(start! * 1000);
    expect(s.getMonth()).toBe(2);
    expect(s.getDate()).toBe(9);
  });

  it('unescapes JSON strings before matching (escaped quotes)', () => {
    const html = `<html><body><script>
      {"description":"Event runs June 8-10, ${Y + 1} at the convention center"}
    </script></body></html>`;
    const cleanedText = '';
    const { start, end } = extractDates(html, cleanedText);
    expect(start).toBeDefined();
    expect(end).toBeDefined();
  });

  it('handles cross-month EU dates from Esports World Cup-like text', () => {
    const html = '';
    const cleanedText = `06 July - 23 August ${Y + 1} Nothing is granted`;
    const { start, end } = extractDates(html, cleanedText);
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    const s = new Date(start! * 1000);
    const e = new Date(end! * 1000);
    expect(s.getMonth()).toBe(6);
    expect(e.getMonth()).toBe(7);
  });
});

describe('extractLinks', () => {
  it('extracts YouTube watch links', () => {
    const html = '<a href="https://www.youtube.com/watch?v=abc123">Watch</a>';
    const { youtubeUrls } = extractLinks(html);
    expect(youtubeUrls).toHaveLength(1);
    expect(youtubeUrls[0]).toBe('https://www.youtube.com/watch?v=abc123');
  });

  it('extracts YouTube live links', () => {
    const html = '<a href="https://youtube.com/live/xyz789">Live</a>';
    const { youtubeUrls } = extractLinks(html);
    expect(youtubeUrls).toHaveLength(1);
  });

  it('extracts YouTube channel links', () => {
    const html = '<a href="https://www.youtube.com/channel/UCabc">Channel</a>';
    const { youtubeUrls } = extractLinks(html);
    expect(youtubeUrls).toHaveLength(1);
  });

  it('extracts YouTube @ links', () => {
    const html = '<a href="https://www.youtube.com/@GameFest">Channel</a>';
    const { youtubeUrls } = extractLinks(html);
    expect(youtubeUrls).toHaveLength(1);
  });

  it('extracts youtu.be short links', () => {
    const html = '<a href="https://youtu.be/abc123">Short</a>';
    const { youtubeUrls } = extractLinks(html);
    expect(youtubeUrls).toHaveLength(1);
  });

  it('extracts YouTube iframe embeds', () => {
    const html = '<iframe src="https://www.youtube.com/watch?v=embed123"></iframe>';
    const { youtubeUrls } = extractLinks(html);
    expect(youtubeUrls).toHaveLength(1);
  });

  it('extracts Twitch links', () => {
    const html = '<a href="https://www.twitch.tv/summergamefest">Twitch</a>';
    const { twitchUrls } = extractLinks(html);
    expect(twitchUrls).toHaveLength(1);
    expect(twitchUrls[0]).toBe('https://www.twitch.tv/summergamefest');
  });

  it('deduplicates identical links', () => {
    const html = `
      <a href="https://youtube.com/watch?v=abc">Link 1</a>
      <a href="https://youtube.com/watch?v=abc">Link 2</a>
    `;
    const { youtubeUrls } = extractLinks(html);
    expect(youtubeUrls).toHaveLength(1);
  });

  it('decodes &amp; in URLs', () => {
    const html = '<a href="https://youtube.com/watch?v=abc&amp;t=120">Link</a>';
    const { youtubeUrls } = extractLinks(html);
    expect(youtubeUrls[0]).toBe('https://youtube.com/watch?v=abc&t=120');
  });

  it('returns empty arrays when no links found', () => {
    const { youtubeUrls, twitchUrls } = extractLinks('<p>No links here</p>');
    expect(youtubeUrls).toHaveLength(0);
    expect(twitchUrls).toHaveLength(0);
  });

  it('ignores non-YouTube/Twitch links', () => {
    const html = '<a href="https://twitter.com/event">Twitter</a>';
    const { youtubeUrls, twitchUrls } = extractLinks(html);
    expect(youtubeUrls).toHaveLength(0);
    expect(twitchUrls).toHaveLength(0);
  });
});

describe('isAllowedUrl', () => {
  it('allows https URLs', () => {
    expect(isAllowedUrl('https://example.com')).toBe(true);
  });

  it('allows http URLs', () => {
    expect(isAllowedUrl('http://example.com')).toBe(true);
  });

  it('rejects javascript: URLs', () => {
    expect(isAllowedUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects file: URLs', () => {
    expect(isAllowedUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects data: URLs', () => {
    expect(isAllowedUrl('data:text/html,<h1>hi</h1>')).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(isAllowedUrl('not a url')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(isAllowedUrl('')).toBe(false);
  });
});

describe('computeStatus', () => {
  it('returns "unknown" when no start date', () => {
    expect(computeStatus(undefined)).toBe('unknown');
  });

  it('returns "upcoming" for future dates', () => {
    const future = Date.now() / 1000 + 86400 * 30;
    expect(computeStatus(future)).toBe('upcoming');
  });

  it('returns "live" when now is between start and end', () => {
    const now = Date.now() / 1000;
    expect(computeStatus(now - 3600, now + 3600)).toBe('live');
  });

  it('returns "live" for single-day event (no end date) within 24h', () => {
    const now = Date.now() / 1000;
    expect(computeStatus(now - 3600)).toBe('live');
  });

  it('returns "past" after end date', () => {
    const now = Date.now() / 1000;
    expect(computeStatus(now - 86400 * 5, now - 86400 * 2)).toBe('past');
  });

  it('returns "past" for single-day event older than 24h', () => {
    const now = Date.now() / 1000;
    expect(computeStatus(now - 86400 * 2)).toBe('past');
  });
});

describe('refreshStatuses', () => {
  it('returns same reference when no status changes', () => {
    const events = [
      { status: 'upcoming' as EventStatus, startDate: Date.now() / 1000 + 86400 * 30 },
      { status: 'unknown' as EventStatus, startDate: undefined },
    ];
    const result = refreshStatuses(events);
    expect(result).toBe(events);
  });

  it('returns new reference when a status changes', () => {
    const events = [
      { status: 'upcoming' as EventStatus, startDate: Date.now() / 1000 - 3600 },
    ];
    const result = refreshStatuses(events);
    expect(result).not.toBe(events);
    expect(result[0].status).toBe('live');
  });
});

describe('sortEvents', () => {
  it('sorts live first, then upcoming, then unknown, then past', () => {
    const now = Date.now() / 1000;
    const events = [
      { status: 'past' as EventStatus, startDate: now - 86400 * 30 },
      { status: 'live' as EventStatus, startDate: now - 3600 },
      { status: 'unknown' as EventStatus, startDate: undefined },
      { status: 'upcoming' as EventStatus, startDate: now + 86400 },
    ];
    const sorted = sortEvents(events);
    expect(sorted.map((e) => e.status)).toEqual(['live', 'upcoming', 'unknown', 'past']);
  });

  it('sorts upcoming events by soonest first', () => {
    const now = Date.now() / 1000;
    const events = [
      { status: 'upcoming' as EventStatus, startDate: now + 86400 * 30 },
      { status: 'upcoming' as EventStatus, startDate: now + 86400 * 5 },
      { status: 'upcoming' as EventStatus, startDate: now + 86400 * 15 },
    ];
    const sorted = sortEvents(events);
    expect(sorted[0].startDate).toBe(now + 86400 * 5);
    expect(sorted[1].startDate).toBe(now + 86400 * 15);
    expect(sorted[2].startDate).toBe(now + 86400 * 30);
  });

  it('puts events with dates before events without dates in same status group', () => {
    const events = [
      { status: 'unknown' as EventStatus, startDate: undefined },
      { status: 'unknown' as EventStatus, startDate: Date.now() / 1000 + 86400 },
    ];
    const sorted = sortEvents(events);
    expect(sorted[0].startDate).toBeDefined();
    expect(sorted[1].startDate).toBeUndefined();
  });
});

describe('MONTHS lookup', () => {
  it('covers all 12 full month names', () => {
    const fullNames = [
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december',
    ];
    for (let i = 0; i < fullNames.length; i++) {
      expect(MONTHS[fullNames[i]]).toBe(i);
    }
  });

  it('covers common abbreviations including "sept"', () => {
    expect(MONTHS['jan']).toBe(0);
    expect(MONTHS['feb']).toBe(1);
    expect(MONTHS['mar']).toBe(2);
    expect(MONTHS['apr']).toBe(3);
    expect(MONTHS['jun']).toBe(5);
    expect(MONTHS['jul']).toBe(6);
    expect(MONTHS['aug']).toBe(7);
    expect(MONTHS['sep']).toBe(8);
    expect(MONTHS['sept']).toBe(8);
    expect(MONTHS['oct']).toBe(9);
    expect(MONTHS['nov']).toBe(10);
    expect(MONTHS['dec']).toBe(11);
  });

  it('covers abbreviations with trailing periods', () => {
    expect(MONTHS['jan.']).toBe(0);
    expect(MONTHS['feb.']).toBe(1);
    expect(MONTHS['jun.']).toBe(5);
    expect(MONTHS['dec.']).toBe(11);
  });
});
