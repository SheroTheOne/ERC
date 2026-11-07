import { createHash } from 'node:crypto';
import type { Me } from '@erc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED } from '../../db/seed/seed.ts';
import {
  ORIGIN,
  as,
  createTestApp,
  loginAs,
  loginCustomer,
  sessionCookie,
  type TestApp,
} from '../setup/app.ts';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ now: '2026-03-20T12:00:00Z' });
});

afterAll(async () => {
  await t.close();
});

const me = (cookie?: string) =>
  t.app.inject({ method: 'GET', url: '/api/v1/me', headers: as(cookie) });

describe('password login for staff', () => {
  it('sets a __Host- session cookie with HttpOnly, Secure and SameSite=Lax', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'anna@erc.example', password: 'erc-demo-2026' },
    });

    expect(response.statusCode).toBe(204);
    const cookie = response.cookies.find((c) => c.name === '__Host-erc_session');
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect(cookie?.domain).toBeUndefined();
    expect(cookie?.maxAge).toBe(12 * 60 * 60);

    const body = (await me(sessionCookie(response))).json<Me>();
    expect(body).toEqual({
      id: SEED.users.anna,
      email: 'anna@erc.example',
      role: 'staff',
      staffId: SEED.staff.anna,
      customerId: null,
    });
  });

  it('accepts the e-mail address case-insensitively', async () => {
    await expect(loginAs(t, 'ANNA@erc.example')).resolves.toContain('__Host-erc_session=');
  });

  it.each([
    ['a wrong password', 'anna@erc.example', 'fel-lösenord'],
    ['an unknown e-mail address', 'finns-inte@erc.example', 'erc-demo-2026'],
  ])('gives the same 401 for %s', async (_label, email, password) => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ detail: 'Fel e-postadress eller lösenord.' });
    expect(sessionCookie(response)).toBeUndefined();
  });

  it('rejects a disabled account', async () => {
    await t.testDb.pool.query(
      `UPDATE app_user SET disabled_at = now() WHERE email = 'bo@erc.example'`,
    );
    try {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'bo@erc.example', password: 'erc-demo-2026' },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await t.testDb.pool.query(
        `UPDATE app_user SET disabled_at = NULL WHERE email = 'bo@erc.example'`,
      );
    }
  });

  it('stores only the SHA-256 of the session token', async () => {
    const cookie = await loginAs(t, 'anna@erc.example');
    const token = cookie.split('=')[1] ?? '';
    const { rows } = await t.testDb.pool.query<{ hashed: number; plain: number }>(
      `SELECT count(*) FILTER (WHERE encode(id_hash, 'hex') = $1)::int AS hashed,
              count(*) FILTER (WHERE encode(id_hash, 'escape') = $2)::int AS plain
       FROM session`,
      [createHash('sha256').update(token).digest('hex'), token],
    );
    expect(rows[0]).toEqual({ hashed: 1, plain: 0 });
  });
});

describe('sessions', () => {
  it('logs out by deleting the session on the server', async () => {
    const cookie = await loginAs(t, 'anna@erc.example');
    const logout = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: as(cookie),
    });

    expect(logout.statusCode).toBe(204);
    expect(logout.cookies.find((c) => c.name === '__Host-erc_session')?.value).toBe('');
    // Den gamla cookien fungerar inte längre, även om klienten skickar den igen.
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it('expires after 12 hours of inactivity for staff, and slides when used', async () => {
    const cookie = await loginAs(t, 'anna@erc.example');
    try {
      t.clock.set('2026-03-20T23:00:00Z'); // 11 timmar senare: giltig, förlängs
      const renewed = await me(cookie);
      expect(renewed.statusCode).toBe(200);
      expect(renewed.cookies.find((c) => c.name === '__Host-erc_session')?.maxAge).toBe(
        12 * 60 * 60,
      );

      t.clock.set('2026-03-21T10:30:00Z'); // 11,5 timmar efter förlängningen: fortfarande giltig
      expect((await me(cookie)).statusCode).toBe(200);

      t.clock.set('2026-03-22T00:00:00Z'); // mer än 12 timmar utan aktivitet
      expect((await me(cookie)).statusCode).toBe(401);
    } finally {
      t.clock.set('2026-03-20T12:00:00Z');
    }
  });

  it('ignores a forged or malformed cookie', async () => {
    expect((await me('__Host-erc_session=' + 'A'.repeat(43))).statusCode).toBe(401);
    expect((await me('__Host-erc_session=kort')).statusCode).toBe(401);
  });

  it('rejects state-changing requests with a session from another origin (CSRF)', async () => {
    const cookie = await loginAs(t, 'alva@erc.example');
    const payload = { name: 'Salong Exempel' };

    const foreign = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/business',
      headers: { cookie, origin: 'https://evil.example' },
      payload,
    });
    expect(foreign.statusCode).toBe(403);

    const missing = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/business',
      headers: { cookie },
      payload,
    });
    expect(missing.statusCode).toBe(403);

    const same = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/business',
      headers: { cookie, origin: ORIGIN },
      payload,
    });
    expect(same.statusCode).toBe(200);
  });
});

describe('e-mail login for customers', () => {
  it('logs in an existing customer with a single-use link', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: { email: 'kim@example.com' },
    });
    const link = t.mailer.loginLinks.findLast((message) => message.to === 'kim@example.com');
    expect(link).toBeDefined();
    const token = link?.token ?? '';

    const first = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      payload: { token },
    });
    expect(first.statusCode).toBe(204);
    const cookie = sessionCookie(first);
    expect(first.cookies.find((c) => c.name === '__Host-erc_session')?.maxAge).toBe(
      30 * 24 * 60 * 60,
    );
    expect((await me(cookie)).json<Me>()).toMatchObject({
      role: 'customer',
      customerId: SEED.customers.kim,
      staffId: null,
    });

    const reused = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      payload: { token },
    });
    expect(reused.statusCode).toBe(401);
  });

  it('answers 202 for unknown addresses without sending anything', async () => {
    const before = t.mailer.loginLinks.length;
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: { email: 'okand@example.com' },
    });
    expect(response.statusCode).toBe(202);
    expect(t.mailer.loginLinks).toHaveLength(before);
  });

  it('never logs a staff account in with an e-mail link', async () => {
    // En kundpost med samma adress som personal får inte ge personalens session.
    await t.testDb.pool.query(
      `INSERT INTO customer (email, name) VALUES ('bo@erc.example', 'Bo som kund')`,
    );
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: { email: 'bo@erc.example' },
    });
    const link = t.mailer.loginLinks.findLast((message) => message.to === 'bo@erc.example');
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      payload: { token: link?.token ?? '' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('expires links after 15 minutes', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: { email: 'robin@example.com' },
    });
    const link = t.mailer.loginLinks.findLast((message) => message.to === 'robin@example.com');
    t.clock.set('2026-03-20T12:16:00Z');
    try {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/verify',
        payload: { token: link?.token ?? '' },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      t.clock.set('2026-03-20T12:00:00Z');
    }
  });

  it('limits how many links one address can receive', async () => {
    const email = 'robin@example.com';
    const sentBefore = t.mailer.loginLinks.filter((m) => m.to === email).length;
    for (let i = 0; i < 5; i++) {
      await t.app.inject({ method: 'POST', url: '/api/v1/auth/magic-link', payload: { email } });
    }
    const sent = t.mailer.loginLinks.filter((m) => m.to === email).length - sentBefore;
    expect(sent).toBeLessThanOrEqual(3);
  });

  it('lets a logged-in customer see only their own bookings', async () => {
    const cookie = await loginCustomer(t, 'kim@example.com');
    const response = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/bookings',
      headers: as(cookie),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });
});
