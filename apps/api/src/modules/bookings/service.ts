import type { Booking, Business, CreateBookingRequest } from '@erc/contracts';
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import type { Database } from '../../db/database.ts';
import type { DB } from '../../db/types.ts';
import { ProblemError } from '../../http/problems.ts';
import type { Clock } from '../../shared/clock.ts';
import type { Mailer } from '../../shared/mailer.ts';
import { hashJson } from '../../shared/stable-json.ts';
import { generateToken, hashToken, isWellFormedToken } from '../../shared/tokens.ts';
import { startOfLocalDay, toInstant, toIso } from '../../shared/time.ts';
import { bookingWindow } from '../availability/service.ts';
import { localDate } from '../availability/slots.ts';
import { findActiveService, getBusiness, listStaffForService } from '../catalog/repository.ts';
import {
  candidateStaff,
  findBooking,
  findIdempotencyRecord,
  findOrCreateCustomer,
  hasValidAccessToken,
  insertAccessToken,
  insertBooking,
  lockBooking,
  lockIdempotencyKey,
  markCancelled,
  parseStoredBooking,
  saveIdempotencyRecord,
  type NewBooking,
} from './repository.ts';

export interface BookingDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly mailer: Mailer;
  readonly log: FastifyBaseLogger;
}

export interface CreateBookingResult {
  readonly booking: Booking;
  readonly replayed: boolean;
}

/** Hanteringslänken gäller till 30 dagar efter att besöket har slutat. */
const ACCESS_TOKEN_LIFETIME_DAYS = 30;

/** Constraints som betyder "den här personen är upptagen" och gör att nästa kandidat prövas. */
const STAFF_UNAVAILABLE = new Set(['booking_no_overlap', 'booking_within_open_hours']);

/**
 * Samtidiga INSERT som krockar i ett EXCLUDE-index kan vänta på varandra och
 * avbrytas med deadlock i stället för 23P01 (ADR-0012). Försöket görs då om i
 * samma savepoint och väntar på den transaktion som överlevde.
 */
const DEADLOCK_DETECTED = '40P01';
const MAX_ATTEMPTS_PER_STAFF = 5;

/**
 * Skapar en bokning (ADR-0003). Allt sker i en transaktion:
 * idempotensnyckeln låses, policy kontrolleras, kunden kopplas, personal prövas
 * en i taget i egna savepoints och svaret sparas tillsammans med bokningen.
 * Dubbelbokning stoppas av booking_no_overlap, inte av koden här.
 */
export async function createBooking(
  deps: BookingDeps,
  input: CreateBookingRequest,
  idempotencyKey: string,
): Promise<CreateBookingResult> {
  const requestHash = hashJson(input);

  const result = await deps.db.transaction().execute(async (trx) => {
    await lockIdempotencyKey(trx, idempotencyKey);
    const previous = await findIdempotencyRecord(trx, idempotencyKey);
    if (previous !== undefined) {
      if (!previous.requestHash.equals(requestHash)) {
        throw new ProblemError('idempotency-key-reused', 422);
      }
      // Bara lyckade svar sparas. Ett 409 ska räknas om vid nästa försök.
      if (previous.responseStatus !== 201) {
        throw new Error(`Unexpected stored status ${previous.responseStatus}`);
      }
      return {
        booking: parseStoredBooking(previous.responseBody),
        replayed: true,
        manageToken: undefined,
      };
    }

    const business = await getBusiness(trx);
    const service = await findActiveService(trx, input.serviceId);
    if (service === undefined) {
      throw new ProblemError('validation-failed', 400, {
        errors: [{ path: 'body/serviceId', message: 'does not refer to an active service' }],
      });
    }

    if (input.staffId !== undefined) {
      const staff = await listStaffForService(trx, service.id);
      if (!staff.some((member) => member.id === input.staffId)) {
        throw new ProblemError('validation-failed', 400, {
          errors: [{ path: 'body/staffId', message: 'does not perform this service' }],
        });
      }
    }

    const startsAt = toInstant(input.startsAt);
    assertWithinPolicy(business, startsAt, toInstant(deps.clock.now()));
    const endsAt = startsAt.add({ minutes: service.durationMinutes });
    const blocked = {
      start: startsAt.subtract({ minutes: service.bufferBeforeMinutes }),
      end: endsAt.add({ minutes: service.bufferAfterMinutes }),
    };

    const customerId = await findOrCreateCustomer(trx, input.contact);
    const day = localDate(startsAt, business.timezone);
    const candidates =
      input.staffId === undefined
        ? await candidateStaff(trx, {
            serviceId: service.id,
            blocked,
            day: {
              start: startOfLocalDay(day, business.timezone),
              end: startOfLocalDay(day.add({ days: 1 }), business.timezone),
            },
          })
        : [input.staffId];

    const bookingId = await insertFirstAvailable(trx, candidates, input.staffId === undefined, {
      customerId,
      serviceId: service.id,
      startsAt: toIso(startsAt),
      endsAt: toIso(endsAt),
      bufferBeforeMinutes: service.bufferBeforeMinutes,
      bufferAfterMinutes: service.bufferAfterMinutes,
      priceOre: service.priceOre,
      contactName: input.contact.name,
      contactPhone: input.contact.phone ?? null,
      customerNote: input.note ?? null,
    });

    const manageToken = generateToken();
    await insertAccessToken(trx, {
      bookingId,
      tokenHash: hashToken(manageToken),
      expiresAt: toIso(endsAt.add({ hours: 24 * ACCESS_TOKEN_LIFETIME_DAYS })),
    });

    const booking = await findBooking(trx, bookingId);
    if (booking === undefined)
      throw new Error(`Booking ${bookingId} vanished inside its transaction`);
    await saveIdempotencyRecord(trx, {
      key: idempotencyKey,
      requestHash,
      responseStatus: 201,
      responseBody: booking,
    });
    return { booking, replayed: false, manageToken };
  });

  if (result.manageToken !== undefined) {
    await sendConfirmation(deps, input.contact.email, result.booking, result.manageToken);
  }
  return { booking: result.booking, replayed: result.replayed };
}

/**
 * Prövar kandidaterna i ordning. Varje försök sker i en savepoint, så att ett
 * misslyckat INSERT inte avbryter hela transaktionen. Med en uttryckligen vald
 * person skickas databasens fel vidare och översätts till RFC 9457 (ADR-0007).
 */
async function insertFirstAvailable(
  trx: Kysely<DB>,
  staffIds: readonly string[],
  tryNextOnConflict: boolean,
  booking: Omit<NewBooking, 'staffId'>,
): Promise<string> {
  for (const staffId of staffIds) {
    for (let attempt = 1; ; attempt++) {
      await sql`SAVEPOINT booking_attempt`.execute(trx);
      try {
        const id = await insertBooking(trx, { ...booking, staffId });
        await sql`RELEASE SAVEPOINT booking_attempt`.execute(trx);
        return id;
      } catch (error) {
        await sql`ROLLBACK TO SAVEPOINT booking_attempt`.execute(trx);
        if (!(error instanceof pg.DatabaseError)) throw error;
        if (error.code === DEADLOCK_DETECTED && attempt < MAX_ATTEMPTS_PER_STAFF) continue;
        const staffUnavailable =
          error.constraint !== undefined && STAFF_UNAVAILABLE.has(error.constraint);
        if (!tryNextOnConflict || !staffUnavailable) throw error;
        break;
      }
    }
  }
  throw new ProblemError('slot-unavailable', 409, {
    detail: 'Ingen i personalen har tiden ledig längre. Hämta lediga tider igen.',
  });
}

/** Policy för kunder och anonyma anrop: rutnät, framförhållning och horisont (ADR-0002). */
function assertWithinPolicy(
  business: Business,
  startsAt: Temporal.Instant,
  now: Temporal.Instant,
): void {
  const local = startsAt.toZonedDateTimeISO(business.timezone);
  const onGrid =
    (local.hour * 60 + local.minute) % business.slotStepMinutes === 0 &&
    local.second === 0 &&
    local.millisecond === 0 &&
    local.microsecond === 0 &&
    local.nanosecond === 0;
  if (!onGrid) {
    throw new ProblemError('validation-failed', 400, {
      errors: [
        {
          path: 'body/startsAt',
          message: `must be on the ${business.slotStepMinutes}-minute grid`,
        },
      ],
    });
  }

  const { notBefore, notAfter } = bookingWindow(business, now);
  if (Temporal.Instant.compare(startsAt, notBefore) < 0) {
    throw new ProblemError('outside-open-hours', 409, {
      detail: `Tiden måste bokas minst ${business.minNoticeMinutes} minuter i förväg.`,
    });
  }
  if (Temporal.Instant.compare(startsAt, notAfter) > 0) {
    throw new ProblemError('outside-open-hours', 409, {
      detail: `Tider kan bokas högst ${business.bookingHorizonDays} dagar framåt.`,
    });
  }
}

async function sendConfirmation(
  deps: BookingDeps,
  to: string,
  booking: Booking,
  manageToken: string,
): Promise<void> {
  try {
    await deps.mailer.sendBookingConfirmation({ to, booking, manageToken });
  } catch (error) {
    // Bokningen är redan committad. Utkorgen i Fas 5 gör om utskick som misslyckas.
    deps.log.error({ err: error, bookingId: booking.id }, 'failed to send booking confirmation');
  }
}

/**
 * Hanteringslänken ger tillgång till exakt en bokning. Ogiltig, utgången eller
 * fel bokning ger 404, så att det inte går att avgöra vilka id:n som finns.
 */
async function authorizeWithToken(
  deps: Pick<BookingDeps, 'db' | 'clock'>,
  bookingId: string,
  token: string | undefined,
): Promise<void> {
  if (token === undefined) throw new ProblemError('unauthenticated', 401);
  const valid =
    isWellFormedToken(token) &&
    (await hasValidAccessToken(deps.db, {
      bookingId,
      tokenHash: hashToken(token),
      now: toIso(toInstant(deps.clock.now())),
    }));
  if (!valid) throw new ProblemError('not-found', 404);
}

export async function getBookingWithToken(
  deps: Pick<BookingDeps, 'db' | 'clock'>,
  bookingId: string,
  token: string | undefined,
): Promise<Booking> {
  await authorizeWithToken(deps, bookingId, token);
  const booking = await findBooking(deps.db, bookingId);
  if (booking === undefined) throw new ProblemError('not-found', 404);
  return booking;
}

/**
 * Avbokar via hanteringslänken. Idempotent: en redan avbokad bokning returneras
 * oförändrad. Avbokning frigör tiden direkt, eftersom booking_no_overlap bara
 * gäller bokningar som inte är avbokade.
 */
export async function cancelBookingWithToken(
  deps: Pick<BookingDeps, 'db' | 'clock'>,
  bookingId: string,
  token: string | undefined,
): Promise<Booking> {
  await authorizeWithToken(deps, bookingId, token);
  const now = toInstant(deps.clock.now());

  await deps.db.transaction().execute(async (trx) => {
    const current = await lockBooking(trx, bookingId);
    if (current === undefined) throw new ProblemError('not-found', 404);
    if (current.status === 'cancelled') return;

    const business = await getBusiness(trx);
    const deadline = toInstant(current.startsAt).subtract({
      minutes: business.cancelCutoffMinutes,
    });
    if (current.status !== 'confirmed' || Temporal.Instant.compare(now, deadline) > 0) {
      throw new ProblemError('cancellation-window-closed', 409, {
        detail: `Avbokning måste ske senast ${business.cancelCutoffMinutes} minuter före besöket.`,
      });
    }
    await markCancelled(trx, bookingId, toIso(now));
  });

  const booking = await findBooking(deps.db, bookingId);
  if (booking === undefined) throw new ProblemError('not-found', 404);
  return booking;
}
