import { describe, it, expect } from 'vitest';
import { normalizeJournal } from '@/components/devlog-view';

describe('normalizeJournal', () => {
  it('maps the legacy "summary" field onto "narrative"', () => {
    const result = normalizeJournal({
      project: 'tracker',
      days: [
        { date: '2026-05-04', title: 'Day', tags: ['fix'], summary: 'did things' },
      ],
    });
    expect(result.days).toHaveLength(1);
    expect(result.days[0].narrative).toBe('did things');
  });

  it('prefers an explicit narrative over summary', () => {
    const result = normalizeJournal({
      days: [{ date: '2026-05-04', narrative: 'real', summary: 'fallback' }],
    });
    expect(result.days[0].narrative).toBe('real');
  });

  it('fills missing array/string fields with safe defaults (no crash on access)', () => {
    const result = normalizeJournal({ days: [{ date: '2026-05-04' }] });
    const day = result.days[0];
    expect(day.narrative).toBe('');
    expect(day.tags).toEqual([]);
    expect(day.filesChanged).toEqual([]);
    expect(day.milestones).toEqual([]);
    expect(day.challenges).toEqual([]);
    expect(day.lookingAhead).toBeNull();
    // The fields the UI calls .split / .length / .map on must be safe:
    expect(() => day.narrative.split('\n\n')).not.toThrow();
    expect(day.tags.length).toBe(0);
  });

  it('drops entries without a date and tolerates malformed input', () => {
    expect(normalizeJournal(null).days).toEqual([]);
    expect(normalizeJournal({ days: 'nope' }).days).toEqual([]);
    expect(normalizeJournal({ days: [null, 42, { title: 'no date' }] }).days).toEqual([]);
  });

  it('defaults the project name when missing', () => {
    expect(normalizeJournal({}).project).toBe('ark');
    expect(normalizeJournal({ project: 'x' }).project).toBe('x');
  });
});
