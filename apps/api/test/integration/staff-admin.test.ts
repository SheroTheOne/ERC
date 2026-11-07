import type {
  AvailabilityResponse,
  Booking,
  StaffMember,
  TimeOff,
  WorkingHoursResponse,
} from '@erc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED } from '../../db/seed/seed.ts';
import { as, createTestApp, loginAs, type TestApp } from '../setup/app.ts';

const { anna, bo, alva } = SEED.staff;
const { haircut } = SEED.services;

let t: TestApp;
let admin: string;
let annaSession: string;

beforeAll(async () => {
  t = await createTestApp({ now: '2026-03-20T12:00:00Z' });
  admin = await loginAs(t, 'alva@erc.example');
  annaSession = await loginAs(t, 'anna@erc.example');
});

afterAll(async () => {
  await t.close();
});

async function bookAnna(startsAt: string): Promise<string> {
  const { rows } = await t.testDb.pool.query<{ id: string }>(
    `INSERT INTO booking (customer_id, service_id, staff_id, starts_at, ends_at,
       buffer_before_minutes, buffer_after_minutes, price_ore, contact_name)
     VALUES ($1, $2, $3, $4, $4::timestamptz + interval '45 minutes', 0, 15, 45000, 'Kim')
     RETURNING id`,
    [SEED.customers.kim, haircut, anna, startsAt],
  );
  return rows[0]?.id ?? '';
}

describe('staff administration', () => {
  it('creates a staff member who can log in with the initial password', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: as(admin),
      payload: {
        email: 'cecilia@erc.example',
        displayName: 'Cecilia',
        role: 'staff',
        password: 'ett-långt-startlösenord',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<StaffMember>()).toMatchObject({
      email: 'cecilia@erc.example',
      displayName: 'Cecilia',
      role: 'staff',
      active: true,
      serviceIds: [],
    });
    await expect(
      loginAs(t, 'cecilia@erc.example', 'ett-långt-startlösenord'),
    ).resolves.toBeTruthy();
  });

  it('rejects a taken e-mail address with 409 and a short password with 400', async () => {
    const taken = await t.app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: as(admin),
      payload: {
        email: 'ANNA@erc.example',
        displayName: 'Anna 2',
        role: 'staff',
        password: 'ett-långt-startlösenord',
      },
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ type: 'https://erc.example/problems/already-exists' });

    const short = await t.app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: as(admin),
      payload: { email: 'kort@erc.example', displayName: 'Kort', role: 'staff', password: 'kort' },
    });
    expect(short.statusCode).toBe(400);
  });

  it('assigns services and lists them on the staff member', async () => {
    const response = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${anna}/services`,
      headers: as(admin),
      payload: { serviceIds: [haircut, SEED.services.beard, SEED.services.colour] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<StaffMember>().serviceIds).toHaveLength(3);

    const unknown = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${anna}/services`,
      headers: as(admin),
      payload: { serviceIds: ['01900000-0000-7000-8000-00000000ffff'] },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('does not let an admin remove their own admin role or deactivate themselves', async () => {
    for (const payload of [{ role: 'staff' }, { active: false }]) {
      const response = await t.app.inject({
        method: 'PATCH',
        url: `/api/v1/staff/${alva}`,
        headers: as(admin),
        payload,
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it('revokes existing sessions when a role changes', async () => {
    const boSession = await loginAs(t, 'bo@erc.example');
    const promote = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/staff/${bo}`,
      headers: as(admin),
      payload: { role: 'admin' },
    });
    expect(promote.statusCode).toBe(200);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: as(boSession) })).statusCode,
    ).toBe(401);

    await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/staff/${bo}`,
      headers: as(admin),
      payload: { role: 'staff' },
    });
  });
});

describe('working hours', () => {
  it('replaces the weekly schedule from a date and keeps history', async () => {
    const response = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${anna}/working-hours`,
      headers: as(annaSession),
      payload: {
        validFrom: '2026-04-06',
        shifts: [
          { weekday: 1, startTime: '10:00', endTime: '18:00' },
          { weekday: 3, startTime: '10:00', endTime: '24:00' },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<WorkingHoursResponse>().rules).toEqual([
      expect.objectContaining({
        weekday: 1,
        startTime: '10:00',
        endTime: '18:00',
        validUntil: null,
      }),
      expect.objectContaining({
        weekday: 3,
        startTime: '10:00',
        endTime: '24:00',
        validUntil: null,
      }),
    ]);

    // Före bytet gäller det gamla schemat fortfarande.
    const before = await t.app.inject({
      method: 'GET',
      url: `/api/v1/staff/${anna}/working-hours`,
      headers: as(annaSession),
      query: { at: '2026-04-03' },
    });
    expect(before.json<WorkingHoursResponse>().rules).toHaveLength(10);
    expect(before.json<WorkingHoursResponse>().rules[0]).toMatchObject({
      validUntil: '2026-04-06',
    });
  });

  it('is reflected in availability immediately', async () => {
    const response = await t.app.inject({
      method: 'GET',
      url: '/api/v1/availability',
      query: { serviceId: haircut, staffId: anna, from: '2026-04-06', to: '2026-04-07' },
    });
    const days = response.json<AvailabilityResponse>().days;
    expect(days[0]?.slots[0]?.startsAt).toBe('2026-04-06T08:00:00Z'); // måndag 10:00 sommartid
    expect(days[1]?.slots).toEqual([]); // tisdag är inte längre en arbetsdag
  });

  it('returns bookings that end up outside the new hours as conflicts', async () => {
    // Onsdag 14:00 sommartid ligger inom 10:00–24:00. Efter ändringen slutar hon 12:00.
    const booking = await bookAnna('2026-04-15T12:00:00Z');
    const response = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${anna}/working-hours`,
      headers: as(admin),
      payload: {
        validFrom: '2026-04-06',
        shifts: [{ weekday: 3, startTime: '10:00', endTime: '12:00' }],
      },
    });
    expect(response.json<{ conflicts: Booking[] }>().conflicts.map((b) => b.id)).toContain(booking);

    const conflicts = await t.app.inject({
      method: 'GET',
      url: '/api/v1/bookings/conflicts',
      headers: as(annaSession),
    });
    expect(conflicts.json<{ items: Booking[] }>().items.map((b) => b.id)).toContain(booking);
  });

  it.each([
    [{ validFrom: '2026-03-01', shifts: [] }, 400, 'past date'],
    [
      { validFrom: '2026-05-04', shifts: [{ weekday: 1, startTime: '12:00', endTime: '09:00' }] },
      400,
      'end before start',
    ],
    [
      {
        validFrom: '2026-05-04',
        shifts: [
          { weekday: 1, startTime: '09:00', endTime: '12:00' },
          { weekday: 1, startTime: '11:00', endTime: '14:00' },
        ],
      },
      409,
      'overlapping shifts',
    ],
  ])('rejects %o (%s)', async (payload, status) => {
    const response = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${anna}/working-hours`,
      headers: as(admin),
      payload,
    });
    expect(response.statusCode).toBe(status);
  });
});

describe('time off', () => {
  let created: TimeOff;

  it('converts local whole days to absolute time and reports conflicts', async () => {
    const booking = await bookAnna('2026-03-30T08:00:00Z'); // måndag 10:00, första dagen med sommartid
    const response = await t.app.inject({
      method: 'POST',
      url: `/api/v1/staff/${anna}/time-off`,
      headers: as(annaSession),
      payload: { fromDate: '2026-03-30', toDate: '2026-03-31', reason: 'Kurs' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ timeOff: TimeOff; conflicts: Booking[] }>();
    created = body.timeOff;
    // Lokal midnatt sommartid är 22:00Z dagen innan.
    expect(created).toMatchObject({
      from: '2026-03-29T22:00:00Z',
      to: '2026-03-31T22:00:00Z',
      reason: 'Kurs',
    });
    expect(body.conflicts.map((b) => b.id)).toContain(booking);
  });

  it('lists and deletes time off, only for the owner or an admin', async () => {
    const listed = await t.app.inject({
      method: 'GET',
      url: `/api/v1/staff/${anna}/time-off`,
      headers: as(annaSession),
    });
    expect(listed.json<{ items: TimeOff[] }>().items.map((item) => item.id)).toContain(created.id);

    const boSession = await loginAs(t, 'bo@erc.example');
    const byOther = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/staff/${anna}/time-off/${created.id}`,
      headers: as(boSession),
    });
    expect(byOther.statusCode).toBe(403);

    const byOwner = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/staff/${anna}/time-off/${created.id}`,
      headers: as(annaSession),
    });
    expect(byOwner.statusCode).toBe(204);

    const again = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/staff/${anna}/time-off/${created.id}`,
      headers: as(annaSession),
    });
    expect(again.statusCode).toBe(404);
  });

  it('rejects a period that ends before it starts', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: `/api/v1/staff/${anna}/time-off`,
      headers: as(annaSession),
      payload: { from: '2026-04-22T10:00:00Z', to: '2026-04-22T09:00:00Z' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('bookings managed by staff', () => {
  it('lists bookings in a range and filters by staff', async () => {
    const id = await bookAnna('2026-03-24T08:00:00Z');
    const response = await t.app.inject({
      method: 'GET',
      url: '/api/v1/bookings',
      headers: as(annaSession),
      query: { from: '2026-03-24T00:00:00Z', to: '2026-03-25T00:00:00Z', staffId: anna },
    });
    expect(response.json<{ items: Booking[] }>().items.map((b) => b.id)).toEqual([id]);

    const tooLong = await t.app.inject({
      method: 'GET',
      url: '/api/v1/bookings',
      headers: as(annaSession),
      query: { from: '2026-03-01T00:00:00Z', to: '2026-04-15T00:00:00Z' },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('books on behalf of a customer without the notice policy', async () => {
    // 30 minuter från nu: kunder måste ha 60 minuters framförhållning, personal inte.
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { ...as(annaSession), 'idempotency-key': crypto.randomUUID() },
      payload: {
        serviceId: haircut,
        staffId: anna,
        startsAt: '2026-03-20T13:30:00Z',
        contact: { name: 'Inringd kund', email: 'telefon@example.com' },
      },
    });
    expect(response.statusCode).toBe(201);
  });

  it('moves a booking, but never onto an occupied slot', async () => {
    const first = await bookAnna('2026-03-26T08:00:00Z');
    const second = await bookAnna('2026-03-26T09:00:00Z');

    const moved = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/bookings/${second}`,
      headers: as(annaSession),
      payload: { startsAt: '2026-03-26T12:00:00Z' },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<Booking>()).toMatchObject({
      startsAt: '2026-03-26T12:00:00Z',
      endsAt: '2026-03-26T12:45:00Z',
    });

    const collision = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/bookings/${second}`,
      headers: as(annaSession),
      payload: { startsAt: '2026-03-26T08:30:00Z' },
    });
    expect(collision.statusCode).toBe(409);
    expect(collision.json()).toMatchObject({
      type: 'https://erc.example/problems/slot-unavailable',
    });
    expect(first).toBeTruthy();
  });

  it('cancels after the customer cutoff and records who cancelled', async () => {
    const id = await bookAnna('2026-03-20T12:15:00Z'); // om en kvart, gränsen för kunder har passerat
    const response = await t.app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${id}/cancel`,
      headers: as(annaSession),
    });
    expect(response.statusCode).toBe(200);
    const { rows } = await t.testDb.pool.query<{ cancelledBy: string }>(
      'SELECT cancelled_by AS "cancelledBy" FROM booking WHERE id = $1',
      [id],
    );
    expect(rows[0]?.cancelledBy).toBe(SEED.users.anna);
  });

  it('allows status changes only on confirmed bookings', async () => {
    const id = await bookAnna('2026-03-27T08:00:00Z');
    const done = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/bookings/${id}`,
      headers: as(annaSession),
      payload: { status: 'completed' },
    });
    expect(done.json<Booking>().status).toBe('completed');

    const again = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/bookings/${id}`,
      headers: as(annaSession),
      payload: { status: 'no_show' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ type: 'https://erc.example/problems/booking-not-active' });
  });
});
