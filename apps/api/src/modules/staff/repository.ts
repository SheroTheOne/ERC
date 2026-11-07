import type { StaffMember, TimeOff, WorkingHoursRule } from '@erc/contracts';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../../db/types.ts';
import { toInstant, toIso } from '../../shared/time.ts';

type Executor = Kysely<DB>;

/** Väggklocka från databasen ('09:00:00', '24:00:00') i API:ts format ('09:00', '24:00'). */
const hhmm = (time: string) => time.slice(0, 5);

export async function listStaffMembers(db: Executor, id?: string): Promise<StaffMember[]> {
  let query = db
    .selectFrom('staff')
    .innerJoin('appUser', 'appUser.id', 'staff.userId')
    .leftJoin('staffService', 'staffService.staffId', 'staff.id')
    .select((eb) => [
      'staff.id',
      'appUser.email',
      'staff.displayName',
      'appUser.role',
      'staff.active',
      eb
        .fn<string[]>('coalesce', [
          sql`array_agg(${eb.ref('staffService.serviceId')} ORDER BY ${eb.ref('staffService.serviceId')}) FILTER (WHERE ${eb.ref('staffService.serviceId')} IS NOT NULL)`,
          sql`'{}'::uuid[]`,
        ])
        .as('serviceIds'),
    ])
    .groupBy(['staff.id', 'appUser.email', 'appUser.role'])
    .orderBy('staff.displayName')
    .orderBy('staff.id');
  if (id !== undefined) query = query.where('staff.id', '=', id);

  const rows = await query.execute();
  return rows.map((row) => ({
    ...row,
    role: row.role === 'admin' ? 'admin' : 'staff',
  }));
}

export async function insertStaff(
  db: Executor,
  input: { email: string; displayName: string; role: 'staff' | 'admin'; passwordHash: string },
): Promise<string> {
  const user = await db
    .insertInto('appUser')
    .values({ email: input.email, role: input.role, passwordHash: input.passwordHash })
    .returning('id')
    .executeTakeFirstOrThrow();
  const staff = await db
    .insertInto('staff')
    .values({ userId: user.id, displayName: input.displayName })
    .returning('id')
    .executeTakeFirstOrThrow();
  return staff.id;
}

export function findStaffUser(
  db: Executor,
  staffId: string,
): Promise<{ userId: string; role: string } | undefined> {
  return db
    .selectFrom('staff')
    .innerJoin('appUser', 'appUser.id', 'staff.userId')
    .select(['appUser.id as userId', 'appUser.role'])
    .where('staff.id', '=', staffId)
    .forUpdate()
    .executeTakeFirst();
}

export async function updateStaff(
  db: Executor,
  staffId: string,
  userId: string,
  input: { displayName?: string; active?: boolean; role?: 'staff' | 'admin' },
): Promise<void> {
  if (input.displayName !== undefined || input.active !== undefined) {
    await db
      .updateTable('staff')
      .set({
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.active === undefined ? {} : { active: input.active }),
      })
      .where('id', '=', staffId)
      .execute();
  }
  if (input.role !== undefined) {
    await db.updateTable('appUser').set({ role: input.role }).where('id', '=', userId).execute();
  }
}

export async function replaceStaffServices(
  db: Executor,
  staffId: string,
  serviceIds: readonly string[],
): Promise<void> {
  await db.deleteFrom('staffService').where('staffId', '=', staffId).execute();
  if (serviceIds.length > 0) {
    await db
      .insertInto('staffService')
      .values(serviceIds.map((serviceId) => ({ staffId, serviceId })))
      .execute();
  }
}

export async function countServices(db: Executor, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const row = await db
    .selectFrom('service')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('id', 'in', ids)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** Låser personalraden, så att två samtidiga schemaändringar för samma person köas. */
export async function lockStaff(db: Executor, staffId: string): Promise<boolean> {
  const row = await db
    .selectFrom('staff')
    .select('id')
    .where('id', '=', staffId)
    .forUpdate()
    .executeTakeFirst();
  return row !== undefined;
}

/** Regler som gäller ett visst lokalt datum. */
export async function rulesAt(
  db: Executor,
  staffId: string,
  date: string,
): Promise<WorkingHoursRule[]> {
  const rows = await db
    .selectFrom('workingHours')
    .select(['id', 'weekday', 'startTime', 'endTime', 'validFrom', 'validUntil'])
    .where('staffId', '=', staffId)
    .where('validFrom', '<=', date)
    .where((eb) => eb.or([eb('validUntil', 'is', null), eb('validUntil', '>', date)]))
    .orderBy('weekday')
    .orderBy('startTime')
    .execute();
  return rows.map((row) => ({
    ...row,
    startTime: hhmm(row.startTime),
    endTime: hhmm(row.endTime),
  }));
}

/**
 * Ersätter veckoschemat från och med validFrom. Regler som börjar då eller
 * senare tas bort, regler som pågår avslutas dagen innan, och de nya reglerna
 * gäller tills vidare. working_hours_no_overlap stoppar överlappande pass.
 */
export async function replaceWorkingHours(
  db: Executor,
  staffId: string,
  validFrom: string,
  shifts: readonly { weekday: number; startTime: string; endTime: string }[],
): Promise<void> {
  await db
    .deleteFrom('workingHours')
    .where('staffId', '=', staffId)
    .where('validFrom', '>=', validFrom)
    .execute();
  await db
    .updateTable('workingHours')
    .set({ validUntil: validFrom })
    .where('staffId', '=', staffId)
    .where('validFrom', '<', validFrom)
    .where((eb) => eb.or([eb('validUntil', 'is', null), eb('validUntil', '>', validFrom)]))
    .execute();
  if (shifts.length > 0) {
    await db
      .insertInto('workingHours')
      .values(shifts.map((shift) => ({ staffId, validFrom, ...shift })))
      .execute();
  }
}

interface TimeOffRow {
  id: string;
  staffId: string;
  periodStart: string;
  periodEnd: string;
  reason: string | null;
}

function toTimeOff(row: TimeOffRow): TimeOff {
  return {
    id: row.id,
    staffId: row.staffId,
    from: row.periodStart,
    to: row.periodEnd,
    reason: row.reason,
  };
}

const timeOffColumns = sql<TimeOffRow>`id, staff_id, lower(period) AS period_start, upper(period) AS period_end, reason`;

export async function listTimeOff(
  db: Executor,
  staffId: string,
  window: { from: string; to: string },
): Promise<TimeOff[]> {
  const { rows } = await sql<TimeOffRow>`
    SELECT ${timeOffColumns}
    FROM time_off
    WHERE staff_id = ${staffId}
      AND period && tstzrange(${window.from}::timestamptz, ${window.to}::timestamptz, '[)')
    ORDER BY lower(period), id
  `.execute(db);
  return rows.map(toTimeOff);
}

export async function insertTimeOff(
  db: Executor,
  input: {
    staffId: string;
    from: Temporal.Instant;
    to: Temporal.Instant;
    reason: string | null;
    createdBy: string;
  },
): Promise<TimeOff> {
  const { rows } = await sql<TimeOffRow>`
    INSERT INTO time_off (staff_id, period, reason, created_by)
    VALUES (
      ${input.staffId},
      tstzrange(${toIso(input.from)}::timestamptz, ${toIso(input.to)}::timestamptz, '[)'),
      ${input.reason},
      ${input.createdBy}
    )
    RETURNING ${timeOffColumns}
  `.execute(db);
  const row = rows[0];
  if (row === undefined) throw new Error('INSERT … RETURNING returned no row');
  return toTimeOff(row);
}

export async function deleteTimeOff(
  db: Executor,
  staffId: string,
  timeOffId: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom('timeOff')
    .where('id', '=', timeOffId)
    .where('staffId', '=', staffId)
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}

/** Används för att avgöra om ett datum ligger i dåtid i företagets tidszon. */
export function todayIn(timeZone: string, now: Date): Temporal.PlainDate {
  return toInstant(now).toZonedDateTimeISO(timeZone).toPlainDate();
}
