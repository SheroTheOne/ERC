// Samtidiga bokningar av samma tid (ADR-0003, ADR-0009). Klart när-kriteriet för Fas 2:
// parallella bokningar av samma tid ger exakt en lyckad bokning.
import { randomUUID } from 'node:crypto';
import type { Booking } from '@erc/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED } from '../../db/seed/seed.ts';
import { createTestApp, type TestApp } from '../setup/app.ts';

const CONTENDERS = 20;
const { haircut } = SEED.services;
const { anna, bo } = SEED.staff;

// Tisdag 2026-03-24 10:00 lokal tid. Både Anna och Bo arbetar då och utför klippning.
const SLOT = { startsAt: '2026-03-24T09:00:00Z', endsAt: '2026-03-24T09:45:00Z' };

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ now: '2026-03-20T12:00:00Z', poolMax: CONTENDERS + 5 });
});

afterAll(async () => {
  await t.close();
});

function connect(): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: t.testDb.url,
    options: '-c search_path=erc,public -c TimeZone=UTC',
  });
  return client.connect().then(() => client);
}

const INSERT_BOOKING = `
  INSERT INTO booking (customer_id, service_id, staff_id, starts_at, ends_at,
    buffer_before_minutes, buffer_after_minutes, price_ore, contact_name)
  VALUES ($1, $2, $3, $4, $5, 0, 15, 45000, 'Kund')`;

/**
 * Deterministisk spärr. En separat transaktion håller ocommittade bokningar på
 * tiden, så att varje tävlande transaktion blockeras i constraint-kontrollen
 * (EXCLUDE väntar på den ocommittade raden). När exakt `waiters` sessioner
 * väntar på lås rullas spärren tillbaka och alla tävlar om samma rad samtidigt.
 * Utan spärren kan ett grönt resultat bero på att anropen råkade köras ett i taget.
 */
async function raceBehindBarrier<T>(
  blockStaff: readonly string[],
  waiters: number,
  start: () => Promise<T>,
): Promise<T> {
  const barrier = await connect();
  const monitor = await connect();
  try {
    await barrier.query('BEGIN');
    for (const staffId of blockStaff) {
      await barrier.query(INSERT_BOOKING, [
        SEED.customers.kim,
        haircut,
        staffId,
        SLOT.startsAt,
        SLOT.endsAt,
      ]);
    }

    const running = start();
    const deadline = Date.now() + 15_000;
    for (;;) {
      const { rows } = await monitor.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
      );
      if ((rows[0]?.n ?? 0) >= waiters) break;
      if (Date.now() > deadline) {
        throw new Error(`Only ${rows[0]?.n ?? 0} of ${waiters} sessions reached the barrier`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await barrier.query('ROLLBACK');
    return await running;
  } finally {
    await barrier.query('ROLLBACK').catch(() => undefined);
    await barrier.end();
    await monitor.end();
  }
}

async function activeAt(startsAt: string): Promise<{ staffId: string }[]> {
  const { rows } = await t.testDb.pool.query<{ staffId: string }>(
    `SELECT staff_id AS "staffId" FROM booking WHERE starts_at = $1 AND status <> 'cancelled' ORDER BY staff_id`,
    [startsAt],
  );
  return rows;
}

async function clearBookings(): Promise<void> {
  await t.testDb.pool.query('DELETE FROM idempotency_key; DELETE FROM booking');
}

function postBooking(index: number, staffId?: string) {
  return t.app.inject({
    method: 'POST',
    url: '/api/v1/bookings',
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      serviceId: haircut,
      ...(staffId === undefined ? {} : { staffId }),
      startsAt: SLOT.startsAt,
      // Olika kunder, så att ingen väntar på en annans kundrad före bokningen.
      contact: { name: `Kund ${index}`, email: `kund-${index}-${randomUUID()}@example.com` },
    },
  });
}

describe(`${CONTENDERS} concurrent bookings of the same slot`, () => {
  it('lets exactly one transaction win at the database level', async () => {
    await clearBookings();
    const clients = await Promise.all(Array.from({ length: CONTENDERS }, connect));
    try {
      const outcomes = await raceBehindBarrier([anna], CONTENDERS, () =>
        Promise.all(
          clients.map(async (client) => {
            await client.query('BEGIN');
            try {
              await client.query(INSERT_BOOKING, [
                SEED.customers.kim,
                haircut,
                anna,
                SLOT.startsAt,
                SLOT.endsAt,
              ]);
              await client.query('COMMIT');
              return 'committed';
            } catch (error) {
              await client.query('ROLLBACK');
              return error instanceof pg.DatabaseError
                ? `${error.code} ${error.constraint ?? ''}`
                : 'other';
            }
          }),
        ),
      );

      expect(outcomes.filter((o) => o === 'committed')).toHaveLength(1);
      expect(outcomes.filter((o) => o === '23P01 booking_no_overlap')).toHaveLength(CONTENDERS - 1);
      expect(await activeAt(SLOT.startsAt)).toEqual([{ staffId: anna }]);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });

  it('returns one 201 and 409 slot-unavailable for everyone else over HTTP', async () => {
    await clearBookings();
    const responses = await raceBehindBarrier([anna], CONTENDERS, () =>
      Promise.all(Array.from({ length: CONTENDERS }, (_, index) => postBooking(index, anna))),
    );

    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([201, ...Array<number>(CONTENDERS - 1).fill(409)]);
    for (const response of responses.filter((r) => r.statusCode === 409)) {
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(response.json()).toMatchObject({
        type: 'https://erc.example/problems/slot-unavailable',
      });
    }
    expect(await activeAt(SLOT.startsAt)).toEqual([{ staffId: anna }]);
    // Bara vinnaren får en bekräftelse.
    const winner = responses.find((r) => r.statusCode === 201)?.json<Booking>();
    expect(t.mailer.sent.filter((message) => message.booking.id === winner?.id)).toHaveLength(1);
  });

  it('fills every available staff member exactly once for "any staff"', async () => {
    await clearBookings();
    // Spärren håller Annas tid, som prövas först (lika mycket bokat, lägst id).
    // Förlorarna går vidare till Bo i en savepoint. Två personal, två vinnare.
    const responses = await raceBehindBarrier([anna], CONTENDERS, () =>
      Promise.all(Array.from({ length: CONTENDERS }, (_, index) => postBooking(index))),
    );

    const winners = responses
      .filter((r) => r.statusCode === 201)
      .map((r) => r.json<Booking>().staffId);
    expect(winners.sort()).toEqual([anna, bo].sort());
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(CONTENDERS - 2);
    expect(await activeAt(SLOT.startsAt)).toEqual(
      [{ staffId: anna }, { staffId: bo }].sort((a, b) => (a.staffId < b.staffId ? -1 : 1)),
    );
  });
});
