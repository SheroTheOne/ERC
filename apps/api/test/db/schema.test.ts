// Databasens invarianter, testade direkt i SQL utan applikationslagret (ADR-0002, ADR-0009).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../setup/database.ts';

const STAFF = '01900000-0000-7000-8000-0000000000a1';
const HAIRCUT = '01900000-0000-7000-8000-0000000000c1'; // 60 min + 15 min buffert efter
const COLOUR = '01900000-0000-7000-8000-0000000000c2'; // utförs inte av STAFF
const CUSTOMER = '01900000-0000-7000-8000-0000000000b1';

let testDb: TestDatabase;

async function query<T extends pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await testDb.pool.query<T>(text, values);
  return result.rows;
}

async function single<T extends pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T> {
  const [row] = await query<T>(text, values);
  if (row === undefined) throw new Error(`No row returned by: ${text}`);
  return row;
}

async function expectPgError(
  promise: Promise<unknown>,
  expected: { code: string; constraint?: string },
): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error, 'expected the statement to fail').toBeInstanceOf(pg.DatabaseError);
  const { code, constraint } = error as pg.DatabaseError;
  expect({ code, constraint }).toMatchObject(expected);
}

async function workingPeriods(from: string, to: string): Promise<string> {
  const row = await single<{ m: string }>(
    `SELECT staff_working_periods($1, tstzrange($2, $3))::text AS m`,
    [STAFF, from, to],
  );
  return row.m;
}

function insertBooking(serviceId: string, startsAt: string, endsAt: string, bufferAfter: number) {
  return single<{ id: string; blocked: string }>(
    `INSERT INTO booking (customer_id, service_id, staff_id, starts_at, ends_at,
       buffer_before_minutes, buffer_after_minutes, price_ore, contact_name)
     VALUES ($1, $2, $3, $4, $5, 0, $6, 50000, 'Kund')
     RETURNING id, blocked::text`,
    [CUSTOMER, serviceId, STAFF, startsAt, endsAt, bufferAfter],
  );
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await testDb.pool.query(`
    INSERT INTO business (name, timezone) VALUES ('Salong', 'Europe/Stockholm');
    INSERT INTO app_user (id, email, role) VALUES ('01900000-0000-7000-8000-000000000001', 'anna@example.com', 'staff');
    INSERT INTO staff (id, user_id, display_name) VALUES ('${STAFF}', '01900000-0000-7000-8000-000000000001', 'Anna');
    INSERT INTO service (id, name, duration_minutes, buffer_after_minutes, price_ore) VALUES
      ('${HAIRCUT}', 'Klippning', 60, 15, 50000),
      ('${COLOUR}', 'Färg', 90, 0, 90000);
    INSERT INTO staff_service VALUES ('${STAFF}', '${HAIRCUT}');
    INSERT INTO customer (id, email, name) VALUES ('${CUSTOMER}', 'kund@example.com', 'Kund');
    -- Söndag 01-05 korsar sommartidsomställningarna. Måndag har lunch och slutar vid midnatt.
    INSERT INTO working_hours (staff_id, weekday, start_time, end_time, valid_from) VALUES
      ('${STAFF}', 7, '01:00', '05:00', '2026-01-01'),
      ('${STAFF}', 1, '09:00', '12:00', '2026-01-01'),
      ('${STAFF}', 1, '13:00', '24:00', '2026-01-01');
  `);
});

afterAll(async () => {
  await testDb.destroy();
});

describe('working hours across daylight saving time (Europe/Stockholm)', () => {
  it('spring forward: 01:00-05:00 local is three real hours on 2026-03-29', async () => {
    expect(await workingPeriods('2026-03-28 12:00Z', '2026-03-30 00:00Z')).toBe(
      '{["2026-03-29 00:00:00+00","2026-03-29 03:00:00+00")}',
    );
  });

  it('fall back: 01:00-05:00 local is five real hours on 2026-10-25', async () => {
    expect(await workingPeriods('2026-10-24 12:00Z', '2026-10-26 00:00Z')).toBe(
      '{["2026-10-24 23:00:00+00","2026-10-25 04:00:00+00")}',
    );
  });

  it('keeps 09:00 wall-clock time when the UTC offset changes', async () => {
    const row = await single<{ winter: string; summer: string }>(
      `SELECT lower(staff_working_periods($1, tstzrange('2026-03-23 00:00Z', '2026-03-24 00:00Z'))) AS winter,
              lower(staff_working_periods($1, tstzrange('2026-03-30 00:00Z', '2026-03-31 00:00Z'))) AS summer`,
      [STAFF],
    );
    expect(row).toEqual({ winter: '2026-03-23T08:00:00Z', summer: '2026-03-30T07:00:00Z' });
  });

  it('does not depend on the session time zone and supports 24:00 as end of day', async () => {
    const client = await testDb.pool.connect();
    try {
      await client.query(`SET TimeZone = 'America/Los_Angeles'`);
      const result = await client.query<{ eq: boolean }>(
        `SELECT staff_working_periods($1, tstzrange('2026-03-30 00:00Z', '2026-03-31 00:00Z'))
              = '{[2026-03-30 07:00Z,2026-03-30 10:00Z),[2026-03-30 11:00Z,2026-03-30 22:00Z)}'::tstzmultirange AS eq`,
        [STAFF],
      );
      expect(result.rows[0]?.eq).toBe(true);
    } finally {
      await client.query(`RESET TimeZone`);
      client.release();
    }
  });

  it('clips periods to the requested window', async () => {
    expect(await workingPeriods('2026-03-30 08:00Z', '2026-03-30 08:30Z')).toBe(
      '{["2026-03-30 08:00:00+00","2026-03-30 08:30:00+00")}',
    );
  });
});

// Testerna i det här blocket är ett scenario som bygger på varandra. Vitest kör
// tester i en fil i ordning, så tillståndet mellan dem är deterministiskt.
describe('booking invariants', () => {
  // Måndag 2026-03-30 (sommartid): 09:00-12:00 och 13:00-24:00 lokal tid = 07-10Z och 11-22Z.
  let first: { id: string; blocked: string };
  let second: { id: string; blocked: string };

  it('accepts a booking inside open hours and blocks its buffer', async () => {
    first = await insertBooking(HAIRCUT, '2026-03-30T07:00Z', '2026-03-30T08:00Z', 15);
    expect(first.blocked).toBe('["2026-03-30 07:00:00+00","2026-03-30 08:15:00+00")');
  });

  it('rejects an overlapping booking', async () => {
    await expectPgError(insertBooking(HAIRCUT, '2026-03-30T07:30Z', '2026-03-30T08:30Z', 15), {
      code: '23P01',
      constraint: 'booking_no_overlap',
    });
  });

  it('rejects a booking that starts inside the previous buffer', async () => {
    await expectPgError(insertBooking(HAIRCUT, '2026-03-30T08:10Z', '2026-03-30T09:10Z', 0), {
      code: '23P01',
      constraint: 'booking_no_overlap',
    });
  });

  it('accepts a booking that starts exactly when the buffer ends (half-open ranges)', async () => {
    second = await insertBooking(HAIRCUT, '2026-03-30T08:15Z', '2026-03-30T09:15Z', 0);
    expect(second.id).toBeTypeOf('string');
  });

  it.each([
    ['before opening', '2026-03-30T05:00Z', '2026-03-30T06:00Z', 0],
    ['across the lunch break', '2026-03-30T09:30Z', '2026-03-30T11:30Z', 0],
    ['with its buffer past closing', '2026-03-30T09:15Z', '2026-03-30T10:00Z', 15],
  ])('rejects a booking %s', async (_label, startsAt, endsAt, bufferAfter) => {
    await expectPgError(insertBooking(HAIRCUT, startsAt, endsAt, bufferAfter), {
      code: '23514',
      constraint: 'booking_within_open_hours',
    });
  });

  it('rejects a service the staff member does not perform', async () => {
    await expectPgError(insertBooking(COLOUR, '2026-03-30T11:00Z', '2026-03-30T12:30Z', 0), {
      code: '23514',
      constraint: 'booking_staff_performs_service',
    });
  });

  it('rejects ends_at <= starts_at', async () => {
    await expectPgError(insertBooking(HAIRCUT, '2026-03-30T12:00Z', '2026-03-30T12:00Z', 0), {
      code: '23514',
      constraint: 'booking_ends_after_starts',
    });
  });

  it('recomputes blocked on every write so clients cannot forge it', async () => {
    await query(
      `UPDATE booking SET blocked = tstzrange('2000-01-01Z', '2000-01-02Z') WHERE id = $1`,
      [second.id],
    );
    const row = await single<{ blocked: string }>(
      `SELECT blocked::text FROM booking WHERE id = $1`,
      [second.id],
    );
    expect(row.blocked).toBe('["2026-03-30 08:15:00+00","2026-03-30 09:15:00+00")');
  });

  it('frees the slot when a booking is cancelled', async () => {
    await query(`UPDATE booking SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [
      first.id,
    ]);
    const replacement = await insertBooking(HAIRCUT, '2026-03-30T07:00Z', '2026-03-30T08:00Z', 15);
    expect(replacement.id).not.toBe(first.id);
  });

  it('rejects reactivating a cancelled booking into a taken slot', async () => {
    await expectPgError(
      query(`UPDATE booking SET status = 'confirmed', cancelled_at = NULL WHERE id = $1`, [
        first.id,
      ]),
      { code: '23P01', constraint: 'booking_no_overlap' },
    );
  });

  it('requires cancelled_at for cancelled bookings', async () => {
    await expectPgError(
      query(`UPDATE booking SET status = 'cancelled' WHERE id = $1`, [second.id]),
      {
        code: '23514',
        constraint: 'booking_cancellation_consistent',
      },
    );
  });

  it('rejects new bookings during time off but keeps existing ones', async () => {
    await query(
      `INSERT INTO time_off (staff_id, period) VALUES ($1, tstzrange('2026-03-30 11:00Z', '2026-03-30 13:00Z'))`,
      [STAFF],
    );
    await expectPgError(insertBooking(HAIRCUT, '2026-03-30T11:30Z', '2026-03-30T12:30Z', 0), {
      code: '23514',
      constraint: 'booking_within_open_hours',
    });
    const row = await single<{ n: number }>(
      `SELECT count(*)::int AS n FROM booking WHERE status <> 'cancelled'`,
    );
    expect(row.n).toBe(2);
  });

  it('allows status changes on a booking that a later schedule change put outside open hours', async () => {
    await query(
      `INSERT INTO time_off (staff_id, period) VALUES ($1, tstzrange('2026-03-30 08:00Z', '2026-03-30 10:00Z'))`,
      [STAFF],
    );
    await query(`UPDATE booking SET status = 'no_show' WHERE id = $1`, [second.id]);
    const row = await single<{ status: string }>(`SELECT status FROM booking WHERE id = $1`, [
      second.id,
    ]);
    expect(row.status).toBe('no_show');
  });

  it('computes free periods as open time minus bookings', async () => {
    const row = await single<{ m: string }>(
      `SELECT staff_free_periods($1, tstzrange('2026-03-30 00:00Z', '2026-03-31 00:00Z'))::text AS m`,
      [STAFF],
    );
    expect(row.m).toBe('{["2026-03-30 13:00:00+00","2026-03-30 22:00:00+00")}');
  });
});

describe('working hours and settings', () => {
  it('rejects overlapping shifts for the same weekday and validity', async () => {
    await expectPgError(
      query(
        `INSERT INTO working_hours (staff_id, weekday, start_time, end_time, valid_from)
         VALUES ($1, 1, '11:00', '14:00', '2026-06-01')`,
        [STAFF],
      ),
      { code: '23P01', constraint: 'working_hours_no_overlap' },
    );
  });

  it('supports effective-dated schedule changes', async () => {
    await query(
      `UPDATE working_hours SET valid_until = '2026-06-01' WHERE staff_id = $1 AND weekday = 1 AND start_time = '09:00'`,
      [STAFF],
    );
    await query(
      `INSERT INTO working_hours (staff_id, weekday, start_time, end_time, valid_from)
       VALUES ($1, 1, '10:00', '12:00', '2026-06-01')`,
      [STAFF],
    );
    // Måndag 2026-06-01: nya passet gäller, 10:00 lokal tid = 08:00Z.
    expect(await workingPeriods('2026-06-01 00:00Z', '2026-06-01 10:00Z')).toBe(
      '{["2026-06-01 08:00:00+00","2026-06-01 10:00:00+00")}',
    );
  });

  it('rejects an unknown time zone', async () => {
    await expectPgError(query(`UPDATE business SET timezone = 'Mars/Olympus'`), {
      code: '23514',
      constraint: 'business_timezone_check',
    });
  });

  it('returns dates as plain YYYY-MM-DD strings and timestamps as UTC ISO strings', async () => {
    const row = await single<{ d: string; t: string }>(
      `SELECT DATE '2026-03-29' AS d, TIMESTAMPTZ '2026-03-29 02:30:00+01' AS t`,
    );
    expect(row).toEqual({ d: '2026-03-29', t: '2026-03-29T01:30:00Z' });
  });
});
