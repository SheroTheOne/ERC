import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  generateSlots,
  localDate,
  type Period,
  type SlotRules,
} from '../../src/modules/availability/slots.ts';

const STOCKHOLM = 'Europe/Stockholm';
const instant = (iso: string) => Temporal.Instant.from(iso);
const period = (start: string, end: string): Period => ({
  start: instant(start),
  end: instant(end),
});
const iso = (slots: readonly Temporal.Instant[]) => slots.map((slot) => slot.toString());

const FAR_PAST = instant('2000-01-01T00:00:00Z');
const FAR_FUTURE = instant('2100-01-01T00:00:00Z');

function rules(overrides: Partial<SlotRules> = {}): SlotRules {
  return {
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    stepMinutes: 15,
    timeZone: STOCKHOLM,
    notBefore: FAR_PAST,
    notAfter: FAR_FUTURE,
    ...overrides,
  };
}

describe('generateSlots', () => {
  it('fills a free period on the step grid', () => {
    // 09:00-10:30 lokal vintertid = 08:00Z-09:30Z.
    const slots = generateSlots([period('2026-01-12T08:00:00Z', '2026-01-12T09:30:00Z')], rules());
    expect(iso(slots)).toEqual([
      '2026-01-12T08:00:00Z',
      '2026-01-12T08:15:00Z',
      '2026-01-12T08:30:00Z',
    ]);
  });

  it('includes a slot that ends exactly when the period ends (half-open)', () => {
    const slots = generateSlots([period('2026-01-12T08:00:00Z', '2026-01-12T09:00:00Z')], rules());
    expect(iso(slots)).toEqual(['2026-01-12T08:00:00Z']);
  });

  it('returns nothing when the service does not fit', () => {
    expect(
      generateSlots([period('2026-01-12T08:00:00Z', '2026-01-12T08:59:00Z')], rules()),
    ).toEqual([]);
  });

  it('aligns to the local grid when a free period starts off-grid', () => {
    // Fritt från 09:07 lokal tid (efter en kortare bokning): första lucka 09:15.
    const slots = generateSlots(
      [period('2026-01-12T08:07:00Z', '2026-01-12T09:30:00Z')],
      rules({ durationMinutes: 30 }),
    );
    expect(iso(slots)[0]).toBe('2026-01-12T08:15:00Z');
  });

  it('keeps both buffers inside the free period', () => {
    const slots = generateSlots(
      [period('2026-01-12T08:00:00Z', '2026-01-12T10:00:00Z')],
      rules({ bufferBeforeMinutes: 10, bufferAfterMinutes: 15 }),
    );
    // Tidigast 08:10 → rutnät 08:15. Senast 10:00 − 75 min = 08:45.
    expect(iso(slots)).toEqual([
      '2026-01-12T08:15:00Z',
      '2026-01-12T08:30:00Z',
      '2026-01-12T08:45:00Z',
    ]);
  });

  it('applies notBefore and notAfter inclusively', () => {
    const slots = generateSlots(
      [period('2026-01-12T08:00:00Z', '2026-01-12T12:00:00Z')],
      rules({
        notBefore: instant('2026-01-12T08:20:00Z'),
        notAfter: instant('2026-01-12T09:00:00Z'),
      }),
    );
    expect(iso(slots)).toEqual([
      '2026-01-12T08:30:00Z',
      '2026-01-12T08:45:00Z',
      '2026-01-12T09:00:00Z',
    ]);
  });

  it('skips the missing hour when clocks spring forward', () => {
    // 2026-03-29: 01:00-05:00 lokal tid = 00:00Z-03:00Z. 02:xx lokal tid finns inte.
    const slots = generateSlots(
      [period('2026-03-29T00:00:00Z', '2026-03-29T03:00:00Z')],
      rules({ stepMinutes: 30 }),
    );
    const local = slots.map((slot) => slot.toZonedDateTimeISO(STOCKHOLM).toPlainTime().toString());
    expect(local).toEqual(['01:00:00', '01:30:00', '03:00:00', '03:30:00', '04:00:00']);
  });

  it('offers the repeated hour twice when clocks fall back', () => {
    // 2026-10-25: 02:00-03:00 lokal tid inträffar två gånger. 01:00-05:00 lokal tid = 5 timmar = 5 luckor.
    const slots = generateSlots(
      [period('2026-10-24T23:00:00Z', '2026-10-25T04:00:00Z')],
      rules({ stepMinutes: 60 }),
    );
    const local = slots.map((slot) =>
      slot.toZonedDateTimeISO(STOCKHOLM).toString({ timeZoneName: 'never' }),
    );
    expect(local).toEqual([
      '2026-10-25T01:00:00+02:00',
      '2026-10-25T02:00:00+02:00',
      '2026-10-25T02:00:00+01:00',
      '2026-10-25T03:00:00+01:00',
      '2026-10-25T04:00:00+01:00',
    ]);
  });

  it('stays on the local grid in a zone with a 30-minute daylight saving shift', () => {
    // Australia/Lord_Howe: +10:30 → +11:00 den 2026-10-04 kl. 02:00 lokal tid.
    const slots = generateSlots(
      [period('2026-10-03T14:00:00Z', '2026-10-03T17:00:00Z')],
      rules({ stepMinutes: 60, timeZone: 'Australia/Lord_Howe' }),
    );
    for (const slot of slots) {
      expect(slot.toZonedDateTimeISO('Australia/Lord_Howe').minute).toBe(0);
    }
  });

  it('rejects a step that does not divide an hour', () => {
    expect(() => generateSlots([], rules({ stepMinutes: 25 }))).toThrow(RangeError);
  });
});

describe('localDate', () => {
  it('uses the business time zone, not UTC', () => {
    expect(localDate(instant('2026-01-11T23:30:00Z'), STOCKHOLM).toString()).toBe('2026-01-12');
  });
});

describe('generateSlots properties', () => {
  const BASE = instant('2026-03-28T00:00:00Z').epochMilliseconds;
  const MINUTE = 60_000;

  // Sorterade, disjunkta och icke angränsande intervall, som en tstzmultirange.
  const freePeriods = fc
    .array(fc.tuple(fc.integer({ min: 1, max: 240 }), fc.integer({ min: 1, max: 600 })), {
      maxLength: 6,
    })
    .map((parts) => {
      let cursor = BASE;
      return parts.map(([gap, length]) => {
        const start = cursor + gap * MINUTE;
        cursor = start + length * MINUTE;
        return {
          start: Temporal.Instant.fromEpochMilliseconds(start),
          end: Temporal.Instant.fromEpochMilliseconds(cursor),
        };
      });
    });

  const slotRules = fc.record({
    durationMinutes: fc.integer({ min: 5, max: 240 }),
    bufferBeforeMinutes: fc.integer({ min: 0, max: 30 }),
    bufferAfterMinutes: fc.integer({ min: 0, max: 30 }),
    stepMinutes: fc.constantFrom(5, 10, 15, 20, 30, 60),
    timeZone: fc.constantFrom(STOCKHOLM, 'America/New_York', 'UTC', 'Asia/Kolkata'),
  });

  it('only produces slots whose blocked time fits inside one free period', () => {
    fc.assert(
      fc.property(freePeriods, slotRules, (free, partial) => {
        const r = rules(partial);
        for (const slot of generateSlots(free, r)) {
          const blockedStart = slot.subtract({ minutes: r.bufferBeforeMinutes });
          const blockedEnd = slot.add({ minutes: r.durationMinutes + r.bufferAfterMinutes });
          const fits = free.some(
            (p) =>
              Temporal.Instant.compare(p.start, blockedStart) <= 0 &&
              Temporal.Instant.compare(blockedEnd, p.end) <= 0,
          );
          if (!fits) return false;
        }
        return true;
      }),
    );
  });

  it('returns strictly increasing slots on the local grid', () => {
    fc.assert(
      fc.property(freePeriods, slotRules, (free, partial) => {
        const r = rules(partial);
        const slots = generateSlots(free, r);
        return slots.every((slot, index) => {
          const zoned = slot.toZonedDateTimeISO(r.timeZone);
          const onGrid =
            (zoned.hour * 60 + zoned.minute) % r.stepMinutes === 0 && zoned.second === 0;
          const previous = slots[index - 1];
          const increasing = previous === undefined || Temporal.Instant.compare(previous, slot) < 0;
          return onGrid && increasing;
        });
      }),
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(freePeriods, slotRules, (free, partial) => {
        const r = rules(partial);
        return iso(generateSlots(free, r)).join() === iso(generateSlots(free, r)).join();
      }),
    );
  });

  it('never misses a grid slot that fits', () => {
    fc.assert(
      fc.property(freePeriods, slotRules, (free, partial) => {
        const r = rules(partial);
        const produced = new Set(iso(generateSlots(free, r)));
        // Brute force: varje minut i varje intervall som ligger på rutnätet och rymmer tjänsten.
        for (const p of free) {
          for (let t = p.start; Temporal.Instant.compare(t, p.end) < 0; t = t.add({ minutes: 1 })) {
            const zoned = t.toZonedDateTimeISO(r.timeZone);
            if ((zoned.hour * 60 + zoned.minute) % r.stepMinutes !== 0 || zoned.second !== 0)
              continue;
            const fits =
              Temporal.Instant.compare(p.start, t.subtract({ minutes: r.bufferBeforeMinutes })) <=
                0 &&
              Temporal.Instant.compare(
                t.add({ minutes: r.durationMinutes + r.bufferAfterMinutes }),
                p.end,
              ) <= 0;
            if (fits && !produced.has(t.toString())) return false;
          }
        }
        return true;
      }),
      { numRuns: 50 },
    );
  });
});
