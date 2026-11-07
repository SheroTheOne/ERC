import type {
  Business,
  CreateServiceRequest,
  Service,
  ServiceAdmin,
  StaffSummary,
  UpdateBusinessRequest,
  UpdateServiceRequest,
} from '@erc/contracts';
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

const serviceAdminColumns = [
  'id',
  'name',
  'description',
  'durationMinutes',
  'bufferBeforeMinutes',
  'bufferAfterMinutes',
  'priceOre',
  'active',
] as const;

export function listAllServices(db: Executor): Promise<ServiceAdmin[]> {
  return db
    .selectFrom('service')
    .select(serviceAdminColumns)
    .orderBy('active', 'desc')
    .orderBy('name')
    .orderBy('id')
    .execute();
}

export function insertService(db: Executor, input: CreateServiceRequest): Promise<ServiceAdmin> {
  return db
    .insertInto('service')
    .values({
      name: input.name,
      description: input.description ?? null,
      durationMinutes: input.durationMinutes,
      bufferBeforeMinutes: input.bufferBeforeMinutes ?? 0,
      bufferAfterMinutes: input.bufferAfterMinutes ?? 0,
      priceOre: input.priceOre,
    })
    .returning(serviceAdminColumns)
    .executeTakeFirstOrThrow();
}

/**
 * Ändringar av längd, buffert och pris påverkar bara nya bokningar. Befintliga
 * bokningar har en ögonblicksbild av dem (ADR-0003).
 */
export function updateService(
  db: Executor,
  id: string,
  input: UpdateServiceRequest,
): Promise<ServiceAdmin | undefined> {
  return db
    .updateTable('service')
    .set(input)
    .where('id', '=', id)
    .returning(serviceAdminColumns)
    .executeTakeFirst();
}

/** Ogiltig tidszon stoppas av business_timezone_check och blir 400 (ADR-0007). */
export async function updateBusiness(
  db: Executor,
  input: UpdateBusinessRequest,
): Promise<Business> {
  await db.updateTable('business').set(input).execute();
  return getBusiness(db);
}
