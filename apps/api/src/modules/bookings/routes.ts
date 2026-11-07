import {
  Booking,
  CreateBookingRequest,
  IdParams,
  IdempotencyHeaders,
  Problem,
} from '@erc/contracts';
import type { FastifyRequest } from 'fastify';
import type { AppInstance } from '../../app.ts';
import { ProblemError } from '../../http/problems.ts';
import { cancelBookingWithToken, createBooking, getBookingWithToken } from './service.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hanteringslänkens token skickas som `Authorization: Bearer <token>`. */
function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined) return undefined;
  const match = /^Bearer (\S+)$/.exec(header);
  return match?.[1] ?? '';
}

function idempotencyKey(value: string | undefined): string {
  if (value === undefined) throw new ProblemError('idempotency-key-required', 428);
  if (!UUID_PATTERN.test(value)) {
    throw new ProblemError('validation-failed', 400, {
      errors: [{ path: 'headers/idempotency-key', message: 'must be a UUID' }],
    });
  }
  return value.toLowerCase();
}

export function bookingRoutes(app: AppInstance): void {
  app.post(
    '/bookings',
    {
      schema: {
        summary: 'Boka en tid. Kräver headern Idempotency-Key (ADR-0003)',
        headers: IdempotencyHeaders,
        body: CreateBookingRequest,
        response: { 201: Booking, 400: Problem, 409: Problem, 422: Problem, 428: Problem },
      },
    },
    async (request, reply) => {
      const key = idempotencyKey(request.headers['idempotency-key']);
      const result = await createBooking({ ...app.deps, log: request.log }, request.body, key);
      if (result.replayed) reply.header('idempotent-replayed', 'true');
      return reply
        .status(201)
        .header('location', `${app.prefix}/bookings/${result.booking.id}`)
        .send(result.booking);
    },
  );

  app.get(
    '/bookings/:id',
    {
      schema: {
        summary: 'Visa en bokning via hanteringslänken',
        params: IdParams,
        response: { 200: Booking, 401: Problem, 404: Problem },
      },
    },
    (request) => getBookingWithToken(app.deps, request.params.id, bearerToken(request)),
  );

  app.post(
    '/bookings/:id/cancel',
    {
      schema: {
        summary: 'Avboka via hanteringslänken. Idempotent',
        params: IdParams,
        response: { 200: Booking, 401: Problem, 404: Problem, 409: Problem },
      },
    },
    (request) => cancelBookingWithToken(app.deps, request.params.id, bearerToken(request)),
  );
}
