import { Type, type Static } from 'typebox';

// RFC 9457 Problem Details. `type` är stabil och klienter får styra beteende på den (ADR-0007).
export const PROBLEM_TYPE_BASE = 'https://erc.example/problems/';

export const ProblemType = Type.Union([
  Type.Literal('validation-failed'),
  Type.Literal('unauthenticated'),
  Type.Literal('forbidden'),
  Type.Literal('not-found'),
  Type.Literal('slot-unavailable'),
  Type.Literal('outside-open-hours'),
  Type.Literal('staff-inactive'),
  Type.Literal('cancellation-window-closed'),
  Type.Literal('schedule-overlap'),
  Type.Literal('staff-does-not-perform-service'),
  Type.Literal('idempotency-key-reused'),
  Type.Literal('idempotency-key-required'),
  Type.Literal('payload-too-large'),
  Type.Literal('unsupported-media-type'),
  Type.Literal('rate-limited'),
  Type.Literal('service-unavailable'),
  Type.Literal('internal'),
]);
export type ProblemType = Static<typeof ProblemType>;

export const ValidationIssue = Type.Object(
  {
    path: Type.String(),
    message: Type.String(),
  },
  { additionalProperties: false },
);
export type ValidationIssue = Static<typeof ValidationIssue>;

export const Problem = Type.Object(
  {
    type: Type.String({ format: 'uri' }),
    title: Type.String(),
    status: Type.Integer({ minimum: 400, maximum: 599 }),
    detail: Type.Optional(Type.String()),
    instance: Type.Optional(Type.String()),
    requestId: Type.String(),
    errors: Type.Optional(Type.Array(ValidationIssue)),
  },
  { additionalProperties: false },
);
export type Problem = Static<typeof Problem>;

export const problemTypeUri = (type: ProblemType): string => PROBLEM_TYPE_BASE + type;
