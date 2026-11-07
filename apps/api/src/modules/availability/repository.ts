import { sql, type Kysely } from 'kysely';
import type { DB } from '../../db/types.ts';
import { toInstant } from '../../shared/time.ts';
import type { Period } from './slots.ts';

/**
 * Fria intervall per personal inom fönstret, från SQL-funktionen
 * staff_free_periods (arbetstid − frånvaro − bokningar inklusive buffert).
 * En fråga för all personal, så att svaret bygger på en och samma snapshot.
 */
export async function freePeriodsByStaff(
  db: Kysely<DB>,
  staffIds: readonly string[],
  window: Period,
): Promise<Map<string, Period[]>> {
  const result = new Map<string, Period[]>(staffIds.map((id) => [id, []]));
  if (staffIds.length === 0) return result;

  const { rows } = await sql<{ staffId: string; periodStart: string; periodEnd: string }>`
    SELECT s.staff_id, lower(r) AS period_start, upper(r) AS period_end
    FROM unnest(${sql.val(staffIds)}::uuid[]) AS s(staff_id)
    CROSS JOIN LATERAL unnest(
      staff_free_periods(s.staff_id, tstzrange(${window.start.toString()}::timestamptz, ${window.end.toString()}::timestamptz, '[)'))
    ) AS r
    ORDER BY s.staff_id, lower(r)
  `.execute(db);

  for (const row of rows) {
    result
      .get(row.staffId)
      ?.push({ start: toInstant(row.periodStart), end: toInstant(row.periodEnd) });
  }
  return result;
}
