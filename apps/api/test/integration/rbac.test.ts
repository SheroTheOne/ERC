// Behörighetsmatris (ADR-0008). Klart när-kriteriet för Fas 3: tester visar att varje
// roll bara kommer åt det den ska. Varje rad är en endpoint, varje kolumn en roll,
// och varje cell den exakta statuskod som förväntas.
import { randomUUID } from 'node:crypto';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED } from '../../db/seed/seed.ts';
import { as, createTestApp, loginAs, loginCustomer, type TestApp } from '../setup/app.ts';

type Role = 'anonymous' | 'customer' | 'otherCustomer' | 'staff' | 'otherStaff' | 'admin';

interface Case {
  readonly name: string;
  /** Byggs om för varje roll, så att anrop som skapar något inte krockar med varandra. */
  readonly request: () => Promise<InjectOptions> | InjectOptions;
  readonly expect: Partial<Record<Role, number>> &
    Record<'anonymous' | 'customer' | 'staff' | 'admin', number>;
}

const { anna, bo } = SEED.staff;
const { kim } = SEED.customers;
const { haircut, beard } = SEED.services;

let t: TestApp;
const cookies: Partial<Record<Role, string>> = {};
let kimsBooking: string;
let throwawayCustomer: string;

/** Annas schema oförändrat, så att anrop som ersätter det inte påverkar andra tester. */
const ANNA_SHIFTS = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, startTime: '09:00', endTime: '12:00' },
  { weekday, startTime: '13:00', endTime: '17:00' },
]);

async function insertBooking(customerId: string, startsAt: string): Promise<string> {
  const { rows } = await t.testDb.pool.query<{ id: string }>(
    `INSERT INTO booking (customer_id, service_id, staff_id, starts_at, ends_at,
       buffer_before_minutes, buffer_after_minutes, price_ore, contact_name)
     VALUES ($1, $2, $3, $4, $4::timestamptz + interval '45 minutes', 0, 15, 45000, 'Kund')
     RETURNING id`,
    [customerId, haircut, anna, startsAt],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('Booking insert returned no id');
  return id;
}

// Varje ny bokning för PATCH-fallen får en egen tid, eftersom statusändringar inte går att ångra.
// Måndag–torsdag 09:00 sommartid: en roll per dag, alla inom Annas arbetstid.
let nextSlot = Temporal.Instant.from('2026-04-06T07:00:00Z');
function freshSlot(): string {
  const slot = nextSlot.toString();
  nextSlot = nextSlot.add({ hours: 24 });
  return slot;
}

const STAFF_ONLY = { anonymous: 401, customer: 403, staff: 200, admin: 200 } as const;
const ADMIN_ONLY = { anonymous: 401, customer: 403, staff: 403, admin: 200 } as const;
const CUSTOMER_ONLY = { anonymous: 401, customer: 200, staff: 403, admin: 403 } as const;
const PUBLIC = { anonymous: 200, customer: 200, staff: 200, admin: 200 } as const;

const cases: readonly Case[] = [
  // Publikt
  {
    name: 'GET /business',
    request: () => ({ method: 'GET', url: '/api/v1/business' }),
    expect: PUBLIC,
  },
  {
    name: 'GET /services',
    request: () => ({ method: 'GET', url: '/api/v1/services' }),
    expect: PUBLIC,
  },
  {
    name: 'GET /availability',
    request: () => ({
      method: 'GET',
      url: '/api/v1/availability',
      query: { serviceId: haircut, from: '2026-03-24', to: '2026-03-24' },
    }),
    expect: PUBLIC,
  },

  // Inloggad
  {
    name: 'GET /me',
    request: () => ({ method: 'GET', url: '/api/v1/me' }),
    expect: { anonymous: 401, customer: 200, staff: 200, admin: 200 },
  },

  // Personal läser
  {
    name: 'GET /staff',
    request: () => ({ method: 'GET', url: '/api/v1/staff' }),
    expect: STAFF_ONLY,
  },
  {
    name: 'GET /staff/{id}/working-hours',
    request: () => ({ method: 'GET', url: `/api/v1/staff/${bo}/working-hours` }),
    expect: STAFF_ONLY,
  },
  {
    name: 'GET /staff/{id}/time-off',
    request: () => ({ method: 'GET', url: `/api/v1/staff/${bo}/time-off` }),
    expect: STAFF_ONLY,
  },
  {
    name: 'GET /bookings',
    request: () => ({
      method: 'GET',
      url: '/api/v1/bookings',
      query: { from: '2026-03-23T00:00:00Z', to: '2026-03-30T00:00:00Z' },
    }),
    expect: STAFF_ONLY,
  },
  {
    name: 'GET /bookings/conflicts',
    request: () => ({ method: 'GET', url: '/api/v1/bookings/conflicts' }),
    expect: STAFF_ONLY,
  },
  {
    name: 'GET /customers',
    request: () => ({ method: 'GET', url: '/api/v1/customers' }),
    expect: STAFF_ONLY,
  },
  {
    name: 'GET /customers/{id}',
    request: () => ({ method: 'GET', url: `/api/v1/customers/${kim}` }),
    expect: STAFF_ONLY,
  },
  {
    name: 'GET /services/all',
    request: () => ({ method: 'GET', url: '/api/v1/services/all' }),
    expect: STAFF_ONLY,
  },

  // Bara administratörer
  {
    name: 'POST /staff',
    request: () => ({
      method: 'POST',
      url: '/api/v1/staff',
      payload: {
        email: `ny-${randomUUID()}@erc.example`,
        displayName: 'Ny',
        role: 'staff',
        password: 'ett-långt-startlösenord',
      },
    }),
    expect: { ...ADMIN_ONLY, admin: 201 },
  },
  {
    name: 'PATCH /staff/{id}',
    request: () => ({
      method: 'PATCH',
      url: `/api/v1/staff/${bo}`,
      payload: { displayName: 'Bo' },
    }),
    expect: ADMIN_ONLY,
  },
  {
    name: 'PUT /staff/{id}/services',
    request: () => ({
      method: 'PUT',
      url: `/api/v1/staff/${bo}/services`,
      payload: { serviceIds: [haircut, beard, SEED.services.colour] },
    }),
    expect: ADMIN_ONLY,
  },
  {
    name: 'PATCH /business',
    request: () => ({
      method: 'PATCH',
      url: '/api/v1/business',
      payload: { name: 'Salong Exempel' },
    }),
    expect: ADMIN_ONLY,
  },
  {
    name: 'POST /services',
    request: () => ({
      method: 'POST',
      url: '/api/v1/services',
      payload: { name: `Tjänst ${randomUUID()}`, durationMinutes: 30, priceOre: 30_000 },
    }),
    expect: { ...ADMIN_ONLY, admin: 201 },
  },
  {
    name: 'PATCH /services/{id}',
    request: () => ({
      method: 'PATCH',
      url: `/api/v1/services/${beard}`,
      payload: { priceOre: 25_000 },
    }),
    expect: ADMIN_ONLY,
  },
  {
    name: 'GET /customers/{id}/export',
    request: () => ({ method: 'GET', url: `/api/v1/customers/${kim}/export` }),
    expect: ADMIN_ONLY,
  },
  {
    name: 'POST /customers/{id}/anonymize',
    request: () => ({ method: 'POST', url: `/api/v1/customers/${throwawayCustomer}/anonymize` }),
    expect: ADMIN_ONLY,
  },

  // Eget schema: personal ändrar sitt eget, administratörer allas
  {
    name: 'PUT /staff/{own id}/working-hours',
    request: () => ({
      method: 'PUT',
      url: `/api/v1/staff/${anna}/working-hours`,
      payload: { validFrom: '2026-06-01', shifts: ANNA_SHIFTS },
    }),
    expect: { anonymous: 401, customer: 403, staff: 200, otherStaff: 403, admin: 200 },
  },
  {
    name: 'POST /staff/{own id}/time-off',
    request: () => ({
      method: 'POST',
      url: `/api/v1/staff/${anna}/time-off`,
      payload: { fromDate: '2026-12-24', toDate: '2026-12-26', reason: 'Jul' },
    }),
    expect: { anonymous: 401, customer: 403, staff: 201, otherStaff: 403, admin: 201 },
  },

  // Kundens egna data
  {
    name: 'GET /me/bookings',
    request: () => ({ method: 'GET', url: '/api/v1/me/bookings' }),
    expect: CUSTOMER_ONLY,
  },
  {
    name: 'GET /me/export',
    request: () => ({ method: 'GET', url: '/api/v1/me/export' }),
    expect: CUSTOMER_ONLY,
  },

  // Bokningar: ägaren och personal ser dem, andra kunder får 404 (inte 403)
  {
    name: 'GET /bookings/{id}',
    request: () => ({ method: 'GET', url: `/api/v1/bookings/${kimsBooking}` }),
    expect: { anonymous: 401, customer: 200, otherCustomer: 404, staff: 200, admin: 200 },
  },
  {
    name: 'PATCH /bookings/{id}',
    request: async () => ({
      method: 'PATCH',
      url: `/api/v1/bookings/${await insertBooking(kim, freshSlot())}`,
      payload: { status: 'completed' },
    }),
    expect: { anonymous: 401, customer: 403, staff: 200, admin: 200 },
  },
];

beforeAll(async () => {
  t = await createTestApp({ now: '2026-03-20T12:00:00Z' });
  kimsBooking = await insertBooking(kim, '2026-03-24T08:00:00Z');
  const { rows } = await t.testDb.pool.query<{ id: string }>(
    `INSERT INTO customer (email, name) VALUES ('engangs@example.com', 'Engångs') RETURNING id`,
  );
  throwawayCustomer = rows[0]?.id ?? '';

  cookies.customer = await loginCustomer(t, 'kim@example.com');
  cookies.otherCustomer = await loginCustomer(t, 'robin@example.com');
  cookies.staff = await loginAs(t, 'anna@erc.example');
  cookies.otherStaff = await loginAs(t, 'bo@erc.example');
  cookies.admin = await loginAs(t, 'alva@erc.example');
});

afterAll(async () => {
  await t.close();
});

describe('role-based access', () => {
  const rows = cases.flatMap((c) =>
    Object.entries(c.expect).map(([role, status]) => ({
      name: c.name,
      role: role as Role,
      status,
      c,
    })),
  );

  it.each(rows)('$name as $role → $status', async ({ role, status, c }) => {
    const options = await c.request();
    const response = await t.app.inject({
      ...options,
      headers: { ...options.headers, ...as(role === 'anonymous' ? undefined : cookies[role]) },
    });
    expect(response.statusCode, response.body).toBe(status);
    if (status >= 400) {
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    }
  });

  it('covers every route in the API', () => {
    // Nya routes måste läggas till i matrisen. Hälsa, inloggning och de
    // publika bokningsflödena testas i sina egna filer.
    const covered = new Set(cases.map((c) => c.name.replace('{own id}', '{id}')));
    const elsewhere = new Set([
      'GET /health',
      'GET /services/{id}/staff',
      'POST /bookings',
      'POST /bookings/{id}/cancel',
      'POST /auth/login',
      'POST /auth/magic-link',
      'POST /auth/magic-link/verify',
      'POST /auth/logout',
      'DELETE /staff/{id}/time-off/{timeOffId}',
    ]);
    // printRoutes ger ett träd där varje nivå är indragen fyra tecken.
    const stack: string[] = [];
    const missing: string[] = [];
    for (const line of t.app.printRoutes({ commonPrefix: false }).split('\n')) {
      const match = /^([│ ]*)(?:├── |└── )(\S+) \(([^)]+)\)$/.exec(line);
      if (match === null) continue;
      const depth = (match[1] ?? '').length / 4;
      stack.length = depth;
      stack.push(match[2] ?? '');
      const path = stack
        .join('')
        .replace('/api/v1', '')
        .replace(/:(\w+)/g, '{$1}');
      for (const method of (match[3] ?? '').split(', ')) {
        if (method === 'HEAD') continue;
        const name = `${method} ${path}`;
        if (!covered.has(name) && !elsewhere.has(name)) missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });
});
