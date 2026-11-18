import {
  AvailabilityResponse,
  Booking,
  Business,
  type CreateBookingRequest,
  HealthResponse,
  Problem,
  type ProblemType,
  ServiceList,
  StaffList,
  problemTypeUri,
} from '@erc/contracts';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

const API_BASE = '/api/v1';

/** Ett RFC 9457-fel från API:t. Klienten styr beteende på `problem.type`, aldrig på texten. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.problem = problem;
  }

  is(type: ProblemType): boolean {
    return this.problem.type === problemTypeUri(type);
  }
}

/** Svaret valideras mot kontraktet, så att ett oväntat svar blir ett tydligt fel och inte ett tyst typfel. */
async function request<S extends TSchema>(
  path: string,
  schema: S,
  init: RequestInit = {},
): Promise<Static<S>> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(API_BASE + path, { ...init, headers, credentials: 'same-origin' });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new ApiError(
      Value.Check(Problem, body)
        ? body
        : {
            type: 'about:blank',
            title: response.statusText,
            status: response.status,
            requestId: response.headers.get('x-request-id') ?? '',
          },
    );
  }
  if (!Value.Check(schema, body)) {
    throw new Error(`Unexpected response from ${path}`);
  }
  return body;
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  return search.toString();
}

const RETRY_DELAYS_MS = [500, 1500];

/** Nätverksfel och 503 kan göras om. Allt annat är ett svar som ska visas. */
function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) return error.problem.status === 503;
  return error instanceof TypeError;
}

/**
 * Varje anrop är ett försök från kunden och får en ny Idempotency-Key. Automatiska omförsök
 * återanvänder nyckeln, så att en bokning som faktiskt gick igenom inte skapas två gånger (ADR-0003).
 */
async function createBooking(
  body: CreateBookingRequest,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<Booking> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return await request('/bookings', Booking, init);
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isRetryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export const api = {
  health: () => request('/health', HealthResponse),
  business: () => request('/business', Business),
  services: () => request('/services', ServiceList),
  serviceStaff: (serviceId: string) =>
    request(`/services/${encodeURIComponent(serviceId)}/staff`, StaffList),
  availability: (params: {
    readonly serviceId: string;
    readonly from: string;
    readonly to: string;
    readonly staffId?: string | undefined;
  }) => request(`/availability?${query(params)}`, AvailabilityResponse),
  createBooking,
};
