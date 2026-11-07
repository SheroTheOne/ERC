import type { AvailabilityResponse, ServiceList, StaffList } from '@erc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED } from '../../db/seed/seed.ts';
import { createTestApp, type TestApp } from '../setup/app.ts';

// Klippning: 45 min + 15 min buffert efter. Anna: mån–fre 09–12 och 13–17. Bo: tis–lör 10–18.
const { haircut, colour } = SEED.services;
const { anna, bo } = SEED.staff;

let t: TestApp;

beforeAll(async () => {
  // Fredag 2026-03-20 13:00 lokal tid, långt före de dagar som testas.
  t = await createTestApp({ now: '2026-03-20T12:00:00Z' });
});

afterAll(async () => {
  await t.close();
});

async function availability(query: Record<string, string>) {
  const response = await t.app.inject({ method: 'GET', url: '/api/v1/availability', query });
  return { status: response.statusCode, body: response.json<AvailabilityResponse>(), response };
}

function starts(body: AvailabilityResponse, date: string): string[] {
  return body.days.find((day) => day.date === date)?.slots.map((slot) => slot.startsAt) ?? [];
}

describe('catalog', () => {
  it('lists active services and the staff who perform them', async () => {
    const services = (
      await t.app.inject({ method: 'GET', url: '/api/v1/services' })
    ).json<ServiceList>();
    expect(services.items.map((service) => service.name).sort()).toEqual([
      'Färgning',
      'Klippning',
      'Skäggtrimning',
    ]);

    const staff = (
      await t.app.inject({ method: 'GET', url: `/api/v1/services/${haircut}/staff` })
    ).json<StaffList>();
    expect(staff.items.map((member) => member.displayName)).toEqual(['Alva', 'Anna', 'Bo']);
  });

  it('returns the business time zone and booking policy', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/api/v1/business' });
    expect(response.json()).toMatchObject({ timezone: 'Europe/Stockholm', slotStepMinutes: 15 });
  });
});

describe('GET /api/v1/availability', () => {
  it('slices one staff member’s working day into slots that fit duration and buffer', async () => {
    // Tisdag 2026-03-24, vintertid (+01:00).
    const { status, body, response } = await availability({
      serviceId: haircut,
      staffId: anna,
      from: '2026-03-24',
      to: '2026-03-24',
    });

    expect(status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const slots = starts(body, '2026-03-24');
    // Förmiddag 09:00–11:00 lokal tid (9 luckor), eftermiddag 13:00–16:00 (13 luckor).
    expect(slots).toHaveLength(22);
    expect(slots[0]).toBe('2026-03-24T08:00:00Z');
    expect(slots).toContain('2026-03-24T10:00:00Z'); // 11:00 lokal tid, slutar 12:00 med buffert
    expect(slots).not.toContain('2026-03-24T10:15:00Z');
    expect(slots.at(-1)).toBe('2026-03-24T15:00:00Z');
    expect(body.days[0]?.slots[0]).toEqual({
      startsAt: '2026-03-24T08:00:00Z',
      endsAt: '2026-03-24T08:45:00Z',
      staffIds: [anna],
    });
  });

  it('keeps working hours on the wall clock across the switch to summer time', async () => {
    const { body } = await availability({
      serviceId: haircut,
      staffId: anna,
      from: '2026-03-23',
      to: '2026-03-30',
    });

    expect(body.days.map((day) => day.date)).toEqual([
      '2026-03-23',
      '2026-03-24',
      '2026-03-25',
      '2026-03-26',
      '2026-03-27',
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
    ]);
    expect(starts(body, '2026-03-23')[0]).toBe('2026-03-23T08:00:00Z'); // 09:00 +01:00
    expect(starts(body, '2026-03-30')[0]).toBe('2026-03-30T07:00:00Z'); // 09:00 +02:00
    expect(starts(body, '2026-03-28')).toEqual([]); // Anna arbetar inte på lördagar
  });

  it('merges staff for "any staff" and lists who can take each slot', async () => {
    const { body } = await availability({
      serviceId: haircut,
      from: '2026-03-24',
      to: '2026-03-24',
    });
    const slots = body.days[0]?.slots ?? [];
    const at = (startsAt: string) => slots.find((slot) => slot.startsAt === startsAt)?.staffIds;

    expect(at('2026-03-24T08:00:00Z')).toEqual([anna]); // 09:00, bara Anna
    expect(at('2026-03-24T09:00:00Z')).toEqual([anna, bo]); // 10:00, båda
    expect(at('2026-03-24T16:00:00Z')).toEqual([bo]); // 17:00, bara Bo
  });

  it('applies the minimum notice policy relative to now', async () => {
    t.clock.set('2026-03-24T08:30:00Z'); // 09:30 lokal tid, framförhållning 60 min
    try {
      const { body } = await availability({
        serviceId: haircut,
        staffId: anna,
        from: '2026-03-24',
        to: '2026-03-24',
      });
      expect(starts(body, '2026-03-24')[0]).toBe('2026-03-24T09:30:00Z');
    } finally {
      t.clock.set('2026-03-20T12:00:00Z');
    }
  });

  it('removes slots that collide with a booking including its buffer, or with time off', async () => {
    await t.testDb.pool.query(
      `INSERT INTO booking (customer_id, service_id, staff_id, starts_at, ends_at,
         buffer_before_minutes, buffer_after_minutes, price_ore, contact_name)
       VALUES ($1, $2, $3, '2026-03-25T08:00Z', '2026-03-25T08:45Z', 0, 15, 45000, 'Kim')`,
      [SEED.customers.kim, haircut, anna],
    );
    await t.testDb.pool.query(
      `INSERT INTO time_off (staff_id, period) VALUES ($1, tstzrange('2026-03-25 12:00Z', '2026-03-25 16:00Z'))`,
      [anna],
    );

    const { body } = await availability({
      serviceId: haircut,
      staffId: anna,
      from: '2026-03-25',
      to: '2026-03-25',
    });
    // Bokningen blockerar 08:00–09:00Z, frånvaron hela eftermiddagen.
    expect(starts(body, '2026-03-25')).toEqual([
      '2026-03-25T09:00:00Z',
      '2026-03-25T09:15:00Z',
      '2026-03-25T09:30:00Z',
      '2026-03-25T09:45:00Z',
      '2026-03-25T10:00:00Z',
    ]);
  });

  it.each([
    [{ from: '2026-03-25', to: '2026-03-24' }, 'querystring/to'],
    [{ from: '2026-03-01', to: '2026-03-15' }, 'querystring/to'],
    [{ from: '2026-02-30', to: '2026-03-01' }, 'querystring/from'],
  ])('rejects an invalid date range %o', async (range, path) => {
    const { status, body } = await availability({ serviceId: haircut, ...range });
    expect(status).toBe(400);
    expect(body).toMatchObject({ errors: [{ path }] });
  });

  it('returns 404 for an unknown service or staff who do not perform it', async () => {
    const unknown = await availability({
      serviceId: '01900000-0000-7000-8000-00000000ffff',
      from: '2026-03-24',
      to: '2026-03-24',
    });
    expect(unknown.status).toBe(404);

    const notOffered = await availability({
      serviceId: colour,
      staffId: anna,
      from: '2026-03-24',
      to: '2026-03-24',
    });
    expect(notOffered.status).toBe(404);
  });
});
