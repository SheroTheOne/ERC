import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppInstance } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { fixedClock } from '../../src/shared/clock.ts';
import { createTestDatabase, type TestDatabase } from '../setup/database.ts';

let testDb: TestDatabase;
let app: AppInstance;

beforeAll(async () => {
  testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.url,
    PUBLIC_ORIGIN: 'http://localhost',
    NODE_ENV: 'test',
  });
  app = await buildApp({ config, db: testDb.db, clock: fixedClock('2026-03-29T01:30:00Z') });
});

afterAll(async () => {
  await app.close();
  await testDb.destroy();
});

describe('GET /api/v1/health', () => {
  it('reports the API and database as healthy', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      status: 'ok',
      database: 'ok',
      time: '2026-03-29T01:30:00.000Z',
    });
  });
});

describe('migrations', () => {
  it('records every migration exactly once', async () => {
    const result = await testDb.pool.query<{ name: string }>(
      'SELECT name FROM public.kysely_migration ORDER BY name',
    );
    expect(result.rows.map((row) => row.name)).toEqual(['0001_initial']);
  });
});
