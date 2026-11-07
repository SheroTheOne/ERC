import { HealthResponse, Problem } from '@erc/contracts';
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
}

/** Svaret valideras mot kontraktet, så att ett oväntat svar blir ett tydligt fel och inte ett tyst typfel. */
async function request<S extends TSchema>(
  path: string,
  schema: S,
  init: RequestInit = {},
): Promise<Static<S>> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
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

export const api = {
  health: () => request('/health', HealthResponse),
};
