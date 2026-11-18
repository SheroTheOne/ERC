import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayLabels,
  daysBetween,
  formatPrice,
  formatSlotRange,
  formatTime,
  isoWeek,
  normalizePhone,
  startOfWeek,
  todayInZone,
  weekday,
} from './time.ts';

const TZ = 'Europe/Stockholm';

describe('kalenderdagar', () => {
  it('lägger till dagar över månads- och årsskiften', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-02', -2)).toBe('2026-02-28');
  });

  it('påverkas inte av sommartid', () => {
    // Natten mot 29 mars 2026 ställs klockan fram i Sverige.
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(daysBetween('2026-03-28', '2026-03-31')).toBe(3);
  });

  it('räknar veckor från måndag', () => {
    expect(weekday('2026-03-30')).toBe(0);
    expect(weekday('2026-04-05')).toBe(6);
    expect(startOfWeek('2026-04-05')).toBe('2026-03-30');
    expect(startOfWeek('2026-03-30')).toBe('2026-03-30');
  });

  it('ger ISO-veckonummer', () => {
    expect(isoWeek('2026-03-30')).toBe(14);
    expect(isoWeek('2026-01-01')).toBe(1);
    expect(isoWeek('2027-01-01')).toBe(53);
  });

  it('ger svenska etiketter', () => {
    expect(dayLabels('2026-03-30')).toEqual({
      weekday: 'mån',
      day: '30',
      long: 'måndag 30 mars',
    });
  });
});

describe('tidszon', () => {
  it('tar dagens datum i företagets zon, inte i UTC', () => {
    // 23:30 UTC är redan nästa dag i Stockholm.
    expect(todayInZone(TZ, new Date('2026-06-14T23:30:00Z'))).toBe('2026-06-15');
    expect(todayInZone('UTC', new Date('2026-06-14T23:30:00Z'))).toBe('2026-06-14');
  });

  it('visar tider i företagets zon före och efter sommartid', () => {
    expect(formatTime('2026-03-27T08:00:00Z', TZ)).toBe('09:00');
    expect(formatTime('2026-03-30T07:00:00Z', TZ)).toBe('09:00');
  });

  it('formaterar ett tidsintervall', () => {
    expect(formatSlotRange('2026-03-30T07:00:00Z', '2026-03-30T08:00:00Z', TZ)).toBe(
      'mån 30 mars 09:00–10:00',
    );
  });
});

describe('formatPrice', () => {
  it('visar hela kronor utan decimaler', () => {
    expect(formatPrice(50_000).replace(/\s/g, ' ')).toBe('500 kr');
  });

  it('visar ören när de finns', () => {
    expect(formatPrice(49_950).replace(/\s/g, ' ')).toBe('499,50 kr');
  });
});

describe('normalizePhone', () => {
  it.each([
    ['070-123 45 67', '+46701234567'],
    ['+46 70 123 45 67', '+46701234567'],
    ['0046701234567', '+46701234567'],
    ['(08) 123 456', '+468123456'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['', 'abc', '123', '+0701234567'])('avvisar %j', (input) => {
    expect(normalizePhone(input)).toBeUndefined();
  });
});
