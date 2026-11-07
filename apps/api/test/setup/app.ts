import { seed } from '../../db/seed/seed.ts';
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
