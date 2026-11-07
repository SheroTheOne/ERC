import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createDatabase, createPool, type Database } from '../../src/db/database.ts';
import { databaseUrl, quoteIdent } from './urls.ts';

export interface TestDatabase {
  readonly url: string;
  /** Pool med samma inställningar som appen (search_path, TimeZone, typparsers). */
  readonly pool: pg.Pool;
  readonly db: Database;
  destroy(): Promise<void>;
}

/**
 * Skapar en egen databas för en testfil genom att klona den migrerade mallen.
 * Ingen transaktion rullas tillbaka mellan tester: samtidighetstester behöver
 * riktiga anslutningar som committar (ADR-0009).
 */
export async function createTestDatabase(
  options: { poolMax?: number } = {},
): Promise<TestDatabase> {
  const adminUrl = inject('adminDatabaseUrl');
  const template = inject('templateDatabaseName');
  const name = `erc_test_${randomBytes(6).toString('hex')}`;

  await withAdmin(adminUrl, (client) =>
    client.query(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(template)}`),
  );

  const url = databaseUrl(adminUrl, name);
  const pool = createPool({
    connectionString: url,
    max: options.poolMax ?? 5,
    applicationName: 'erc-test',
    onIdleError: ignoreTerminationOnDrop,
  });
  const db = createDatabase(pool);

  return {
    url,
    pool,
    db,
    async destroy() {
      await db.destroy();
      await withAdmin(adminUrl, (client) =>
        client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`),
      );
    },
  };
}

const ADMIN_SHUTDOWN = '57P01';

/**
 * destroy() tar bort databasen med WITH (FORCE). En anslutning som poolen
 * fortfarande håller på att stänga avslutas då av servern, och det felet är
 * väntat. Alla andra fel ska synas.
 */
function ignoreTerminationOnDrop(error: Error): void {
  if (error instanceof pg.DatabaseError && error.code === ADMIN_SHUTDOWN) return;
  throw error;
}

async function withAdmin<T>(adminUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
