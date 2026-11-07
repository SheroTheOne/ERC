import { randomUUID } from 'node:crypto';
import type { AvailabilityResponse, Booking } from '@erc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED } from '../../db/seed/seed.ts';
import { createTestApp, type TestApp } from '../setup/app.ts';

const { haircut, colour } = SEED.services;
const { anna, bo } = SEED.staff;

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ now: '2026-03-20T12:00:00Z' });
});

afterAll(async () => {
  await t.close();
});

interface BookingInput {
  serviceId?: string;
  staffId?: string;
  startsAt: string;
  email?: string;
  name?: string;
}

function bookingBody(input: BookingInput) {
  return {
    serviceId: input.serviceId ?? haircut,
    ...(input.staffId === undefined ? {} : { staffId: input.staffId }),
    startsAt: input.startsAt,
    contact: {
      name: input.name ?? 'Test Kund',
      email: input.email ?? `${randomUUID()}@example.com`,
    },
  };
}

function book(input: BookingInput, key: string | null = randomUUID()) {
  return t.app.inject({
    method: 'POST',
    url: '/api/v1/bookings',
    headers: key === null ? {} : { 'idempotency-key': key },
    payload: bookingBody(input),
  });
}

function manageToken(email: string): string {
  const message = t.mailer.lastTo(email);
  if (message === undefined) throw new Error(`No confirmation sent to ${email}`);
  return message.manageToken;
}

async function activeBookings(staffId: string, startsAt: string): Promise<number> {
  const { rows } = await t.testDb.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM booking WHERE staff_id = $1 AND starts_at = $2 AND status <> 'cancelled'`,
    [staffId, startsAt],
  );
  return rows[0]?.n ?? 0;
}

describe('POST /api/v1/bookings', () => {
  it('creates a booking, snapshots the service and sends the manage link by e-mail only', async () => {
    const email = 'ny@example.com';
    // Tisdag 2026-03-24 10:00 lokal tid hos Anna.
    const response = await book({ staffId: anna, startsAt: '2026-03-24T10:00:00+01:00', email });

    expect(response.statusCode).toBe(201);
    const booking = response.json<Booking>();
    expect(booking).toMatchObject({
      status: 'confirmed',
      serviceId: haircut,
      serviceName: 'Klippning',
      staffId: anna,
      staffName: 'Anna',
      startsAt: '2026-03-24T09:00:00Z',
      endsAt: '2026-03-24T09:45:00Z',
      priceOre: 45_000,
      cancelledAt: null,
    });
    expect(response.headers.location).toBe(`/api/v1/bookings/${booking.id}`);
    expect(JSON.stringify(booking)).not.toContain(manageToken(email));

    const { rows } = await t.testDb.pool.query<{ blocked: string }>(
      'SELECT blocked::text FROM booking WHERE id = $1',
      [booking.id],
    );
    expect(rows[0]?.blocked).toBe('["2026-03-24 09:00:00+00","2026-03-24 10:00:00+00")');
  });

  it('replays the stored response for a retried request with the same key', async () => {
    const key = randomUUID();
    const input = {
      staffId: anna,
      startsAt: '2026-03-24T13:00:00+01:00',
      email: 'retry@example.com',
    };

    const first = await book(input, key);
    const second = await book(input, key);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json<Booking>().id).toBe(first.json<Booking>().id);
    expect(await activeBookings(anna, '2026-03-24T12:00:00Z')).toBe(1);
    expect(t.mailer.sent.filter((message) => message.to === 'retry@example.com')).toHaveLength(1);
  });

  it('rejects reusing a key for a different request', async () => {
    const key = randomUUID();
    expect(
      (await book({ staffId: bo, startsAt: '2026-03-24T15:00:00+01:00' }, key)).statusCode,
    ).toBe(201);
    const reused = await book({ staffId: bo, startsAt: '2026-03-24T16:00:00+01:00' }, key);
    expect(reused.statusCode).toBe(422);
    expect(reused.json()).toMatchObject({
      type: 'https://erc.example/problems/idempotency-key-reused',
    });
  });

  it('requires a UUID Idempotency-Key header', async () => {
    expect((await book({ startsAt: '2026-03-26T10:00:00+01:00' }, null)).statusCode).toBe(428);
    expect((await book({ startsAt: '2026-03-26T10:00:00+01:00' }, 'not-a-uuid')).statusCode).toBe(
      400,
    );
  });

  it('rejects a slot that is already taken with 409 slot-unavailable', async () => {
    const response = await book({ staffId: anna, startsAt: '2026-03-24T10:30:00+01:00' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      type: 'https://erc.example/problems/slot-unavailable',
    });
  });

  it.each([
    ['before opening', '2026-03-24T08:00:00+01:00', 409, 'outside-open-hours'],
    ['inside the notice period', '2026-03-20T13:30:00+01:00', 409, 'outside-open-hours'],
    ['beyond the booking horizon', '2026-06-01T10:00:00+02:00', 409, 'outside-open-hours'],
    ['off the 15-minute grid', '2026-03-26T10:05:00+01:00', 400, 'validation-failed'],
  ])('rejects a start %s', async (_label, startsAt, status, type) => {
    const response = await book({ staffId: anna, startsAt });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ type: `https://erc.example/problems/${type}` });
  });

  it('rejects staff who do not perform the service', async () => {
    const response = await book({
      serviceId: colour,
      staffId: anna,
      startsAt: '2026-03-26T10:00:00+01:00',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ errors: [{ path: 'body/staffId' }] });
  });

  it('never overwrites an existing customer’s details from an anonymous booking', async () => {
    const response = await book({
      staffId: bo,
      startsAt: '2026-03-26T11:00:00+01:00',
      email: 'kim@example.com',
      name: 'Någon Annan',
    });
    expect(response.statusCode).toBe(201);

    const { rows } = await t.testDb.pool.query<{ name: string; contact: string }>(
      `SELECT c.name, b.contact_name AS contact FROM booking b JOIN customer c ON c.id = b.customer_id WHERE b.id = $1`,
      [response.json<Booking>().id],
    );
    expect(rows[0]).toEqual({ name: 'Kim Svensson', contact: 'Någon Annan' });
  });

  it('assigns the least booked staff member when no staff is chosen', async () => {
    // Torsdag 2026-03-26: Bo har redan en bokning den dagen, Anna ingen. Båda arbetar 13:00.
    const response = await book({ startsAt: '2026-03-26T13:00:00+01:00' });
    expect(response.statusCode).toBe(201);
    expect(response.json<Booking>().staffId).toBe(anna);
  });
});

describe('managing a booking with the link from the confirmation', () => {
  const email = 'hantera@example.com';
  let booking: Booking;
  let token: string;

  beforeAll(async () => {
    const response = await book({ staffId: anna, startsAt: '2026-03-27T10:00:00+01:00', email });
    booking = response.json<Booking>();
    token = manageToken(email);
  });

  const get = (id: string, authorization?: string) =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1/bookings/${id}`,
      headers: authorization === undefined ? {} : { authorization },
    });

  const cancel = (id: string, bearer: string) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${id}/cancel`,
      headers: { authorization: `Bearer ${bearer}` },
    });

  it('shows the booking with a valid token', async () => {
    const response = await get(booking.id, `Bearer ${token}`);
    expect(response.statusCode).toBe(200);
    expect(response.json<Booking>().id).toBe(booking.id);
  });

  it('requires a token, and hides bookings the token does not belong to', async () => {
    expect((await get(booking.id)).statusCode).toBe(401);
    expect((await get(booking.id, 'Bearer ' + 'x'.repeat(43))).statusCode).toBe(404);
    expect((await get(booking.id, 'Bearer short')).statusCode).toBe(404);

    const other = (
      await book({ staffId: bo, startsAt: '2026-03-27T15:00:00+01:00' })
    ).json<Booking>();
    expect((await get(other.id, `Bearer ${token}`)).statusCode).toBe(404);
  });

  it('refuses to cancel after the cancellation cutoff', async () => {
    t.clock.set('2026-03-27T08:30:00Z'); // 09:30 lokal tid, besöket 10:00, gräns 120 min
    try {
      const response = await cancel(booking.id, token);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        type: 'https://erc.example/problems/cancellation-window-closed',
      });
    } finally {
      t.clock.set('2026-03-20T12:00:00Z');
    }
  });

  it('cancels idempotently and frees the slot immediately', async () => {
    const first = await cancel(booking.id, token);
    expect(first.statusCode).toBe(200);
    expect(first.json<Booking>()).toMatchObject({
      status: 'cancelled',
      cancelledAt: '2026-03-20T12:00:00Z',
    });

    const again = await cancel(booking.id, token);
    expect(again.statusCode).toBe(200);
    expect(again.json<Booking>()).toEqual(first.json<Booking>());

    const availability = (
      await t.app.inject({
        method: 'GET',
        url: '/api/v1/availability',
        query: { serviceId: haircut, staffId: anna, from: '2026-03-27', to: '2026-03-27' },
      })
    ).json<AvailabilityResponse>();
    expect(availability.days[0]?.slots.map((slot) => slot.startsAt)).toContain(
      '2026-03-27T09:00:00Z',
    );

    expect((await book({ staffId: anna, startsAt: '2026-03-27T10:00:00+01:00' })).statusCode).toBe(
      201,
    );
  });
});
