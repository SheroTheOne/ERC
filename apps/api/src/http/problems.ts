import {
  problemTypeUri,
  type Problem,
  type ProblemType,
  type ValidationIssue,
} from '@erc/contracts';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import pg from 'pg';

const TITLES = {
  'validation-failed': 'Ogiltig förfrågan',
  unauthenticated: 'Inloggning krävs',
  forbidden: 'Åtkomst nekad',
  'not-found': 'Resursen finns inte',
  'slot-unavailable': 'Tiden är inte längre ledig',
  'outside-open-hours': 'Tiden ligger utanför öppettiderna',
  'staff-inactive': 'Personen tar inte emot bokningar',
  'cancellation-window-closed': 'Det är för sent att avboka',
  'schedule-overlap': 'Arbetspasset överlappar ett annat pass',
  'staff-does-not-perform-service': 'Personen utför inte tjänsten',
  'idempotency-key-reused': 'Idempotensnyckeln används redan för en annan förfrågan',
  'idempotency-key-required': 'Headern Idempotency-Key saknas',
  'payload-too-large': 'Förfrågan är för stor',
  'unsupported-media-type': 'Innehållstypen stöds inte',
  'rate-limited': 'För många förfrågningar',
  'service-unavailable': 'Tjänsten är tillfälligt otillgänglig',
  internal: 'Ett oväntat fel inträffade',
} as const satisfies Record<ProblemType, string>;

/** Ett fel som ska nå klienten som RFC 9457 Problem Details (ADR-0007). */
export class ProblemError extends Error {
  override readonly name = 'ProblemError';
  readonly type: ProblemType;
  readonly status: number;
  readonly detail: string | undefined;
  readonly errors: readonly ValidationIssue[] | undefined;

  constructor(
    type: ProblemType,
    status: number,
    options: { detail?: string; errors?: readonly ValidationIssue[]; cause?: unknown } = {},
  ) {
    super(options.detail ?? TITLES[type], { cause: options.cause });
    this.type = type;
    this.status = status;
    this.detail = options.detail;
    this.errors = options.errors;
  }
}

/**
 * Databasens namngivna constraints är en del av kontraktet (ADR-0002). Bara de
 * som kan utlösas av en giltig förfrågan finns här. Övriga, till exempel
 * booking_cancellation_consistent, är programmeringsfel och blir 500.
 */
const CONSTRAINT_PROBLEMS: Readonly<Record<string, readonly [ProblemType, number]>> = {
  booking_no_overlap: ['slot-unavailable', 409],
  booking_within_open_hours: ['outside-open-hours', 409],
  booking_staff_active: ['staff-inactive', 409],
  working_hours_no_overlap: ['schedule-overlap', 409],
  booking_staff_performs_service: ['staff-does-not-perform-service', 422],
};

const SQLSTATE = {
  exclusionViolation: '23P01',
  checkViolation: '23514',
  connectionFailure: '08006',
  cannotConnectNow: '57P03',
  adminShutdown: '57P01',
} as const;

export function problemFromDatabaseError(error: pg.DatabaseError): ProblemError | undefined {
  const { code, constraint } = error;
  if (
    (code === SQLSTATE.exclusionViolation || code === SQLSTATE.checkViolation) &&
    constraint !== undefined
  ) {
    const mapped = CONSTRAINT_PROBLEMS[constraint];
    return mapped === undefined
      ? undefined
      : new ProblemError(mapped[0], mapped[1], { cause: error });
  }
  if (
    code === SQLSTATE.connectionFailure ||
    code === SQLSTATE.cannotConnectNow ||
    code === SQLSTATE.adminShutdown
  ) {
    return new ProblemError('service-unavailable', 503, { cause: error });
  }
  return undefined;
}

function problemFromFastifyError(error: FastifyError): ProblemError | undefined {
  if (error.validation !== undefined) {
    const context = error.validationContext ?? 'request';
    return new ProblemError('validation-failed', 400, {
      errors: error.validation.map((issue) => ({
        path: `${context}${issue.instancePath}`,
        message: issue.message ?? 'is invalid',
      })),
      cause: error,
    });
  }
  switch (error.statusCode) {
    case 400:
      return new ProblemError('validation-failed', 400, { detail: error.message, cause: error });
    case 413:
      return new ProblemError('payload-too-large', 413, { cause: error });
    case 415:
      return new ProblemError('unsupported-media-type', 415, { cause: error });
    case undefined:
    default:
      return undefined;
  }
}

function isFastifyError(error: unknown): error is FastifyError {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('FST_')
  );
}

/** Gör om vilket fel som helst till ett ProblemError. Okända fel blir 500 utan intern information. */
export function toProblem(error: unknown): ProblemError {
  if (error instanceof ProblemError) return error;
  if (error instanceof pg.DatabaseError) {
    return problemFromDatabaseError(error) ?? new ProblemError('internal', 500, { cause: error });
  }
  if (isFastifyError(error)) {
    return problemFromFastifyError(error) ?? new ProblemError('internal', 500, { cause: error });
  }
  return new ProblemError('internal', 500, { cause: error });
}

export function problemBody(problem: ProblemError, request: FastifyRequest): Problem {
  return {
    type: problemTypeUri(problem.type),
    title: TITLES[problem.type],
    status: problem.status,
    ...(problem.detail === undefined ? {} : { detail: problem.detail }),
    instance: request.url.split('?', 1)[0] ?? request.url,
    requestId: request.id,
    ...(problem.errors === undefined ? {} : { errors: [...problem.errors] }),
  };
}

export function sendProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  problem: ProblemError,
): FastifyReply {
  return reply
    .status(problem.status)
    .type('application/problem+json')
    .send(problemBody(problem, request));
}
