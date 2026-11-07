import { randomUUID } from 'node:crypto';
import type { Booking, Customer, CustomerExport } from '@erc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED } from '../../db/seed/seed.ts';
import { as, createTestApp, loginAs, loginCustomer, type TestApp } from '../setup/app.ts';

let t: TestApp;
let admin: string;

beforeAll(async () => {
  t = await createTestApp({ now: '2026-03-20T12:00:00Z' });
  admin = await loginAs(t, 'alva@erc.example');
});

afterAll(async () => {
  await t.close();
});

async function bookAs(email: string, startsAt: string): Promise<Booking> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/api/v1/bookings',
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      serviceId: SEED.services.haircut,
      staffId: SEED.staff.bo,
      startsAt,
      contact: { name: 'Sara Lind', email, phone: '+46709876543' },
      note: 'Kort lugg',
    },
  });
  if (response.statusCode !== 201) throw new Error(response.body);
  return response.json<Booking>();
}

describe('customer search', () => {
  it('matches name or e-mail, case-insensitively, and treats % literally', async () => {
    const search = async (q: string) =>
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/v1/customers',
          headers: as(admin),
          query: { q },
        })
      )
        .json<{ items: Customer[] }>()
        .items.map((c) => c.email);

    expect(await search('svensson')).toEqual(['kim@example.com']);
    expect(await search('ROBIN@')).toEqual(['robin@example.com']);
    expect(await search('%')).toEqual([]);
  });
});

describe('customer self-service', () => {
  it('shows a logged-in customer their bookings and a complete export', async () => {
    const booking = await bookAs('sara@example.com', '2026-03-24T13:00:00+01:00');
    const cookie = await loginCustomer(t, 'sara@example.com');

    const mine = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/bookings',
      headers: as(cookie),
    });
    expect(mine.json<{ items: Booking[] }>().items.map((b) => b.id)).toEqual([booking.id]);

    const exported = (
      await t.app.inject({ method: 'GET', url: '/api/v1/me/export', headers: as(cookie) })
    ).json<CustomerExport>();
    expect(exported.customer).toMatchObject({
      email: 'sara@example.com',
      name: 'Sara Lind',
      phone: '+46709876543',
    });
    expect(exported.bookings.map((b) => b.id)).toEqual([booking.id]);
  });

  it('lets the owner cancel within the cutoff without the e-mail link', async () => {
    const booking = await bookAs('sara@example.com', '2026-03-25T13:00:00+01:00');
    const cookie = await loginCustomer(t, 'sara@example.com');
    const response = await t.app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${booking.id}/cancel`,
      headers: as(cookie),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Booking>().status).toBe('cancelled');
  });
});

describe('anonymization (GDPR article 17)', () => {
  it('removes personal data everywhere, revokes access and keeps the booking rows', async () => {
    const email = 'radera@example.com';
    const booking = await bookAs(email, '2026-03-26T13:00:00+01:00');
    const manageToken = t.mailer.lastTo(email)?.manageToken ?? '';
    const customerSession = await loginCustomer(t, email);

    const response = await t.app.inject({
      method: 'POST',
      url: `/api/v1/customers/${booking.customerId}/anonymize`,
      headers: as(admin),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Customer>()).toMatchObject({
      name: 'Raderad kund',
      email: `deleted+${booking.customerId}@invalid`,
      phone: null,
    });

    const { rows } = await t.testDb.pool.query<Record<string, unknown>>(
      `SELECT b.contact_name, b.contact_phone, b.customer_note, b.status, u.email AS user_email, u.disabled_at IS NOT NULL AS disabled
       FROM booking b JOIN customer c ON c.id = b.customer_id LEFT JOIN app_user u ON u.id = c.user_id
       WHERE b.id = $1`,
      [booking.id],
    );
    expect(rows[0]).toMatchObject({
      contact_name: 'Raderad kund',
      contact_phone: null,
      customer_note: null,
      status: 'confirmed',
      disabled: true,
    });
    expect(String(rows[0]?.['user_email'])).toMatch(/^deleted\+.*@invalid$/);

    // Varken sessionen eller hanteringslänken fungerar längre.
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: as(customerSession) }))
        .statusCode,
    ).toBe(401);
    const viaLink = await t.app.inject({
      method: 'GET',
      url: `/api/v1/bookings/${booking.id}`,
      headers: { authorization: `Bearer ${manageToken}` },
    });
    expect(viaLink.statusCode).toBe(404);

    // Den gamla adressen ger inte längre någon inloggningslänk.
    const linksBefore = t.mailer.loginLinks.length;
    await t.app.inject({ method: 'POST', url: '/api/v1/auth/magic-link', payload: { email } });
    expect(t.mailer.loginLinks).toHaveLength(linksBefore);
  });

  it('is idempotent', async () => {
    const first = await t.app.inject({
      method: 'POST',
      url: `/api/v1/customers/${SEED.customers.robin}/anonymize`,
      headers: as(admin),
    });
    const second = await t.app.inject({
      method: 'POST',
      url: `/api/v1/customers/${SEED.customers.robin}/anonymize`,
      headers: as(admin),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });
});
