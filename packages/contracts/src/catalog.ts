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

/** Tjänst med de fält som bara personal ser. */
export const ServiceAdmin = Type.Object(
  {
    id: Uuid,
    name: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    durationMinutes: Type.Integer(),
    bufferBeforeMinutes: Type.Integer(),
    bufferAfterMinutes: Type.Integer(),
    priceOre: Type.Integer(),
    active: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ServiceAdmin = Static<typeof ServiceAdmin>;

export const ServiceAdminList = Type.Object(
  { items: Type.Array(ServiceAdmin) },
  { additionalProperties: false },
);

const ServiceFields = {
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
  durationMinutes: Type.Integer({ minimum: 5, maximum: 480 }),
  bufferBeforeMinutes: Type.Integer({ minimum: 0, maximum: 120 }),
  bufferAfterMinutes: Type.Integer({ minimum: 0, maximum: 120 }),
  priceOre: Type.Integer({ minimum: 0, maximum: 100_000_000 }),
};

export const CreateServiceRequest = Type.Object(
  {
    name: ServiceFields.name,
    description: Type.Optional(ServiceFields.description),
    durationMinutes: ServiceFields.durationMinutes,
    bufferBeforeMinutes: Type.Optional(ServiceFields.bufferBeforeMinutes),
    bufferAfterMinutes: Type.Optional(ServiceFields.bufferAfterMinutes),
    priceOre: ServiceFields.priceOre,
  },
  { additionalProperties: false },
);
export type CreateServiceRequest = Static<typeof CreateServiceRequest>;

export const UpdateServiceRequest = Type.Object(
  {
    name: Type.Optional(ServiceFields.name),
    description: Type.Optional(ServiceFields.description),
    durationMinutes: Type.Optional(ServiceFields.durationMinutes),
    bufferBeforeMinutes: Type.Optional(ServiceFields.bufferBeforeMinutes),
    bufferAfterMinutes: Type.Optional(ServiceFields.bufferAfterMinutes),
    priceOre: Type.Optional(ServiceFields.priceOre),
    active: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateServiceRequest = Static<typeof UpdateServiceRequest>;

export const UpdateBusinessRequest = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    slotStepMinutes: Type.Optional(
      Type.Union([5, 10, 15, 20, 30, 60].map((step) => Type.Literal(step))),
    ),
    minNoticeMinutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 10080 })),
    bookingHorizonDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
    cancelCutoffMinutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 10080 })),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateBusinessRequest = Static<typeof UpdateBusinessRequest>;

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
