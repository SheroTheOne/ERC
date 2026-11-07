import { Type, type Static } from 'typebox';
import { Uuid } from './common.ts';

export const Business = Type.Object(
  {
    name: Type.String(),
    timezone: Type.String(),
    slotStepMinutes: Type.Integer(),
    minNoticeMinutes: Type.Integer(),
    bookingHorizonDays: Type.Integer(),
    cancelCutoffMinutes: Type.Integer(),
  },
  { additionalProperties: false },
);
export type Business = Static<typeof Business>;

export const Service = Type.Object(
  {
    id: Uuid,
    name: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    durationMinutes: Type.Integer(),
    priceOre: Type.Integer(),
  },
  { additionalProperties: false },
);
export type Service = Static<typeof Service>;

export const ServiceList = Type.Object(
  { items: Type.Array(Service) },
  { additionalProperties: false },
);
export type ServiceList = Static<typeof ServiceList>;

export const StaffSummary = Type.Object(
  { id: Uuid, displayName: Type.String() },
  { additionalProperties: false },
);
export type StaffSummary = Static<typeof StaffSummary>;

export const StaffList = Type.Object(
  { items: Type.Array(StaffSummary) },
  { additionalProperties: false },
);
export type StaffList = Static<typeof StaffList>;
