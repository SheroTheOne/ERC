import { Type, type Static } from 'typebox';
import { Instant, LocalDate, Uuid } from './common.ts';

export const MAX_AVAILABILITY_DAYS = 14;

export const AvailabilityQuery = Type.Object(
  {
    serviceId: Uuid,
    from: LocalDate,
    /** Inklusive. Högst MAX_AVAILABILITY_DAYS dagar räknat från `from`. */
    to: LocalDate,
    staffId: Type.Optional(Uuid),
  },
  { additionalProperties: false },
);
export type AvailabilityQuery = Static<typeof AvailabilityQuery>;

export const Slot = Type.Object(
  {
    startsAt: Instant,
    endsAt: Instant,
    /** Personal som kan ta tiden, sorterad efter id. */
    staffIds: Type.Array(Uuid, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type Slot = Static<typeof Slot>;

export const AvailabilityDay = Type.Object(
  { date: LocalDate, slots: Type.Array(Slot) },
  { additionalProperties: false },
);
export type AvailabilityDay = Static<typeof AvailabilityDay>;

export const AvailabilityResponse = Type.Object(
  {
    timezone: Type.String(),
    serviceId: Uuid,
    days: Type.Array(AvailabilityDay),
  },
  { additionalProperties: false },
);
export type AvailabilityResponse = Static<typeof AvailabilityResponse>;
