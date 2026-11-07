import {
  MAX_AVAILABILITY_DAYS,
  type AvailabilityQuery,
  type AvailabilityResponse,
  type Business,
} from '@erc/contracts';
import type { Database } from '../../db/database.ts';
import { ProblemError } from '../../http/problems.ts';
import type { Clock } from '../../shared/clock.ts';
import { parseLocalDate, startOfLocalDay, toInstant, toIso } from '../../shared/time.ts';
import { findActiveService, getBusiness, listStaffForService } from '../catalog/repository.ts';
import { freePeriodsByStaff } from './repository.ts';
import { generateSlots, localDate } from './slots.ts';

export interface BookingWindow {
  readonly notBefore: Temporal.Instant;
  readonly notAfter: Temporal.Instant;
}

/**
 * Policy för kunder och anonyma anrop: framförhållning och bokningshorisont
 * (ADR-0002). Horisonten räknas i lokala kalenderdagar.
 */
export function bookingWindow(business: Business, now: Temporal.Instant): BookingWindow {
  return {
    notBefore: now.add({ minutes: business.minNoticeMinutes }),
    notAfter: now
      .toZonedDateTimeISO(business.timezone)
      .add({ days: business.bookingHorizonDays })
      .toInstant(),
  };
}

export async function getAvailability(
  deps: { readonly db: Database; readonly clock: Clock },
  query: AvailabilityQuery,
): Promise<AvailabilityResponse> {
  const from = parseLocalDate(query.from);
  const to = parseLocalDate(query.to);
  if (from === undefined || to === undefined) {
    throw invalidQuery(from === undefined ? 'from' : 'to', 'must be a valid calendar date');
  }
  const days = from.until(to, { largestUnit: 'day' }).days + 1;
  if (days < 1) throw invalidQuery('to', 'must not be before from');
  if (days > MAX_AVAILABILITY_DAYS) {
    throw invalidQuery('to', `must be at most ${MAX_AVAILABILITY_DAYS - 1} days after from`);
  }

  const business = await getBusiness(deps.db);
  const service = await findActiveService(deps.db, query.serviceId);
  if (service === undefined)
    throw new ProblemError('not-found', 404, { detail: 'Tjänsten finns inte.' });

  const staff = (await listStaffForService(deps.db, service.id)).filter(
    (member) => query.staffId === undefined || member.id === query.staffId,
  );
  if (query.staffId !== undefined && staff.length === 0) {
    throw new ProblemError('not-found', 404, { detail: 'Personen utför inte tjänsten.' });
  }

  const timeZone = business.timezone;
  const window = {
    start: startOfLocalDay(from, timeZone),
    end: startOfLocalDay(to.add({ days: 1 }), timeZone),
  };
  const policy = bookingWindow(business, toInstant(deps.clock.now()));
  const free = await freePeriodsByStaff(
    deps.db,
    staff.map((member) => member.id),
    window,
  );

  // Starttid → personal som kan ta den. Personal sorteras efter id för ett stabilt svar.
  const byStart = new Map<string, { start: Temporal.Instant; staffIds: string[] }>();
  for (const member of [...staff].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const slots = generateSlots(free.get(member.id) ?? [], {
      durationMinutes: service.durationMinutes,
      bufferBeforeMinutes: service.bufferBeforeMinutes,
      bufferAfterMinutes: service.bufferAfterMinutes,
      stepMinutes: business.slotStepMinutes,
      timeZone,
      ...policy,
    });
    for (const start of slots) {
      const key = toIso(start);
      const entry = byStart.get(key) ?? { start, staffIds: [] };
      entry.staffIds.push(member.id);
      byStart.set(key, entry);
    }
  }

  const byDate = new Map<string, AvailabilityResponse['days'][number]['slots']>();
  for (let day = from; Temporal.PlainDate.compare(day, to) <= 0; day = day.add({ days: 1 })) {
    byDate.set(day.toString(), []);
  }
  const ordered = [...byStart.values()].sort((a, b) => Temporal.Instant.compare(a.start, b.start));
  for (const { start, staffIds } of ordered) {
    byDate.get(localDate(start, timeZone).toString())?.push({
      startsAt: toIso(start),
      endsAt: toIso(start.add({ minutes: service.durationMinutes })),
      staffIds,
    });
  }

  return {
    timezone: timeZone,
    serviceId: service.id,
    days: [...byDate].map(([date, slots]) => ({ date, slots })),
  };
}

function invalidQuery(field: string, message: string): ProblemError {
  return new ProblemError('validation-failed', 400, {
    errors: [{ path: `querystring/${field}`, message }],
  });
}
