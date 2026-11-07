import process from 'node:process';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { createDatabase, createPool } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { databaseUrl, quoteIdent } from './urls.ts';

declare module 'vitest' {
  interface ProvidedContext {
    adminDatabaseUrl: string;
    templateDatabaseName: string;
  }
}

const POSTGRES_IMAGE = 'postgres:18';

/**
 * Startar eller ansluter till PostgreSQL 18 och bygger en migrerad mall som
 * varje testfil klonar med CREATE DATABASE … TEMPLATE (ADR-0009).
 *
 * TEST_DATABASE_URL pekar på en befintlig server (CI-tjänst eller lokal
 * instans) och kräver behörighet att skapa databaser. Saknas den startas en
 * container med Testcontainers, vilket kräver Docker eller Podman.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let adminUrl = process.env['TEST_DATABASE_URL'];
  let stopContainer: (() => Promise<unknown>) | undefined;

  if (adminUrl === undefined || adminUrl === '') {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withCommand(['postgres', '-c', 'fsync=off', '-c', 'max_connections=200'])
      .start();
    adminUrl = container.getConnectionUri();
    stopContainer = () => container.stop();
  }

  const templateName = `erc_template_${process.pid}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(templateName)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoteIdent(templateName)}`);
  } finally {
    await admin.end();
  }

  // Alla anslutningar till mallen måste vara stängda innan den kan klonas.
  const templateDb = createDatabase(
    createPool({ connectionString: databaseUrl(adminUrl, templateName), max: 1 }),
  );
  try {
    await migrateToLatest(templateDb);
  } finally {
    await templateDb.destroy();
  }

  project.provide('adminDatabaseUrl', adminUrl);
  project.provide('templateDatabaseName', templateName);

  const finalAdminUrl = adminUrl;
  return async () => {
    if (stopContainer !== undefined) {
      await stopContainer();
      return;
    }
    const client = new pg.Client({ connectionString: finalAdminUrl });
    await client.connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(templateName)} WITH (FORCE)`);
    } finally {
      await client.end();
    }
  };
}
