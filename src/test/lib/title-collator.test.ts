import { describe, it, expect } from 'vitest';
import { titleCollator } from '@/lib/title-collator';

const TITLES = [
  'zelda', 'Zelda', 'Élan', 'elan', 'Alan Wake', 'alan wake 2', 'Ökami', 'okami', 'Baldur\'s Gate 3',
  'baldur\'s gate', '2064: Read Only Memories', 'Ábzu', 'abzu', 'DOOM', 'Doom Eternal', 'çelik', 'Celeste',
  'Hades II', 'hades', 'Ys VIII', 'ys origin', 'Ñandú', 'nandu',
];

describe('titleCollator', () => {
  it('orders titles exactly like localeCompare with base sensitivity', () => {
    const oldOrder = [...TITLES].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const newOrder = [...TITLES].sort((a, b) => titleCollator.compare(a, b));
    expect(newOrder).toEqual(oldOrder);
  });

  it('agrees with localeCompare on every pair', () => {
    for (const a of TITLES) {
      for (const b of TITLES) {
        expect(Math.sign(titleCollator.compare(a, b))).toBe(Math.sign(a.localeCompare(b, undefined, { sensitivity: 'base' })));
      }
    }
  });

  it('sorts 3,000 titles quickly', () => {
    const many = Array.from({ length: 3000 }, (_, i) => `${TITLES[i % TITLES.length]} ${(i * 7919) % 3000}`);
    const t0 = performance.now();
    many.sort((a, b) => titleCollator.compare(a, b));
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
