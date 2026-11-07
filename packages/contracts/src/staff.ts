import { Type, type Static } from 'typebox';
import { Email } from './auth.ts';
import { Booking } from './booking.ts';
import { Instant, LocalDate, Uuid } from './common.ts';

export const StaffRole = Type.Union([Type.Literal('staff'), Type.Literal('admin')]);
export type StaffRole = Static<typeof StaffRole>;

export const StaffMember = Type.Object(
  {
    id: Uuid,
    email: Type.String(),
    displayName: Type.String(),
    role: StaffRole,
    active: Type.Boolean(),
    serviceIds: Type.Array(Uuid),
  },
  { additionalProperties: false },
);
export type StaffMember = Static<typeof StaffMember>;

export const StaffMemberList = Type.Object(
  { items: Type.Array(StaffMember) },
  { additionalProperties: false },
);

export const CreateStaffRequest = Type.Object(
  {
    email: Email,
    displayName: Type.String({ minLength: 1, maxLength: 100 }),
    role: StaffRole,
    /** Startlösenord som administratören lämnar över. Minst 12 tecken (OWASP). */
    password: Type.String({ minLength: 12, maxLength: 1024 }),
  },
  { additionalProperties: false },
);
export type CreateStaffRequest = Static<typeof CreateStaffRequest>;

export const UpdateStaffRequest = Type.Object(
  {
    displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    role: Type.Optional(StaffRole),
    active: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateStaffRequest = Static<typeof UpdateStaffRequest>;

export const StaffServicesRequest = Type.Object(
  { serviceIds: Type.Array(Uuid, { uniqueItems: true, maxItems: 100 }) },
  { additionalProperties: false },
);

/** Väggklocka i företagets tidszon. '24:00' betyder slutet av dygnet (ADR-0004). */
export const WallClockTime = Type.String({ pattern: '^(([01]\\d|2[0-3]):[0-5]\\d|24:00)$' });

export const Shift = Type.Object(
  {
    weekday: Type.Integer({ minimum: 1, maximum: 7 }),
    startTime: WallClockTime,
    endTime: WallClockTime,
  },
  { additionalProperties: false },
);
export type Shift = Static<typeof Shift>;

export const WorkingHoursRule = Type.Object(
  {
    id: Uuid,
    weekday: Type.Integer(),
    startTime: Type.String(),
    endTime: Type.String(),
    validFrom: LocalDate,
    validUntil: Type.Union([LocalDate, Type.Null()]),
  },
  { additionalProperties: false },
);
export type WorkingHoursRule = Static<typeof WorkingHoursRule>;

export const WorkingHoursQuery = Type.Object(
  { at: Type.Optional(LocalDate) },
  { additionalProperties: false },
);

export const WorkingHoursResponse = Type.Object(
  { staffId: Uuid, at: LocalDate, rules: Type.Array(WorkingHoursRule) },
  { additionalProperties: false },
);
export type WorkingHoursResponse = Static<typeof WorkingHoursResponse>;

export const ReplaceWorkingHoursRequest = Type.Object(
  { validFrom: LocalDate, shifts: Type.Array(Shift, { maxItems: 50 }) },
  { additionalProperties: false },
);
export type ReplaceWorkingHoursRequest = Static<typeof ReplaceWorkingHoursRequest>;

export const ReplaceWorkingHoursResponse = Type.Object(
  {
    staffId: Uuid,
    at: LocalDate,
    rules: Type.Array(WorkingHoursRule),
    /** Aktiva bokningar som nu ligger utanför öppen tid (ADR-0002). */
    conflicts: Type.Array(Booking),
  },
  { additionalProperties: false },
);

export const TimeOff = Type.Object(
  {
    id: Uuid,
    staffId: Uuid,
    from: Instant,
    to: Instant,
    reason: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type TimeOff = Static<typeof TimeOff>;

export const TimeOffList = Type.Object(
  { items: Type.Array(TimeOff) },
  { additionalProperties: false },
);

export const TimeOffQuery = Type.Object(
  { from: Type.Optional(Instant), to: Type.Optional(Instant) },
  { additionalProperties: false },
);

const Reason = Type.Optional(Type.String({ maxLength: 500 }));

/** Antingen exakta tidpunkter, eller lokala heldagar där `toDate` ingår. */
export const CreateTimeOffRequest = Type.Union([
  Type.Object({ from: Instant, to: Instant, reason: Reason }, { additionalProperties: false }),
  Type.Object(
    { fromDate: LocalDate, toDate: LocalDate, reason: Reason },
    { additionalProperties: false },
  ),
]);
export type CreateTimeOffRequest = Static<typeof CreateTimeOffRequest>;

export const CreateTimeOffResponse = Type.Object(
  { timeOff: TimeOff, conflicts: Type.Array(Booking) },
  { additionalProperties: false },
);

export const StaffTimeOffParams = Type.Object(
  { id: Uuid, timeOffId: Uuid },
  { additionalProperties: false },
);
