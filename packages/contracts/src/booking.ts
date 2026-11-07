import { Type, type Static } from 'typebox';
import { Instant, Uuid } from './common.ts';

export const BookingStatus = Type.Union([
  Type.Literal('confirmed'),
  Type.Literal('cancelled'),
  Type.Literal('completed'),
  Type.Literal('no_show'),
]);
export type BookingStatus = Static<typeof BookingStatus>;

export const Contact = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    email: Type.String({ format: 'email', maxLength: 254 }),
    phone: Type.Optional(Type.String({ pattern: '^\\+[1-9][0-9]{6,14}$' })),
  },
  { additionalProperties: false },
);
export type Contact = Static<typeof Contact>;

export const CreateBookingRequest = Type.Object(
  {
    serviceId: Uuid,
    /** Utelämnas för "valfri personal". Servern väljer då (ADR-0003). */
    staffId: Type.Optional(Uuid),
    startsAt: Instant,
    contact: Contact,
    note: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type CreateBookingRequest = Static<typeof CreateBookingRequest>;

export const IdempotencyHeaders = Type.Object({
  'idempotency-key': Type.Optional(Type.String()),
});

export const Booking = Type.Object(
  {
    id: Uuid,
    status: BookingStatus,
    customerId: Uuid,
    serviceId: Uuid,
    serviceName: Type.String(),
    staffId: Uuid,
    staffName: Type.String(),
    startsAt: Instant,
    endsAt: Instant,
    priceOre: Type.Integer(),
    contactName: Type.String(),
    contactPhone: Type.Union([Type.String(), Type.Null()]),
    cancelledAt: Type.Union([Instant, Type.Null()]),
  },
  { additionalProperties: false },
);
export type Booking = Static<typeof Booking>;

export const BookingList = Type.Object(
  { items: Type.Array(Booking) },
  { additionalProperties: false },
);
export type BookingList = Static<typeof BookingList>;

export const MAX_BOOKING_LIST_DAYS = 31;

export const BookingListQuery = Type.Object(
  {
    from: Instant,
    /** Exklusiv. Högst MAX_BOOKING_LIST_DAYS dagar efter `from`. */
    to: Instant,
    staffId: Type.Optional(Uuid),
    status: Type.Optional(BookingStatus),
  },
  { additionalProperties: false },
);
export type BookingListQuery = Static<typeof BookingListQuery>;

/** Personalens ändringar: status eller flytt. Invarianterna gäller alltid (ADR-0002). */
export const UpdateBookingRequest = Type.Object(
  {
    status: Type.Optional(
      Type.Union([Type.Literal('completed'), Type.Literal('no_show'), Type.Literal('cancelled')]),
    ),
    startsAt: Type.Optional(Instant),
    staffId: Type.Optional(Uuid),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateBookingRequest = Static<typeof UpdateBookingRequest>;
