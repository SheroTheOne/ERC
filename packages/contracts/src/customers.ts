import { Type, type Static } from 'typebox';
import { Booking } from './booking.ts';
import { Instant, Uuid } from './common.ts';

export const Customer = Type.Object(
  {
    id: Uuid,
    email: Type.String(),
    name: Type.String(),
    phone: Type.Union([Type.String(), Type.Null()]),
    createdAt: Instant,
    anonymizedAt: Type.Union([Instant, Type.Null()]),
  },
  { additionalProperties: false },
);
export type Customer = Static<typeof Customer>;

export const CustomerList = Type.Object(
  { items: Type.Array(Customer) },
  { additionalProperties: false },
);

export const CustomerQuery = Type.Object(
  {
    /** Söker i namn och e-post. */
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    limit: Type.Integer({ minimum: 1, maximum: 100, default: 50 }),
  },
  { additionalProperties: false },
);

/** Dataexport enligt GDPR artikel 15 och 20 (ADR-0010). */
export const CustomerExport = Type.Object(
  { customer: Customer, bookings: Type.Array(Booking) },
  { additionalProperties: false },
);
export type CustomerExport = Static<typeof CustomerExport>;
