import { type ProblemType, problemTypeUri } from '@erc/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api.ts';
import { describeBookingFailure, validateContact } from './errors.ts';

function problem(type: ProblemType, status: number, extra: object = {}): ApiError {
  return new ApiError({
    type: problemTypeUri(type),
    title: type,
    status,
    requestId: 'r1',
    ...extra,
  });
}

describe('describeBookingFailure', () => {
  it('skickar tillbaka till tiderna när tiden är tagen', () => {
    expect(describeBookingFailure(problem('slot-unavailable', 409))).toEqual({
      kind: 'slot-gone',
      message: 'Tiden hann bokas av någon annan. Välj en ny tid.',
    });
  });

  it.each(['outside-open-hours', 'staff-inactive', 'staff-does-not-perform-service'] as const)(
    'behandlar %s som att tiden inte finns längre',
    (type) => {
      expect(describeBookingFailure(problem(type, 422)).kind).toBe('slot-gone');
    },
  );

  it('kopplar valideringsfel till fälten', () => {
    const failure = describeBookingFailure(
      problem('validation-failed', 400, {
        errors: [
          { path: 'body/contact/email', message: 'must match format "email"' },
          { path: 'body/contact/phone', message: 'must match pattern' },
        ],
      }),
    );
    expect(failure.kind).toBe('invalid');
    expect(failure.kind === 'invalid' && Object.keys(failure.fields)).toEqual(['email', 'phone']);
  });

  it('ger ett allmänt fel med referens för okända valideringsfel', () => {
    const failure = describeBookingFailure(
      problem('validation-failed', 400, { errors: [{ path: 'body/startsAt', message: 'x' }] }),
    );
    expect(failure).toEqual({
      kind: 'retry',
      message: 'Bokningen gick inte igenom. Försök igen (referens r1).',
    });
  });

  it('hanterar nätverksfel', () => {
    expect(describeBookingFailure(new TypeError('Failed to fetch')).kind).toBe('retry');
  });
});

describe('validateContact', () => {
  const valid = { name: 'Kim', email: 'kim@example.com', phone: '', note: '' };

  it('godkänner ett komplett formulär utan telefon', () => {
    expect(validateContact(valid, undefined)).toEqual({});
  });

  it('kräver namn och giltig e-post', () => {
    expect(
      Object.keys(validateContact({ ...valid, name: '  ', email: 'kim@' }, undefined)),
    ).toEqual(['name', 'email']);
  });

  it('avvisar telefonnummer som inte går att tolka', () => {
    expect(validateContact({ ...valid, phone: '12' }, undefined)).toHaveProperty('phone');
    expect(validateContact({ ...valid, phone: '070 123 45 67' }, '+46701234567')).toEqual({});
  });
});
