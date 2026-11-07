import type { Booking, Customer, CustomerExport } from '@erc/contracts';
import { sql } from 'kysely';
import { deleteSessionsForUser } from '../../auth/sessions.ts';
import type { Database } from '../../db/database.ts';
import { ProblemError } from '../../http/problems.ts';
import type { Clock } from '../../shared/clock.ts';
import { toInstant, toIso } from '../../shared/time.ts';
import { listBookings } from '../bookings/repository.ts';

export interface CustomerDeps {
  readonly db: Database;
  readonly clock: Clock;
}

const ANONYMIZED_NAME = 'Raderad kund';

function selectCustomers(db: Database) {
  return db
    .selectFrom('customer')
    .select(['id', 'email', 'name', 'phone', 'createdAt', 'anonymizedAt']);
}

/** % och _ i söksträngen ska matcha sig själva, inte fungera som jokertecken. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

export function searchCustomers(
  deps: CustomerDeps,
  query: { q?: string; limit: number },
): Promise<Customer[]> {
  let builder = selectCustomers(deps.db);
  if (query.q !== undefined) {
    const pattern = `%${escapeLike(query.q)}%`;
    builder = builder.where((eb) =>
      eb.or([eb('name', 'ilike', pattern), eb(sql<string>`email::text`, 'ilike', pattern)]),
    );
  }
  return builder.orderBy('name').orderBy('id').limit(query.limit).execute();
}

export async function getCustomer(deps: CustomerDeps, id: string): Promise<Customer> {
  const customer = await selectCustomers(deps.db).where('id', '=', id).executeTakeFirst();
  if (customer === undefined) throw new ProblemError('not-found', 404);
  return customer;
}

export function customerBookings(deps: CustomerDeps, customerId: string): Promise<Booking[]> {
  return listBookings(deps.db, { customerId });
}

/** Allt som finns om kunden, för GDPR artikel 15 och 20 (ADR-0010). */
export async function exportCustomer(deps: CustomerDeps, id: string): Promise<CustomerExport> {
  return { customer: await getCustomer(deps, id), bookings: await customerBookings(deps, id) };
}

/**
 * Radering enligt GDPR artikel 17 genom anonymisering (ADR-0010).
 * Personuppgifterna ersätts i kunden, på bokningarna och i inloggningskontot,
 * sessioner och hanteringslänkar återkallas, men bokningsraderna finns kvar för
 * statistik och beläggning. Idempotent.
 */
export async function anonymizeCustomer(deps: CustomerDeps, id: string): Promise<Customer> {
  const now = toIso(toInstant(deps.clock.now()));

  await deps.db.transaction().execute(async (trx) => {
    const customer = await trx
      .selectFrom('customer')
      .select(['id', 'userId', 'anonymizedAt'])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (customer === undefined) throw new ProblemError('not-found', 404);
    if (customer.anonymizedAt !== null) return;

    await trx
      .updateTable('customer')
      .set({
        name: ANONYMIZED_NAME,
        email: `deleted+${id}@invalid`,
        phone: null,
        anonymizedAt: now,
      })
      .where('id', '=', id)
      .execute();
    await trx
      .updateTable('booking')
      .set({ contactName: ANONYMIZED_NAME, contactPhone: null, customerNote: null })
      .where('customerId', '=', id)
      .execute();
    await trx
      .deleteFrom('bookingAccessToken')
      .where('bookingId', 'in', trx.selectFrom('booking').select('id').where('customerId', '=', id))
      .execute();

    if (customer.userId !== null) {
      await trx
        .updateTable('appUser')
        .set({ email: `deleted+${customer.userId}@invalid`, disabledAt: now })
        .where('id', '=', customer.userId)
        .execute();
      await deleteSessionsForUser(trx, customer.userId);
    }
  });

  return getCustomer(deps, id);
}
