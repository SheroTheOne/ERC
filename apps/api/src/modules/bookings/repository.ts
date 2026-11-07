import { Booking, BookingStatus, type Contact } from '@erc/contracts';
import { sql, type Kysely } from 'kysely';
import { Value } from 'typebox/value';
import type { DB, Json } from '../../db/types.ts';
import type { Period } from '../availability/slots.ts';

type Executor = Kysely<DB>;

/**
 * Serialiserar förfrågningar med samma idempotensnyckel inom transaktionen.
 * En krock i den 64-bitars hashen ger bara onödig väntan, aldrig fel svar,
 * eftersom nyckeln jämförs exakt efteråt.
 */
export async function lockIdempotencyKey(db: Executor, key: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(db);
}

/**
 * Köar bokningsförsök per personal, så att samtidiga INSERT mot samma person inte
 * hamnar i deadlock i EXCLUDE-indexet (ADR-0012). Låsen tas alltid i id-ordning,
 * en i taget, så att två transaktioner aldrig kan vänta på varandra i cirkel.
 * Låsen skyddar inte integriteten, det gör booking_no_overlap.
 */
export async function lockStaffForBooking(
  db: Executor,
  staffIds: readonly string[],
): Promise<void> {
  for (const staffId of [...new Set(staffIds)].sort()) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`booking-staff:${staffId}`}, 0))`.execute(
      db,
    );
  }
}

export interface IdempotencyRecord {
  readonly requestHash: Buffer;
  readonly responseStatus: number;
  readonly responseBody: Json;
}

export function findIdempotencyRecord(
  db: Executor,
  key: string,
): Promise<IdempotencyRecord | undefined> {
  return db
    .selectFrom('idempotencyKey')
    .select(['requestHash', 'responseStatus', 'responseBody'])
    .where('key', '=', key)
    .executeTakeFirst();
}

export async function saveIdempotencyRecord(
  db: Executor,
  record: { key: string; requestHash: Buffer; responseStatus: number; responseBody: Booking },
): Promise<void> {
  await db
    .insertInto('idempotencyKey')
    .values({
      key: record.key,
      requestHash: record.requestHash,
      responseStatus: record.responseStatus,
      responseBody: JSON.stringify(record.responseBody),
    })
    .execute();
}

/**
 * Kopplar bokningen till en befintlig kund via e-post, eller skapar en ny.
 * Befintliga kontaktuppgifter skrivs aldrig över av en anonym bokning (ADR-0008).
 */
export async function findOrCreateCustomer(db: Executor, contact: Contact): Promise<string> {
  const inserted = await db
    .insertInto('customer')
    .values({ email: contact.email, name: contact.name, phone: contact.phone ?? null })
    .onConflict((oc) => oc.column('email').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted !== undefined) return inserted.id;

  const existing = await db
    .selectFrom('customer')
    .select('id')
    .where('email', '=', contact.email)
    .executeTakeFirstOrThrow();
  return existing.id;
}

/**
 * Personal som utför tjänsten och har den blockerade tiden ledig, i den ordning
 * de ska prövas: minst bokad tid den lokala dagen först, sedan id (ADR-0003).
 * Resultatet är bara ett förslag. Det är constraintet som avgör vid INSERT.
 */
export async function candidateStaff(
  db: Executor,
  input: { serviceId: string; blocked: Period; day: Period },
): Promise<string[]> {
  const blockedStart = input.blocked.start.toString();
  const blockedEnd = input.blocked.end.toString();
  const { rows } = await sql<{ id: string }>`
    SELECT s.id
    FROM staff s
    JOIN staff_service ss ON ss.staff_id = s.id AND ss.service_id = ${input.serviceId}
    WHERE s.active
      AND tstzrange(${blockedStart}::timestamptz, ${blockedEnd}::timestamptz, '[)')
          <@ staff_free_periods(s.id, tstzrange(${blockedStart}::timestamptz, ${blockedEnd}::timestamptz, '[)'))
    ORDER BY (
      SELECT coalesce(sum(upper(b.blocked) - lower(b.blocked)), interval '0')
      FROM booking b
      WHERE b.staff_id = s.id
        AND b.status <> 'cancelled'
        AND b.blocked && tstzrange(${input.day.start.toString()}::timestamptz, ${input.day.end.toString()}::timestamptz, '[)')
    ), s.id
  `.execute(db);
  return rows.map((row) => row.id);
}

export interface NewBooking {
  readonly customerId: string;
  readonly serviceId: string;
  readonly staffId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  readonly priceOre: number;
  readonly contactName: string;
  readonly contactPhone: string | null;
  readonly customerNote: string | null;
}

export async function insertBooking(db: Executor, booking: NewBooking): Promise<string> {
  const { id } = await db
    .insertInto('booking')
    .values(booking)
    .returning('id')
    .executeTakeFirstOrThrow();
  return id;
}

export async function insertAccessToken(
  db: Executor,
  token: { bookingId: string; tokenHash: Buffer; expiresAt: string },
): Promise<void> {
  await db.insertInto('bookingAccessToken').values(token).execute();
}

export async function hasValidAccessToken(
  db: Executor,
  input: { bookingId: string; tokenHash: Buffer; now: string },
): Promise<boolean> {
  const row = await db
    .selectFrom('bookingAccessToken')
    .select('bookingId')
    .where('tokenHash', '=', input.tokenHash)
    .where('bookingId', '=', input.bookingId)
    .where('expiresAt', '>', input.now)
    .executeTakeFirst();
  return row !== undefined;
}

export async function findBooking(db: Executor, id: string): Promise<Booking | undefined> {
  const row = await db
    .selectFrom('booking')
    .innerJoin('service', 'service.id', 'booking.serviceId')
    .innerJoin('staff', 'staff.id', 'booking.staffId')
    .select([
      'booking.id',
      'booking.status',
      'booking.serviceId',
      'service.name as serviceName',
      'booking.staffId',
      'staff.displayName as staffName',
      'booking.startsAt',
      'booking.endsAt',
      'booking.priceOre',
      'booking.contactName',
      'booking.cancelledAt',
    ])
    .where('booking.id', '=', id)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return { ...row, status: toBookingStatus(row.status) };
}

/** Låser bokningsraden för en statusändring, så att två avbokningar inte krockar. */
export function lockBooking(
  db: Executor,
  id: string,
): Promise<{ status: string; startsAt: string } | undefined> {
  return db
    .selectFrom('booking')
    .select(['status', 'startsAt'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

export async function markCancelled(db: Executor, id: string, at: string): Promise<void> {
  await db
    .updateTable('booking')
    .set({ status: 'cancelled', cancelledAt: at })
    .where('id', '=', id)
    .execute();
}

/** Ett sparat svar från idempotenstabellen måste fortfarande stämma med kontraktet. */
export function parseStoredBooking(body: Json): Booking {
  if (!Value.Check(Booking, body)) {
    throw new Error('Stored idempotent response does not match the Booking contract');
  }
  return body;
}

function toBookingStatus(status: string): BookingStatus {
  if (!Value.Check(BookingStatus, status)) {
    throw new Error(`Unknown booking status in database: ${status}`);
  }
  return status;
}
