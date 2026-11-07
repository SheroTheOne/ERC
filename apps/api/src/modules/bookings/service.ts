import {
  MAX_BOOKING_LIST_DAYS,
  type Booking,
  type BookingListQuery,
  type Business,
  type CreateBookingRequest,
  type UpdateBookingRequest,
} from '@erc/contracts';
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import type { Actor } from '../../auth/sessions.ts';
import type { Database } from '../../db/database.ts';
import type { DB } from '../../db/types.ts';
import { isStaff } from '../../http/auth.ts';
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
  findConflicts,
  findIdempotencyRecord,
  findOrCreateCustomer,
  hasValidAccessToken,
  insertAccessToken,
  insertBooking,
  isOwnedBy,
  listBookings,
  lockBooking,
  lockIdempotencyKey,
  lockStaffForBooking,
  markCancelled,
  moveBooking,
  parseStoredBooking,
  saveIdempotencyRecord,
  setStatus,
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
 * avbrytas med deadlock i stället för 23P01 (ADR-0012). Låsen per personal
 * förhindrar det i den här kodvägen. Om en annan skrivväg ändå orsakar en
 * deadlock görs försöket om i samma savepoint.
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
  actor: Actor | null,
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
    // Personal får boka utanför policyn, till exempel samma dag eller utanför rutnätet.
    if (!isStaff(actor)) assertWithinPolicy(business, startsAt, toInstant(deps.clock.now()));
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

    await lockStaffForBooking(trx, candidates);
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

type BookingAccess =
  | { readonly mode: 'staff'; readonly actor: Actor }
  | { readonly mode: 'owner'; readonly actor: Actor }
  | { readonly mode: 'token' };

/**
 * Vem får se och avboka en bokning (ADR-0008): personal alltid, en inloggad
 * kund sina egna, och den som har hanteringslänken just den bokningen.
 * Allt annat ger 404, så att det inte går att avgöra vilka id:n som finns.
 */
async function authorizeBookingAccess(
  deps: Pick<BookingDeps, 'db' | 'clock'>,
  bookingId: string,
  actor: Actor | null,
  token: string | undefined,
): Promise<BookingAccess> {
  if (isStaff(actor)) return { mode: 'staff', actor };

  if (actor !== null && actor.customerId !== null) {
    const owned = await isOwnedBy(deps.db, bookingId, actor.customerId);
    if (owned) return { mode: 'owner', actor };
  }

  if (token !== undefined) {
    const valid =
      isWellFormedToken(token) &&
      (await hasValidAccessToken(deps.db, {
        bookingId,
        tokenHash: hashToken(token),
        now: toIso(toInstant(deps.clock.now())),
      }));
    if (valid) return { mode: 'token' };
  }

  if (actor === null && token === undefined) throw new ProblemError('unauthenticated', 401);
  throw new ProblemError('not-found', 404);
}

async function loadBooking(db: Database, bookingId: string): Promise<Booking> {
  const booking = await findBooking(db, bookingId);
  if (booking === undefined) throw new ProblemError('not-found', 404);
  return booking;
}

export async function getBooking(
  deps: Pick<BookingDeps, 'db' | 'clock'>,
  bookingId: string,
  actor: Actor | null,
  token: string | undefined,
): Promise<Booking> {
  await authorizeBookingAccess(deps, bookingId, actor, token);
  return loadBooking(deps.db, bookingId);
}

/**
 * Avbokar. Idempotent: en redan avbokad bokning returneras oförändrad.
 * Kunder och hanteringslänkar måste hålla gränsen för avbokning, personal inte.
 * Avbokning frigör tiden direkt, eftersom booking_no_overlap bara gäller bokningar
 * som inte är avbokade.
 */
export async function cancelBooking(
  deps: Pick<BookingDeps, 'db' | 'clock'>,
  bookingId: string,
  actor: Actor | null,
  token: string | undefined,
): Promise<Booking> {
  const access = await authorizeBookingAccess(deps, bookingId, actor, token);
  const now = toInstant(deps.clock.now());

  await deps.db.transaction().execute(async (trx) => {
    const current = await lockBooking(trx, bookingId);
    if (current === undefined) throw new ProblemError('not-found', 404);
    if (current.status === 'cancelled') return;
    if (current.status !== 'confirmed') {
      throw new ProblemError('booking-not-active', 409, {
        detail: `En bokning med status ${current.status} kan inte avbokas.`,
      });
    }

    if (access.mode !== 'staff') {
      const business = await getBusiness(trx);
      const deadline = toInstant(current.startsAt).subtract({
        minutes: business.cancelCutoffMinutes,
      });
      if (Temporal.Instant.compare(now, deadline) > 0) {
        throw new ProblemError('cancellation-window-closed', 409, {
          detail: `Avbokning måste ske senast ${business.cancelCutoffMinutes} minuter före besöket.`,
        });
      }
    }
    await markCancelled(trx, bookingId, {
      at: toIso(now),
      by: access.mode === 'token' ? null : access.actor.userId,
    });
  });

  return loadBooking(deps.db, bookingId);
}

/**
 * Personalens ändringar: ny status eller flytt till annan tid eller person.
 * Policy gäller inte personal, men invarianterna i databasen gäller alltid
 * (ADR-0002): en flytt till en upptagen tid ger 409 slot-unavailable.
 */
export async function updateBooking(
  deps: Pick<BookingDeps, 'db' | 'clock'>,
  bookingId: string,
  actor: Actor,
  input: UpdateBookingRequest,
): Promise<Booking> {
  const moving = input.startsAt !== undefined || input.staffId !== undefined;
  if (moving && input.status !== undefined) {
    throw new ProblemError('validation-failed', 400, {
      errors: [{ path: 'body', message: 'change status and move a booking in separate requests' }],
    });
  }
  const now = toIso(toInstant(deps.clock.now()));

  await deps.db.transaction().execute(async (trx) => {
    const current = await lockBooking(trx, bookingId);
    if (current === undefined) throw new ProblemError('not-found', 404);
    if (current.status !== 'confirmed') {
      throw new ProblemError('booking-not-active', 409, {
        detail: `En bokning med status ${current.status} kan inte ändras.`,
      });
    }

    if (input.status === 'cancelled') {
      await markCancelled(trx, bookingId, { at: now, by: actor.userId });
    } else if (input.status !== undefined) {
      await setStatus(trx, bookingId, input.status);
    } else {
      const startsAt = toInstant(input.startsAt ?? current.startsAt);
      const duration = toInstant(current.startsAt).until(toInstant(current.endsAt));
      const staffId = input.staffId ?? current.staffId;
      await lockStaffForBooking(trx, [current.staffId, staffId]);
      await moveBooking(trx, bookingId, {
        staffId,
        startsAt: toIso(startsAt),
        endsAt: toIso(startsAt.add(duration)),
      });
    }
  });

  return loadBooking(deps.db, bookingId);
}

export function listBookingsForStaff(
  deps: Pick<BookingDeps, 'db'>,
  query: BookingListQuery,
): Promise<Booking[]> {
  const from = toInstant(query.from);
  const to = toInstant(query.to);
  if (Temporal.Instant.compare(to, from) <= 0) {
    throw new ProblemError('validation-failed', 400, {
      errors: [{ path: 'querystring/to', message: 'must be after from' }],
    });
  }
  if (from.until(to).total('hours') > MAX_BOOKING_LIST_DAYS * 24) {
    throw new ProblemError('validation-failed', 400, {
      errors: [
        {
          path: 'querystring/to',
          message: `must be at most ${MAX_BOOKING_LIST_DAYS} days after from`,
        },
      ],
    });
  }
  return listBookings(deps.db, {
    from: toIso(from),
    to: toIso(to),
    ...(query.staffId === undefined ? {} : { staffId: query.staffId }),
    ...(query.status === undefined ? {} : { status: query.status }),
  });
}

export function listConflicts(deps: Pick<BookingDeps, 'db' | 'clock'>): Promise<Booking[]> {
  return findConflicts(deps.db, { from: toIso(toInstant(deps.clock.now())) });
}
