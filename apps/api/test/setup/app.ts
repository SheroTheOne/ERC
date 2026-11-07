import { DEMO_PASSWORD, seed } from '../../db/seed/seed.ts';
import { buildApp, type AppInstance } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import type { Clock } from '../../src/shared/clock.ts';
import { InMemoryMailer } from '../../src/shared/mailer.ts';
import { createTestDatabase, type TestDatabase } from './database.ts';

/** En klocka som testerna kan ställa. Domänkoden läser aldrig Date.now() (ADR-0009). */
export class MutableClock implements Clock {
  #now: Date;

  constructor(iso: string) {
    this.#now = new Date(iso);
  }

  now(): Date {
    return new Date(this.#now.getTime());
  }

  set(iso: string): void {
    this.#now = new Date(iso);
  }
}

export interface TestApp {
  readonly app: AppInstance;
  readonly testDb: TestDatabase;
  readonly mailer: InMemoryMailer;
  readonly clock: MutableClock;
  close(): Promise<void>;
}

/**
 * App med egen databas och demodatan från db/seed (Europe/Stockholm, steg 15 min,
 * framförhållning 60 min, horisont 60 dagar, avbokning senast 120 min före).
 */
export async function createTestApp(
  options: { now: string; poolMax?: number } = { now: '2026-03-20T12:00:00Z' },
): Promise<TestApp> {
  const testDb = await createTestDatabase(
    options.poolMax === undefined ? {} : { poolMax: options.poolMax },
  );
  await seed(testDb.db);
  const config = loadConfig({
    DATABASE_URL: testDb.url,
    PUBLIC_ORIGIN: 'http://localhost',
    NODE_ENV: 'test',
  });
  const mailer = new InMemoryMailer();
  const clock = new MutableClock(options.now);
  const app = await buildApp({ config, db: testDb.db, clock, mailer });

  return {
    app,
    testDb,
    mailer,
    clock,
    async close() {
      await app.close();
      await testDb.destroy();
    },
  };
}

export const ORIGIN = 'http://localhost';
const SESSION_COOKIE = '__Host-erc_session';

/** Headers för ett anrop som inloggad användare, med Origin så att CSRF-kontrollen godkänner det. */
export function as(cookie: string | undefined): Record<string, string> {
  return cookie === undefined ? {} : { cookie, origin: ORIGIN };
}

export function sessionCookie(response: {
  cookies: readonly { name: string; value: string }[];
}): string | undefined {
  const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE && c.value !== '');
  return cookie === undefined ? undefined : `${SESSION_COOKIE}=${cookie.value}`;
}

/** Loggar in personal eller administratör och returnerar cookie-headern. */
export async function loginAs(
  t: TestApp,
  email: string,
  password = DEMO_PASSWORD,
): Promise<string> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  const cookie = sessionCookie(response);
  if (response.statusCode !== 204 || cookie === undefined) {
    throw new Error(`Login as ${email} failed with ${response.statusCode}: ${response.body}`);
  }
  return cookie;
}

/** Loggar in en befintlig kund via e-postlänken och returnerar cookie-headern. */
export async function loginCustomer(t: TestApp, email: string): Promise<string> {
  await t.app.inject({ method: 'POST', url: '/api/v1/auth/magic-link', payload: { email } });
  const link = t.mailer.loginLinks.findLast((message) => message.to === email);
  if (link === undefined) throw new Error(`No login link sent to ${email}`);
  const response = await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link/verify',
    payload: { token: link.token },
  });
  const cookie = sessionCookie(response);
  if (response.statusCode !== 204 || cookie === undefined) {
    throw new Error(`Customer login for ${email} failed with ${response.statusCode}`);
  }
  return cookie;
}
