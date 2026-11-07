import type {
  Booking,
  CreateStaffRequest,
  CreateTimeOffRequest,
  ReplaceWorkingHoursRequest,
  StaffMember,
  TimeOff,
  UpdateStaffRequest,
  WorkingHoursResponse,
} from '@erc/contracts';
import { hashPassword } from '../../auth/password.ts';
import { deleteSessionsForUser, type Actor } from '../../auth/sessions.ts';
import type { Database } from '../../db/database.ts';
import { ProblemError } from '../../http/problems.ts';
import type { Clock } from '../../shared/clock.ts';
import { parseLocalDate, startOfLocalDay, toInstant } from '../../shared/time.ts';
import { findConflicts } from '../bookings/repository.ts';
import { getBusiness } from '../catalog/repository.ts';
import {
  countServices,
  deleteTimeOff,
  findStaffUser,
  insertStaff,
  insertTimeOff,
  listStaffMembers,
  listTimeOff,
  lockStaff,
  replaceStaffServices,
  replaceWorkingHours,
  rulesAt,
  todayIn,
  updateStaff,
} from './repository.ts';

export interface StaffDeps {
  readonly db: Database;
  readonly clock: Clock;
}

const notFound = () => new ProblemError('not-found', 404);

export function listStaff(deps: StaffDeps): Promise<StaffMember[]> {
  return listStaffMembers(deps.db);
}

async function loadStaffMember(db: Database, staffId: string): Promise<StaffMember> {
  const [member] = await listStaffMembers(db, staffId);
  if (member === undefined) throw notFound();
  return member;
}

export async function createStaff(
  deps: StaffDeps,
  input: CreateStaffRequest,
): Promise<StaffMember> {
  const passwordHash = await hashPassword(input.password);
  // En upptagen e-postadress ger 409 via app_user_email_key (ADR-0007).
  const staffId = await deps.db
    .transaction()
    .execute((trx) => insertStaff(trx, { ...input, passwordHash }));
  return loadStaffMember(deps.db, staffId);
}

/**
 * En administratör får inte ta bort sin egen adminroll eller stänga av sig själv,
 * så att installationen inte kan bli utan administratör av misstag.
 */
export async function changeStaff(
  deps: StaffDeps,
  actor: Actor,
  staffId: string,
  input: UpdateStaffRequest,
): Promise<StaffMember> {
  await deps.db.transaction().execute(async (trx) => {
    const target = await findStaffUser(trx, staffId);
    if (target === undefined) throw notFound();
    const self = target.userId === actor.userId;
    if (self && (input.active === false || (input.role !== undefined && input.role !== 'admin'))) {
      throw new ProblemError('forbidden', 403, {
        detail: 'Du kan inte ta bort din egen adminroll eller stänga av dig själv.',
      });
    }
    await updateStaff(trx, staffId, target.userId, input);
    // En ändrad roll gäller direkt: befintliga sessioner återkallas.
    if (input.role !== undefined && input.role !== target.role) {
      await deleteSessionsForUser(trx, target.userId);
    }
  });
  return loadStaffMember(deps.db, staffId);
}

export async function setStaffServices(
  deps: StaffDeps,
  staffId: string,
  serviceIds: readonly string[],
): Promise<StaffMember> {
  await deps.db.transaction().execute(async (trx) => {
    if (!(await lockStaff(trx, staffId))) throw notFound();
    if ((await countServices(trx, serviceIds)) !== serviceIds.length) {
      throw new ProblemError('validation-failed', 400, {
        errors: [{ path: 'body/serviceIds', message: 'contains an unknown service' }],
      });
    }
    await replaceStaffServices(trx, staffId, serviceIds);
  });
  return loadStaffMember(deps.db, staffId);
}

export async function getWorkingHours(
  deps: StaffDeps,
  staffId: string,
  at: string | undefined,
): Promise<WorkingHoursResponse> {
  const business = await getBusiness(deps.db);
  const date = at ?? todayIn(business.timezone, deps.clock.now()).toString();
  if (parseLocalDate(date) === undefined) {
    throw new ProblemError('validation-failed', 400, {
      errors: [{ path: 'querystring/at', message: 'must be a valid calendar date' }],
    });
  }
  await loadStaffMember(deps.db, staffId);
  return { staffId, at: date, rules: await rulesAt(deps.db, staffId, date) };
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * Ersätter veckoschemat från ett datum. Bokningar som hamnar utanför den nya
 * arbetstiden ligger kvar och returneras som konflikter (ADR-0002).
 */
export async function setWorkingHours(
  deps: StaffDeps,
  staffId: string,
  input: ReplaceWorkingHoursRequest,
): Promise<WorkingHoursResponse & { conflicts: Booking[] }> {
  const business = await getBusiness(deps.db);
  const validFrom = parseLocalDate(input.validFrom);
  if (validFrom === undefined) {
    throw new ProblemError('validation-failed', 400, {
      errors: [{ path: 'body/validFrom', message: 'must be a valid calendar date' }],
    });
  }
  if (Temporal.PlainDate.compare(validFrom, todayIn(business.timezone, deps.clock.now())) < 0) {
    throw new ProblemError('validation-failed', 400, {
      errors: [{ path: 'body/validFrom', message: 'must not be in the past' }],
    });
  }
  input.shifts.forEach((shift, index) => {
    if (minutes(shift.endTime) <= minutes(shift.startTime)) {
      throw new ProblemError('validation-failed', 400, {
        errors: [{ path: `body/shifts/${index}/endTime`, message: 'must be after startTime' }],
      });
    }
  });

  await deps.db.transaction().execute(async (trx) => {
    if (!(await lockStaff(trx, staffId))) throw notFound();
    await replaceWorkingHours(trx, staffId, validFrom.toString(), input.shifts);
  });

  const from = startOfLocalDay(validFrom, business.timezone).toString();
  return {
    staffId,
    at: validFrom.toString(),
    rules: await rulesAt(deps.db, staffId, validFrom.toString()),
    conflicts: await findConflicts(deps.db, { staffId, from }),
  };
}

const DEFAULT_TIME_OFF_WINDOW_DAYS = 90;

export async function getTimeOff(
  deps: StaffDeps,
  staffId: string,
  query: { from?: string; to?: string },
): Promise<TimeOff[]> {
  await loadStaffMember(deps.db, staffId);
  const from = query.from === undefined ? toInstant(deps.clock.now()) : toInstant(query.from);
  const to =
    query.to === undefined
      ? from.add({ hours: 24 * DEFAULT_TIME_OFF_WINDOW_DAYS })
      : toInstant(query.to);
  return listTimeOff(deps.db, staffId, { from: from.toString(), to: to.toString() });
}

/** Lokala heldagar räknas om till absolut tid när de skrivs (ADR-0004). */
async function resolvePeriod(
  db: Database,
  input: CreateTimeOffRequest,
): Promise<{ from: Temporal.Instant; to: Temporal.Instant }> {
  if ('from' in input) return { from: toInstant(input.from), to: toInstant(input.to) };
  const fromDate = parseLocalDate(input.fromDate);
  const toDate = parseLocalDate(input.toDate);
  if (fromDate === undefined || toDate === undefined) {
    throw new ProblemError('validation-failed', 400, {
      errors: [
        {
          path: `body/${fromDate === undefined ? 'fromDate' : 'toDate'}`,
          message: 'must be a valid calendar date',
        },
      ],
    });
  }
  const { timezone } = await getBusiness(db);
  return {
    from: startOfLocalDay(fromDate, timezone),
    to: startOfLocalDay(toDate.add({ days: 1 }), timezone),
  };
}

export async function addTimeOff(
  deps: StaffDeps,
  actor: Actor,
  staffId: string,
  input: CreateTimeOffRequest,
): Promise<{ timeOff: TimeOff; conflicts: Booking[] }> {
  const period = await resolvePeriod(deps.db, input);
  if (Temporal.Instant.compare(period.to, period.from) <= 0) {
    throw new ProblemError('validation-failed', 400, {
      errors: [{ path: 'body', message: 'the period must end after it starts' }],
    });
  }

  const timeOff = await deps.db.transaction().execute(async (trx) => {
    if (!(await lockStaff(trx, staffId))) throw notFound();
    return insertTimeOff(trx, {
      staffId,
      ...period,
      reason: input.reason ?? null,
      createdBy: actor.userId,
    });
  });
  return {
    timeOff,
    conflicts: await findConflicts(deps.db, {
      staffId,
      from: toInstant(deps.clock.now()).toString(),
    }),
  };
}

export async function removeTimeOff(
  deps: StaffDeps,
  staffId: string,
  timeOffId: string,
): Promise<void> {
  if (!(await deleteTimeOff(deps.db, staffId, timeOffId))) throw notFound();
}
