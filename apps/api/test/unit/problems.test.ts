import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { ProblemError, toProblem } from '../../src/http/problems.ts';

function databaseError(code: string, constraint?: string): pg.DatabaseError {
  const error = new pg.DatabaseError('database error', 0, 'error');
  error.code = code;
  if (constraint !== undefined) error.constraint = constraint;
  return error;
}

describe('toProblem', () => {
  it.each([
    ['23P01', 'booking_no_overlap', 'slot-unavailable', 409],
    ['23514', 'booking_within_open_hours', 'outside-open-hours', 409],
    ['23514', 'booking_staff_active', 'staff-inactive', 409],
    ['23P01', 'working_hours_no_overlap', 'schedule-overlap', 409],
    ['23514', 'booking_staff_performs_service', 'staff-does-not-perform-service', 422],
  ])('maps %s on %s to %s (%i)', (code, constraint, type, status) => {
    const problem = toProblem(databaseError(code, constraint));
    expect({ type: problem.type, status: problem.status }).toEqual({ type, status });
  });

  it('treats constraints that a valid request cannot violate as internal errors', () => {
    const problem = toProblem(databaseError('23514', 'booking_cancellation_consistent'));
    expect({ type: problem.type, status: problem.status }).toEqual({
      type: 'internal',
      status: 500,
    });
  });

  it('maps a lost database connection to 503', () => {
    expect(toProblem(databaseError('57P01')).status).toBe(503);
  });

  it('passes ProblemError through unchanged', () => {
    const original = new ProblemError('not-found', 404);
    expect(toProblem(original)).toBe(original);
  });

  it('never exposes the message of an unknown error', () => {
    const problem = toProblem(new Error('password=hunter2'));
    expect(problem.status).toBe(500);
    expect(problem.detail).toBeUndefined();
  });
});
