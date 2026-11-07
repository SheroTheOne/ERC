import type { Business, Service, StaffSummary } from '@erc/contracts';
import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.ts';
import { ProblemError } from '../../http/problems.ts';

type Executor = Kysely<DB>;

export interface ServiceDetails extends Service {
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
}

/** Företaget har exakt en rad. Saknas den är installationen inte konfigurerad. */
export async function getBusiness(db: Executor): Promise<Business> {
  const business = await db
    .selectFrom('business')
    .select([
      'name',
      'timezone',
      'slotStepMinutes',
      'minNoticeMinutes',
      'bookingHorizonDays',
      'cancelCutoffMinutes',
    ])
    .executeTakeFirst();
  if (business === undefined) {
    throw new ProblemError('service-unavailable', 503, {
      detail: 'Företaget är inte konfigurerat.',
    });
  }
  return business;
}

export function listActiveServices(db: Executor): Promise<Service[]> {
  return db
    .selectFrom('service')
    .select(['id', 'name', 'description', 'durationMinutes', 'priceOre'])
    .where('active', '=', true)
    .orderBy('name')
    .orderBy('id')
    .execute();
}

export async function findActiveService(
  db: Executor,
  id: string,
): Promise<ServiceDetails | undefined> {
  return db
    .selectFrom('service')
    .select([
      'id',
      'name',
      'description',
      'durationMinutes',
      'priceOre',
      'bufferBeforeMinutes',
      'bufferAfterMinutes',
    ])
    .where('id', '=', id)
    .where('active', '=', true)
    .executeTakeFirst();
}

/** Aktiv personal som utför tjänsten, sorterad efter namn. */
export function listStaffForService(db: Executor, serviceId: string): Promise<StaffSummary[]> {
  return db
    .selectFrom('staff')
    .innerJoin('staffService', 'staffService.staffId', 'staff.id')
    .select(['staff.id', 'staff.displayName'])
    .where('staffService.serviceId', '=', serviceId)
    .where('staff.active', '=', true)
    .orderBy('staff.displayName')
    .orderBy('staff.id')
    .execute();
}
