import { Type } from 'typebox';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type AppInstance } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { createDatabase, createPool } from '../../src/db/database.ts';
import { fixedClock } from '../../src/shared/clock.ts';

// En databas som inte går att nå: HTTP-lagret ska fungera och svara 503, utan riktig PostgreSQL.
const UNREACHABLE_DATABASE = 'postgres://erc:erc@127.0.0.1:1/erc';

let app: AppInstance | undefined;

async function createApp(): Promise<AppInstance> {
  const config = loadConfig({
    DATABASE_URL: UNREACHABLE_DATABASE,
    PUBLIC_ORIGIN: 'http://localhost',
    NODE_ENV: 'test',
  });
  const db = createDatabase(
    createPool({ connectionString: config.databaseUrl, max: 1, onIdleError: () => undefined }),
  );
  app = await buildApp({ config, db, clock: fixedClock('2026-01-01T00:00:00Z') });
  app.addHook('onClose', () => db.destroy());
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('problem responses', () => {
  it('returns 404 as application/problem+json with a request id', async () => {
    const response = await (
      await createApp()
    ).inject({ method: 'GET', url: '/api/v1/missing?x=1' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    const body = response.json<Record<string, unknown>>();
    expect(body).toEqual({
      type: 'https://erc.example/problems/not-found',
      title: 'Resursen finns inte',
      status: 404,
      instance: '/api/v1/missing',
      requestId: response.headers['x-request-id'],
    });
  });

  it('returns 503 when the database is unreachable', async () => {
    const response = await (await createApp()).inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json<Record<string, unknown>>()['type']).toBe(
      'https://erc.example/problems/service-unavailable',
    );
  });

  it('lists schema violations, including unknown fields', async () => {
    const instance = await createApp();
    instance.post(
      '/api/v1/echo',
      {
        schema: {
          body: Type.Object(
            { name: Type.String({ minLength: 1 }) },
            { additionalProperties: false },
          ),
        },
      },
      (request) => request.body,
    );

    const response = await instance.inject({
      method: 'POST',
      url: '/api/v1/echo',
      payload: { name: 'Kim', admin: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<Record<string, unknown>>()).toMatchObject({
      type: 'https://erc.example/problems/validation-failed',
      errors: [{ path: 'body', message: 'must NOT have additional properties' }],
    });
  });

  it('rejects malformed JSON as a validation problem', async () => {
    const response = await (
      await createApp()
    ).inject({
      method: 'POST',
      url: '/api/v1/health',
      headers: { 'content-type': 'application/json' },
      payload: '{bad',
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  });
});
