import { describe, expect, it } from 'vitest';
import { weekWindow } from './week.ts';

describe('weekWindow', () => {
  it('börjar på idag i innevarande vecka', () => {
    // Onsdag 1 april 2026.
    const week = weekWindow('2026-03-30', '2026-04-01', 60);
    expect(week.days).toHaveLength(7);
    expect(week.days[0]).toBe('2026-03-30');
    expect(week.range).toEqual({ from: '2026-04-01', to: '2026-04-05' });
    expect(week.hasPrevious).toBe(false);
    expect(week.hasNext).toBe(true);
  });

  it('slutar vid bokningshorisonten', () => {
    const week = weekWindow('2026-04-06', '2026-04-01', 7);
    expect(week.range).toEqual({ from: '2026-04-06', to: '2026-04-08' });
    expect(week.hasPrevious).toBe(true);
    expect(week.hasNext).toBe(false);
  });

  it('har inga bokningsbara dagar bortom horisonten', () => {
    expect(weekWindow('2026-04-13', '2026-04-01', 7).range).toBeNull();
  });

  it('tillåter nästa vecka när horisonten slutar precis på dess måndag', () => {
    expect(weekWindow('2026-03-30', '2026-03-30', 7).hasNext).toBe(true);
  });
});
